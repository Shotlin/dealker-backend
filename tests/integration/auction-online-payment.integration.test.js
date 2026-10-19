/**
 * Razorpay TEST-mode flows around auctions — real Postgres + the real Razorpay TEST API.
 *
 *   RZP_TEST_KEY_ID=rzp_test_… RZP_TEST_KEY_SECRET=… B2BAUC_TEST_DB=1 REDIS_PORT=6380 REDIS_DB=15 \
 *   DB_HOST=localhost DB_PORT=5434 DB_NAME=… DB_USER=… DB_PASSWORD=… \
 *   npx vitest run tests/integration/auction-online-payment.integration.test.js
 *
 * Orders are created on Razorpay for real (test account, no money). A "payment" cannot be completed without
 * the hosted checkout UI, so the callback is signed exactly like Razorpay signs it (HMAC with the key secret /
 * webhook secret) — that is what the server verifies.
 */
import crypto from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const keyId = process.env.RZP_TEST_KEY_ID
const keySecret = process.env.RZP_TEST_KEY_SECRET
const d = process.env.B2BAUC_TEST_DB && keyId && keySecret ? describe : describe.skip

d('auction online payments with Razorpay TEST keys (real database)', () => {
  let q, pool, svc, redis
  const U = {}
  const WEBHOOK_SECRET = 'whsec_' + crypto.randomBytes(8).toString('hex')
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const one = async (sql, p) => (await q(sql, p)).rows[0]
  const bal = async (uid) => Number((await one('SELECT balance FROM wallets WHERE user_id = $1', [uid])).balance)
  const sign = (orderId, paymentId) => crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex')

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000',
      RAZORPAY_KEY_ID: keyId, RAZORPAY_KEY_SECRET: keySecret, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    })
    const db = await import('../../src/config/database.js')
    q = db.query; pool = db.pool
    await (await import('../../src/config/razorpay.js')).refreshRazorpayClient()
    svc = {
      admin: await import('../../src/modules/auctions/auction-admin.service.js'),
      bid: await import('../../src/modules/auctions/auction-bidding.service.js'),
      settle: await import('../../src/modules/auctions/auction-settlement.service.js'),
      checkout: await import('../../src/modules/auctions/auction-checkout.service.js'),
      shared: await import('../../src/modules/auctions/auction.shared.js'),
      payments: new (await import('../../src/modules/payments/payments.service.js')).PaymentsService(new (await import('../../src/modules/payments/payments.repository.js')).PaymentsRepository()),
      wallet: new (await import('../../src/modules/wallet/wallet.service.js')).WalletService(new (await import('../../src/modules/wallet/wallet.repository.js')).WalletRepository()),
    }
    redis = (await import('../../src/config/redis.js')).redis

    U.adminUser = await one(`INSERT INTO users (phone, name, role) VALUES ($1,'Admin','ADMIN') RETURNING id`, ['9' + rand()])
    U.admin = { kind: 'ADMIN', userId: U.adminUser.id, vendorId: null }
    U.vendor = await one(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ('RZP Seller',$1,$2,$3,'ACTIVE') RETURNING id`, ['rz-' + rand(), `r${rand()}@t.io`, '64' + rand()])
    U.shop = await one(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
      VALUES ('RZP Shop',$1,$2,'1 St','Kolkata','West Bengal','700001',22.5,88.3,$3,10,true) RETURNING id`, ['rs-' + rand(), 'R' + rand().slice(0, 6), U.vendor.id])
    const mk = async (name) => {
      const u = await one(`INSERT INTO users (phone, name, role) VALUES ($1,$2,'CUSTOMER') RETURNING id`, ['7' + rand(), name])
      await q(`INSERT INTO addresses (user_id, address_line1, city, state, pincode, is_default) VALUES ($1,'1 Road','Kolkata','West Bengal','700001',true)`, [u.id])
      await q(`INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`, [u.id])
      return u.id
    }
    U.win = await mk('Online Winner'); U.win2 = await mk('Webhook Winner'); U.lose = await mk('Online Loser')
  })

  afterAll(async () => { await redis?.quit().catch(() => {}); await pool?.end().catch(() => {}) })

  beforeEach(async () => {
    await q('DELETE FROM auctions'); await redis.flushdb()
    await q(`UPDATE auction_settings SET enabled = TRUE, loser_fee_refund_pct = 0, vendor_fee_share_pct = 50, vendor_auctions_require_approval = FALSE,
             bid_rate_limit_per_minute = 1000, blocked_states = '{}' WHERE id = TRUE`)
    svc.shared.invalidateSettingsCache()
  })

  const lot = async () => {
    const { rows: [p] } = await q(`INSERT INTO products (name, slug, price, owner_type, owner_vendor_id, is_active) VALUES ('RZP Phone',$1,20000,'VENDOR',$2,true) RETURNING id`, ['rp-' + rand(), U.vendor.id])
    await q(`INSERT INTO shop_products (shop_id, product_id, price, stock_quantity, is_available) VALUES ($1,$2,20000,1,true)`, [U.shop.id, p.id])
    return svc.admin.createAuction(U.admin, { productId: p.id, startPrice: 20000, registrationFee: 500, bidIncrement: 1000, startsAt: new Date(Date.now() - 1000).toISOString(), durationHours: 2 })
  }
  const join = (uid, id) => svc.bid.register(uid, id, { consent: true, ip: '10.0.0.1' })
  const bid = (uid, id, amount) => svc.bid.placeBid(uid, id, { maxAmount: amount, ip: '10.0.0.1', userAgent: 'vitest' })
  const finish = async (id) => { await q(`UPDATE auctions SET starts_at = NOW() - INTERVAL '3 hours', ends_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [id]); await svc.settle.closeEndedAuctions() }
  const addr = async (uid) => (await one('SELECT id FROM addresses WHERE user_id = $1', [uid])).id

  async function topUp(uid, amount) {
    const t = await svc.wallet.createTopUp(uid, amount)
    expect(t, JSON.stringify(t)).toMatchObject({ success: true })
    expect(t.data.razorpayOrderId).toMatch(/^order_/)                     // a real order exists on Razorpay
    expect(t.data.keyId).toBe(keyId)
    const paymentId = 'pay_' + crypto.randomBytes(7).toString('hex')
    // a forged callback never credits (it burns its own top-up order, so use a throwaway one)
    const forged = await svc.wallet.createTopUp(uid, 10)
    const b0 = await bal(uid)
    expect((await svc.wallet.verifyTopUp(uid, { orderId: forged.data.razorpayOrderId, paymentId, signature: 'bad' })).success).toBe(false)
    expect(await bal(uid)).toBe(b0)
    const before = await bal(uid)
    const ok = await svc.wallet.verifyTopUp(uid, { orderId: t.data.razorpayOrderId, paymentId, signature: sign(t.data.razorpayOrderId, paymentId) })
    expect(ok.success, JSON.stringify(ok)).toBe(true)
    expect(await bal(uid)).toBe(before + amount)
    const again = await svc.wallet.verifyTopUp(uid, { orderId: t.data.razorpayOrderId, paymentId, signature: sign(t.data.razorpayOrderId, paymentId) })
    expect(await bal(uid)).toBe(before + amount)                          // replay never double-credits
    return again
  }

  const webhook = (event, body) => {
    const raw = JSON.stringify(body)
    const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')
    return svc.payments.handleWebhook(body, sig, raw, 'evt_' + crypto.randomBytes(6).toString('hex'))
  }

  it('wallet top-up through Razorpay funds the ₹500 registration fee; forged callbacks and replays are harmless', async () => {
    await topUp(U.win, 600)
    const a = await lot()
    await join(U.win, a.id)
    expect(await bal(U.win)).toBe(100)                                    // ₹600 − ₹500 fee
  })

  it('winner pays ONLINE: Razorpay order → signed callback → order PAID → auction SOLD; fee credited', async () => {
    await topUp(U.win, 500); await topUp(U.lose, 500)
    const a = await lot()
    await join(U.lose, a.id); await join(U.win, a.id)
    await bid(U.lose, a.id, 20000); await bid(U.win, a.id, 22000)
    await finish(a.id)
    const won = await one('SELECT status, winner_id, amount_due FROM auctions WHERE id = $1', [a.id])
    expect(won).toMatchObject({ status: 'AWAITING_PAYMENT', winner_id: U.win })

    const co = await svc.checkout.checkout(U.win, a.id, { addressId: await addr(U.win), paymentMethod: 'ONLINE' })
    expect(co).toMatchObject({ paid: false, payment_required: true })
    const created = await svc.payments.createPaymentOrder(U.win, co.order_id)
    expect(created, JSON.stringify(created)).toMatchObject({ success: true })
    expect(created.data.amount).toBe(Number(won.amount_due))              // Razorpay is asked for price − fee, nothing else
    expect(created.data.razorpayOrderId).toMatch(/^order_/)

    const paymentId = 'pay_' + crypto.randomBytes(7).toString('hex')
    const ok = await svc.payments.verifyPayment(U.win, { razorpayOrderId: created.data.razorpayOrderId, razorpayPaymentId: paymentId, razorpaySignature: sign(created.data.razorpayOrderId, paymentId) })
    expect(ok.success, JSON.stringify(ok)).toBe(true)
    expect((await one('SELECT payment_status FROM orders WHERE id = $1', [co.order_id])).payment_status).toBe('PAID')

    const sweep = await svc.settle.processPaymentDeadlines()              // the worker tick that closes paid auctions
    expect(sweep.sold).toBe(1)
    expect((await one('SELECT status FROM auctions WHERE id = $1', [a.id])).status).toBe('SOLD')
    const regs = (await q(`SELECT status FROM auction_registrations WHERE auction_id = $1`, [a.id])).rows.map((r) => r.status).sort()
    expect(regs).toEqual(['APPLIED', 'FORFEITED'])
  })

  it('a failed/forged online payment never marks the order paid and never costs the winner the auction', async () => {
    await topUp(U.win2, 500)
    const a = await lot()
    await join(U.win2, a.id); await bid(U.win2, a.id, 20000); await finish(a.id)
    const co = await svc.checkout.checkout(U.win2, a.id, { addressId: await addr(U.win2), paymentMethod: 'ONLINE' })
    const created = await svc.payments.createPaymentOrder(U.win2, co.order_id)
    const forged = await svc.payments.verifyPayment(U.win2, { razorpayOrderId: created.data.razorpayOrderId, razorpayPaymentId: 'pay_forged', razorpaySignature: 'deadbeef' })
    expect(forged.success).toBe(false)
    expect((await one('SELECT payment_status FROM orders WHERE id = $1', [co.order_id])).payment_status).not.toBe('PAID')
    expect((await svc.settle.processPaymentDeadlines()).sold).toBe(0)
    // the failed attempt must not cost the winner the auction: the unit stays held and they can pay again
    const after = await one('SELECT status, order_id FROM auctions WHERE id = $1', [a.id])
    expect(after).toMatchObject({ status: 'AWAITING_PAYMENT', order_id: null })
    const co2 = await svc.checkout.checkout(U.win2, a.id, { addressId: await addr(U.win2), paymentMethod: 'ONLINE' })
    const created2 = await svc.payments.createPaymentOrder(U.win2, co2.order_id)
    const pid = 'pay_' + crypto.randomBytes(7).toString('hex')
    expect((await svc.payments.verifyPayment(U.win2, { razorpayOrderId: created2.data.razorpayOrderId, razorpayPaymentId: pid, razorpaySignature: sign(created2.data.razorpayOrderId, pid) })).success).toBe(true)
    expect((await svc.settle.processPaymentDeadlines()).sold).toBe(1)
    expect((await one('SELECT status FROM auctions WHERE id = $1', [a.id])).status).toBe('SOLD')
  })

  it('webhook payment.captured finalises an online auction payment; bad signature and duplicate delivery are ignored', async () => {
    await topUp(U.win2, 500)
    const a = await lot()
    await join(U.win2, a.id); await bid(U.win2, a.id, 20000); await finish(a.id)
    const co = await svc.checkout.checkout(U.win2, a.id, { addressId: await addr(U.win2), paymentMethod: 'ONLINE' })
    const created = await svc.payments.createPaymentOrder(U.win2, co.order_id)
    const rzpOrder = created.data.razorpayOrderId
    const body = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_' + crypto.randomBytes(7).toString('hex'), order_id: rzpOrder, method: 'card' } } } }

    const bad = await svc.payments.handleWebhook(body, 'f'.repeat(64), JSON.stringify(body), 'evt_bad_' + crypto.randomBytes(4).toString('hex'))
    expect(bad.success).toBe(false)
    expect((await one('SELECT payment_status FROM orders WHERE id = $1', [co.order_id])).payment_status).not.toBe('PAID')

    const EVT = 'evt_' + crypto.randomBytes(6).toString('hex')
    const raw = JSON.stringify(body)
    const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')
    await svc.payments.handleWebhook(body, sig, raw, EVT)
    expect((await one('SELECT payment_status FROM orders WHERE id = $1', [co.order_id])).payment_status).toBe('PAID')
    const dup = await svc.payments.handleWebhook(body, sig, raw, EVT)
    expect(dup).toMatchObject({ success: true, duplicate: true })
    expect((await svc.settle.processPaymentDeadlines()).sold).toBe(1)
  })
})
