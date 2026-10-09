/**
 * B2B (lot) auctions vs B2C auctions — real Postgres + Redis.
 *
 *   B2BAUC_TEST_DB=1 REDIS_PORT=6380 REDIS_DB=15 DB_HOST=localhost DB_PORT=5434 DB_NAME=… DB_USER=… DB_PASSWORD=… \
 *   npx vitest run tests/integration/b2b-auctions.integration.test.js
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const d = process.env.B2BAUC_TEST_DB ? describe : describe.skip

d('B2B auctions (real database)', () => {
  let q, pool, svc, redis
  const U = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const one = async (sql, p) => (await q(sql, p)).rows[0]

  beforeAll(async () => {
    Object.assign(process.env, { JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' })
    const db = await import('../../src/config/database.js')
    q = db.query; pool = db.pool
    svc = {
      admin: await import('../../src/modules/auctions/auction-admin.service.js'),
      bid: await import('../../src/modules/auctions/auction-bidding.service.js'),
      settle: await import('../../src/modules/auctions/auction-settlement.service.js'),
      checkout: await import('../../src/modules/auctions/auction-checkout.service.js'),
      shared: await import('../../src/modules/auctions/auction.shared.js'),
    }
    redis = (await import('../../src/config/redis.js')).redis

    U.adminUser = await one(`INSERT INTO users (phone, name, role) VALUES ($1,'Admin','ADMIN') RETURNING id`, ['9' + rand()])
    U.admin = { kind: 'ADMIN', userId: U.adminUser.id, vendorId: null }
    const mkVendor = async (name, status = 'ACTIVE') => {
      const v = await one(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [name, 'ba-' + rand(), `b${rand()}@t.io`, '63' + rand(), status])
      const user = await one(`INSERT INTO users (phone, name, role) VALUES ($1,$2,'CUSTOMER') RETURNING id`, ['6' + rand(), name + ' owner'])
      await q(`INSERT INTO vendor_users (vendor_id, user_id, role, is_active) VALUES ($1,$2,'VENDOR_OWNER',true)`, [v.id, user.id])
      await q(`INSERT INTO addresses (user_id, address_line1, city, state, pincode, is_default) VALUES ($1,'1 Road','Kolkata','West Bengal','700001',true)`, [user.id])
      await q(`INSERT INTO wallets (user_id, balance) VALUES ($1, 200000) ON CONFLICT (user_id) DO UPDATE SET balance = 200000`, [user.id])
      return { id: v.id, userId: user.id }
    }
    U.seller = await mkVendor('Seller V')
    U.buyer = await mkVendor('Buyer V')
    U.other = await mkVendor('Other V')
    U.unverified = await mkVendor('Pending V', 'PENDING_ONBOARDING')
    U.shop = await one(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
      VALUES ('Seller Shop',$1,$2,'1 St','Kolkata','West Bengal','700001',22.5,88.3,$3,10,true) RETURNING id`, ['bs-' + rand(), 'B' + rand().slice(0, 6), U.seller.id])
    U.customer = (await one(`INSERT INTO users (phone, name, role) VALUES ($1,'Retail Customer','CUSTOMER') RETURNING id`, ['8' + rand()])).id
    await q(`INSERT INTO addresses (user_id, address_line1, city, state, pincode, is_default) VALUES ($1,'1 Road','Kolkata','West Bengal','700001',true)`, [U.customer])
    await q(`INSERT INTO wallets (user_id, balance) VALUES ($1, 200000) ON CONFLICT (user_id) DO UPDATE SET balance = 200000`, [U.customer])
  })

  afterAll(async () => { await redis?.quit().catch(() => {}); await pool?.end().catch(() => {}) })

  beforeEach(async () => {
    await q('DELETE FROM auctions')
    await q(`DELETE FROM commission_rules`)
    await redis.flushdb()
    await q(`UPDATE wallets SET balance = 500000 WHERE user_id = ANY($1::uuid[])`, [[U.buyer.userId, U.customer, U.other.userId]])
    await q(`UPDATE auction_settings SET enabled = TRUE, loser_fee_refund_pct = 0, vendor_fee_share_pct = 50, vendor_auctions_require_approval = TRUE,
             bid_rate_limit_per_minute = 1000, blocked_states = '{}' WHERE id = TRUE`)
    svc.shared.invalidateSettingsCache()
  })

  const makeProduct = async (stock) => {
    const { rows: [p] } = await q(`INSERT INTO products (name, slug, price, owner_type, owner_vendor_id, is_active) VALUES ('Lot Phone',$1,20000,'VENDOR',$2,true) RETURNING id`, ['lp-' + rand(), U.seller.id])
    const { rows: [sp] } = await q(`INSERT INTO shop_products (shop_id, product_id, price, stock_quantity, is_available) VALUES ($1,$2,20000,$3,true) RETURNING id`, [U.shop.id, p.id, stock])
    return { productId: p.id, shopProductId: sp.id }
  }
  const stockOf = async (id) => Number((await q('SELECT stock_quantity FROM shop_products WHERE id = $1', [id])).rows[0].stock_quantity)
  const create = async (prod, over = {}) => svc.admin.createAuction(U.admin, {
    productId: prod.productId, startPrice: 100000, registrationFee: 1000, bidIncrement: 5000,
    startsAt: new Date(Date.now() - 1000).toISOString(), durationHours: 2, ...over,
  })
  const join = (uid, id) => svc.bid.register(uid, id, { consent: true, ip: '10.0.0.1' })
  const bid = (uid, id, amount) => svc.bid.placeBid(uid, id, { maxAmount: amount, ip: '10.0.0.1', userAgent: 'vitest' })
  const finish = async (id) => { await q(`UPDATE auctions SET starts_at = NOW() - INTERVAL '3 hours', ends_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [id]); await svc.settle.closeEndedAuctions() }

  it('a B2B lot sets aside the whole quantity; a lot bigger than stock is refused; B2C stays one unit', async () => {
    const prod = await makeProduct(10)
    const a = await create(prod, { audience: 'B2B', quantity: 10 })
    expect(a).toMatchObject({ audience: 'B2B', quantity: 10, status: 'LIVE' })
    expect(await stockOf(prod.shopProductId)).toBe(0)
    await svc.admin.cancel(U.admin, a.id, 'test over')
    expect(await stockOf(prod.shopProductId)).toBe(10) // released in full

    await expect(create(prod, { audience: 'B2B', quantity: 11 })).rejects.toMatchObject({ code: 'OUT_OF_STOCK' })
    await expect(create(prod, { audience: 'B2C', quantity: 3 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(create(prod, { audience: 'B2B', quantity: 0 })).rejects.toMatchObject({ code: 'VALIDATION' })
    const c = await create(prod)                                     // default = B2C, one unit
    expect(c).toMatchObject({ audience: 'B2C', quantity: 1 })
    expect(await stockOf(prod.shopProductId)).toBe(9)
  })

  it('B2B auctions admit verified vendors only; customers are refused, and B2C auctions refuse vendors', async () => {
    const lot = await create(await makeProduct(5), { audience: 'B2B', quantity: 5 })
    await expect(join(U.customer, lot.id)).rejects.toMatchObject({ code: 'VENDORS_ONLY' })
    await expect(join(U.unverified.userId, lot.id)).rejects.toMatchObject({ code: 'VENDORS_ONLY' })
    await expect(join(U.seller.userId, lot.id)).rejects.toMatchObject({ code: 'OWN_AUCTION' })
    await expect(join(U.buyer.userId, lot.id)).resolves.toBeTruthy()

    const retail = await create(await makeProduct(1))
    await expect(join(U.buyer.userId, retail.id)).rejects.toMatchObject({ code: 'CUSTOMERS_ONLY' })
    await expect(join(U.customer, retail.id)).resolves.toBeTruthy()
  })

  it('invited-only B2B auctions admit just the listed vendors', async () => {
    const lot = await create(await makeProduct(5), { audience: 'B2B', quantity: 5, eligibleVendorIds: [U.buyer.id] })
    expect(lot.eligible_vendor_ids).toEqual([U.buyer.id])
    await expect(join(U.other.userId, lot.id)).rejects.toMatchObject({ code: 'NOT_INVITED' })
    await expect(join(U.buyer.userId, lot.id)).resolves.toBeTruthy()
    await expect(create(await makeProduct(5), { audience: 'B2B', quantity: 5, eligibleVendorIds: ['00000000-0000-0000-0000-000000000000'] })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('each side only sees its own auctions', async () => {
    const lot = await create(await makeProduct(5), { audience: 'B2B', quantity: 5 })
    const retail = await create(await makeProduct(1))
    const vendorView = (await svc.bid.listPublic(U.buyer.userId, { tab: 'live' })).data.map((x) => x.id)
    const customerView = (await svc.bid.listPublic(U.customer, { tab: 'live' })).data.map((x) => x.id)
    expect(vendorView).toContain(lot.id); expect(vendorView).not.toContain(retail.id)
    expect(customerView).toContain(retail.id); expect(customerView).not.toContain(lot.id)
    await expect(svc.bid.getPublic(U.customer, lot.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const detail = await svc.bid.getPublic(U.buyer.userId, lot.id)
    expect(detail).toMatchObject({ audience: 'B2B', quantity: 5 })
    expect(detail.unit_price).toBe(20000) // ₹1,00,000 lot ÷ 5
  })

  it('winning a lot creates a B2B order: whole quantity, per-unit price, B2B commission rule', async () => {
    await q(`INSERT INTO commission_rules (scope, channel, commission_pct, tax_pct) VALUES ('GLOBAL','B2C',10,0), ('GLOBAL','B2B',3,0)`)
    const prod = await makeProduct(10)
    const lot = await create(prod, { audience: 'B2B', quantity: 10 })
    await join(U.buyer.userId, lot.id)
    await bid(U.buyer.userId, lot.id, 100000)
    await finish(lot.id)
    const won = (await q('SELECT status, winner_id, winning_bid FROM auctions WHERE id = $1', [lot.id])).rows[0]
    expect(won.status).toBe('AWAITING_PAYMENT')
    expect(won.winner_id).toBe(U.buyer.userId)

    const res = await svc.checkout.checkout(U.buyer.userId, lot.id, { addressId: (await one('SELECT id FROM addresses WHERE user_id = $1', [U.buyer.userId])).id, paymentMethod: 'WALLET' })
    expect(res.paid).toBe(true)
    const order = await one(`SELECT id, order_channel, auction_id FROM orders WHERE id = $1`, [res.order_id])
    expect(order).toMatchObject({ order_channel: 'B2B' })
    const item = await one(`SELECT quantity, unit_price, subtotal FROM order_items WHERE order_id = $1`, [res.order_id])
    expect(Number(item.quantity)).toBe(10)
    expect(Number(item.unit_price)).toBe(10000)
    expect(Number(item.subtotal)).toBe(100000)
    const so = await one(`SELECT channel, commission_rate, commission_amount, payable_to_seller FROM seller_orders WHERE order_id = $1`, [res.order_id])
    expect(so.channel).toBe('B2B')
    expect(Number(so.commission_amount)).toBe(3000)        // the B2B rule (3%), not the B2C one (10%)
    expect(Number(so.payable_to_seller)).toBe(97000)
  })

  it('a customer auction order is B2C and uses the B2C commission rule', async () => {
    await q(`INSERT INTO commission_rules (scope, channel, commission_pct, tax_pct) VALUES ('GLOBAL','B2C',10,0), ('GLOBAL','B2B',3,0)`)
    const retail = await create(await makeProduct(1), { startPrice: 20000, bidIncrement: 1000 })
    await join(U.customer, retail.id)
    await bid(U.customer, retail.id, 20000)
    await finish(retail.id)
    const res = await svc.checkout.checkout(U.customer, retail.id, { addressId: (await one('SELECT id FROM addresses WHERE user_id = $1', [U.customer])).id, paymentMethod: 'WALLET' })
    expect((await one(`SELECT order_channel FROM orders WHERE id = $1`, [res.order_id])).order_channel).toBe('B2C')
    const so = await one(`SELECT channel, commission_amount FROM seller_orders WHERE order_id = $1`, [res.order_id])
    expect(so.channel).toBe('B2C')
    expect(Number(so.commission_amount)).toBe(2000)
  })

  it('auction orders list: stages per auction, filtered by audience', async () => {
    const lot = await create(await makeProduct(4), { audience: 'B2B', quantity: 4 })
    await join(U.buyer.userId, lot.id); await bid(U.buyer.userId, lot.id, 100000); await finish(lot.id)
    const retail = await create(await makeProduct(1), { startPrice: 20000, bidIncrement: 1000 })
    await join(U.customer, retail.id); await bid(U.customer, retail.id, 20000); await finish(retail.id)

    const b2b = await svc.admin.listOrders(U.admin, { audience: 'B2B' })
    expect(b2b.data.map((r) => r.id)).toEqual([lot.id])
    const row = b2b.data[0]
    expect(row).toMatchObject({ quantity: 4, unit_price: 25000, auction_status: 'AWAITING_PAYMENT', current: 'ORDER' })
    expect(row.stages.map((s) => s.key)).toEqual(['WINNER', 'ORDER', 'PAYMENT', 'QC', 'SHIPPING', 'DELIVERED'])
    expect(row.stages[0].done).toBe(true)
    expect(row.stages[1].done).toBe(false)

    await svc.checkout.checkout(U.buyer.userId, lot.id, { addressId: (await one('SELECT id FROM addresses WHERE user_id = $1', [U.buyer.userId])).id, paymentMethod: 'WALLET' })
    const after = (await svc.admin.listOrders(U.admin, { audience: 'B2B' })).data[0]
    expect(after.stages.find((s) => s.key === 'ORDER').done).toBe(true)
    expect(after.stages.find((s) => s.key === 'PAYMENT').done).toBe(true)
    expect(after.order_number).toBeTruthy()

    const b2c = await svc.admin.listOrders(U.admin, { audience: 'B2C' })
    expect(b2c.data.map((r) => r.id)).toEqual([retail.id])
    expect((await svc.admin.listOrders(U.admin, { audience: 'B2B', status: 'AWAITING_PAYMENT' })).data.length).toBe(0)
    expect((await svc.admin.listOrders(U.admin, { status: 'IN_PROGRESS' })).data.length).toBeGreaterThanOrEqual(1)
  })

  it('admin list can filter by audience and relist keeps the lot settings', async () => {
    const lot = await create(await makeProduct(6), { audience: 'B2B', quantity: 6, eligibleVendorIds: [U.buyer.id] })
    await create(await makeProduct(1))
    expect((await svc.admin.listManage(U.admin, { audience: 'B2B' })).data.map((a) => a.id)).toEqual([lot.id])
    expect((await svc.admin.listManage(U.admin, { audience: 'B2C' })).data.every((a) => a.audience === 'B2C')).toBe(true)
    await finish(lot.id)                                   // no bids → UNSOLD
    const re = await svc.admin.relist(U.admin, lot.id, { durationHours: 4 })
    expect(re).toMatchObject({ audience: 'B2B', quantity: 6, status: 'DRAFT' })
    expect(re.eligible_vendor_ids).toEqual([U.buyer.id])
  })
})
