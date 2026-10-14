/**
 * Vendor listings — B2B / B2C channels (migration 205), real Postgres.
 *
 *   LISTING_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=… DB_USER=… DB_PASSWORD=… npx vitest run tests/integration/vendor-listing-channels.integration.test.js
 * The target database must already be fully migrated.
 */
import { beforeAll, describe, expect, it } from 'vitest'

const d = process.env.LISTING_TEST_DB ? describe : describe.skip

d('vendor listings — sales channels (real database)', () => {
  let q, listings
  const F = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const photos = ['https://x.test/1.jpg', 'https://x.test/2.jpg', 'https://x.test/3.jpg']
  const scope = () => ({ vendorId: F.vendor.id, actorId: F.user.id })
  const base = (over = {}) => ({ name: 'Channel Phone ' + rand(), categoryId: F.cat.id, condition: 'NEW', stock: 20, images: photos, ...over })

  beforeAll(async () => {
    Object.assign(process.env, { JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    q = (await import('../../src/config/database.js')).query
    listings = (await import('../../src/modules/listings/listings.service.js')).listingsService
    const one = async (sql, p) => (await q(sql, p)).rows[0]
    F.user = await one(`INSERT INTO users (phone, name, role) VALUES ($1,'Channel Vendor','ADMIN') RETURNING id`, ['8' + rand()])
    F.vendor = await one(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ('Channel Vendor',$1,$2,$3,'ACTIVE') RETURNING id`,
      ['chv-' + rand(), `c${rand()}@t.io`, '73' + rand()])
    await one(
      `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
       VALUES ('Channel Shop',$1,$2,'1 St','Kolkata','West Bengal','700001',22.5,88.3,$3,5,true) RETURNING id`,
      ['chs-' + rand(), 'C' + rand().slice(0, 6), F.vendor.id])
    F.cat = await one(`INSERT INTO categories (name, slug) VALUES ($1,$2) RETURNING id`, ['Phones ' + rand(), 'ph-' + rand()])
  })

  it('B2C-only (the default) behaves as before and keeps the B2B columns empty', async () => {
    const l = await listings.create(base({ price: 50000, mrp: 55000 }), scope())
    expect(l.sell_b2c).toBe(true)
    expect(l.sell_b2b).toBe(false)
    expect(l.wholesale_price).toBeNull()
    expect(l.min_order_qty).toBe(1)
  })

  it('B2B-only stores the wholesale terms, uses wholesale as the base price and is hidden from customers', async () => {
    const l = await listings.create(base({
      sellB2c: false, sellB2b: true, wholesalePrice: 58000, moq: 5, b2bDiscountPct: 5, b2bNotes: 'Bulk orders available',
      vendorQc: { checklist: { screen: 'Working fine' } }, videoUrl: 'https://x.test/v.mp4',
    }), scope())
    expect(l.sell_b2c).toBe(false)
    expect(l.wholesale_price).toBe(58000)
    expect(l.min_order_qty).toBe(5)
    expect(l.b2b_discount_pct).toBe(5)
    expect(l.b2b_notes).toBe('Bulk orders available')
    expect(l.vendor_qc.checklist.screen).toBe('Working fine')
    expect(l.video_url).toBe('https://x.test/v.mp4')
    expect(l.selling_price).toBe(58000)
    const card = (await listings.list(scope(), { channel: 'B2B', search: l.name })).data[0]
    expect(card.wholesale_price).toBe(58000)
  })

  it('rejects incomplete or inconsistent channel terms with a readable message', async () => {
    await expect(listings.create(base({ price: 1000 , sellB2c: false, sellB2b: false }), scope())).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: /at least one sales channel/ })
    await expect(listings.create(base({ sellB2c: false, sellB2b: true }), scope())).rejects.toMatchObject({ message: /Wholesale price is required/ })
    await expect(listings.create(base({ sellB2c: false, sellB2b: true, wholesalePrice: 100, moq: 50 }), scope())).rejects.toMatchObject({ message: /cannot exceed the stock/ })
    await expect(listings.create(base({ price: 1000, sellB2b: true, wholesalePrice: 2000, moq: 2 }), scope())).rejects.toMatchObject({ message: /cannot be higher than the B2C/ })
    await expect(listings.create(base({ sellB2b: true, wholesalePrice: 900, moq: 2 }), scope())).rejects.toMatchObject({ message: /Selling price is required/ })
  })

  it('a used lot may hold several units only when it is not sold to customers', async () => {
    const used = { condition: 'USED_GOOD', conditionNotes: 'Light scratches on the frame', stock: 12 }
    await expect(listings.create(base({ ...used, price: 20000 }), scope())).rejects.toMatchObject({ message: /single-unit/ })
    const lot = await listings.create(base({ ...used, sellB2c: false, sellB2b: true, wholesalePrice: 18000, moq: 4 }), scope())
    expect(lot.stock_quantity).toBe(12)
  })

  it('edits keep the channel rules: cannot switch B2B on without terms, can switch it off', async () => {
    const l = await listings.create(base({ price: 40000, mrp: 45000 }), scope())
    await expect(listings.update(l.id, { sellB2b: true }, scope())).rejects.toMatchObject({ message: /Wholesale price is required/ })
    const both = await listings.update(l.id, { sellB2b: true, wholesalePrice: 36000, moq: 3 }, scope())
    expect(both.sell_b2b).toBe(true)
    expect(both.wholesale_price).toBe(36000)
    const off = await listings.update(l.id, { sellB2b: false }, scope())
    expect(off.sell_b2b).toBe(false)
    await expect(listings.update(l.id, { sellB2c: false }, scope())).rejects.toMatchObject({ message: /at least one sales channel/ })
  })
})
