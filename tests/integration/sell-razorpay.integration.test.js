/**
 * Sell-your-phone Razorpay: buyer funding, automatic refunds, RazorpayX payouts (Razorpay is stubbed).
 *   customer verifies IMEI → lists → vendors offer → customer accepts → buyer pays (held) → pickup → inspection → payout.
 *
 *   SELL_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=sell_journey_test DB_USER=dealker_user DB_PASSWORD=… REDIS_PORT=6380 \
 *   JWT_ACCESS_SECRET=… JWT_REFRESH_SECRET=… COOKIE_SECRET=… SETTINGS_ENCRYPTION_KEY=… \
 *   npx vitest run tests/integration/sell-journey.integration.test.js
 * The database must be fully migrated. Do not set LOG_LEVEL=silent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import jwt from 'jsonwebtoken'

const d = process.env.SELL_TEST_DB ? describe : describe.skip
const S = '/api/v1/sell-requests'
const M = '/api/v1/manage/sell-requests'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const tomorrow = () => new Date(Date.now() + 86400_000).toISOString().slice(0, 10)

d('sell razorpay', () => {
  let app, q, tmp, rzpMod, rzMod
  const T = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  let seq = 0
  const imei = () => {
    const body = String(36000000000000 + Math.floor(Math.random() * 9e11) + seq++).slice(0, 14)
    for (let c = 0; c < 10; c++) {
      const s = body + c
      let sum = 0
      for (let i = 0; i < 15; i++) { let n = Number(s[14 - i]); if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9 } sum += n }
      if (sum % 10 === 0) return s
    }
  }
  const call = async (method, url, who, payload) => {
    const res = await app.inject({ method, url, headers: who ? { authorization: `Bearer ${who.token}` } : {}, payload })
    let body; try { body = res.json() } catch { body = null }
    return { status: res.statusCode, body, data: body?.data }
  }
  const mkToken = async (role, name) => {
    const { rows } = await q(`INSERT INTO users (phone, name, role) VALUES ($1,$2,$3) RETURNING id, session_version`, [`9${rand()}`, name, role])
    return { id: rows[0].id, token: jwt.sign({ id: rows[0].id, role, session_version: rows[0].session_version }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) }
  }
  const mkVendor = async (key, lat, lng) => {
    const n = rand()
    const v = await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`, [`Buyer ${key} ${n}`, `sr-${n}`, `s${n}@x.test`, `7${n}`])
    T[key] = await mkToken('CUSTOMER', `Owner ${key}`)
    T[key].vendorId = v.rows[0].id
    await q(`INSERT INTO vendor_users (vendor_id, user_id, role) VALUES ($1,$2,'VENDOR_OWNER')`, [T[key].vendorId, T[key].id])
    await q(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, is_active)
             VALUES ($1,$2,$3,'1 Main Rd','Kolkata','WB','700001',$4,$5,$6,TRUE)`, [`Store ${key}`, `st-${n}`, `B${n.slice(0, 8)}`, lat, lng, T[key].vendorId])
  }
  const qa = { ageMonths: 12, screenScratches: 'NONE', bodyDents: false, screenReplaced: false, skinReplaced: false, billAvailable: true, boxAvailable: true, chargerAvailable: true, batteryHealth: 90, powersOn: true }
  const body = (extra = {}) => ({ type: 'SELL_TO_AB', model: 'iPhone 14', variant: '128GB', color: 'White', imei: imei(), qa, location: { lat: 22.5726, lng: 88.3639, pincode: '700001' }, ...extra })
  const key = () => crypto.randomUUID()

  /** Create a request as the customer (with a passing IMEI check) and have both buyers offer. */
  async function listed({ offerA = 40000, offerB = 41000, who = T.cust } = {}) {
    const i = imei()
    const chk = await call('POST', `${S}/verify-imei`, who, { imei: i })
    const r = await call('POST', S, who, body({ imei: i, imeiCheckId: chk.data.checkId }))
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const id = r.data.id
    if (offerA) expect((await call('POST', `${M}/${id}/offers`, T.buyA, { amount: offerA })).status).toBe(200)
    if (offerB) expect((await call('POST', `${M}/${id}/offers`, T.buyB, { amount: offerB, note: 'Pickup today' })).status).toBe(200)
    return { id, imei: i }
  }
  async function accepted(opts) {
    const l = await listed(opts)
    const offers = (await call('GET', `${S}/${l.id}/offers`, T.cust)).data.offers
    const best = offers.find((o) => o.best) || offers[0]
    const acc = await call('POST', `${S}/${l.id}/offers/${best.id}/accept`, T.cust)
    expect(acc.status, JSON.stringify(acc.body)).toBe(200)
    T.winner = best.vendorId === T.buyA.vendorId ? T.buyA : T.buyB
    return { ...l, offer: best }
  }
  const fund = async (id, who = T.winner) => {
    expect((await call('POST', `${M}/${id}/vendor-payment`, who, { method: 'UPI', reference: 'UTR123456789', idempotencyKey: key() })).status).toBe(200)
    return call('POST', `${M}/${id}/vendor-payment/confirm`, T.admin)
  }
  const bookPickup = (id) => call('POST', `${S}/${id}/fulfilment`, T.cust, { fulfilment: 'PICKUP', address: 'A-101, Green Valley Apt, Sector 45, Noida', pincode: '201301', date: tomorrow(), window: '9 AM - 12 PM' })
  /** Drive a funded, booked request to "phone received". */
  async function received(opts) {
    const a = await accepted(opts)
    await bookPickup(a.id)
    await fund(a.id)
    expect((await call('POST', `${M}/${a.id}/pickup`, T.winner, { provider: 'PORTER', awb: `AWB${rand()}`, courierName: 'Porter' })).status).toBe(200)
    for (const status of ['PICKED_UP', 'IN_TRANSIT', 'RECEIVED']) expect((await call('POST', `${M}/${a.id}/pickup/status`, T.winner, { status })).status).toBe(200)
    return a
  }
  async function inspect(id, { price } = {}) {
    const m1 = mp('p.png', 'image/png', PNG)
    const up = await app.inject({ method: 'POST', url: `${M}/media`, headers: { authorization: `Bearer ${T.winner.token}`, ...m1.headers }, payload: m1.payload })
    expect(up.statusCode, up.body).toBe(201)
    const media = up.json().data.files[0].media
    expect((await call('POST', `${M}/${id}/media`, T.winner, { mediaIds: [media.id], stage: 'TECHNICIAN_QC' })).status).toBe(200)
    expect((await call('POST', `${M}/${id}/qc/start`, T.winner, {})).status).toBe(200)
    const ins = await call('POST', `${M}/${id}/qc/inspection`, T.winner, { physicalCondition: 'GOOD', screenCondition: 'FLAWLESS', imeiVerified: true, batteryHealth: 90, remarks: 'ok' })
    expect(ins.status, JSON.stringify(ins.body)).toBe(200)
    return call('POST', `${M}/${id}/qc/decision`, T.winner, { result: 'PASSED', finalValuation: price })
  }
  function mp(name, type, data) {
    const b = '----t' + crypto.randomBytes(8).toString('hex')
    return { payload: Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${b}` } }
  }

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sell-rzp-'))
    Object.assign(process.env, { RAZORPAY_KEY_ID: 'rzp_test_stub', RAZORPAY_KEY_SECRET: 'stub_secret_value', RAZORPAY_WEBHOOK_SECRET: 'whsec_stub_value', RAZORPAYX_ACCOUNT_NUMBER: '2323230000000001', NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000', PRIVATE_UPLOAD_DIR: path.join(tmp, 'private'), UPLOAD_DIR: path.join(tmp, 'public'), SELL_DEMO_SEED: '1' })
    q = (await import('../../src/config/database.js')).query
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    rzpMod = await import('../../src/config/razorpay.js')
    rzMod = await import('../../src/modules/sell-requests/sell-razorpay.service.js')
    installStubs()
    await app.ready()
    await q(`UPDATE sell_settings SET enabled = TRUE, require_vendor_funding = TRUE, offer_window_minutes = 60, max_offer_refreshes = 2, estimate_spread_pct = 8,
             pickup_enabled = TRUE, dropoff_enabled = TRUE, qc_required_for_approval = FALSE WHERE id = TRUE`)
    await q(`DELETE FROM app_settings WHERE key = 'wallet_max_balance'`).catch(() => {})
    await q(`UPDATE vendors SET is_active = FALSE WHERE slug LIKE 'sr-%'`)
    T.admin = await mkToken('ADMIN', 'Admin')
    T.cust = await mkToken('CUSTOMER', 'Rahul Sharma')
    T.other = await mkToken('CUSTOMER', 'Someone Else')
    await mkVendor('buyA', 22.5800, 88.3700)
    await mkVendor('buyB', 22.6200, 88.3900)
  }, 90000)
  afterAll(async () => { await app?.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

  // ── Razorpay stub (keeps state like the real one) ─────────────────────
  const RUN = crypto.randomBytes(4).toString('hex')
  const R = { orders: new Map(), payments: new Map(), refunds: [], x: [], seq: 0, failOrders: false }
  const sign = (o, p) => crypto.createHmac('sha256', 'stub_secret_value').update(`${o}|${p}`).digest('hex')
  function installStubs() {
    const rz = rzpMod.razorpay
    rz.orders.create = async (b) => { if (R.failOrders) throw new Error('down'); const id = `order_${RUN}_${++R.seq}`; R.orders.set(id, { ...b, id }); return { id } }
    rz.orders.fetchPayments = async (id) => ({ items: [...R.payments.values()].filter((p) => p.order_id === id) })
    rz.payments.fetch = async (id) => { const p = R.payments.get(id); if (!p) throw new Error('nf'); return p }
    rz.payments.capture = async (id) => { const p = R.payments.get(id); p.status = 'captured'; return p }
    rz.payments.fetchMultipleRefund = async (id) => ({ items: R.refunds.filter((x) => x.payment_id === id) })
    rz.payments.refund = async (id, b) => { const r = { id: `rfnd_${RUN}_${++R.seq}`, payment_id: id, amount: b.amount, notes: b.notes }; R.refunds.push(r); return r }
    rzMod._xFetch.current = async (path, payload) => {
      R.x.push({ path, payload })
      if (path === '/contacts') return { id: 'cont_1' }
      if (path === '/fund_accounts') return { id: 'fa_1' }
      if (path === '/payouts') return { id: `pout_${RUN}_${++R.seq}`, status: 'processing' }
      return { status: 'processing' }
    }
  }
  /** The buyer's Checkout: returns the payment Razorpay would report. */
  const pay = (orderId, { status = 'captured', amount, method = 'upi' } = {}) => {
    const o = R.orders.get(orderId)
    const p = { id: `pay_${RUN}_${++R.seq}`, order_id: orderId, amount: amount ?? o.amount, status, method }
    R.payments.set(p.id, p)
    return p
  }
  const fundOrder = (id, who = T.winner) => call('POST', `${M}/${id}/vendor-payment/razorpay/order`, who)
  const verify = (id, order, p, who = T.winner, sig) => call('POST', `${M}/${id}/vendor-payment/razorpay/verify`, who,
    { razorpayOrderId: order, razorpayPaymentId: p.id, razorpaySignature: sig ?? sign(order, p.id) })
  const journey = async (id) => (await call('GET', `${S}/${id}/journey`, T.cust)).data
  const mgmt = async (id) => (await call('GET', `${M}/${id}`, T.winner)).data.journey

  describe('buyer funding with Razorpay Checkout', () => {
    it('creates an order for exactly the accepted amount, only for the assigned buyer', async () => {
      const a = await accepted()
      const other = T.winner === T.buyA ? T.buyB : T.buyA
      expect((await fundOrder(a.id, other)).status).toBe(404)
      expect((await fundOrder(a.id, T.cust)).status).toBe(403)
      const o = await fundOrder(a.id)
      expect(o.status, JSON.stringify(o.body)).toBe(200)
      expect(o.data).toMatchObject({ keyId: 'rzp_test_stub', amount: a.offer.amount * 100, currency: 'INR' })
      expect(R.orders.get(o.data.orderId).notes).toMatchObject({ sell_request_id: a.id })
      expect((await fundOrder(a.id)).data.orderId).toBe(o.data.orderId)   // resumes, does not create another
    })

    it('a forged signature is refused and nothing is held', async () => {
      const a = await accepted()
      const o = (await fundOrder(a.id)).data
      const p = pay(o.orderId)
      const bad = await verify(a.id, o.orderId, p, T.winner, 'f'.repeat(64))
      expect(bad.status).toBe(400)
      expect(bad.body.code).toBe('PAYMENT_VERIFICATION_FAILED')
      expect((await mgmt(a.id)).vendorPayment.status).toBe('PENDING')
    })

    it('refuses a payment for the wrong amount or one that Razorpay did not capture', async () => {
      const a = await accepted()
      const o = (await fundOrder(a.id)).data
      expect((await verify(a.id, o.orderId, pay(o.orderId, { amount: 100 }))).body.code).toBe('AMOUNT_MISMATCH')
      expect((await verify(a.id, o.orderId, pay(o.orderId, { status: 'failed' }))).body.code).toBe('PAYMENT_NOT_COMPLETE')
      expect((await mgmt(a.id)).vendorPayment.status).toBe('PENDING')
    })

    it('a verified payment is held at once, with no finance step, and the customer is told', async () => {
      const a = await accepted()
      const o = (await fundOrder(a.id)).data
      const p = pay(o.orderId)
      const ok = await verify(a.id, o.orderId, p)
      expect(ok.status, JSON.stringify(ok.body)).toBe(200)
      expect(ok.data).toMatchObject({ funded: true, vendorPaymentStatus: 'HELD', heldAmount: a.offer.amount })
      const m = await mgmt(a.id)
      expect(m.vendorPayment).toMatchObject({ status: 'HELD', heldAmount: a.offer.amount })
      expect(m.payments.find((x) => x.kind === 'VENDOR_FUNDING')).toMatchObject({ status: 'CONFIRMED', method: 'UPI', reference: p.id })
      // replay is harmless
      expect((await verify(a.id, o.orderId, p)).status).toBe(200)
      expect((await mgmt(a.id)).payments.filter((x) => x.kind === 'VENDOR_FUNDING')).toHaveLength(1)
      // and a second order cannot be opened for a settled sale
      expect((await fundOrder(a.id)).body.code).toBe('INVALID_STATE')
    })

    it('an authorized-only payment is captured; the webhook finishes a payment whose callback was lost', async () => {
      const a = await accepted()
      const o = (await fundOrder(a.id)).data
      const p = pay(o.orderId, { status: 'authorized' })
      expect(await rzMod.completeFundingByOrder(o.orderId, p.id)).toBe(true)
      expect(R.payments.get(p.id).status).toBe('captured')
      expect((await mgmt(a.id)).vendorPayment.status).toBe('HELD')
      expect(await rzMod.completeFundingByOrder('order_unknown', 'pay_x')).toBe(false)   // not ours → wallet top-up path
      // sync recovers a payment with no callback at all
      const b = await accepted()
      const ob = (await fundOrder(b.id)).data
      pay(ob.orderId)
      expect((await call('POST', `${M}/${b.id}/vendor-payment/razorpay/sync`, T.winner)).data.funded).toBe(true)
    })

    it('the signed Razorpay webhook funds the sale (and an unsigned one does nothing)', async () => {
      const a = await accepted()
      const o = (await fundOrder(a.id)).data
      const p = pay(o.orderId)
      const hook = (event, payload, secret = 'whsec_stub_value') => {
        const raw = JSON.stringify({ event, payload })
        return app.inject({ method: 'POST', url: '/api/v1/payments/webhook', payload: raw,
          headers: { 'content-type': 'application/json', 'x-razorpay-event-id': `evt_${crypto.randomUUID()}`, 'x-razorpay-signature': crypto.createHmac('sha256', secret).update(raw).digest('hex') } })
      }
      const evil = await hook('payment.captured', { payment: { entity: { id: p.id, order_id: o.orderId, method: 'upi' } } }, 'wrong')
      expect(evil.statusCode).toBe(400)
      expect((await mgmt(a.id)).vendorPayment.status).toBe('PENDING')
      const good = await hook('payment.captured', { payment: { entity: { id: p.id, order_id: o.orderId, method: 'upi' } } })
      expect(good.statusCode, good.body).toBe(200)
      await new Promise((r) => setTimeout(r, 200))
      expect((await mgmt(a.id)).vendorPayment.status).toBe('HELD')
    })

    it('a payment that arrives after the sale was cancelled is returned automatically', async () => {
      const a = await accepted()
      const o = (await fundOrder(a.id)).data
      const c = await call('POST', `${S}/${a.id}/cancel`, T.cust, { reason: 'Changed my mind' })
      expect(c.status, JSON.stringify(c.body)).toBe(200)
      await rzMod.completeFunding(o.orderId, pay(o.orderId).id)
      const refunds = R.refunds.filter((x) => x.notes?.sell_request_id === a.id)
      expect(refunds).toHaveLength(1)
      expect(refunds[0].amount).toBe(a.offer.amount * 100)
      expect((await mgmt(a.id)).vendorPayment.status).not.toBe('HELD')
    })

    it('the manual UTR route still works when online payment is not used', async () => {
      const a = await accepted()
      expect((await fund(a.id)).status).toBe(200)
      expect((await mgmt(a.id)).vendorPayment.status).toBe('HELD')
    })

    it('shows a clear error when Razorpay is down', async () => {
      const a = await accepted()
      R.failOrders = true
      const r = await fundOrder(a.id)
      R.failOrders = false
      expect(r.status).toBe(502)
      expect(r.body.code).toBe('PAYMENTS_UNAVAILABLE')
    })
  })

  describe('refunds and seller payouts', () => {
    async function fundedByRazorpay() {
      const a = await accepted()
      const o = (await fundOrder(a.id)).data
      const p = pay(o.orderId)
      await verify(a.id, o.orderId, p)
      await bookPickup(a.id)
      expect((await call('POST', `${M}/${a.id}/pickup`, T.winner, { provider: 'PORTER', awb: `AWB${rand()}`, courierName: 'Porter' })).status).toBe(200)
      for (const status of ['PICKED_UP', 'IN_TRANSIT', 'RECEIVED']) expect((await call('POST', `${M}/${a.id}/pickup/status`, T.winner, { status })).status).toBe(200)
      return { ...a, paymentId: p.id }
    }

    it('a failed inspection returns the whole payment to the buyer by itself', async () => {
      const a = await fundedByRazorpay()
      const m1 = mp('p.png', 'image/png', PNG)
      const up = await app.inject({ method: 'POST', url: `${M}/media`, headers: { authorization: `Bearer ${T.winner.token}`, ...m1.headers }, payload: m1.payload })
      await call('POST', `${M}/${a.id}/media`, T.winner, { mediaIds: [up.json().data.files[0].media.id], stage: 'TECHNICIAN_QC' })
      await call('POST', `${M}/${a.id}/qc/start`, T.winner, {})
      await call('POST', `${M}/${a.id}/qc/inspection`, T.winner, { physicalCondition: 'POOR', screenCondition: 'CRACKED', imeiVerified: true, batteryHealth: 60, remarks: 'bad' })
      expect((await call('POST', `${M}/${a.id}/qc/decision`, T.winner, { result: 'FAILED', note: 'Water damage' })).status).toBe(200)
      const refund = R.refunds.find((x) => x.payment_id === a.paymentId)
      expect(refund).toMatchObject({ amount: a.offer.amount * 100 })
      const m = await mgmt(a.id)
      expect(m.vendorPayment.status).toBe('REFUNDED')
      expect(m.payments.find((x) => x.kind === 'VENDOR_REFUND')).toMatchObject({ status: 'PAID', reference: refund.id })
    })

    it('a lower final price refunds only the difference, and the seller is paid through RazorpayX', async () => {
      const a = await fundedByRazorpay()
      const lower = a.offer.amount - 3000
      expect((await inspect(a.id, { price: lower })).status).toBe(200)
      expect((await call('POST', `${S}/${a.id}/qc/decision`, T.cust, { decision: 'ACCEPT' })).status).toBe(200)
      R.x.length = 0
      const ok = await call('POST', `${S}/${a.id}/payout`, T.cust, { method: 'UPI', upiId: 'rahul.sharma@okhdfcbank' })
      expect(ok.status, JSON.stringify(ok.body)).toBe(200)
      expect(R.x.map((c) => c.path)).toEqual(['/contacts', '/fund_accounts', '/payouts'])
      expect(R.x[1].payload).toMatchObject({ account_type: 'vpa', vpa: { address: 'rahul.sharma@okhdfcbank' } })
      expect(R.x[2].payload).toMatchObject({ amount: lower * 100, mode: 'UPI', account_number: '2323230000000001' })
      expect((await journey(a.id)).payout.status).toBe('PROCESSING')
      const { rows: [pp] } = await q(`SELECT provider_ref FROM sell_payments WHERE request_id = $1 AND kind = 'CUSTOMER_PAYOUT'`, [a.id])
      expect(pp.provider_ref).toMatch(/^pout_/)
      // RazorpayX confirms (webhook payload)
      expect(await rzMod.applyPayoutResult({ id: pp.provider_ref, status: 'processed', utr: 'UTR556677889900' })).toBe(true)
      expect(await rzMod.applyPayoutResult({ id: pp.provider_ref, status: 'processed', utr: 'UTR556677889900' })).toBe(true)   // idempotent
      const j = await journey(a.id)
      expect(j).toMatchObject({ stage: 'PAID', payout: { status: 'PAID', receiptRef: 'UTR556677889900' } })
      const diff = R.refunds.find((x) => x.payment_id === a.paymentId)
      expect(diff.amount).toBe(3000 * 100)
      expect((await mgmt(a.id)).vendorPayment.status).toBe('REFUNDED')
    })

    it('a failed RazorpayX payout lets the seller fix their details', async () => {
      const a = await fundedByRazorpay()
      expect((await inspect(a.id, { price: a.offer.amount })).status).toBe(200)
      await call('POST', `${S}/${a.id}/payout`, T.cust, { method: 'BANK', bank: { holderName: 'Rahul Sharma', accountNumber: '123456789012', ifsc: 'HDFC0001234' }, confirmAccountNumber: '123456789012' })
      expect(R.x.at(-1).payload).toMatchObject({ mode: 'IMPS', amount: a.offer.amount * 100 })
      const { rows: [pp] } = await q(`SELECT provider_ref FROM sell_payments WHERE request_id = $1 AND kind = 'CUSTOMER_PAYOUT'`, [a.id])
      expect(await rzMod.applyPayoutResult({ id: pp.provider_ref, status: 'failed', status_details: { description: 'Invalid account' } })).toBe(true)
      const j = await journey(a.id)
      expect(j.payout.status).toBe('PENDING')
      expect(j.stage).toBe('PAYOUT_PENDING')
    })

    it('without RazorpayX the payout waits for finance, exactly as before', async () => {
      const { env } = await import('../../src/config/env.js')
      const saved = env.RAZORPAYX_ACCOUNT_NUMBER
      try {
        env.RAZORPAYX_ACCOUNT_NUMBER = undefined
        const a = await fundedByRazorpay()
        expect((await inspect(a.id, { price: a.offer.amount })).status).toBe(200)
        R.x.length = 0
        await call('POST', `${S}/${a.id}/payout`, T.cust, { method: 'UPI', upiId: 'ab.cd@okhdfcbank' })
        expect(R.x).toHaveLength(0)
        expect((await call('GET', `${M}/finance/queue`, T.admin)).data.payoutsToSend.map((x) => x.id)).toContain(a.id)
        expect((await call('POST', `${M}/${a.id}/payout/paid`, T.admin, { reference: 'UTR123123123123' })).status).toBe(200)
      } finally { env.RAZORPAYX_ACCOUNT_NUMBER = saved }
    })
  })
})
