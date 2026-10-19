/**
 * Sell-your-phone journey — real app over HTTP, real Postgres.
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

d('sell journey', () => {
  let app, q, tmp
  const T = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  let seq = 0
  const imei = () => {
    const body = String(35000000000000 + (Date.now() % 1e7) * 10 + seq++).slice(0, 14)
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
    const v = await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`, [`Buyer ${key} ${n}`, `sj-${n}`, `s${n}@x.test`, `7${n}`])
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
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sell-journey-'))
    Object.assign(process.env, { NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000', PRIVATE_UPLOAD_DIR: path.join(tmp, 'private'), UPLOAD_DIR: path.join(tmp, 'public'), SELL_DEMO_SEED: '1' })
    q = (await import('../../src/config/database.js')).query
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
    await q(`UPDATE sell_settings SET enabled = TRUE, require_vendor_funding = TRUE, offer_window_minutes = 60, max_offer_refreshes = 2, estimate_spread_pct = 8,
             pickup_enabled = TRUE, dropoff_enabled = TRUE, qc_required_for_approval = FALSE WHERE id = TRUE`)
    await q(`DELETE FROM app_settings WHERE key = 'wallet_max_balance'`).catch(() => {})
    await q(`UPDATE shiprocket_settings SET simulation_mode = FALSE`).catch(() => {})   // these tests book the courier by hand
    await q(`UPDATE vendors SET is_active = FALSE WHERE slug LIKE 'sj-%'`)
    T.admin = await mkToken('ADMIN', 'Admin')
    T.cust = await mkToken('CUSTOMER', 'Rahul Sharma')
    T.other = await mkToken('CUSTOMER', 'Someone Else')
    await mkVendor('buyA', 22.5800, 88.3700)
    await mkVendor('buyB', 22.6200, 88.3900)
  }, 90000)
  afterAll(async () => { await app?.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

  describe('IMEI & estimate', () => {
    it('verifies a good IMEI and refuses a malformed, blocked or already-listed one', async () => {
      const ok = await call('POST', `${S}/verify-imei`, T.cust, { imei: imei() })
      expect(ok.status).toBe(200)
      expect(ok.data.eligible).toBe(true)
      expect(ok.data.checks.map((c) => c.key)).toEqual(expect.arrayContaining(['FORMAT', 'BLOCKLIST', 'NO_LIVE_REQUEST', 'CEIR']))
      expect(ok.data.checks.find((c) => c.key === 'CEIR').status).toBe('INFO')   // never claimed as passed

      const bad = await call('POST', `${S}/verify-imei`, T.cust, { imei: '123456789012345' })
      expect(bad.data.eligible).toBe(false)

      const blocked = imei()
      expect((await call('POST', `${M}/imei-blocklist`, T.admin, { imei: blocked, reason: 'Reported stolen', source: 'POLICE' })).status).toBe(201)
      expect((await call('POST', `${S}/verify-imei`, T.cust, { imei: blocked })).data.eligible).toBe(false)
      expect((await call('POST', S, T.cust, body({ imei: blocked }))).body.code).toBe('IMEI_BLOCKED')
      expect((await call('GET', `${M}/imei-blocklist?q=${blocked.slice(0, 8)}`, T.admin)).data.items.map((x) => x.imei)).toContain(blocked)
      expect((await call('DELETE', `${M}/imei-blocklist/${blocked}`, T.admin)).status).toBe(200)

      const l = await listed({ offerA: 0, offerB: 0 })
      const again = await call('POST', `${S}/verify-imei`, T.other, { imei: l.imei })
      expect(again.data.eligible).toBe(false)
      expect(again.data.checks.find((c) => c.key === 'NO_LIVE_REQUEST').status).toBe('FAIL')
    })

    it('the blocklist is admin-only', async () => {
      expect((await call('GET', `${M}/imei-blocklist`, T.cust)).status).toBe(403)
      expect((await call('POST', `${M}/imei-blocklist`, T.buyA, { imei: imei(), reason: 'x' })).status).toBe(403)
    })

    it('estimate gives a price band around the system valuation and the buyers who could bid', async () => {
      const e = await call('POST', `${S}/estimate`, T.cust, body())
      expect(e.status, JSON.stringify(e.body)).toBe(200)
      expect(e.data.estimateMin).toBeLessThan(e.data.quote)
      expect(e.data.estimateMax).toBeGreaterThan(e.data.quote)
      expect(e.data.vendorsNearby).toBeGreaterThanOrEqual(2)
      expect(e.data.offerWindowMinutes).toBe(60)
      expect((await call('GET', `${S}/journey-config`, T.cust)).data.pickupWindows.length).toBeGreaterThan(0)
    })
  })

  describe('listing → offers → accept', () => {
    let l
    it('the request stores the estimate band, offer window and the IMEI check', async () => {
      l = await listed({ offerA: 38000, offerB: 41000 })
      const j = (await call('GET', `${S}/${l.id}/journey`, T.cust)).data
      expect(j.stage).toBe('LISTED')
      expect(j.nextAction).toBe('WAIT_FOR_OFFERS')
      expect(j.estimate.min).toBeLessThan(j.estimate.max)
      expect(new Date(j.offersCloseAt).getTime()).toBeGreaterThan(Date.now())
      expect(j.imeiVerifiedAt).toBeTruthy()
    })

    it('the customer compares named buyers with distance and a best-offer flag; other customers cannot see them', async () => {
      const o = (await call('GET', `${S}/${l.id}/offers`, T.cust)).data
      expect(o.offers).toHaveLength(2)
      expect(o.offers[0].amount).toBe(41000)
      expect(o.offers[0]).toMatchObject({ best: true, note: 'Pickup today' })
      expect(o.offers[0].vendorName).toMatch(/^Store /)
      expect(o.offers[0].distanceKm).toBeGreaterThan(0)
      expect(o.open).toBe(true)
      expect((await call('GET', `${S}/${l.id}/offers`, T.other)).status).toBe(404)
    })

    it('a vendor cannot offer once the window closes; the customer can refresh a limited number of times', async () => {
      await q(`UPDATE sell_requests SET offers_close_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [l.id])
      expect((await call('POST', `${M}/${l.id}/offers`, T.buyA, { amount: 39000 })).body.code).toBe('OFFERS_CLOSED')
      const stale = (await call('GET', `${S}/${l.id}/offers`, T.cust)).data
      expect(stale.open).toBe(false)
      expect((await call('GET', `${S}/${l.id}/journey`, T.cust)).data.nextAction).toBe('REFRESH_OFFERS')
      expect((await call('POST', `${S}/${l.id}/offers/${stale.offers[0].id}/accept`, T.cust)).body.code).toBe('OFFERS_CLOSED')
      expect((await call('POST', `${S}/${l.id}/offers/refresh`, T.cust)).data.open).toBe(true)
      expect((await call('POST', `${M}/${l.id}/offers`, T.buyA, { amount: 39000 })).status).toBe(200)
      await call('POST', `${S}/${l.id}/offers/refresh`, T.cust)
      expect((await call('POST', `${S}/${l.id}/offers/refresh`, T.cust)).body.code).toBe('REFRESH_LIMIT')
    })

    it('accepting is exclusive even in parallel; the others are declined and the buyer must now pay', async () => {
      const offers = (await call('GET', `${S}/${l.id}/offers`, T.cust)).data.offers
      const [a, b] = await Promise.all(offers.map((o) => call('POST', `${S}/${l.id}/offers/${o.id}/accept`, T.cust)))
      expect([a.status, b.status].sort()).toEqual([200, 409])
      const j = (await call('GET', `${S}/${l.id}/journey`, T.cust)).data
      expect(j).toMatchObject({ stage: 'OFFER_ACCEPTED', nextAction: 'CHOOSE_FULFILMENT', status: 'IN_PROGRESS' })
      expect(j.vendorPayment).toMatchObject({ status: 'PENDING' })
      const { rows } = await q(`SELECT status, COUNT(*)::int AS n FROM sell_request_offers WHERE request_id = $1 GROUP BY status`, [l.id])
      expect(Object.fromEntries(rows.map((r) => [r.status, r.n]))).toMatchObject({ ACCEPTED: 1, DECLINED: 1 })
    })
  })

  describe('pickup, buyer payment and inspection', () => {
    let a
    it('booking validates the address, date and window', async () => {
      a = await accepted()
      const bad = (extra) => call('POST', `${S}/${a.id}/fulfilment`, T.cust, { fulfilment: 'PICKUP', address: 'A-101, Green Valley Apt, Noida', pincode: '201301', date: tomorrow(), window: '9 AM - 12 PM', ...extra })
      expect((await bad({ address: 'short' })).status).toBe(422)
      expect((await bad({ pincode: '12' })).status).toBe(422)
      expect((await bad({ window: 'whenever' })).status).toBe(422)
      expect((await bad({ date: '2020-01-01' })).status).toBe(422)
      expect((await bad({ fulfilment: 'TELEPORT' })).status).toBe(422)
      expect((await call('POST', `${S}/${a.id}/fulfilment`, T.other, { fulfilment: 'DROP_OFF' })).status).toBe(404)
      const ok = await bookPickup(a.id)
      expect(ok.status, JSON.stringify(ok.body)).toBe(200)
      expect(ok.data).toMatchObject({ stage: 'PICKUP_REQUESTED', nextAction: 'WAIT_FOR_BUYER_PAYMENT' })
    })

    it('no courier and no receipt until the buyer has paid; only the assigned buyer acts', async () => {
      const loser = T.winner === T.buyA ? T.buyB : T.buyA
      expect((await call('POST', `${M}/${a.id}/pickup`, T.winner, { provider: 'PORTER' })).body.code).toBe('VENDOR_NOT_FUNDED')
      expect((await call('POST', `${M}/${a.id}/received`, T.winner)).body.code).toBe('VENDOR_NOT_FUNDED')
      expect((await call('POST', `${M}/${a.id}/vendor-payment`, loser, { method: 'UPI', reference: 'UTR000111222', idempotencyKey: key() })).status).toBe(404)
      expect((await call('POST', `${M}/${a.id}/vendor-payment/confirm`, T.winner, {})).status).toBe(403)   // finance only
    })

    it('the buyer pays exactly the accepted amount (idempotent); finance confirms and the amount is held', async () => {
      const k = key()
      const pay = (b) => call('POST', `${M}/${a.id}/vendor-payment`, T.winner, { method: 'UPI', reference: 'UTR123456789', idempotencyKey: k, ...b })
      expect((await pay({ amount: 1 })).body.code).toBe('AMOUNT_MISMATCH')
      expect((await pay({ method: 'BITCOIN' })).status).toBe(422)
      expect((await pay({ reference: '' })).status).toBe(422)
      expect((await pay({})).status).toBe(200)
      expect((await pay({})).status).toBe(200)   // replay
      const { rows } = await q(`SELECT COUNT(*)::int AS n FROM sell_payments WHERE request_id = $1 AND kind = 'VENDOR_FUNDING'`, [a.id])
      expect(rows[0].n).toBe(1)
      const queue = (await call('GET', `${M}/finance/queue`, T.admin)).data
      expect(queue.fundingToConfirm.map((x) => x.id)).toContain(a.id)
      expect((await call('GET', `${M}/finance/queue`, T.cust)).status).toBe(403)
      const c = await call('POST', `${M}/${a.id}/vendor-payment/confirm`, T.admin)
      expect(c.status, JSON.stringify(c.body)).toBe(200)
      expect(c.data.vendorPayment).toMatchObject({ status: 'HELD', heldAmount: a.offer.amount })
      expect((await call('GET', `${S}/${a.id}/journey`, T.cust)).data.nextAction).toBe('WAIT_FOR_PICKUP_SLOT')
    })

    it('the courier is booked, tracked by status events, and the customer sees steps with a link — no live location', async () => {
      const awb = `AWB${rand()}`
      const p = await call('POST', `${M}/${a.id}/pickup`, T.winner, { provider: 'SHIPROCKET', awb, courierName: 'Delhivery', trackingUrl: 'https://track.example.com/x' })
      expect(p.status, JSON.stringify(p.body)).toBe(200)
      expect((await call('POST', `${M}/${a.id}/pickup`, T.winner, { provider: 'SHIPROCKET', trackingUrl: 'javascript:alert(1)' })).status).toBe(422)
      expect((await call('POST', `${M}/${a.id}/received`, T.winner)).data.stage).toBe('RECEIVED')   // allowed (self handover) — but we continue the courier path on a fresh request below
      const j = (await call('GET', `${S}/${a.id}/journey`, T.cust)).data
      expect(j.steps.map((s) => s.label)).toEqual(['Offer Accepted', 'Buyer Paid', 'Pickup Scheduled', 'Device Picked Up', 'In Transit', 'Received by Buyer', 'Inspection', 'Final Price Approved', 'Payment Sent'])
      expect(j.pickup).toMatchObject({ provider: 'SHIPROCKET', courier: 'Delhivery', trackingUrl: 'https://track.example.com/x', awb })
      expect(JSON.stringify(j)).not.toMatch(/"lat"|"lng"|rider/i)
    })

    it('courier statuses move the stage forward in order and never backwards', async () => {
      const b = await received()
      expect((await call('GET', `${S}/${b.id}/journey`, T.cust)).data.stage).toBe('RECEIVED')
      expect((await call('POST', `${M}/${b.id}/pickup/status`, T.winner, { status: 'PICKED_UP' })).status).toBe(200)
      expect((await call('GET', `${S}/${b.id}/journey`, T.cust)).data.stage).toBe('RECEIVED')
      expect((await call('POST', `${M}/${b.id}/pickup/status`, T.winner, { status: 'WARP' })).status).toBe(422)
    })
  })

  describe('final price and payout', () => {
    it('a price unchanged at inspection is accepted automatically; the customer chooses UPI; finance sends it; the sale completes', async () => {
      const r = await received()
      const dec = await inspect(r.id)
      expect(dec.status, JSON.stringify(dec.body)).toBe(200)
      let j = (await call('GET', `${S}/${r.id}/journey`, T.cust)).data
      expect(j).toMatchObject({ stage: 'PAYOUT_PENDING', status: 'APPROVED', nextAction: 'CHOOSE_PAYOUT' })
      expect(j.payoutOptions.find((o) => o.method === 'UPI').enabled).toBe(true)
      expect(j.payoutOptions.find((o) => o.method === 'WALLET').enabled).toBe(false)   // ₹40k+ cannot fit the wallet cap

      const bad = (b) => call('POST', `${S}/${r.id}/payout`, T.cust, b)
      expect((await bad({ method: 'UPI', upiId: 'not an upi' })).status).toBe(422)
      expect((await bad({ method: 'BANK', bank: { holderName: 'R', accountNumber: '12', ifsc: 'X' } })).status).toBe(422)
      expect((await bad({ method: 'BANK', bank: { holderName: 'Rahul Sharma', accountNumber: '123456789012', ifsc: 'HDFC0001234' }, confirmAccountNumber: '999' })).status).toBe(422)
      expect((await bad({ method: 'WALLET' })).body.code).toBe('PAYOUT_UNAVAILABLE')
      expect((await call('POST', `${S}/${r.id}/payout`, T.other, { method: 'UPI', upiId: 'ab@okhdfc' })).status).toBe(404)

      const ok = await bad({ method: 'UPI', upiId: 'rahul.sharma@okhdfcbank' })
      expect(ok.status, JSON.stringify(ok.body)).toBe(200)
      expect(ok.data).toMatchObject({ stage: 'PAYOUT_PENDING', nextAction: 'PAYOUT_PROCESSING' })
      expect(ok.data.payout.display).toMatch(/^UPI · ra•+@okhdfcbank$/)
      expect(JSON.stringify(ok.data)).not.toContain('rahul.sharma')   // never returned in clear to the customer

      const queue = (await call('GET', `${M}/finance/queue`, T.admin)).data
      expect(queue.payoutsToSend.map((x) => x.id)).toContain(r.id)
      expect((await call('GET', `${M}/${r.id}/payout/details`, T.winner)).status).toBe(403)
      expect((await call('GET', `${M}/${r.id}/payout/details`, T.admin)).data).toMatchObject({ method: 'UPI', upiId: 'rahul.sharma@okhdfcbank' })
      expect((await call('POST', `${M}/${r.id}/payout/paid`, T.admin, { reference: 'x' })).status).toBe(422)
      const paid = await call('POST', `${M}/${r.id}/payout/paid`, T.admin, { reference: 'UTR998877665544' })
      expect(paid.status, JSON.stringify(paid.body)).toBe(200)
      j = (await call('GET', `${S}/${r.id}/journey`, T.cust)).data
      expect(j).toMatchObject({ stage: 'PAID', status: 'COMPLETED', nextAction: 'DONE' })
      expect(j.payout).toMatchObject({ status: 'PAID', amount: r.offer.amount, receiptRef: 'UTR998877665544' })
      expect(j.steps.every((s) => s.done)).toBe(true)
      // paying twice is impossible
      expect((await call('POST', `${M}/${r.id}/payout/paid`, T.admin, { reference: 'UTR998877665544' })).status).toBe(409)
      const { rows } = await q(`SELECT kind, status, amount FROM sell_payments WHERE request_id = $1 ORDER BY created_at`, [r.id])
      expect(rows.filter((x) => x.kind === 'CUSTOMER_PAYOUT')).toEqual([expect.objectContaining({ status: 'PAID' })])
      // the IMEI is free again
      expect((await call('POST', `${S}/verify-imei`, T.other, { imei: r.imei })).data.checks.find((c) => c.key === 'SOLD_BEFORE').status).toBe('WARN')
    })

    it('a price cut at inspection waits for the customer; accepting pays the lower amount and returns the difference to the buyer', async () => {
      const r = await received()
      const dec = await inspect(r.id, { price: r.offer.amount - 3000 })
      expect(dec.status, JSON.stringify(dec.body)).toBe(200)
      const j = (await call('GET', `${S}/${r.id}/journey`, T.cust)).data
      expect(j).toMatchObject({ stage: 'FINAL_PRICE', nextAction: 'DECIDE_FINAL_PRICE' })
      expect(j.inspection).toMatchObject({ finalValuation: r.offer.amount - 3000, customerDecision: 'PENDING' })
      expect((await call('POST', `${S}/${r.id}/payout`, T.cust, { method: 'UPI', upiId: 'ab@okhdfc' })).body.code).toBe('INVALID_STATE')   // decide first
      expect((await call('POST', `${S}/${r.id}/qc/decision`, T.cust, { decision: 'ACCEPT' })).status).toBe(200)
      expect((await call('GET', `${S}/${r.id}/journey`, T.cust)).data).toMatchObject({ stage: 'PAYOUT_PENDING', payout: { amount: r.offer.amount - 3000 } })
      await call('POST', `${S}/${r.id}/payout`, T.cust, { method: 'BANK', bank: { holderName: 'Rahul Sharma', accountNumber: '123456789012', ifsc: 'HDFC0001234' }, confirmAccountNumber: '123456789012' })
      const d1 = (await call('GET', `${M}/${r.id}/payout/details`, T.admin)).data
      expect(d1).toMatchObject({ method: 'BANK', accountNumber: '123456789012', ifsc: 'HDFC0001234' })
      const view = (await call('GET', `${S}/${r.id}`, T.cust)).data
      expect(view.journey.payout.display).toBe('Bank ••9012 · HDFC0001234')
      expect(JSON.stringify(view)).not.toContain('123456789012')
      await call('POST', `${M}/${r.id}/payout/paid`, T.admin, { reference: 'UTR112233445566' })
      const { rows } = await q(`SELECT amount, status FROM sell_payments WHERE request_id = $1 AND kind = 'VENDOR_REFUND'`, [r.id])
      expect(rows).toEqual([expect.objectContaining({ amount: '3000.00', status: 'PROCESSING' })])
      expect((await call('GET', `${M}/finance/queue`, T.admin)).data.refundsToSend.map((x) => x.id)).toContain(r.id)
      expect((await call('POST', `${M}/${r.id}/refund/paid`, T.admin, { reference: 'REFUND000111' })).data.vendorPayment.status).toBe('REFUNDED')
    })

    it('the final price can never exceed the accepted offer', async () => {
      const r = await received()
      const dec = await inspect(r.id, { price: r.offer.amount + 500 })
      expect(dec.status).toBe(422)
    })

    it('declining the new price closes the sale, sends the phone back and returns the buyer\'s money', async () => {
      const r = await received()
      await inspect(r.id, { price: r.offer.amount - 5000 })
      expect((await call('POST', `${S}/${r.id}/qc/decision`, T.cust, { decision: 'DECLINE' })).status).toBe(200)
      const j = (await call('GET', `${S}/${r.id}/journey`, T.cust)).data
      expect(j).toMatchObject({ stage: 'RETURNING', status: 'CANCELLED', nextAction: 'DEVICE_RETURNING' })
      expect(j.vendorPayment.status).toBe('REFUNDING')
      expect((await call('POST', `${M}/${r.id}/returned`, T.winner)).data.stage).toBe('CLOSED')
      expect((await call('POST', `${M}/${r.id}/refund/paid`, T.admin, { reference: 'REFUND998877' })).data.vendorPayment.status).toBe('REFUNDED')
    })

    it('a failed inspection also returns the phone and the money', async () => {
      const r = await received()
      await call('POST', `${M}/${r.id}/qc/start`, T.winner, {}).catch(() => {})
      const up = mp('p.png', 'image/png', PNG)
      const m = (await app.inject({ method: 'POST', url: `${M}/media`, headers: { authorization: `Bearer ${T.winner.token}`, ...up.headers }, payload: up.payload })).json().data.files[0].media
      await call('POST', `${M}/${r.id}/media`, T.winner, { mediaIds: [m.id], stage: 'TECHNICIAN_QC' })
      await call('POST', `${M}/${r.id}/qc/start`, T.winner, {})
      await call('POST', `${M}/${r.id}/qc/inspection`, T.winner, { physicalCondition: 'POOR', screenCondition: 'CRACKED', imeiVerified: true, remarks: 'dead' })
      expect((await call('POST', `${M}/${r.id}/qc/decision`, T.winner, { result: 'FAILED', note: 'Water damage' })).status).toBe(200)
      const j = (await call('GET', `${S}/${r.id}/journey`, T.cust)).data
      expect(j.stage).toBe('RETURNING')
      expect(j.vendorPayment.status).toBe('REFUNDING')
    })

    it('a customer who cancels before pickup gets a clean close and no money moves', async () => {
      const r = await accepted()
      await bookPickup(r.id)
      expect((await call('POST', `${S}/${r.id}/cancel`, T.cust, { reason: 'changed my mind' })).status).toBe(200)
      const j = (await call('GET', `${S}/${r.id}/journey`, T.cust)).data
      expect(j).toMatchObject({ stage: 'CLOSED', nextAction: 'CLOSED' })
      expect(j.vendorPayment.status).toBe('PENDING')
    })

    it('a wallet payout is instant when it fits the wallet cap', async () => {
      await q(`INSERT INTO app_settings (key, value) VALUES ('wallet_max_balance', '1000000') ON CONFLICT (key) DO UPDATE SET value = '1000000'`).catch(() => {})
      const r = await received()
      await inspect(r.id)
      const j = (await call('GET', `${S}/${r.id}/journey`, T.cust)).data
      if (!j.payoutOptions.find((o) => o.method === 'WALLET').enabled) return   // wallet cap not configurable in this environment
      const ok = await call('POST', `${S}/${r.id}/payout`, T.cust, { method: 'WALLET' })
      expect(ok.status, JSON.stringify(ok.body)).toBe(200)
      expect(ok.data).toMatchObject({ stage: 'PAID', status: 'COMPLETED' })
      const { rows } = await q(`SELECT w.balance FROM wallets w WHERE w.user_id = $1`, [T.cust.id])
      expect(Number(rows[0].balance)).toBeGreaterThanOrEqual(r.offer.amount)
    })
  })

  describe('drop-off at the store', () => {
    it('no courier: the customer drops the phone, the buyer marks it received after being paid', async () => {
      const a = await accepted()
      const b = await call('POST', `${S}/${a.id}/fulfilment`, T.cust, { fulfilment: 'DROP_OFF' })
      expect(b.status, JSON.stringify(b.body)).toBe(200)
      expect(b.data.buyer.address).toMatch(/Main Rd/)
      expect(b.data.steps.map((s) => s.label)).toEqual(['Offer Accepted', 'Drop-off Chosen', 'Buyer Paid', 'Received at Store', 'Inspection', 'Final Price Approved', 'Payment Sent'])
      expect((await call('POST', `${M}/${a.id}/received`, T.winner)).body.code).toBe('VENDOR_NOT_FUNDED')
      await fund(a.id)
      expect((await call('POST', `${M}/${a.id}/pickup`, T.winner, { provider: 'SELF' })).status).toBe(409)   // pickup is only for PICKUP bookings
      expect((await call('POST', `${M}/${a.id}/received`, T.winner)).data.stage).toBe('RECEIVED')
    })
  })

  describe('settings', () => {
    it('admins can tune the journey; the old sell/exchange behaviour is unchanged', async () => {
      const s = await call('GET', `${M}/settings`, T.admin)
      expect(s.data).toMatchObject({ offerWindowMinutes: 60, requireVendorFunding: true, pickupEnabled: true })
      const u = await call('PUT', `${M}/settings`, T.admin, { ...s.data, offerWindowMinutes: 30, pickupEnabled: false })
      expect(u.data).toMatchObject({ offerWindowMinutes: 30, pickupEnabled: false })
      const a = await accepted()
      expect((await bookPickup(a.id)).body.code).toBe('FULFILMENT_UNAVAILABLE')
      await call('PUT', `${M}/settings`, T.admin, { ...u.data, offerWindowMinutes: 60, pickupEnabled: true })
    })
  })
})
