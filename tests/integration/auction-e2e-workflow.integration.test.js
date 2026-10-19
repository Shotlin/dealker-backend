/**
 * Auctions end to end — real Postgres + Redis. From the first bid to the vendor's payout:
 *
 *   bid → win → order → wallet payment → seller confirms/packs → shipment → delivered → vendor settlement → payout,
 *   plus every loser's ₹ registration fee (wallet debit, forfeit split to vendor/platform) and the admin's views.
 *
 *   B2BAUC_TEST_DB=1 REDIS_PORT=6380 REDIS_DB=15 DB_HOST=localhost DB_PORT=5434 DB_NAME=… DB_USER=… DB_PASSWORD=… \
 *   npx vitest run tests/integration/auction-e2e-workflow.integration.test.js
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const d = process.env.B2BAUC_TEST_DB ? describe : describe.skip

d('auction workflow B2C + B2B (real database)', () => {
  let q, pool, svc, redis
  const U = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const one = async (sql, p) => (await q(sql, p)).rows[0]
  const bal = async (uid) => Number((await one('SELECT balance FROM wallets WHERE user_id = $1', [uid])).balance)

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
      track: (await import('../../src/modules/order-overview/order-overview.service.js')),
      sellerOrders: new (await import('../../src/modules/seller-orders/seller-orders.service.js')).SellerOrdersService(),
      settlements: new (await import('../../src/modules/vendor-settlements/vendor-settlements.service.js')).VendorSettlementsService(),
    }
    redis = (await import('../../src/config/redis.js')).redis

    U.adminUser = await one(`INSERT INTO users (phone, name, role) VALUES ($1,'Admin','ADMIN') RETURNING id`, ['9' + rand()])
    U.admin = { kind: 'ADMIN', userId: U.adminUser.id, vendorId: null }
    const mkUser = async (name, role = 'CUSTOMER') => {
      const u = await one(`INSERT INTO users (phone, name, role) VALUES ($1,$2,$3) RETURNING id`, ['6' + rand(), name, role])
      await q(`INSERT INTO addresses (user_id, address_line1, city, state, pincode, is_default) VALUES ($1,'1 Road','Kolkata','West Bengal','700001',true)`, [u.id])
      await q(`INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`, [u.id])
      return u.id
    }
    const mkVendor = async (name) => {
      const v = await one(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`, [name, 'e2e-' + rand(), `e${rand()}@t.io`, '63' + rand()])
      const userId = await mkUser(name + ' owner')
      await q(`INSERT INTO vendor_users (vendor_id, user_id, role, is_active) VALUES ($1,$2,'VENDOR_OWNER',true)`, [v.id, userId])
      return { id: v.id, userId }
    }
    U.seller = await mkVendor('Seller V')
    U.buyer = await mkVendor('Winner V')
    U.loser = await mkVendor('Loser V')
    await q(`INSERT INTO vendor_profiles (vendor_id, address_line1, city, state, pincode) VALUES ($1,'12 Trade Rd','Kolkata','West Bengal','700020')`, [U.buyer.id])
    U.sellerActor = { kind: 'VENDOR', userId: U.seller.userId, vendorId: U.seller.id }
    U.shop = await one(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
      VALUES ('E2E Shop',$1,$2,'1 St','Kolkata','West Bengal','700001',22.5,88.3,$3,10,true) RETURNING id`, ['es-' + rand(), 'E' + rand().slice(0, 6), U.seller.id])
    U.winner = await mkUser('Customer Winner')
    U.l1 = await mkUser('Customer Loser 1')
    U.l2 = await mkUser('Customer Loser 2')
  })

  afterAll(async () => { await redis?.quit().catch(() => {}); await pool?.end().catch(() => {}) })

  beforeEach(async () => {
    await q('DELETE FROM auctions')
    await q('DELETE FROM commission_rules')
    await redis.flushdb()
    await q(`UPDATE wallets SET balance = 500000 WHERE user_id = ANY($1::uuid[])`, [[U.buyer.userId, U.loser.userId, U.winner, U.l1, U.l2]])
    await q(`UPDATE auction_settings SET enabled = TRUE, loser_fee_refund_pct = 0, vendor_fee_share_pct = 50, vendor_auctions_require_approval = TRUE,
             bid_rate_limit_per_minute = 1000, blocked_states = '{}' WHERE id = TRUE`)
    svc.shared.invalidateSettingsCache()
    await q(`INSERT INTO commission_rules (scope, channel, commission_pct, tax_pct) VALUES ('GLOBAL','B2C',10,0), ('GLOBAL','B2B',3,0)`)
  })

  const makeProduct = async (stock) => {
    const { rows: [p] } = await q(`INSERT INTO products (name, slug, price, owner_type, owner_vendor_id, is_active) VALUES ('E2E Phone',$1,20000,'VENDOR',$2,true) RETURNING id`, ['e2e-' + rand(), U.seller.id])
    const { rows: [sp] } = await q(`INSERT INTO shop_products (shop_id, product_id, price, stock_quantity, is_available) VALUES ($1,$2,20000,$3,true) RETURNING id`, [U.shop.id, p.id, stock])
    return { productId: p.id, shopProductId: sp.id }
  }
  const join = (uid, id) => svc.bid.register(uid, id, { consent: true, ip: '10.0.0.1' })
  const bid = (uid, id, amount) => svc.bid.placeBid(uid, id, { maxAmount: amount, ip: '10.0.0.1', userAgent: 'vitest' })
  const finish = async (id) => { await q(`UPDATE auctions SET starts_at = NOW() - INTERVAL '3 hours', ends_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [id]); await svc.settle.closeEndedAuctions() }
  const addr = async (uid) => (await one('SELECT id FROM addresses WHERE user_id = $1', [uid])).id

  /** The seller's side after payment: confirm, pack, book a shipment, track it to delivered. */
  async function fulfil(orderId) {
    const so = await one('SELECT id, vendor_id FROM seller_orders WHERE order_id = $1', [orderId])
    expect(so.vendor_id).toBe(U.seller.id)
    await svc.sellerOrders.updateStatus(so.id, U.seller.id, 'CONFIRMED', U.seller.userId)
    await svc.sellerOrders.updateStatus(so.id, U.seller.id, 'PACKED', U.seller.userId)
    await svc.track.shipmentTracking.createManual(so.id, { provider: 'SELF', courierName: 'Own delivery' }, U.seller.userId)
    const sh = await one('SELECT id FROM shipments WHERE seller_order_id = $1', [so.id])
    for (const status of ['PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED']) await svc.track.shipmentTracking.addEvent(sh.id, { status }, U.seller.userId)
    return so.id
  }

  async function runWorkflow({ audience, quantity, startPrice, fee, winnerId, loserIds, winBid }) {
    const prod = await makeProduct(quantity)
    const a = await svc.admin.createAuction(U.sellerActor, {
      productId: prod.productId, audience, quantity: audience === 'B2B' ? quantity : undefined, startPrice, registrationFee: fee,
      bidIncrement: 1000, startsAt: new Date(Date.now() + 10 * 60000).toISOString(), durationHours: 2,
    })
    expect(a.status).toBe('PENDING_APPROVAL')                       // vendor auctions wait for the platform
    await svc.admin.approveAuction(U.admin, a.id)
    await q(`UPDATE auctions SET starts_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [a.id])
    await svc.settle.startDueAuctions()
    expect((await one('SELECT status FROM auctions WHERE id = $1', [a.id])).status).toBe('LIVE')

    const before = {}
    for (const u of [winnerId, ...loserIds]) before[u] = await bal(u)
    for (const u of [...loserIds, winnerId]) await join(u, a.id)
    for (const u of [winnerId, ...loserIds]) expect(await bal(u)).toBe(before[u] - fee)       // registration fee leaves the wallet

    let amount = startPrice
    for (const u of loserIds) { await bid(u, a.id, amount); amount += 1000 }
    await bid(winnerId, a.id, winBid)
    await finish(a.id)
    const won = await one('SELECT status, winner_id, winning_bid, amount_due FROM auctions WHERE id = $1', [a.id])
    expect(won.status).toBe('AWAITING_PAYMENT')
    expect(won.winner_id).toBe(winnerId)
    // proxy bidding: the winner pays one step above the runner-up, not their private maximum
    const price = Number(won.winning_bid)
    expect(price).toBeGreaterThan(amount - 1000)
    expect(price).toBeLessThanOrEqual(winBid)
    expect(Number(won.amount_due)).toBe(price - fee)                    // fee is credited against the price

    // a business winner pays with no address picked: delivery goes to the business address on their profile
    const pay = await svc.checkout.checkout(winnerId, a.id, { addressId: audience === 'B2B' ? undefined : await addr(winnerId), paymentMethod: 'WALLET' })
    expect(pay.paid).toBe(true)
    expect(await bal(winnerId)).toBe(before[winnerId] - fee - (price - fee))   // fee + remainder = bid, nothing more
    const order = await one('SELECT * FROM orders WHERE id = $1', [pay.order_id])
    expect(order.payment_status).toBe('PAID')
    expect(order.order_channel).toBe(audience)
    if (audience === 'B2B') {
      const sh = await one(`SELECT * FROM orders WHERE id = $1`, [pay.order_id])
      expect(JSON.stringify(sh)).toContain('12 Trade Rd')
      const mine = await svc.bid.getPublic(winnerId, a.id)
      expect(mine.my).toMatchObject({ is_winner: true, order_id: pay.order_id, order_status: 'ORDER_PLACED' })
      expect(mine.my.order_number).toBe(pay.order_number)
    }

    // losers: fee stays gone, wallet shows the debit, ledger conserves money
    for (const u of loserIds) {
      expect(await bal(u)).toBe(before[u] - fee)
      const tx = await q(`SELECT amount FROM wallet_transactions t JOIN wallets w ON w.id = t.wallet_id WHERE w.user_id = $1 AND t.type = 'DEBIT'`, [u])
      expect(tx.rows.map((r) => Number(r.amount))).toContain(fee)
    }
    const led = Object.fromEntries((await q(`SELECT entry_type, SUM(amount)::float t FROM auction_fee_ledger WHERE auction_id = $1 GROUP BY 1`, [a.id])).rows.map((r) => [r.entry_type, r.t]))
    const forfeited = fee * loserIds.length
    expect(led.FEE_CHARGED).toBe(fee * (loserIds.length + 1))
    expect(led.FEE_APPLIED_TO_ORDER).toBe(fee)
    expect(led.FEE_FORFEIT_VENDOR + led.FEE_FORFEIT_PLATFORM).toBe(forfeited)
    expect(led.FEE_FORFEIT_VENDOR).toBe(forfeited / 2)                 // 50 / 50 default split
    const regs = (await q(`SELECT status FROM auction_registrations WHERE auction_id = $1`, [a.id])).rows.map((r) => r.status).sort()
    expect(regs).toEqual([...loserIds.map(() => 'FORFEITED'), 'APPLIED'].sort())

    // fulfilment → delivery → settlement
    const soId = await fulfil(pay.order_id)
    const delivered = await one(`SELECT status, fulfilment_status, commission_amount, payable_to_seller FROM seller_orders WHERE id = $1`, [soId])
    expect(delivered.status).toBe('DELIVERED')
    expect((await one('SELECT status FROM orders WHERE id = $1', [pay.order_id])).status).toBe('DELIVERED')
    const rate = audience === 'B2B' ? 0.03 : 0.10
    expect(Number(delivered.commission_amount)).toBe(price * rate)
    const ledger = Object.fromEntries((await q(`SELECT entry_type, SUM(amount)::float t FROM settlement_ledger WHERE seller_order_id = $1 GROUP BY 1`, [soId])).rows.map((r) => [r.entry_type, r.t]))
    expect(ledger.GROSS_SALES).toBe(price)                            // vendor is settled on the FULL winning bid
    expect(ledger.COMMISSION).toBe(-(price * rate))
    const vendorBal = Number((await one(`SELECT COALESCE(SUM(amount),0) b FROM settlement_ledger WHERE vendor_id = $1`, [U.seller.id])).b)
    expect(vendorBal).toBeGreaterThanOrEqual(price - price * rate + forfeited / 2)   // sale net + the vendor's share of forfeited fees

    // admin pays the vendor out
    const payout = await svc.settlements.createPayout(U.seller.id, { notes: 'e2e', createdBy: U.adminUser.id })
    expect(Number(payout.amount)).toBe(vendorBal)
    const paid = await svc.settlements.markPayoutPaid(payout.id, { utrNumber: 'UTR123', actorId: U.adminUser.id })
    expect(paid.status).toBe('PAID')

    // admin dashboard: every number is visible and consistent
    const detail = await svc.admin.getManage(U.admin, a.id)
    expect(detail.registrations).toHaveLength(loserIds.length + 1)
    expect(detail.auction).toMatchObject({ status: 'SOLD', audience })
    const orders = (await svc.admin.listOrders(U.admin, { audience })).data.find((r) => r.id === a.id)
    expect(orders.stages.map((s) => [s.key, s.done])).toEqual([['WINNER', true], ['ORDER', true], ['PAYMENT', true], ['QC', expect.any(Boolean)], ['SHIPPING', true], ['DELIVERED', true]])
    const st = await svc.admin.stats(U.admin)
    expect(JSON.stringify(st)).toContain(String(led.FEE_FORFEIT_PLATFORM))
    const ov = await svc.track.orderOverview.get(pay.order_id)
    expect(ov.order.status).toBe('DELIVERED')
    return { a, pay, soId }
  }

  it('B2C: customer wins → pays → vendor ships → delivered → payout; 2 losing customers forfeit ₹500 each', async () => {
    await runWorkflow({ audience: 'B2C', quantity: 1, startPrice: 20000, fee: 500, winnerId: U.winner, loserIds: [U.l1, U.l2], winBid: 24000 })
  })

  it('B2B: vendor wins a lot of 10 → pays → seller ships → delivered → payout; a losing vendor forfeits ₹500', async () => {
    await runWorkflow({ audience: 'B2B', quantity: 10, startPrice: 100000, fee: 500, winnerId: U.buyer.userId, loserIds: [U.loser.userId], winBid: 120000 })
  })

  it('a B2B winner with no business address on file is told to add one (nothing is charged)', async () => {
    const prod = await makeProduct(2)
    const a = await svc.admin.createAuction(U.admin, { productId: prod.productId, audience: 'B2B', quantity: 2, startPrice: 10000, registrationFee: 500, bidIncrement: 500, startsAt: new Date(Date.now() - 1000).toISOString(), durationHours: 2 })
    await join(U.loser.userId, a.id); await bid(U.loser.userId, a.id, 10000); await finish(a.id)
    const b0 = await bal(U.loser.userId)
    await expect(svc.checkout.checkout(U.loser.userId, a.id, { paymentMethod: 'WALLET' })).rejects.toMatchObject({ code: 'ADDRESS_REQUIRED' })
    expect(await bal(U.loser.userId)).toBe(b0)
  })

  it('a loser gets their fee back when the auction is cancelled (B2C and B2B)', async () => {
    for (const audience of ['B2C', 'B2B']) {
      const prod = await makeProduct(3)
      const a = await svc.admin.createAuction(U.admin, { productId: prod.productId, audience, quantity: audience === 'B2B' ? 3 : undefined, startPrice: 10000, registrationFee: 500, bidIncrement: 500, startsAt: new Date(Date.now() - 1000).toISOString(), durationHours: 2 })
      const uid = audience === 'B2B' ? U.loser.userId : U.l1
      const b0 = await bal(uid)
      await join(uid, a.id)
      expect(await bal(uid)).toBe(b0 - 500)
      await svc.admin.cancel(U.admin, a.id, 'seller withdrew')
      expect(await bal(uid)).toBe(b0)                                   // full refund to the wallet
    }
  })
})
