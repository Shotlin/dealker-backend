/**
 * Vendor order inbox — product + auction + repair rows in one list, with tab/type counts and next actions.
 *   B2BAUC_TEST_DB=1 REDIS_PORT=6380 REDIS_DB=15 DB_HOST=… DB_PORT=… DB_NAME=… DB_USER=… DB_PASSWORD=… \
 *   npx vitest run tests/integration/vendor-orders.integration.test.js
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const d = process.env.B2BAUC_TEST_DB ? describe : describe.skip

d('vendor orders inbox (real database)', () => {
  let q, pool, list
  const U = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const one = async (sql, p) => (await q(sql, p)).rows[0]

  beforeAll(async () => {
    Object.assign(process.env, { JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    const db = await import('../../src/config/database.js')
    q = db.query; pool = db.pool
    list = (await import('../../src/modules/vendor-orders/vendor-orders.service.js')).list
    const mkV = async (n) => (await one(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`, [n, 'vo-' + rand(), `v${rand()}@t.io`, '65' + rand()])).id
    U.v = await mkV('Orders V'); U.other = await mkV('Someone Else')
    U.cust = (await one(`INSERT INTO users (phone, name, role) VALUES ($1,'Asha Buyer','CUSTOMER') RETURNING id`, ['5' + rand()])).id
    U.shop = (await one(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
      VALUES ('VO Shop',$1,$2,'1 St','Kolkata','West Bengal','700001',22.5,88.3,$3,10,true) RETURNING id`, ['vs-' + rand(), 'V' + rand().slice(0, 6), U.v])).id
    U.prod = (await one(`INSERT INTO products (name, slug, price, owner_type, owner_vendor_id, is_active) VALUES ('Order Phone',$1,20000,'VENDOR',$2,true) RETURNING id`, ['op-' + rand(), U.v])).id
  })
  afterAll(async () => { await pool?.end().catch(() => {}) })

  /** An order + its seller order for vendor `vendorId` in `status`; `auction` makes it an auction order. */
  async function order({ vendorId = U.v, status, pay = 'ONLINE', paid = 'PAID', auction = false, name = 'Order Phone' }) {
    let auctionId = null
    if (auction) {
      auctionId = (await one(`INSERT INTO auctions (auction_number, product_id, shop_id, vendor_id, owner_type, title, start_price, current_price, registration_fee, status, starts_at, ends_at, original_ends_at)
        VALUES ($1,$2,$3,$4,'VENDOR','Auction ' || $5, 100,100,10,'SOLD', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour') RETURNING id`, ['AU-T-' + rand(), U.prod, U.shop, vendorId, name])).id
    }
    const o = await one(`INSERT INTO orders (order_number, customer_id, status, payment_method, payment_status, subtotal, total_payable, order_channel, auction_id, items, delivery_address)
      VALUES ($1,$2,'ORDER_PLACED',$3,$4,20000,20000,$5,$6,'[]'::jsonb,'{"city":"Kolkata"}'::jsonb) RETURNING id`, ['T' + rand(), U.cust, pay, paid, auction ? 'B2C' : 'B2C', auctionId])
    const so = await one(`INSERT INTO seller_orders (order_id, vendor_id, shop_id, seller_order_number, status, item_subtotal, payable_to_seller)
      VALUES ($1,$2,$3,$4,$5,20000,18000) RETURNING id`, [o.id, vendorId, U.shop, 'S' + rand(), status])
    await q(`INSERT INTO order_items (order_id, seller_order_id, product_id, product_name, quantity, unit_price, subtotal) VALUES ($1,$2,$3,$4,1,20000,20000)`, [o.id, so.id, U.prod, name])
    return so.id
  }
  async function repair(status, extra = {}) {
    const r = await one(`INSERT INTO repair_requests (code, channel, status, customer_name, customer_phone, assigned_vendor_id, approved_total, amount_paid)
      VALUES ($1,'B2C',$2,'Ravi Repair','9999999999',$3,$4,$5) RETURNING id`, ['RP' + rand().slice(0, 6), status, extra.vendorId || U.v, extra.total || 0, extra.paid || 0])
    await q(`INSERT INTO repair_items (request_id, line_no, brand, model, problem_category) VALUES ($1,1,'Apple','iPhone 12','SCREEN')`, [r.id])
    return r.id
  }

  it('lists product, auction and repair work for this vendor only, stage-sorted, with counts and next actions', async () => {
    await order({ status: 'ORDER_PLACED' })                                    // product, needs confirm
    await order({ status: 'ORDER_PLACED', pay: 'ONLINE', paid: 'PENDING' })    // product, awaiting payment (no action)
    await order({ status: 'CONFIRMED', pay: 'COD', paid: 'PENDING' })          // product, COD → can pack
    await order({ status: 'PACKED', auction: true, name: 'iPhone 15' })        // auction, ready to ship
    await order({ status: 'SHIPPED' })                                         // product shipped
    await order({ status: 'DELIVERED', auction: true })                        // auction done
    await order({ status: 'CANCELLED' })                                       // product cancelled
    await order({ vendorId: U.other, status: 'ORDER_PLACED' })                 // someone else's — never visible
    await repair('ACCEPTED'); await repair('IN_REPAIR'); await repair('READY_FOR_DELIVERY'); await repair('COMPLETED'); await repair('REJECTED')
    await repair('IN_REPAIR', { vendorId: U.other })

    const all = await list(U.v, {})
    expect(all.counts).toEqual({ all: 12, new: 2, active: 4, shipped: 2, done: 2, cancelled: 2 })   // the unpaid online order waits under active
    expect(all.types).toEqual({ all: 12, product: 5, auction: 2, repair: 5 })
    expect(all.data.map((r) => r.stage).slice(0, 2)).toEqual(['NEW', 'NEW'])               // things needing you come first
    expect(all.data.every((r) => r.customer)).toBe(true)

    const actions = Object.fromEntries(all.data.map((r) => [`${r.kind}:${r.status}`, r.next_action?.key ?? null]))
    expect(actions['PRODUCT:CONFIRMED']).toBe('pack')
    expect(actions['AUCTION:PACKED']).toBe('ship')
    expect(actions['PRODUCT:SHIPPED']).toBeNull()
    expect(actions['REPAIR:ACCEPTED']).toBe('receive')
    expect(actions['REPAIR:IN_REPAIR']).toBe('send-to-qc')
    expect(actions['REPAIR:READY_FOR_DELIVERY']).toBe('deliver')
    const unpaid = all.data.find((r) => r.kind === 'PRODUCT' && r.status === 'ORDER_PLACED' && r.payment_status === 'PENDING')
    expect(unpaid).toMatchObject({ next_action: null, awaiting_payment: true })
    const paidNew = all.data.find((r) => r.kind === 'PRODUCT' && r.status === 'ORDER_PLACED' && r.payment_status === 'PAID')
    expect(paidNew.next_action).toMatchObject({ key: 'confirm' })
  })

  it('filters by type, tab and search; paginates; refuses a non-vendor', async () => {
    const products = await list(U.v, { type: 'product' })
    expect(products.data.every((r) => r.kind === 'PRODUCT')).toBe(true)
    expect(products.pagination.total).toBe(products.counts.all)
    const auctions = await list(U.v, { type: 'auction', tab: 'done' })
    expect(auctions.data).toHaveLength(1)
    const repairsNew = await list(U.v, { type: 'repair', tab: 'new' })
    expect(repairsNew.data.map((r) => r.status)).toEqual(['ACCEPTED'])
    const found = await list(U.v, { q: 'iPhone 15' })
    expect(found.data.length).toBeGreaterThanOrEqual(1)
    expect(found.data.every((r) => /iPhone 15/i.test(r.title))).toBe(true)
    const byCustomer = await list(U.v, { q: 'Ravi' })
    expect(byCustomer.data.every((r) => r.kind === 'REPAIR')).toBe(true)
    const p1 = await list(U.v, { limit: 5, page: 1 }); const p3 = await list(U.v, { limit: 5, page: 3 })
    expect(p1.data).toHaveLength(5); expect(p3.data).toHaveLength(2)
    await expect(list(null, {})).rejects.toMatchObject({ statusCode: 403 })
  })
})
