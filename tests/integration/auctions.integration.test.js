/**
 * Auctions — integration tests against a REAL Postgres (and Redis for the rate limiter).
 *
 * Opt-in (never runs against a dev database by accident):
 *   AUCTION_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=dealker_auction_test \
 *   DB_USER=… DB_PASSWORD=… REDIS_PORT=6380 REDIS_DB=15 npx vitest run tests/integration/auctions.integration.test.js
 * The target database must already be fully migrated (npm run db:migrate).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const enabled = !!process.env.AUCTION_TEST_DB
const d = enabled ? describe : describe.skip

let q, pool, svc

d('auctions (real database)', () => {
  const U = {} // fixtures
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test',
      CORS_ORIGINS: 'http://localhost:3000',
    })
    const db = await import('../../src/config/database.js')
    q = db.query
    pool = db.pool
    svc = {
      admin: await import('../../src/modules/auctions/auction-admin.service.js'),
      bid: await import('../../src/modules/auctions/auction-bidding.service.js'),
      settle: await import('../../src/modules/auctions/auction-settlement.service.js'),
      checkout: await import('../../src/modules/auctions/auction-checkout.service.js'),
      shared: await import('../../src/modules/auctions/auction.shared.js'),
    }
    const { redis } = await import('../../src/config/redis.js')
    U.redis = redis

    const one = async (sql, p) => (await q(sql, p)).rows[0]
    U.adminUser = await one(`INSERT INTO users (phone, name, role) VALUES ($1,'Admin','ADMIN') RETURNING id`, ['9' + rand()])
    U.admin = { kind: 'ADMIN', userId: U.adminUser.id, vendorId: null }

    U.vendor = await one(`INSERT INTO vendors (name, slug, email, phone) VALUES ('Test Vendor',$1,$2,$3) RETURNING id`, ['tv-' + rand(), `v${rand()}@t.io`, '61' + rand()])
    U.vendor2 = await one(`INSERT INTO vendors (name, slug, email, phone) VALUES ('Other Vendor',$1,$2,$3) RETURNING id`, ['ov-' + rand(), `o${rand()}@t.io`, '62' + rand()])
    U.shop = await one(
      `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
       VALUES ('Test Shop',$1,$2,'1 St','Kolkata','West Bengal','700001',22.5,88.3,$3,10,true) RETURNING id`,
      ['ts-' + rand(), 'T' + rand().slice(0, 6), U.vendor.id])
    U.platformShop = await one(`SELECT id FROM shops WHERE is_platform = true LIMIT 1`)
    U.vendorActor = { kind: 'VENDOR', userId: null, vendorId: U.vendor.id }
    U.vendor2Actor = { kind: 'VENDOR', userId: null, vendorId: U.vendor2.id }

    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
    for (const n of names) {
      U[n] = (await one(`INSERT INTO users (phone, name, role) VALUES ($1,$2,'CUSTOMER') RETURNING id`, ['8' + rand(), `Bidder ${n}`])).id
      await q(`INSERT INTO addresses (user_id, address_line1, city, state, pincode, is_default) VALUES ($1,'1 Road','Kolkata','West Bengal','700001',true)`, [U[n]])
    }
    U.staff = (await one(`INSERT INTO users (phone, name, role) VALUES ($1,'Vendor Staff','CUSTOMER') RETURNING id`, ['7' + rand()])).id
    await q(`INSERT INTO vendor_users (vendor_id, user_id, role, is_active) VALUES ($1,$2,'VENDOR_OWNER',true)`, [U.vendor.id, U.staff])
    U.names = names
  })

  afterAll(async () => {
    await U.redis?.quit().catch(() => {})
    await pool?.end().catch(() => {})
  })

  const resetWallets = async (balance = 5000) => {
    for (const n of [...U.names, 'staff']) {
      const uid = U[n]
      await q(`INSERT INTO wallets (user_id, balance) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET balance = $2`, [uid, balance])
    }
    await q(`DELETE FROM auction_bidder_profiles`)
    await U.redis.flushdb()
    svc.shared.invalidateSettingsCache()
  }
  beforeEach(async () => {
    await q('DELETE FROM auctions')
    await resetWallets()
    await q(`UPDATE auction_settings SET enabled = TRUE, loser_fee_refund_pct = 0, vendor_fee_share_pct = 50, strike_limit = 3,
             vendor_auctions_require_approval = TRUE, bid_rate_limit_per_minute = 1000, blocked_states = '{}' WHERE id = TRUE`)
    svc.shared.invalidateSettingsCache()
  })

  const balance = async (n) => Number((await q('SELECT balance FROM wallets WHERE user_id = $1', [U[n]])).rows[0].balance)
  const makeProduct = async ({ vendor = true, stock = 1, price = 25000 } = {}) => {
    const slug = 'p-' + rand()
    const { rows: [p] } = await q(
      `INSERT INTO products (name, slug, price, owner_type, owner_vendor_id, is_active) VALUES ('iPhone 15 (test)',$1,$2,$3,$4,true) RETURNING id`,
      [slug, price, vendor ? 'VENDOR' : 'ADMIN', vendor ? U.vendor.id : null])
    const { rows: [sp] } = await q(
      `INSERT INTO shop_products (shop_id, product_id, price, stock_quantity, is_available) VALUES ($1,$2,$3,$4,true) RETURNING id`,
      [vendor ? U.shop.id : U.platformShop.id, p.id, price, stock])
    return { productId: p.id, shopProductId: sp.id }
  }
  const stockOf = async (spId) => Number((await q('SELECT stock_quantity FROM shop_products WHERE id = $1', [spId])).rows[0].stock_quantity)

  const live = async (overrides = {}, productOpts = {}) => {
    const prod = await makeProduct(productOpts)
    const a = await svc.admin.createAuction(U.admin, {
      productId: prod.productId, startPrice: 20000, registrationFee: 500, bidIncrement: 1000,
      startsAt: new Date(Date.now() - 1000).toISOString(), durationHours: 2, ...overrides,
    })
    expect(a.status).toBe('LIVE')
    return { ...prod, id: a.id, auction: a }
  }
  const join = (n, id) => svc.bid.register(U[n], id, { consent: true, ip: `10.0.0.${n.charCodeAt(0)}` })
  const bid = (n, id, amount) => svc.bid.placeBid(U[n], id, { maxAmount: amount, ip: `10.0.0.${n.charCodeAt(0)}`, userAgent: 'vitest' })
  const endNowByClock = async (id) => {
    await q(`UPDATE auctions SET starts_at = NOW() - INTERVAL '3 hours', ends_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [id])
    await svc.settle.closeEndedAuctions()
  }
  const row = async (id) => (await q('SELECT * FROM auctions WHERE id = $1', [id])).rows[0]
  const feeLedger = async (id) => {
    const { rows } = await q(`SELECT entry_type, SUM(amount)::float AS t FROM auction_fee_ledger WHERE auction_id = $1 GROUP BY 1`, [id])
    return Object.fromEntries(rows.map((r) => [r.entry_type, r.t]))
  }

  // ───────────────────────────────────────────────────────────────────────
  it('THE BRIEF: ₹20,000 start, ₹500 fee — D wins at ₹24,000 and pays ₹23,500; losers forfeit ₹1,500 (₹750 vendor / ₹750 platform)', async () => {
    const { id, shopProductId } = await live()
    expect(await stockOf(shopProductId)).toBe(0) // unit held out of normal sale

    for (const n of ['A', 'B', 'C', 'D']) await join(n, id)
    for (const n of ['A', 'B', 'C', 'D']) expect(await balance(n)).toBe(4500) // ₹500 each charged

    await bid('A', id, 20000)
    await bid('B', id, 21000)
    await bid('C', id, 22000)
    await bid('A', id, 23000)
    const last = await bid('D', id, 24000)
    expect(last.you_are_leading).toBe(true)
    expect(last.current_price).toBe(24000)

    await endNowByClock(id)
    const a = await row(id)
    expect(a.status).toBe('AWAITING_PAYMENT')
    expect(String(a.winner_id)).toBe(U.D)
    expect(Number(a.winning_bid)).toBe(24000)
    expect(Number(a.fee_credit)).toBe(500)
    expect(Number(a.amount_due)).toBe(23500)

    // fees are still in escrow until the winner pays
    expect((await q(`SELECT COUNT(*)::int n FROM auction_registrations WHERE auction_id=$1 AND status='ACTIVE'`, [id])).rows[0].n).toBe(4)

    await q('UPDATE wallets SET balance = 30000 WHERE user_id = $1', [U.D])
    const { rows: [addr] } = await q('SELECT id FROM addresses WHERE user_id = $1', [U.D])
    const out = await svc.checkout.checkout(U.D, id, { addressId: addr.id, paymentMethod: 'WALLET' })
    expect(out.paid).toBe(true)
    expect(out.amount_due).toBe(23500)
    expect(await balance('D')).toBe(30000 - 23500)

    const done = await row(id)
    expect(done.status).toBe('SOLD')

    // the order: item at the full winning bid, fee shown as discount
    const { rows: [o] } = await q('SELECT * FROM orders WHERE id = $1', [out.order_id])
    expect(Number(o.subtotal)).toBe(24000)
    expect(Number(o.discount_amount)).toBe(500)
    expect(o.payment_status).toBe('PAID')
    expect(String(o.auction_id)).toBe(id)
    const { rows: [so] } = await q('SELECT * FROM seller_orders WHERE order_id = $1', [out.order_id])
    expect(Number(so.item_subtotal)).toBe(24000)       // vendor is settled on the FULL price
    expect(Number(so.platform_discount)).toBe(0)       // …and is not reimbursed twice
    expect(Number(so.commission_amount)).toBe(2400)    // 10%
    expect(String(so.vendor_id)).toBe(U.vendor.id)

    // fee accounting
    const regs = Object.fromEntries((await q('SELECT r.status, u.name FROM auction_registrations r JOIN users u ON u.id=r.user_id WHERE auction_id=$1', [id])).rows.map((r) => [r.name, r.status]))
    expect(regs).toEqual({ 'Bidder A': 'FORFEITED', 'Bidder B': 'FORFEITED', 'Bidder C': 'FORFEITED', 'Bidder D': 'APPLIED' })
    const led = await feeLedger(id)
    expect(led.FEE_CHARGED).toBe(2000)
    expect(led.FEE_APPLIED_TO_ORDER).toBe(500)
    expect(led.FEE_FORFEIT_VENDOR).toBe(750)
    expect(led.FEE_FORFEIT_PLATFORM).toBe(750)
    expect(led.FEE_REFUNDED).toBeUndefined()
    // conservation: charged = applied + forfeited + refunded
    expect(led.FEE_CHARGED).toBe(led.FEE_APPLIED_TO_ORDER + led.FEE_FORFEIT_VENDOR + led.FEE_FORFEIT_PLATFORM)
    // vendor's share reached the settlement ledger
    const { rows: [sl] } = await q(`SELECT SUM(amount)::float AS t FROM settlement_ledger WHERE vendor_id=$1 AND entry_type='INCENTIVE' AND reason LIKE $2`, [U.vendor.id, '%entry-fee share'])
    expect(sl.t).toBeGreaterThanOrEqual(750)
    // losers' wallets untouched (fee gone), no refund
    for (const n of ['A', 'B', 'C']) expect(await balance(n)).toBe(4500)
    // unit stays sold
    expect(await stockOf((await row(id)).shop_product_id)).toBe(0)
  })

  it('reserve not met → UNSOLD, every fee refunded, stock restored', async () => {
    const { id, shopProductId } = await live({ reservePrice: 30000 })
    await join('A', id); await join('B', id)
    await bid('A', id, 22000)
    await bid('B', id, 23000)
    expect((await svc.bid.getPublic(U.A, id)).reserve_status).toBe('NOT_MET')
    await endNowByClock(id)
    expect((await row(id)).status).toBe('UNSOLD')
    expect(await balance('A')).toBe(5000)
    expect(await balance('B')).toBe(5000)
    expect(await stockOf(shopProductId)).toBe(1)
    const led = await feeLedger(id)
    expect(led.FEE_REFUNDED).toBe(1000)
  })

  it('no bids → UNSOLD and registrants are refunded', async () => {
    const { id } = await live()
    await join('A', id)
    await endNowByClock(id)
    expect((await row(id)).status).toBe('UNSOLD')
    expect(await balance('A')).toBe(5000)
  })

  it('admin cancels a live auction → all fees refunded, stock back', async () => {
    const { id, shopProductId } = await live()
    await join('A', id); await join('B', id)
    await bid('A', id, 20000)
    await svc.admin.cancel(U.admin, id, 'listing error')
    expect((await row(id)).status).toBe('CANCELLED')
    expect(await balance('A')).toBe(5000)
    expect(await balance('B')).toBe(5000)
    expect(await stockOf(shopProductId)).toBe(1)
    await expect(bid('B', id, 25000)).rejects.toMatchObject({ code: 'NOT_LIVE' })
  })

  it('loser_fee_refund_pct=50 → each loser gets ₹250 back, the rest is split', async () => {
    const { id } = await live({ loserFeeRefundPct: 50 }, { vendor: false })
    for (const n of ['A', 'B', 'C']) await join(n, id)
    await bid('A', id, 20000); await bid('B', id, 21000); await bid('C', id, 22000)
    await endNowByClock(id)
    await q('UPDATE wallets SET balance = 30000 WHERE user_id = $1', [U.C])
    const { rows: [addr] } = await q('SELECT id FROM addresses WHERE user_id = $1', [U.C])
    await svc.checkout.checkout(U.C, id, { addressId: addr.id, paymentMethod: 'WALLET' })
    expect(await balance('A')).toBe(4500 + 250)
    expect(await balance('B')).toBe(4500 + 250)
    const led = await feeLedger(id)
    expect(led.FEE_REFUNDED).toBe(500)
    expect(led.FEE_FORFEIT_PLATFORM).toBe(500) // platform-owned: vendor share is 0, platform takes all
    expect(led.FEE_FORFEIT_VENDOR).toBeUndefined()
    expect(led.FEE_CHARGED).toBe(led.FEE_APPLIED_TO_ORDER + led.FEE_REFUNDED + led.FEE_FORFEIT_PLATFORM)
  })

  it('winner never pays → penalty + strike, SECOND CHANCE to the next bidder, who pays', async () => {
    const { id } = await live({}, { vendor: false })
    for (const n of ['A', 'B', 'C']) await join(n, id)
    await bid('B', id, 21000)
    await bid('C', id, 22000)
    await endNowByClock(id)
    expect(String((await row(id)).winner_id)).toBe(U.C)

    await q(`UPDATE auctions SET payment_deadline = NOW() - INTERVAL '1 minute' WHERE id = $1`, [id])
    const sweep = await svc.settle.processPaymentDeadlines()
    expect(sweep.defaulted).toBe(1)

    let a = await row(id)
    expect(a.status).toBe('AWAITING_PAYMENT')
    expect(String(a.winner_id)).toBe(U.B)           // B's own highest bid
    expect(Number(a.winning_bid)).toBe(21000)
    expect(Number(a.amount_due)).toBe(20500)
    expect(a.offer_round).toBe(2)
    expect((await q('SELECT strikes FROM auction_bidder_profiles WHERE user_id=$1', [U.C])).rows[0].strikes).toBe(1)
    expect((await q(`SELECT status FROM auction_registrations WHERE auction_id=$1 AND user_id=$2`, [id, U.C])).rows[0].status).toBe('FORFEITED')

    // the original winner can no longer check out
    const { rows: [addrC] } = await q('SELECT id FROM addresses WHERE user_id = $1', [U.C])
    await expect(svc.checkout.checkout(U.C, id, { addressId: addrC.id, paymentMethod: 'WALLET' })).rejects.toMatchObject({ code: 'NOT_WINNER' })

    await q('UPDATE wallets SET balance = 30000 WHERE user_id = $1', [U.B])
    const { rows: [addrB] } = await q('SELECT id FROM addresses WHERE user_id = $1', [U.B])
    await svc.checkout.checkout(U.B, id, { addressId: addrB.id, paymentMethod: 'WALLET' })
    a = await row(id)
    expect(a.status).toBe('SOLD')

    // running the sweep again must not pay anything out twice
    const before = await feeLedger(id)
    await svc.settle.processPaymentDeadlines()
    expect(await feeLedger(id)).toEqual(before)
    expect(before.FEE_CHARGED).toBe(before.FEE_APPLIED_TO_ORDER + before.FEE_FORFEIT_PLATFORM)
  })

  it('every candidate defaults → DEFAULTED, remaining bidders refunded, stock released', async () => {
    const { id, shopProductId } = await live({}, { vendor: false })
    for (const n of ['A', 'B']) await join(n, id)
    await bid('A', id, 21000)
    await bid('B', id, 22000)
    await endNowByClock(id)
    await q(`UPDATE auctions SET payment_deadline = NOW() - INTERVAL '1 minute' WHERE id = $1`, [id])
    await svc.settle.processPaymentDeadlines() // B defaults → offer to A
    await q(`UPDATE auctions SET payment_deadline = NOW() - INTERVAL '1 minute' WHERE id = $1`, [id])
    await svc.settle.processPaymentDeadlines() // A defaults → none left
    expect((await row(id)).status).toBe('DEFAULTED')
    expect(await stockOf(shopProductId)).toBe(1)
    const led = await feeLedger(id)
    expect(led.FEE_CHARGED).toBe(1000)
    expect(led.FEE_FORFEIT_PLATFORM).toBe(1000) // both penalised
  })

  it('3 strikes → auto-blocked from auctions', async () => {
    await q(`INSERT INTO auction_bidder_profiles (user_id, strikes) VALUES ($1, 2)`, [U.E])
    const { id } = await live({}, { vendor: false })
    await join('E', id)
    await bid('E', id, 20000)
    await endNowByClock(id)
    await q(`UPDATE auctions SET payment_deadline = NOW() - INTERVAL '1 minute' WHERE id = $1`, [id])
    await svc.settle.processPaymentDeadlines()
    const p = (await q('SELECT strikes, is_blocked FROM auction_bidder_profiles WHERE user_id=$1', [U.E])).rows[0]
    expect(p).toEqual({ strikes: 3, is_blocked: true })
    const next = await live({}, { vendor: false })
    await expect(join('E', next.id)).rejects.toMatchObject({ code: 'BIDDER_BLOCKED' })
  })

  it('8 bidders hammering one auction at once: serialised, consistent, no lost updates', async () => {
    const { id } = await live()
    for (const n of U.names) await join(n, id)
    const attempts = U.names.map((n, i) => bid(n, id, 20000 + i * 1000).then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.code })))
    const results = await Promise.all(attempts)
    for (const r of results.filter((x) => !x.ok)) expect(['BID_TOO_LOW']).toContain(r.code)

    const a = await row(id)
    // highest ceiling submitted was H's 27,000 and must be the leader's private max
    expect(Number(a.leader_max)).toBe(27000)
    expect(String(a.leader_id)).toBe(U.H)
    expect(Number(a.current_price)).toBeLessThanOrEqual(27000)
    const { rows } = await q('SELECT seq, amount FROM auction_bids WHERE auction_id = $1 ORDER BY seq', [id])
    expect(rows.map((r) => Number(r.seq))).toEqual(rows.map((_, i) => i + 1))   // gap-free, no dupes
    expect(Number(a.bid_seq)).toBe(rows.length)
    expect(a.bid_count).toBe(rows.length)
    const prices = rows.map((r) => Number(r.amount))
    for (let i = 1; i < prices.length; i++) expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1])
  })

  it('proxy bidding: a higher hidden max wins at one step above the runner-up; max is never exposed', async () => {
    const { id } = await live({ reservePrice: 21000 })
    await join('A', id); await join('B', id)
    await bid('A', id, 40000)               // A's private ceiling
    const r = await bid('B', id, 25000)     // B tries, A out-proxies
    expect(r.you_are_leading).toBe(false)
    const pub = await svc.bid.getPublic(U.B, id)
    expect(pub.current_price).toBe(26000)   // 25,000 + one ₹1,000 step
    expect(pub.leader_alias).toBe('Bidder #1')
    const blob = JSON.stringify(pub) + JSON.stringify(await svc.bid.listBids(U.B, id))
    expect(blob).not.toContain('40000')
    expect(blob).not.toContain('leader_max')
    expect(blob).not.toContain('reserve_price')
    expect(pub.reserve_status).toBe('MET')
    // A (the leader) can see their own ceiling, B cannot see A's
    expect((await svc.bid.getPublic(U.A, id)).my.my_max).toBe(40000)
  })

  it('anti-sniping: a bid in the final minute extends the auction', async () => {
    const { id } = await live()
    await join('A', id)
    await q(`UPDATE auctions SET ends_at = NOW() + INTERVAL '30 seconds' WHERE id = $1`, [id])
    const r = await bid('A', id, 20000)
    expect(r.extended).toBe(true)
    const a = await row(id)
    expect(new Date(a.ends_at).getTime()).toBeGreaterThan(Date.now() + 90_000)
    expect(a.extension_count).toBe(1)
  })

  it('a bid that arrives after the end time is refused', async () => {
    const { id } = await live()
    await join('A', id)
    await q(`UPDATE auctions SET starts_at = NOW() - INTERVAL '3 hours', ends_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [id])
    await expect(bid('A', id, 20000)).rejects.toMatchObject({ code: 'BIDDING_CLOSED' })
  })

  it('buy-now closes the auction immediately; refused once bidding has started', async () => {
    const a1 = await live({ buyNowPrice: 30000 })
    await join('A', a1.id)
    const res = await svc.bid.buyNow(U.A, a1.id, {})
    expect(res.final_price).toBe(30000)
    expect(res.amount_due).toBe(29500)
    expect((await row(a1.id)).status).toBe('AWAITING_PAYMENT')

    const a2 = await live({ buyNowPrice: 30000 })
    await join('A', a2.id); await join('B', a2.id)
    await bid('A', a2.id, 20000)
    await expect(svc.bid.buyNow(U.B, a2.id, {})).rejects.toMatchObject({ code: 'BUY_NOW_UNAVAILABLE' })
  })

  it('guards: unregistered, low wallet, double-join, no consent, staff, vendor staff, own bid', async () => {
    const { id } = await live()
    await expect(bid('A', id, 20000)).rejects.toMatchObject({ code: 'NOT_REGISTERED' })
    await expect(svc.bid.register(U.A, id, { consent: false })).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' })

    await q('UPDATE wallets SET balance = 100 WHERE user_id = $1', [U.A])
    await expect(join('A', id)).rejects.toMatchObject({ code: 'INSUFFICIENT_WALLET', details: { required: 500, shortfall: 400 } })
    expect(await balance('A')).toBe(100) // nothing charged on failure
    expect((await row(id)).registration_count).toBe(0)

    await join('B', id)
    await expect(join('B', id)).rejects.toMatchObject({ code: 'ALREADY_REGISTERED' })
    expect(await balance('B')).toBe(4500) // charged exactly once

    await expect(svc.bid.register(U.adminUser.id, id, { consent: true })).rejects.toMatchObject({ code: 'STAFF_CANNOT_BID' })
    await expect(svc.bid.register(U.staff, id, { consent: true })).rejects.toMatchObject({ code: 'OWN_AUCTION' })

    await join('C', id)
    await bid('C', id, 21000)
    await expect(bid('B', id, 20999)).rejects.toMatchObject({ code: 'BID_TOO_LOW', details: { minimum: 21000 } })
    await expect(bid('C', id, 21000)).rejects.toMatchObject({ code: 'MAX_NOT_HIGHER' })
  })

  it('geo-block and kill-switch', async () => {
    const { id } = await live()
    await q(`UPDATE auction_settings SET blocked_states = '{west bengal}' WHERE id = TRUE`)
    svc.shared.invalidateSettingsCache()
    await expect(join('A', id)).rejects.toMatchObject({ code: 'REGION_RESTRICTED' })
    await q(`UPDATE auction_settings SET blocked_states = '{}', enabled = FALSE WHERE id = TRUE`)
    svc.shared.invalidateSettingsCache()
    await expect(join('A', id)).rejects.toMatchObject({ code: 'AUCTIONS_DISABLED' })
  })

  it('validation: fee cap (% of start), reserve < start, short duration, one auction per product', async () => {
    const prod = await makeProduct()
    const base = { productId: prod.productId, startPrice: 20000, registrationFee: 500, durationHours: 2 }
    await expect(svc.admin.createAuction(U.admin, { ...base, registrationFee: 2500 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.admin.createAuction(U.admin, { ...base, reservePrice: 19000 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(svc.admin.createAuction(U.admin, { ...base, durationHours: 0.1 })).rejects.toMatchObject({ code: 'VALIDATION' })
    const ok = await svc.admin.createAuction(U.admin, { ...base, startsAt: new Date(Date.now() + 3600_000).toISOString() })
    expect(ok.status).toBe('SCHEDULED')
    await expect(svc.admin.createAuction(U.admin, base)).rejects.toMatchObject({ code: 'PRODUCT_ALREADY_IN_AUCTION' })
  })

  it('vendor flow: own product only, goes to approval, admin approves → scheduled; foreign auctions are 404', async () => {
    const mine = await makeProduct()
    const other = await makeProduct()
    await q('UPDATE products SET owner_vendor_id = $2 WHERE id = $1', [other.productId, U.vendor2.id])

    await expect(svc.admin.createAuction(U.vendorActor, { productId: other.productId, startPrice: 20000, registrationFee: 500, durationHours: 2 }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })

    const a = await svc.admin.createAuction(U.vendorActor, {
      productId: mine.productId, startPrice: 20000, registrationFee: 500, durationHours: 2,
      startsAt: new Date(Date.now() + 3600_000).toISOString(),
    })
    expect(a.status).toBe('PENDING_APPROVAL')
    expect(await stockOf(mine.shopProductId)).toBe(1) // not reserved until approved

    await expect(svc.admin.approveAuction(U.vendorActor, a.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(svc.admin.getManage(U.vendor2Actor, a.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const approved = await svc.admin.approveAuction(U.admin, a.id)
    expect(approved.status).toBe('SCHEDULED')
    expect(await stockOf(mine.shopProductId)).toBe(0)

    // vendor view hides identities and private numbers
    const view = await svc.admin.getManage(U.vendorActor, a.id)
    expect(view.auction.leader_max).toBeUndefined()
    expect(view.flags).toEqual([])

    // vendor may cancel before it starts
    await svc.admin.cancel(U.vendorActor, a.id, 'changed my mind')
    expect((await row(a.id)).status).toBe('CANCELLED')
    expect(await stockOf(mine.shopProductId)).toBe(1)
  })

  it('pre-registration on a scheduled auction; pause freezes bidding and resume compensates the clock', async () => {
    const prod = await makeProduct({ vendor: false })
    const a = await svc.admin.createAuction(U.admin, {
      productId: prod.productId, startPrice: 20000, registrationFee: 500, bidIncrement: 1000,
      startsAt: new Date(Date.now() + 3600_000).toISOString(), durationHours: 2,
    })
    await join('A', a.id)                                   // allowed while SCHEDULED
    await expect(bid('A', a.id, 20000)).rejects.toMatchObject({ code: 'NOT_LIVE' })
    await svc.admin.startNow(U.admin, a.id)
    expect((await row(a.id)).status).toBe('LIVE')

    await svc.admin.pauseAuction(U.admin, a.id)
    await expect(bid('A', a.id, 20000)).rejects.toMatchObject({ code: 'NOT_LIVE' })
    const before = new Date((await row(a.id)).ends_at).getTime()
    await q(`UPDATE auctions SET paused_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [a.id])
    await svc.admin.resumeAuction(U.admin, a.id)
    const after = new Date((await row(a.id)).ends_at).getTime()
    expect(after - before).toBeGreaterThanOrEqual(10 * 60_000 - 2000)
    expect((await bid('A', a.id, 20000)).accepted).toBe(true)
  })

  it('online checkout: order stays pending until paid; an expired order frees the winner to retry', async () => {
    const { id } = await live({}, { vendor: false })
    await join('A', id)
    await bid('A', id, 20000)
    await endNowByClock(id)
    const { rows: [addr] } = await q('SELECT id FROM addresses WHERE user_id = $1', [U.A])
    const out = await svc.checkout.checkout(U.A, id, { addressId: addr.id, paymentMethod: 'ONLINE' })
    expect(out.paid).toBe(false)
    expect(out.payment_required).toBe(true)
    expect((await row(id)).status).toBe('AWAITING_PAYMENT')
    await expect(svc.checkout.checkout(U.A, id, { addressId: addr.id, paymentMethod: 'ONLINE' })).rejects.toMatchObject({ code: 'ORDER_EXISTS' })

    // payment arrives (what the Razorpay flow does)
    await q(`UPDATE orders SET payment_status = 'PAID' WHERE id = $1`, [out.order_id])
    const sweep = await svc.settle.processPaymentDeadlines()
    expect(sweep.sold).toBe(1)
    expect((await row(id)).status).toBe('SOLD')
  })

  it('stats and risk queries run on real data', async () => {
    const s = await svc.admin.stats(U.admin)
    expect(s).toHaveProperty('live')
    expect(Array.isArray(s.revenue_series)).toBe(true)
    const r = await svc.admin.riskOverview()
    expect(r).toHaveProperty('shared_ip')
    const v = await svc.admin.stats(U.vendorActor)
    expect(v).toHaveProperty('gmv_30d')
    const list = await svc.admin.listManage(U.vendorActor, {})
    for (const a of list.data) expect(String(a.vendor_id)).toBe(U.vendor.id)
  })
})
