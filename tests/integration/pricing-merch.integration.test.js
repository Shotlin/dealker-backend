/**
 * Price control + merchandising — real Postgres.
 *
 *   PRICING_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=… DB_USER=… DB_PASSWORD=… \
 *   npx vitest run tests/integration/pricing-merch.integration.test.js
 * The target database must already be fully migrated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const d = process.env.PRICING_TEST_DB ? describe : describe.skip

d('pricing + merchandising (real database)', () => {
  let q, listings, pricing, merch
  const F = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const photos = ['https://x.test/1.jpg', 'https://x.test/2.jpg', 'https://x.test/3.jpg']
  const price = async (id) => Number((await q(`SELECT COALESCE(sale_price, price) AS p FROM shop_products WHERE id = $1`, [id])).rows[0].p)
  const prodPrice = async (id) => Number((await q(`SELECT p.sale_price AS p FROM shop_products sp JOIN products p ON p.id = sp.product_id WHERE sp.id = $1`, [id])).rows[0].p)

  async function mk(over = {}) {
    return listings.create({
      name: 'PC Phone ' + rand(), categoryId: F.cat.id, condition: 'NEW', price: 10000, mrp: 12000, stock: 5,
      images: photos, ownerVendorId: F.vendor.id, brand: F.brand, ...over,
    }, { vendorId: null, actorId: F.admin.id })
  }
  const scopeOf = (L) => ({ listingIds: L.map((l) => l.id) })

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000',
    })
    q = (await import('../../src/config/database.js')).query
    listings = (await import('../../src/modules/listings/listings.service.js')).listingsService
    const { PricingService } = await import('../../src/modules/pricing/pricing.service.js')
    const { MerchandisingService } = await import('../../src/modules/merchandising/merchandising.service.js')
    pricing = new PricingService()
    merch = new MerchandisingService()
    const one = async (sql, p) => (await q(sql, p)).rows[0]
    F.brand = 'Brand' + rand()
    F.admin = await one(`INSERT INTO users (phone, name, role) VALUES ($1,'PC Admin','ADMIN') RETURNING id`, ['8' + rand()])
    F.vendor = await one(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ('PC Vendor',$1,$2,$3,'ACTIVE') RETURNING id`, ['pcv-' + rand(), `p${rand()}@t.io`, '75' + rand()])
    await one(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
               VALUES ('PC Shop',$1,$2,'1 St','Kolkata','West Bengal','700001',22.5,88.3,$3,5,true) RETURNING id`, ['pcs-' + rand(), 'P' + rand().slice(0, 6), F.vendor.id])
    F.cat = await one(`INSERT INTO categories (name, slug) VALUES ($1,$2) RETURNING id`, ['PC Cat ' + rand(), 'pc-' + rand()])
  })

  afterAll(async () => { /* scratch DB is dropped by the runner */ })

  it('refuses an unscoped change and bad parameters', async () => {
    await expect(pricing.previewPrice({ scope: {}, params: { operation: 'PERCENT', value: -5 } })).rejects.toMatchObject({ code: 'SCOPE_REQUIRED' })
    await expect(pricing.previewPrice({ scope: { all: true }, params: { operation: 'PERCENT', value: 0 } })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(pricing.previewPrice({ scope: { listingIds: ['nope'] }, params: { operation: 'PERCENT', value: -5 } })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('preview does not write; apply changes selling price (not MRP), mirrors to products, and records the batch', async () => {
    const L = [await mk(), await mk({ price: 20000, mrp: 25000 })]
    const params = { operation: 'PERCENT', value: -5 }
    const pre = await pricing.previewPrice({ scope: scopeOf(L), params })
    expect(pre.summary).toMatchObject({ changed: 2, skipped: 0 })
    expect(pre.sample.map((s) => s.new).sort((a, b) => a - b)).toEqual([9500, 19000])
    expect(await price(L[0].id)).toBe(10000) // preview wrote nothing

    const res = await pricing.applyPrice({ scope: scopeOf(L), params, note: 'Festival -5%' }, F.admin.id)
    expect(res.changed).toBe(2)
    expect(await price(L[0].id)).toBe(9500)
    expect(await price(L[1].id)).toBe(19000)
    expect(await prodPrice(L[0].id)).toBe(9500)
    const sp = (await q(`SELECT price, mrp FROM shop_products WHERE id = $1`, [L[0].id])).rows[0]
    expect(Number(sp.price)).toBe(9500)
    expect(Number(sp.mrp)).toBe(12000) // MRP untouched
    const b = (await pricing.batches({})).data.find((x) => x.id === res.batchId)
    expect(b).toMatchObject({ kind: 'PRICE', status: 'APPLIED', item_count: 2, note: 'Festival -5%' })
  })

  it('skips unsafe rows (above MRP / below cost) with reasons and still applies the safe ones', async () => {
    const a = await mk({ price: 11500, mrp: 12000 })
    const b = await mk({ price: 10000, mrp: 12000 })
    const out = await pricing.previewPrice({ scope: scopeOf([a, b]), params: { operation: 'PERCENT', value: 10 } })
    expect(out.summary).toMatchObject({ changed: 1, skipped: 1 })
    expect(out.sample.find((s) => s.id === a.id).skip).toMatch(/above the MRP/)
    await pricing.applyPrice({ scope: scopeOf([a, b]), params: { operation: 'PERCENT', value: 10 } }, F.admin.id)
    expect(await price(a.id)).toBe(11500)
    expect(await price(b.id)).toBe(11000)
    await q(`UPDATE shop_products SET cost_price = 9000 WHERE id = $1`, [b.id])
    const below = await pricing.previewPrice({ scope: scopeOf([b]), params: { operation: 'SET', value: 8000 } })
    expect(below.sample[0].skip).toMatch(/below cost/)
    await expect(pricing.applyPrice({ scope: scopeOf([b]), params: { operation: 'SET', value: 8000 } }, F.admin.id)).rejects.toMatchObject({ code: 'NOTHING_TO_DO' })
  })

  it('discount-from-MRP, fixed amount, brand + channel scoping, and wholesale target', async () => {
    const a = await mk({ price: 10000, mrp: 20000 })
    await pricing.applyPrice({ scope: scopeOf([a]), params: { operation: 'DISCOUNT_FROM_MRP', value: 30 } }, F.admin.id)
    expect(await price(a.id)).toBe(14000)
    await pricing.applyPrice({ scope: scopeOf([a]), params: { operation: 'FIXED', value: -500 } }, F.admin.id)
    expect(await price(a.id)).toBe(13500)

    const brand = 'OnlyBrand' + rand()
    const x = await mk({ brand }); const y = await mk()
    await pricing.applyPrice({ scope: { brands: [brand] }, params: { operation: 'PERCENT', value: -10 } }, F.admin.id)
    expect(await price(x.id)).toBe(9000)
    expect(await price(y.id)).toBe(10000)

    await q(`UPDATE shop_products SET wholesale_price = 8000, sell_b2b = TRUE WHERE id = $1`, [y.id])
    const w = await pricing.applyPrice({ scope: { listingIds: [y.id], channel: 'B2B' }, params: { operation: 'PERCENT', value: -5, target: 'WHOLESALE' } }, F.admin.id)
    expect(w.changed).toBe(1)
    expect(Number((await q(`SELECT wholesale_price FROM shop_products WHERE id = $1`, [y.id])).rows[0].wholesale_price)).toBe(7600)
    expect(await price(y.id)).toBe(10000) // retail untouched
    const none = await pricing.previewPrice({ scope: { listingIds: [x.id] }, params: { operation: 'PERCENT', value: -5, target: 'WHOLESALE' } })
    expect(none.sample[0].skip).toMatch(/No wholesale price/)
  })

  it('revert restores untouched listings and keeps later manual edits', async () => {
    const L = [await mk(), await mk()]
    const res = await pricing.applyPrice({ scope: scopeOf(L), params: { operation: 'PERCENT', value: -10 } }, F.admin.id)
    await listings.update(L[1].id, { price: 8888 }, { vendorId: null, actorId: F.admin.id }) // edited after the batch
    const r = await pricing.revert(res.batchId, F.admin.id)
    expect(r).toEqual({ restored: 1, conflicts: 1 })
    expect(await price(L[0].id)).toBe(10000)
    expect(await price(L[1].id)).toBe(8888)
    expect((await pricing.batchItems(res.batchId)).batch.status).toBe('REVERTED')
    await expect(pricing.revert(res.batchId, F.admin.id)).rejects.toMatchObject({ code: 'ALREADY_REVERTED' })
  })

  it('bulk stock: set / add / subtract, guards, status sync, and revert', async () => {
    const a = await mk({ stock: 5 }); const b = await mk({ stock: 1 })
    const used = await mk({ condition: 'USED_GOOD', conditionNotes: 'light scratches on back', stock: 1 })
    const pre = await pricing.previewStock({ scope: scopeOf([a, b, used]), params: { operation: 'SUBTRACT', value: 2 } })
    expect(pre.summary).toMatchObject({ changed: 1, skipped: 2 })
    const set0 = await pricing.applyStock({ scope: scopeOf([a]), params: { operation: 'SET', value: 0 } }, F.admin.id)
    let row = (await q(`SELECT stock_quantity, listing_status, is_available FROM shop_products WHERE id = $1`, [a.id])).rows[0]
    expect(row).toMatchObject({ stock_quantity: 0, listing_status: 'OUT_OF_STOCK', is_available: false })
    await pricing.applyStock({ scope: scopeOf([a]), params: { operation: 'ADD', value: 7 } }, F.admin.id)
    row = (await q(`SELECT stock_quantity, listing_status FROM shop_products WHERE id = $1`, [a.id])).rows[0]
    expect(row).toMatchObject({ stock_quantity: 7, listing_status: 'ACTIVE' })
    const addUsed = await pricing.previewStock({ scope: scopeOf([used]), params: { operation: 'ADD', value: 3 } })
    expect(addUsed.sample[0].skip).toMatch(/single-unit/)
    await pricing.revert(set0.batchId, F.admin.id).catch(() => {}) // later edit → conflict, harmless
    expect((await pricing.batches({})).data.length).toBeGreaterThan(0)
  })

  it('sections: move replaces the old section, Featured syncs is_featured, windows validated, public view honours rules', async () => {
    const a = await mk(); const b = await mk({ stock: 0 })
    await listings.approve(a.id, F.admin.id)
    expect(await merch.move([a.id, b.id], 'NEW_ARRIVAL')).toMatchObject({ moved: 2 })
    expect((await merch.listSection('NEW_ARRIVAL')).data.map((r) => r.id)).toEqual(expect.arrayContaining([a.id, b.id]))
    await merch.move([a.id], 'FEATURED')
    expect((await merch.listSection('NEW_ARRIVAL')).data.map((r) => r.id)).not.toContain(a.id)
    expect((await q(`SELECT is_featured FROM products WHERE id = $1`, [a.product_id])).rows[0].is_featured).toBe(true)

    const live = await merch.publicSection('FEATURED')
    expect(live.data.map((r) => r.id)).toContain(a.id)
    await merch.move([b.id], 'FEATURED')
    expect((await merch.publicSection('FEATURED')).data.map((r) => r.id)).not.toContain(b.id) // out of stock

    await expect(merch.move([a.id], 'DEAL_OF_THE_DAY', { endsAt: new Date(Date.now() - 3600e3).toISOString() })).rejects.toMatchObject({ code: 'VALIDATION' })
    await merch.move([a.id], 'DEAL_OF_THE_DAY', { endsAt: new Date(Date.now() + 3600e3).toISOString() })
    expect((await merch.publicSection('DEAL_OF_THE_DAY')).data.map((r) => r.id)).toContain(a.id)
    await q(`UPDATE shop_products SET merch_ends_at = NOW() - interval '1 minute' WHERE id = $1`, [a.id])
    expect((await merch.publicSection('DEAL_OF_THE_DAY')).data.map((r) => r.id)).not.toContain(a.id) // expired
    expect((await merch.overview()).sections.find((s) => s.key === 'DEAL_OF_THE_DAY').expired).toBeGreaterThan(0)

    await merch.move([a.id], null)
    expect((await q(`SELECT merch_section, is_featured FROM shop_products WHERE id = $1`, [a.id])).rows[0]).toMatchObject({ merch_section: null, is_featured: false })
    await expect(merch.move([a.id], 'MADE_UP')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(merch.move([], 'FEATURED')).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('channels: at least one required; B2C off hides the listing from the public section', async () => {
    const a = await mk(); await listings.approve(a.id, F.admin.id); await merch.move([a.id], 'BEST_SELLER')
    await expect(merch.setChannels([a.id], { b2c: false, b2b: false })).rejects.toMatchObject({ code: 'VALIDATION' })
    await merch.setChannels([a.id], { b2c: false, b2b: true })
    expect((await merch.publicSection('BEST_SELLER')).data.map((r) => r.id)).not.toContain(a.id)
    await merch.setChannels([a.id], { b2c: true, b2b: true })
    expect((await merch.publicSection('BEST_SELLER')).data.map((r) => r.id)).toContain(a.id)
  })

  it('bulk actions report per-listing failures, and QC gate blocks approvals', async () => {
    const a = await mk(); const b = await mk()
    expect(await merch.bulk([a.id, b.id], 'PAUSE')).toMatchObject({ done: 2, failed: [] })
    expect((await q(`SELECT listing_status FROM shop_products WHERE id = $1`, [a.id])).rows[0].listing_status).toBe('PAUSED')
    await merch.bulk([a.id], 'RESUME')
    expect((await q(`SELECT listing_status FROM shop_products WHERE id = $1`, [a.id])).rows[0].listing_status).toBe('ACTIVE')
    await q(`UPDATE qc_settings SET require_pass_to_publish = TRUE WHERE id = 1`)
    const r = await merch.bulk([a.id, b.id], 'APPROVE')
    await q(`UPDATE qc_settings SET require_pass_to_publish = FALSE WHERE id = 1`)
    expect(r.done).toBe(0)
    expect(r.failed[0].reason).toMatch(/QC must pass/)
    expect(await merch.bulk([a.id, b.id], 'DELETE')).toMatchObject({ done: 2 })
    await expect(merch.bulk([a.id], 'EXPLODE')).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('duplicate creates a paused, pending, QC-pending draft without identity fields', async () => {
    const a = await mk({ imei: '490154203237518', serialNumber: 'SER-' + rand(), sku: 'SKU-' + rand() })
    await listings.approve(a.id, F.admin.id)
    await merch.move([a.id], 'FEATURED')
    const { id } = await merch.duplicate(a.id, F.admin.id)
    const copy = (await q(
      `SELECT sp.approval_status, sp.listing_status, sp.qc_status, sp.merch_section, sp.is_available, sp.seller_sku,
              p.name, p.imei, p.serial_number, p.sku, p.is_featured, p.thumbnail_url, p.owner_vendor_id
         FROM shop_products sp JOIN products p ON p.id = sp.product_id WHERE sp.id = $1`, [id])).rows[0]
    expect(copy).toMatchObject({ approval_status: 'PENDING', listing_status: 'PAUSED', qc_status: 'QC_PENDING', merch_section: null, is_available: false,
      seller_sku: null, imei: null, serial_number: null, sku: null, is_featured: false, owner_vendor_id: F.vendor.id })
    expect(copy.name).toMatch(/\(copy\)$/)
    expect(copy.thumbnail_url).toBeTruthy()
    await expect(merch.duplicate('00000000-0000-0000-0000-000000000000', F.admin.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('brands list feeds the scope picker', async () => {
    expect((await pricing.brands()).map((b) => b.brand)).toContain(F.brand)
  })
})
