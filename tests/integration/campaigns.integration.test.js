/**
 * Promo campaigns — real Postgres: validation, start/end lifecycle (prices +
 * sections), overlap protection, scheduler tick, sales attribution, coupons.
 *
 *   CAMPAIGN_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=… DB_USER=… DB_PASSWORD=… \
 *   npx vitest run tests/integration/campaigns.integration.test.js
 */
import { beforeAll, describe, expect, it } from 'vitest'

const d = process.env.CAMPAIGN_TEST_DB ? describe : describe.skip

d('campaigns (real database)', () => {
  let q, svc, listings, merch
  const F = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const photos = ['https://x.test/1.jpg', 'https://x.test/2.jpg', 'https://x.test/3.jpg']
  const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString()
  const price = async (id) => Number((await q(`SELECT COALESCE(sale_price, price) AS p FROM shop_products WHERE id = $1`, [id])).rows[0].p)
  const section = async (id) => (await q(`SELECT merch_section FROM shop_products WHERE id = $1`, [id])).rows[0].merch_section
  const mk = async (over = {}) => listings.create({
    name: 'Camp Phone ' + rand(), categoryId: F.cat.id, condition: 'NEW', price: 10000, mrp: 12000, stock: 5,
    images: photos, ownerVendorId: F.vendor.id, brand: F.brand, ...over,
  }, { vendorId: null, actorId: F.admin.id })
  const base = (L, over = {}) => ({ name: 'Diwali Flash ' + rand(), type: 'FLASH_SALE', startsAt: inHours(1), endsAt: inHours(5),
    scope: { listingIds: L.map((l) => l.id) }, discount: { operation: 'PERCENT', value: -10 }, ...over })

  beforeAll(async () => {
    Object.assign(process.env, { JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    q = (await import('../../src/config/database.js')).query
    listings = (await import('../../src/modules/listings/listings.service.js')).listingsService
    const { CampaignsService } = await import('../../src/modules/promo-campaigns/campaigns.service.js')
    const { MerchandisingService } = await import('../../src/modules/merchandising/merchandising.service.js')
    svc = new CampaignsService(); merch = new MerchandisingService()
    F.brand = 'CampBrand' + rand()
    F.admin = (await q(`INSERT INTO users (phone, name, role) VALUES ($1,'Camp Admin','ADMIN') RETURNING id`, ['8' + rand()])).rows[0]
    F.customer = (await q(`INSERT INTO users (phone, name, role) VALUES ($1,'Camp Customer','CUSTOMER') RETURNING id`, ['7' + rand()])).rows[0]
    F.vendor = (await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ('Camp Vendor',$1,$2,$3,'ACTIVE') RETURNING id`, ['cv-' + rand(), `c${rand()}@t.io`, '77' + rand()])).rows[0]
    await q(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
             VALUES ('CS',$1,$2,'1 St','Kolkata','West Bengal','700001',22.5,88.3,$3,5,true)`, ['cs-' + rand(), 'C' + rand().slice(0, 6), F.vendor.id])
    F.cat = (await q(`INSERT INTO categories (name, slug) VALUES ($1,$2) RETURNING id`, ['Camp Cat ' + rand(), 'cc-' + rand()])).rows[0]
  })

  it('validates: name, window, discount direction, scope, coupon, section/type rules', async () => {
    const L = [await mk()]
    await expect(svc.create(base(L, { name: 'ab' }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.create(base(L, { startsAt: inHours(5), endsAt: inHours(1) }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.create(base(L, { discount: { operation: 'PERCENT', value: 10 } }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.create(base(L, { discount: { operation: 'PERCENT', value: -95 } }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.create(base(L, { discount: { operation: 'SET', value: 100 } }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.create(base(L, { scope: {} }))).rejects.toMatchObject({ code: 'SCOPE_REQUIRED' })
    await expect(svc.create(base(L, { discount: null }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.create(base(L, { type: 'VENDOR' }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.create({ name: 'Coupon push', type: 'COUPON' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.create({ name: 'Coupon push', type: 'COUPON', couponId: '00000000-0000-0000-0000-000000000000' })).rejects.toMatchObject({ code: 'VALIDATION' })
    const ok = await svc.create(base(L))
    expect(ok).toMatchObject({ status: 'DRAFT', type: 'FLASH_SALE', section: 'FLASH_SALE' })
  })

  it('schedule needs a future window; edit is blocked once running; drafts can be deleted', async () => {
    const L = [await mk()]
    const c = await svc.create(base(L, { startsAt: null, endsAt: null }))
    await expect(svc.schedule(c.id)).rejects.toMatchObject({ code: 'VALIDATION' })
    const upd = await svc.update(c.id, { startsAt: inHours(1), endsAt: inHours(3), name: 'Renamed campaign' })
    expect(upd.name).toBe('Renamed campaign')
    expect((await svc.schedule(c.id)).status).toBe('SCHEDULED')
    await expect(svc.schedule(c.id)).rejects.toMatchObject({ code: 'INVALID_STATE' })
    await svc.start(c.id)
    await expect(svc.update(c.id, { name: 'Too late now' })).rejects.toMatchObject({ code: 'NOT_EDITABLE' })
    await expect(svc.remove(c.id)).rejects.toMatchObject({ code: 'NOT_DELETABLE' })
    await svc.end(c.id)
    const d2 = await svc.create(base(L)); await svc.remove(d2.id)
    await expect(svc.get(d2.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('start applies the discount and section; end restores prices and the previous section', async () => {
    const [a, b] = [await mk(), await mk({ price: 20000, mrp: 25000 })]
    await merch.move([a.id], 'FEATURED')
    const c = await svc.create(base([a, b], { endsAt: inHours(4) }))
    const started = await svc.start(c.id, F.admin.id)
    expect(started).toMatchObject({ status: 'ACTIVE', listing_count: 2 })
    expect(await price(a.id)).toBe(9000)
    expect(await price(b.id)).toBe(18000)
    expect(await section(a.id)).toBe('FLASH_SALE')
    expect(started.listings.find((l) => l.id === a.id)).toMatchObject({ price_before: 10000, price_after: 9000 })
    const batch = (await q(`SELECT kind, status, note FROM price_adjustment_batches WHERE id = $1`, [started.activation_batch_id])).rows[0]
    expect(batch).toMatchObject({ kind: 'PRICE', status: 'APPLIED', note: expect.stringContaining('Campaign:') })
    await expect(svc.start(c.id)).rejects.toMatchObject({ code: 'INVALID_STATE' })

    const ended = await svc.end(c.id, 'Test over', F.admin.id)
    expect(ended).toMatchObject({ status: 'ENDED' })
    expect(ended.revert.restored).toBe(2)
    expect(await price(a.id)).toBe(10000)
    expect(await price(b.id)).toBe(20000)
    expect(await section(a.id)).toBe('FEATURED') // back where it was
    expect(await section(b.id)).toBeNull()
    await expect(svc.end(c.id)).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('a listing already in a running campaign is skipped by a second one; edits made meanwhile survive the end', async () => {
    const [a, b] = [await mk(), await mk()]
    const c1 = await svc.start((await svc.create(base([a], { type: 'DISCOUNT', discount: { operation: 'PERCENT', value: -10 } }))).id)
    expect(await price(a.id)).toBe(9000)
    const prev = await svc.preview(base([a, b]))
    expect(prev.summary.listings).toBe(1) // a is held by campaign 1
    const c2 = await svc.start((await svc.create(base([a, b], { type: 'DISCOUNT', discount: { operation: 'PERCENT', value: -20 } }))).id)
    expect(c2.listing_count).toBe(1)
    expect(await price(a.id)).toBe(9000)
    expect(await price(b.id)).toBe(8000)
    await listings.update(b.id, { price: 7777 }, { vendorId: null, actorId: F.admin.id }) // admin edit during the campaign
    const e2 = await svc.end(c2.id)
    expect(e2.revert).toEqual({ restored: 0, conflicts: 1 })
    expect(await price(b.id)).toBe(7777)
    await svc.end(c1.id)
    expect(await price(a.id)).toBe(10000)
  })

  it('discount-from-MRP and skipped rows (would exceed cost) are reported, not forced', async () => {
    const a = await mk({ price: 10000, mrp: 20000 })
    await q(`UPDATE shop_products SET cost_price = 9500 WHERE id = $1`, [a.id])
    const prev = await svc.preview(base([a], { discount: { operation: 'DISCOUNT_FROM_MRP', value: 60 } }))
    expect(prev.sample[0].skip).toMatch(/below cost/)
    const c = await svc.create(base([a], { discount: { operation: 'DISCOUNT_FROM_MRP', value: 60 } }))
    const s = await svc.start(c.id)
    expect(s.listing_count).toBe(0) // nothing could change, the campaign still runs
    expect(await price(a.id)).toBe(10000)
    await svc.end(c.id)
  })

  it('the scheduler tick starts due campaigns, ends finished ones and abandons windows that already passed', async () => {
    const a = await mk(); const b = await mk()
    const due = await svc.create(base([a], { startsAt: inHours(1), endsAt: inHours(3) })); await svc.schedule(due.id)
    await q(`UPDATE promo_campaigns SET starts_at = NOW() - interval '1 minute' WHERE id = $1`, [due.id])
    const late = await svc.create(base([b], { startsAt: inHours(1), endsAt: inHours(3) })); await svc.schedule(late.id)
    await q(`UPDATE promo_campaigns SET starts_at = NOW() - interval '3 hours', ends_at = NOW() - interval '1 hour' WHERE id = $1`, [late.id])
    const t1 = await svc.tick()
    expect(t1.started).toBeGreaterThanOrEqual(1)
    expect((await svc.get(due.id)).status).toBe('ACTIVE')
    expect(await price(a.id)).toBe(9000)
    expect((await svc.get(late.id))).toMatchObject({ status: 'ENDED' })
    expect(await price(b.id)).toBe(10000) // never applied
    await q(`UPDATE promo_campaigns SET ends_at = NOW() - interval '1 second' WHERE id = $1`, [due.id])
    const t2 = await svc.tick()
    expect(t2.ended).toBeGreaterThanOrEqual(1)
    expect(await price(a.id)).toBe(10000)
    expect((await svc.get(due.id)).end_reason).toMatch(/end time/)
    expect((await svc.tick())).toMatchObject({ started: 0, ended: 0 })
  })

  it('stats attribute only in-window orders of the campaign listings; overview totals them', async () => {
    const [a, b] = [await mk(), await mk()]
    const c = await svc.start((await svc.create(base([a], { endsAt: inHours(4) }))).id)
    const sp = (await q(`SELECT shop_id, product_id FROM shop_products WHERE id = $1`, [a.id])).rows[0]
    const spB = (await q(`SELECT shop_id, product_id FROM shop_products WHERE id = $1`, [b.id])).rows[0]
    const mkOrder = async (listing, ref, qty, unit, status = 'DELIVERED') => {
      const o = (await q(`INSERT INTO orders (order_number, customer_id, is_marketplace, status, items, subtotal, total_payable, payment_method, payment_status, delivery_address)
        VALUES ($1,$2,TRUE,$3,'[]'::jsonb,$4,$4,'ONLINE','PAID','{}'::jsonb) RETURNING id`, ['CMP-' + rand(), F.customer.id, status, qty * unit])).rows[0]
      const so = (await q(`INSERT INTO seller_orders (order_id, seller_order_number, vendor_id, status, item_subtotal) VALUES ($1,$2,$3,'DELIVERED',$4) RETURNING id`, [o.id, 'SO-' + rand(), F.vendor.id, qty * unit])).rows[0]
      await q(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, unit, subtotal, shop_product_id, shop_id, seller_order_id)
               VALUES ($1,$2,$3,$4,$5,'pc',$6,$7,$8,$9)`, [o.id, ref.product_id, 'Item', unit, qty, qty * unit, listing.id, ref.shop_id, so.id])
      return o
    }
    await mkOrder(a, sp, 2, 9000)                 // counts: 2 × 9000, saved 2 × 1000
    await mkOrder(a, sp, 1, 9000, 'CANCELLED')    // cancelled → ignored
    await mkOrder(b, spB, 1, 10000)               // not a campaign listing → ignored
    const det = await svc.get(c.id)
    expect(det.stats).toMatchObject({ orders: 1, units: 2, revenue: 18000, customers: 1, vendors: 1, savings: 2000 })
    const ov = await svc.overview()
    expect(ov.active).toBeGreaterThanOrEqual(1)
    expect(ov.revenue).toBeGreaterThanOrEqual(18000)
    await svc.end(c.id)
  })

  it('coupon campaigns change no prices and report coupon usage in their window', async () => {
    const coupon = (await q(`INSERT INTO coupons (code, discount_type, discount_value, valid_from, valid_until, is_active)
      VALUES ($1,'PERCENTAGE',10, NOW() - interval '1 day', NOW() + interval '10 days', true) RETURNING id`, ['WELCOME' + rand()])).rows[0]
    const c = await svc.create({ name: 'Welcome coupon push', type: 'COUPON', couponId: coupon.id, startsAt: inHours(1), endsAt: inHours(48) })
    expect(c.coupon_code).toMatch(/^WELCOME/)
    const s = await svc.start(c.id)
    expect(s).toMatchObject({ status: 'ACTIVE', listing_count: 0, activation_batch_id: null })
    const o = (await q(`INSERT INTO orders (order_number, customer_id, is_marketplace, status, items, subtotal, total_payable, payment_method, payment_status, delivery_address)
      VALUES ($1,$2,TRUE,'DELIVERED','[]'::jsonb,100,90,'ONLINE','PAID','{}'::jsonb) RETURNING id`, ['CPN-' + rand(), F.customer.id])).rows[0]
    await q(`INSERT INTO coupon_usages (coupon_id, user_id, customer_id, order_id, discount_amount) VALUES ($1,$2,$2,$3,10)`, [coupon.id, F.customer.id, o.id])
    const det = await svc.get(c.id)
    expect(det.stats).toMatchObject({ couponUses: 1, couponDiscount: 10 })
    await svc.end(c.id)
  })

  it('cancel only works before a campaign starts', async () => {
    const L = [await mk()]
    const c = await svc.create(base(L)); await svc.schedule(c.id)
    expect((await svc.cancel(c.id, 'Plans changed')).status).toBe('CANCELLED')
    const run = await svc.start((await svc.create(base(L))).id)
    await expect(svc.cancel(run.id)).rejects.toMatchObject({ code: 'INVALID_STATE' })
    await svc.end(run.id)
  })
})
