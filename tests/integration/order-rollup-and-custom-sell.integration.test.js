/**
 * 1. A vendor accepting / packing a seller order moves the customer's parent order (status + history rows).
 * 2. The sell flow accepts a phone, storage and colour that are not in the catalogue.
 *   ORDER_ROLLUP_TEST_DB=1 DB_HOST=localhost DB_PORT=5498 DB_NAME=scratch DB_USER=u DB_PASSWORD=pw REDIS_DB=14 \
 *   npx vitest run tests/integration/order-rollup-and-custom-sell.integration.test.js
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const d = process.env.ORDER_ROLLUP_TEST_DB ? describe : describe.skip

d('vendor order roll-up + custom sell device (real database)', () => {
  let q, pool, orders, sell
  const U = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const one = async (sql, p) => (await q(sql, p)).rows[0]
  const QA = { ageMonths: 12, screenScratches: 'NONE', bodyDents: false, screenReplaced: false, skinReplaced: false, billAvailable: true, boxAvailable: true, chargerAvailable: true, batteryHealth: 90, powersOn: true }

  beforeAll(async () => {
    Object.assign(process.env, { JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), COOKIE_SECRET: 'z'.repeat(32), SETTINGS_ENCRYPTION_KEY: 'k'.repeat(32), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    const db = await import('../../src/config/database.js')
    q = db.query; pool = db.pool
    orders = new (await import('../../src/modules/seller-orders/seller-orders.service.js')).SellerOrdersService()
    sell = await import('../../src/modules/sell-requests/sell-requests.service.js')
    U.v = (await one(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ('Roll V',$1,$2,$3,'ACTIVE') RETURNING id`, ['ro-' + rand(), `r${rand()}@t.io`, '65' + rand()])).id
    U.cust = (await one(`INSERT INTO users (phone, name, role) VALUES ($1,'Buyer','CUSTOMER') RETURNING id`, ['5' + rand()])).id
    U.shop = (await one(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
      VALUES ('Roll Shop',$1,$2,'1 St','Kolkata','West Bengal','700001',22.5,88.3,$3,10,true) RETURNING id`, ['rs-' + rand(), 'R' + rand().slice(0, 6), U.v])).id
  })
  afterAll(async () => { await pool?.end().catch(() => {}) })

  it('vendor accept + pack write the parent order status and history', async () => {
    const o = await one(`INSERT INTO orders (order_number, customer_id, status, payment_method, payment_status, subtotal, total_payable, order_channel, items, delivery_address)
      VALUES ($1,$2,'ORDER_PLACED','COD','PENDING',500,500,'B2C','[]'::jsonb,'{"city":"Kolkata"}'::jsonb) RETURNING id`, ['T' + rand(), U.cust])
    const so = await one(`INSERT INTO seller_orders (order_id, vendor_id, shop_id, seller_order_number, status, item_subtotal, payable_to_seller)
      VALUES ($1,$2,$3,$4,'ORDER_PLACED',500,450) RETURNING id`, [o.id, U.v, U.shop, 'S' + rand()])
    const parent = async () => (await one(`SELECT status FROM orders WHERE id = $1`, [o.id])).status
    const hist = async () => (await q(`SELECT to_status FROM order_status_history WHERE order_id = $1 ORDER BY changed_at, id`, [o.id])).rows.map((r) => r.to_status)

    await orders.updateStatus(so.id, U.v, 'CONFIRMED', null)
    expect(await parent()).toBe('CONFIRMED')
    expect(await hist()).toContain('CONFIRMED')

    await orders.updateStatus(so.id, U.v, 'PACKED', null)
    expect(await parent()).toBe('PACKED')
    expect(await hist()).toEqual(expect.arrayContaining(['CONFIRMED', 'PACKED']))

    // idempotent: re-sending the same status adds nothing
    const before = (await hist()).length
    await orders.updateStatus(so.id, U.v, 'PACKED', null)
    expect((await hist()).length).toBe(before)
  })

  it('packing straight from "placed" records both Confirmed and Packed', async () => {
    const o = await one(`INSERT INTO orders (order_number, customer_id, status, payment_method, payment_status, subtotal, total_payable, order_channel, items, delivery_address)
      VALUES ($1,$2,'ORDER_PLACED','COD','PENDING',500,500,'B2C','[]'::jsonb,'{"city":"Kolkata"}'::jsonb) RETURNING id`, ['T' + rand(), U.cust])
    const so = await one(`INSERT INTO seller_orders (order_id, vendor_id, shop_id, seller_order_number, status, item_subtotal, payable_to_seller)
      VALUES ($1,$2,$3,$4,'ORDER_PLACED',500,450) RETURNING id`, [o.id, U.v, U.shop, 'S' + rand()])
    await orders.updateStatus(so.id, U.v, 'PACKED', null)
    const h = (await q(`SELECT to_status FROM order_status_history WHERE order_id = $1`, [o.id])).rows.map((r) => r.to_status)
    expect(h).toEqual(expect.arrayContaining(['CONFIRMED', 'PACKED']))
  })

  it('a phone that is not in the catalogue is valued from the price the customer expects', async () => {
    const r = await sell.quote({ custom: { brand: 'Nothing', model: 'Phone 2a Plus', expectedPrice: 25000, storage: true, colour: true }, variant: '256 GB', color: 'Glyph White', qa: QA })
    expect(r.model.custom).toBe(true)
    expect(r.model.name).toBe('Nothing Phone 2a Plus')
    expect(r.base).toBe(25000)
    expect(r.value).toBeGreaterThan(0)
    expect(r.value).toBeLessThanOrEqual(25000)
  })

  it('an unlisted phone needs a sensible expected price, storage and colour', async () => {
    await expect(sell.quote({ custom: { brand: 'X', model: 'Y Phone', expectedPrice: 10 }, variant: '128 GB', color: 'Black', qa: QA })).rejects.toMatchObject({ statusCode: 422 })
    await expect(sell.quote({ custom: { brand: 'X', model: 'Y Phone', expectedPrice: 9000 }, variant: '', color: 'Black', qa: QA })).rejects.toMatchObject({ statusCode: 422 })
  })

  it('a listed model with a typed storage and colour is accepted', async () => {
    const m = await one(`INSERT INTO sell_device_models (name, category, variants, colors, base_price, brand) VALUES ('RollTest 5','Smartphone','["64 GB","128 GB"]','["Black"]',30000,'RollTest') RETURNING id`)
    const r = await sell.quote({ modelId: m.id, custom: { storage: true, colour: true }, variant: '1 TB', color: 'Rose Gold', qa: QA })
    expect(r.model.id).toBe(m.id)
    expect(r.base).toBeGreaterThan(0)
    // without the custom flag the same input is still refused
    await expect(sell.quote({ modelId: m.id, variant: '1 TB', color: 'Rose Gold', qa: QA })).rejects.toMatchObject({ statusCode: 422 })
  })
})
