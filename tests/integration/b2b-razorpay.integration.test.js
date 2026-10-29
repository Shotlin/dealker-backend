/**
 * Wholesale (B2B) Razorpay: one Checkout for several orders, verified before escrow, refunded to the card on cancel (Razorpay is stubbed).
 *
 *   B2B_RZP_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=ws_scratch DB_USER=… DB_PASSWORD=… REDIS_PORT=6380 \
 *   JWT_ACCESS_SECRET=… JWT_REFRESH_SECRET=… COOKIE_SECRET=… SETTINGS_ENCRYPTION_KEY=… \
 *   npx vitest run tests/integration/b2b-razorpay.integration.test.js
 * The database must be fully migrated (incl. 222). Do not set LOG_LEVEL=silent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'

const d = process.env.B2B_RZP_TEST_DB ? describe : describe.skip

d('wholesale Razorpay checkout (real database, stubbed Razorpay)', () => {
  let app, q, listings, rzpMod, b2b
  const V = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const tag = `rz${rand()}`
  const RUN = crypto.randomBytes(4).toString('hex')
  const R = { orders: new Map(), payments: new Map(), refunds: [], seq: 0, failOrders: false, failRefund: false }
  const sign = (o, p) => crypto.createHmac('sha256', 'stub_secret_value').update(`${o}|${p}`).digest('hex')
  const call = async (v, method, url, payload) => {
    const res = await app.inject({ method, url: `/api/v1/vendor/b2b${url}`, headers: { authorization: `Bearer ${v.token}` }, payload })
    return { status: res.statusCode, body: res.json() }
  }
  const mkVendor = async (name) => {
    const n = rand()
    const { rows } = await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`, [name, `rz-${n}`, `rz${n}@t.io`, `7${n}`])
    const u = (await q(`INSERT INTO users (phone, name, role) VALUES ($1,$2,'CUSTOMER') RETURNING id, session_version`, [`9${rand()}`, `${name} user`])).rows[0]
    await q(`INSERT INTO vendor_users (vendor_id, user_id, role) VALUES ($1,$2,'VENDOR_OWNER')`, [rows[0].id, u.id])
    await q(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, commission_rate, is_active)
             VALUES ($1,$2,$3,'12 MG Road','Delhi','Delhi','110001',28.6,77.2,$4,5,true)`, [`${name} Shop`, `rzs-${n}`, `R${n.slice(0, 6)}`, rows[0].id])
    return { id: rows[0].id, userId: u.id, name, token: jwt.sign({ id: u.id, role: 'CUSTOMER', session_version: u.session_version }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) }
  }
  const mkListing = async (v, name, price) => {
    const cat = (await q(`SELECT id FROM categories LIMIT 1`)).rows[0] ?? (await q(`INSERT INTO categories (name, slug) VALUES ($1,$2) RETURNING id`, [`C${rand()}`, `c-${rand()}`])).rows[0]
    const l = await listings.create({
      name: `${tag} ${name}`, brand: tag, categoryId: cat.id, condition: 'NEW', stock: 50, specifications: {},
      images: ['https://x.test/1.jpg', 'https://x.test/2.jpg', 'https://x.test/3.jpg'], sellB2c: false, sellB2b: true, wholesalePrice: price, moq: 2,
    }, { vendorId: v.id, actorId: v.userId })
    await q(`UPDATE shop_products SET approval_status='APPROVED', listing_status='ACTIVE' WHERE id=$1`, [l.id])
    return l
  }
  /** Buy `qty` of a listing as the buyer → an unpaid order on its own requirement. */
  const buy = async (listing, qty = 2) => {
    const r = await call(V.buyer, 'POST', `/wholesale/${listing.id}/order`, { quantity: qty })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    return r.body.data
  }
  const pay = (orderId, { status = 'captured', amount, method = 'upi' } = {}) => {
    const o = R.orders.get(orderId)
    const p = { id: `pay_${RUN}_${++R.seq}`, order_id: orderId, amount: amount ?? o.amount, status, method }
    R.payments.set(p.id, p)
    return p
  }
  const startCheckout = (ids, who = V.buyer) => call(who, 'POST', '/pay/razorpay/order', { requirementIds: ids })
  const verify = (order, p, who = V.buyer, sig) => call(who, 'POST', '/pay/razorpay/verify', { razorpayOrderId: order, razorpayPaymentId: p.id, razorpaySignature: sig ?? sign(order, p.id) })
  const orderRow = async (id) => (await q(`SELECT status, payment_status, payment_method FROM b2b_orders WHERE id=$1`, [id])).rows[0]

  beforeAll(async () => {
    Object.assign(process.env, { JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000',
      RAZORPAY_KEY_ID: 'rzp_test_stub', RAZORPAY_KEY_SECRET: 'stub_secret_value', RAZORPAY_WEBHOOK_SECRET: 'whsec_stub_value' })
    q = (await import('../../src/config/database.js')).query
    listings = (await import('../../src/modules/listings/listings.service.js')).listingsService
    rzpMod = await import('../../src/config/razorpay.js')
    b2b = (await import('../../src/modules/b2b/b2b.service.js')).b2b
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
    const rz = rzpMod.razorpay
    rz.orders.create = async (b) => { if (R.failOrders) throw new Error('down'); const id = `order_${RUN}_${++R.seq}`; R.orders.set(id, { ...b, id }); return { id } }
    rz.orders.fetchPayments = async (id) => ({ items: [...R.payments.values()].filter((p) => p.order_id === id) })
    rz.payments.fetch = async (id) => { const p = R.payments.get(id); if (!p) throw new Error('nf'); return p }
    rz.payments.capture = async (id) => { const p = R.payments.get(id); p.status = 'captured'; return p }
    rz.payments.fetchMultipleRefund = async (id) => ({ items: R.refunds.filter((x) => x.payment_id === id) })
    rz.payments.refund = async (id, b) => { if (R.failRefund) throw new Error('down'); const r = { id: `rfnd_${RUN}_${++R.seq}`, payment_id: id, amount: b.amount, notes: b.notes }; R.refunds.push(r); return r }
    V.buyer = await mkVendor('Rzp Buyer')
    V.s1 = await mkVendor('Rzp Seller One')
    V.s2 = await mkVendor('Rzp Seller Two')
    V.l1 = await mkListing(V.s1, 'Phone A', 10000)
    V.l2 = await mkListing(V.s2, 'Phone B', 25000)
  }, 90000)
  afterAll(async () => { await app?.close() })

  it('one Checkout pays two orders from two sellers and holds both in escrow', async () => {
    const a = await buy(V.l1, 2) // ₹20,000
    const b = await buy(V.l2, 2) // ₹50,000
    const c = await startCheckout([a.requirement_id, b.requirement_id])
    expect(c.status, JSON.stringify(c.body)).toBe(200)
    expect(c.body.data).toMatchObject({ keyId: 'rzp_test_stub', amount: 7000000, amountRupees: 70000, currency: 'INR' })
    const p = pay(c.body.data.orderId)
    const v = await verify(c.body.data.orderId, p)
    expect(v.status, JSON.stringify(v.body)).toBe(200)
    expect(v.body.data.status).toBe('PAID')
    expect(await orderRow(a.order_id)).toMatchObject({ status: 'PAID', payment_status: 'ESCROW_HELD', payment_method: 'RAZORPAY' })
    expect(await orderRow(b.order_id)).toMatchObject({ status: 'PAID', payment_status: 'ESCROW_HELD', payment_method: 'RAZORPAY' })
    const pays = (await q(`SELECT amount, method, reference FROM b2b_payments WHERE requirement_id = ANY($1) ORDER BY amount`, [[a.requirement_id, b.requirement_id]])).rows
    expect(pays.map((x) => [Number(x.amount), x.method, x.reference])).toEqual([[20000, 'RAZORPAY', p.id], [50000, 'RAZORPAY', p.id]])
    // the wallet was never touched
    expect(Number((await q(`SELECT COALESCE(SUM(amount),0) b FROM settlement_ledger WHERE vendor_id=$1`, [V.buyer.id])).rows[0].b)).toBe(0)
  })

  it('verifying twice (or the webhook after the app) never double-pays', async () => {
    const a = await buy(V.l1)
    const c = (await startCheckout([a.requirement_id])).body.data
    const p = pay(c.orderId)
    expect((await verify(c.orderId, p)).status).toBe(200)
    expect((await verify(c.orderId, p)).status).toBe(200)
    expect(await b2b.completeRazorpayByOrder(c.orderId, p.id)).toBe(true)
    expect(await b2b.completeRazorpayByOrder('order_unknown', 'pay_x')).toBe(false) // not ours → wallet top-up path
    expect((await q(`SELECT 1 FROM b2b_payments WHERE requirement_id=$1`, [a.requirement_id])).rows).toHaveLength(1)
  })

  it('resumes the same Checkout for the same orders and amount', async () => {
    const a = await buy(V.l1)
    const c1 = (await startCheckout([a.requirement_id])).body.data
    const c2 = (await startCheckout([a.requirement_id])).body.data
    expect(c2.orderId).toBe(c1.orderId)
  })

  it('rejects a bad signature, a payment for another order, a short amount and a stranger', async () => {
    const a = await buy(V.l1)
    const c = (await startCheckout([a.requirement_id])).body.data
    const p = pay(c.orderId)
    expect((await verify(c.orderId, p, V.buyer, 'f'.repeat(64))).body.code).toBe('PAYMENT_VERIFICATION_FAILED')
    expect((await verify(c.orderId, p, V.s1)).status).toBe(404) // someone else's checkout
    const short = pay(c.orderId, { amount: 100 })
    expect((await verify(c.orderId, short)).body.code).toBe('AMOUNT_MISMATCH')
    R.orders.set('order_other', { id: 'order_other', amount: 2000000 })
    const foreign = pay('order_other')
    expect((await verify(c.orderId, foreign)).body.code).toBe('PAYMENT_VERIFICATION_FAILED')
    const failed = pay(c.orderId, { status: 'failed' })
    expect((await verify(c.orderId, failed)).body.code).toBe('PAYMENT_NOT_COMPLETE')
    expect((await orderRow(a.order_id)).status).toBe('PENDING_PAYMENT')
  })

  it('only the buyer can start a Checkout, and only for unpaid orders', async () => {
    const a = await buy(V.l1)
    expect((await startCheckout([a.requirement_id], V.s1)).status).toBe(403)
    const c = (await startCheckout([a.requirement_id])).body.data
    await verify(c.orderId, pay(c.orderId))
    expect((await startCheckout([a.requirement_id])).body.code).toBe('NOTHING_TO_PAY')
    expect((await startCheckout([])).status).toBe(400)
    const b = await buy(V.l1)
    R.failOrders = true
    try { expect((await startCheckout([b.requirement_id])).body.code).toBe('PAYMENTS_UNAVAILABLE') } finally { R.failOrders = false }
  })

  it('sync settles a payment whose callback never reached the app', async () => {
    const a = await buy(V.l1)
    const c = (await startCheckout([a.requirement_id])).body.data
    expect((await call(V.buyer, 'POST', '/pay/razorpay/sync', { razorpayOrderId: c.orderId })).body.code).toBe('PAYMENT_NOT_COMPLETE')
    pay(c.orderId)
    const s = await call(V.buyer, 'POST', '/pay/razorpay/sync', { razorpayOrderId: c.orderId })
    expect(s.status, JSON.stringify(s.body)).toBe(200)
    expect((await orderRow(a.order_id)).status).toBe('PAID')
  })

  it('a seller cancelling a Razorpay-paid order refunds the card for exactly that order', async () => {
    const a = await buy(V.l1, 3) // ₹30,000
    const c = (await startCheckout([a.requirement_id])).body.data
    const p = pay(c.orderId)
    await verify(c.orderId, p)
    const x = await call(V.s1, 'POST', `/orders/${a.order_id}/cancel`, { reason: 'Out of stock' })
    expect(x.status, JSON.stringify(x.body)).toBe(200)
    const refunds = R.refunds.filter((r) => r.payment_id === p.id)
    expect(refunds).toHaveLength(1)
    expect(refunds[0].amount).toBe(3000000)
    expect(await orderRow(a.order_id)).toMatchObject({ status: 'CANCELLED', payment_status: 'REFUNDED' })
    expect(Number((await q(`SELECT COALESCE(SUM(amount),0) b FROM settlement_ledger WHERE vendor_id=$1`, [V.buyer.id])).rows[0].b)).toBe(0) // not credited to the wallet as well
  })

  it('if Razorpay cannot send the refund, the cancel does not happen (nothing half-done)', async () => {
    const a = await buy(V.l1)
    const c = (await startCheckout([a.requirement_id])).body.data
    await verify(c.orderId, pay(c.orderId))
    R.failRefund = true
    let x
    try { x = await call(V.s1, 'POST', `/orders/${a.order_id}/cancel`, { reason: 'Out of stock' }) } finally { R.failRefund = false }
    expect(x.body.code).toBe('REFUND_FAILED')
    expect((await orderRow(a.order_id)).status).toBe('PAID')
    expect((await call(V.s1, 'POST', `/orders/${a.order_id}/cancel`, { reason: 'Out of stock' })).status).toBe(200) // retry works
  })

  it('when the orders changed while the buyer was paying, the money goes straight back', async () => {
    const a = await buy(V.l1)
    const c = (await startCheckout([a.requirement_id])).body.data
    await q(`UPDATE b2b_orders SET status='CANCELLED' WHERE id=$1`, [a.order_id]) // e.g. cancelled by an admin meanwhile
    const p = pay(c.orderId)
    const v = await verify(c.orderId, p)
    expect(v.body.code).toBe('ORDERS_CHANGED')
    expect(R.refunds.filter((r) => r.payment_id === p.id)).toHaveLength(1)
    expect((await q(`SELECT status FROM b2b_razorpay_orders WHERE razorpay_order_id=$1`, [c.orderId])).rows[0].status).toBe('FAILED')
  })
})
