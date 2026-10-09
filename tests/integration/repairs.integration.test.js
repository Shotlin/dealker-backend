/**
 * Repairs (B2C + B2B) — real app over HTTP, real Postgres, real files.
 *
 *   SELL_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=sell_evidence_test DB_USER=dealker_user \
 *   DB_PASSWORD=dealker_password_dev REDIS_HOST=localhost REDIS_PORT=6380 \
 *   npx vitest run tests/integration/repairs.integration.test.js
 * The database must be fully migrated (npm run db:migrate).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import jwt from 'jsonwebtoken'

const d = process.env.SELL_TEST_DB ? describe : describe.skip
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const GSTIN = () => `29ABCDE${String(1000 + Math.floor(Math.random() * 8999))}F1Z5`

function multipart(name, type, data) {
  const b = '----t' + crypto.randomBytes(8).toString('hex')
  return {
    payload: Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${b}` },
  }
}

d('repairs', () => {
  let app, q, tmp
  const T = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const imei = () => `RP${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`.toUpperCase()
  const auth = (t, extra = {}) => ({ authorization: `Bearer ${t.token}`, ...extra })
  const call = async (method, url, who, payload) => {
    const res = await app.inject({ method, url, headers: auth(who), payload })
    let body; try { body = res.json() } catch { body = null }
    return { status: res.statusCode, body, data: body?.data }
  }
  const M = '/api/v1/manage/repairs'
  const C = '/api/v1/repairs'
  const mkToken = async (role, name) => {
    const { rows } = await q(`INSERT INTO users (phone, name, role) VALUES ($1,$2,$3) RETURNING id, session_version`, [`9${rand()}`, name, role])
    return { id: rows[0].id, token: jwt.sign({ id: rows[0].id, role, session_version: rows[0].session_version }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) }
  }
  const setSettings = (cols) => q(`UPDATE repair_settings SET ${Object.entries(cols).map(([k, v]) => `${k} = ${v}`).join(', ')} WHERE id = TRUE`)
  const device = (extra = {}) => ({ brand: 'Apple', model: 'iPhone 13', imeiSerial: imei(), problemCategory: 'SCREEN', problemDescription: 'Cracked screen', warrantyStatus: 'OUT_OF_WARRANTY', ...extra })
  const b2c = (extra = {}) => ({ channel: 'B2C', serviceMode: 'DROP_OFF', description: 'broken', items: [device()], ...extra })
  const b2bBody = (n = 3, extra = {}) => ({ channel: 'B2B', businessName: 'Acme Retail Pvt Ltd', gstin: GSTIN(), contactPerson: 'Priya', poReference: 'PO-77', serviceMode: 'DROP_OFF', items: Array.from({ length: n }, () => device()), ...extra })
  const labour = (items, price = 1000) => items.map((i) => ({ itemId: i.id, kind: 'LABOUR', description: 'Screen replacement', qty: 1, unitPrice: price }))

  /** Drive a request from REQUESTED up to ESTIMATE_SENT. */
  async function toEstimate(who, body, price = 1000) {
    const created = await call('POST', C, who, body)
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const id = created.data.id
    expect((await call('POST', `${M}/${id}/accept`, T.admin, { vendorId: T.vendA.vendorId, technicianId: T.vendA.id })).status).toBe(200)
    expect((await call('POST', `${M}/${id}/receive`, T.vendA)).status).toBe(200)
    const cur = (await call('GET', `${M}/${id}`, T.vendA)).data
    const quote = await call('POST', `${M}/${id}/quotes`, T.vendA, { lines: labour(cur.items, price) })
    expect(quote.status, JSON.stringify(quote.body)).toBe(200)
    return { id, req: quote.data }
  }
  const pay = (id, body) => call('POST', `${M}/${id}/payments`, T.admin, { method: 'UPI', idempotencyKey: crypto.randomUUID(), ...body })

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repairs-'))
    Object.assign(process.env, {
      JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000',
      PRIVATE_UPLOAD_DIR: path.join(tmp, 'private'), UPLOAD_DIR: path.join(tmp, 'public'), REPAIR_NO_NOTIFY: '1',
    })
    q = (await import('../../src/config/database.js')).query
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
    await setSettings({ enabled: 'TRUE', b2c_enabled: 'TRUE', b2b_enabled: 'TRUE', require_advance: 'TRUE', advance_pct: 30, tax_pct: 18, diagnostic_fee: 199, platform_commission_pct: 10, default_warranty_days: 90, estimate_validity_days: 7 })
    T.admin = await mkToken('ADMIN', 'Admin')
    T.cust = await mkToken('CUSTOMER', 'Cust One')
    T.other = await mkToken('CUSTOMER', 'Cust Two')
    for (const k of ['vendA', 'vendB']) {
      const n = rand()
      const v = await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`, [`Service ${k}`, `rp-${n}`, `r${n}@x.test`, `7${n}`])
      T[k] = await mkToken('CUSTOMER', `Tech ${k}`)
      T[k].vendorId = v.rows[0].id
      await q(`INSERT INTO vendor_users (vendor_id, user_id, role) VALUES ($1,$2,'VENDOR_OWNER')`, [T[k].vendorId, T[k].id])
    }
  }, 60000)
  afterAll(async () => {
    await setSettings({ enabled: 'TRUE', b2c_enabled: 'TRUE', b2b_enabled: 'TRUE' }).catch(() => {})
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // ── B2C happy path ────────────────────────────────────────────────────
  describe('B2C: book → repair → deliver', () => {
    let id, req
    it('customer books a repair with a photo; it starts REQUESTED', async () => {
      const m = multipart('crack.png', 'image/png', PNG)
      const up = await app.inject({ method: 'POST', url: `${C}/media`, headers: auth(T.cust, m.headers), payload: m.payload })
      expect(up.statusCode).toBe(201)
      const photo = up.json().data.files[0].media
      const created = await call('POST', C, T.cust, b2c({ mediaIds: [photo.id] }))
      expect(created.status, JSON.stringify(created.body)).toBe(201)
      id = created.data.id
      expect(created.data).toMatchObject({ channel: 'B2C', status: 'REQUESTED', business: null })
      expect(created.data.code).toMatch(/^REP-\d+$/)
      expect(created.data.media).toHaveLength(1)
      expect(created.data.sla.inspectionDue).toBeTruthy()
      // the photo is served through its signed link
      const file = await app.inject({ method: 'GET', url: created.data.media[0].url })
      expect(file.statusCode).toBe(200)
      expect(file.headers['content-type']).toBe('image/png')
    })

    it('the customer sees it; another customer and other service centres do not', async () => {
      expect((await call('GET', `${C}/${id}`, T.cust)).status).toBe(200)
      expect((await call('GET', `${C}/${id}`, T.other)).status).toBe(404)
      expect((await call('GET', `${M}/${id}`, T.vendA)).status).toBe(404)    // not assigned yet
      const mine = await call('GET', `${C}/mine`, T.cust)
      expect(mine.data.items.map((i) => i.id)).toContain(id)
      expect((await call('GET', `${C}/mine`, T.other)).data.items.map((i) => i.id)).not.toContain(id)
    })

    it('rejects every skipped step', async () => {
      for (const action of ['start', 'send-to-qc', 'ready', 'deliver', 'fail', 'receive']) {
        const r = await call('POST', `${M}/${id}/${action}`, T.admin, { reason: 'x' })
        expect(r.status, action).toBe(409)
      }
      expect((await call('POST', `${C}/${id}/approve-estimate`, T.cust)).status).toBe(409)   // no estimate yet
    })

    it('only platform staff can accept; the customer and service centres cannot', async () => {
      expect((await call('POST', `${M}/${id}/accept`, T.cust)).status).toBe(403)
      expect((await call('POST', `${M}/${id}/accept`, T.vendA)).status).toBe(403)
      const ok = await call('POST', `${M}/${id}/accept`, T.admin, { vendorId: T.vendA.vendorId, technicianId: T.vendA.id })
      expect(ok.status, JSON.stringify(ok.body)).toBe(200)
      expect(ok.data).toMatchObject({ status: 'ACCEPTED', serviceCenterId: T.vendA.vendorId })
      expect(ok.data.technician).toBe('Tech vendA')
    })

    it('the assigned service centre sees it; a different one does not', async () => {
      expect((await call('GET', `${M}/${id}`, T.vendA)).status).toBe(200)
      expect((await call('GET', `${M}/${id}`, T.vendB)).status).toBe(404)
      expect((await call('POST', `${M}/${id}/receive`, T.vendB)).status).toBe(404)
      expect((await call('POST', `${M}/${id}/receive`, T.cust)).status).toBe(403)
    })

    it('service centre receives the device and records a diagnosis', async () => {
      expect((await call('POST', `${M}/${id}/receive`, T.vendA)).data.status).toBe('INSPECTION')
      const cur = (await call('GET', `${M}/${id}`, T.vendA)).data
      expect((await call('POST', `${M}/${id}/items/${cur.items[0].id}/diagnosis`, T.vendA, { diagnosis: '' })).status).toBe(422)
      const dx = await call('POST', `${M}/${id}/items/${cur.items[0].id}/diagnosis`, T.vendA, { diagnosis: 'Digitizer broken, LCD fine' })
      expect(dx.data.items[0].diagnosis).toMatch(/Digitizer/)
    })

    it('the server prices the estimate: client totals are ignored, tax comes from settings', async () => {
      const cur = (await call('GET', `${M}/${id}`, T.vendA)).data
      const item = cur.items[0]
      expect((await call('POST', `${M}/${id}/quotes`, T.vendA, { lines: [] })).status).toBe(422)
      expect((await call('POST', `${M}/${id}/quotes`, T.vendA, { lines: [{ itemId: item.id, kind: 'LABOUR', description: 'ok', qty: 1, unitPrice: -5 }] })).status).toBe(422)
      expect((await call('POST', `${M}/${id}/quotes`, T.vendA, { lines: [{ itemId: item.id, kind: 'HACK', description: 'ok', qty: 1, unitPrice: 5 }] })).status).toBe(422)
      expect((await call('POST', `${M}/${id}/quotes`, T.vendA, { lines: [{ kind: 'PART', description: 'only a part, no device line', qty: 1, unitPrice: 5 }] })).status).toBe(422)
      const res = await call('POST', `${M}/${id}/quotes`, T.vendA, {
        total: 1, subtotal: 1, taxAmount: 0,                                    // ignored
        lines: [{ itemId: item.id, kind: 'LABOUR', description: 'Screen replacement', qty: 1, unitPrice: 800 }, { itemId: item.id, kind: 'PART', description: 'OEM display', qty: 1, unitPrice: 1200 }],
      })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      req = res.data
      expect(req.status).toBe('ESTIMATE_SENT')
      expect(req.quotes[0]).toMatchObject({ version: 1, status: 'SENT', subtotal: 2000, discountAmount: 0, taxAmount: 360, total: 2360 })
    })

    it('a revised estimate supersedes the old one', async () => {
      const cur = (await call('GET', `${M}/${id}`, T.vendA)).data
      const res = await call('POST', `${M}/${id}/quotes`, T.vendA, { lines: [{ itemId: cur.items[0].id, kind: 'LABOUR', description: 'Screen replacement', qty: 1, unitPrice: 1000 }] })
      expect(res.data.status).toBe('ESTIMATE_SENT')
      expect(res.data.quotes.map((x) => [x.version, x.status])).toEqual([[2, 'SENT'], [1, 'SUPERSEDED']])
      expect(res.data.quotes[0].total).toBe(1180)
    })

    it('only the customer (or staff on their behalf, with a reference) can approve', async () => {
      expect((await call('POST', `${C}/${id}/approve-estimate`, T.other)).status).toBe(404)
      expect((await call('POST', `${M}/${id}/approve-estimate`, T.vendA)).status).toBe(403)
      expect((await call('POST', `${M}/${id}/approve-estimate`, T.admin, {})).status).toBe(422)   // reference required
      const ok = await call('POST', `${C}/${id}/approve-estimate`, T.cust)
      expect(ok.status, JSON.stringify(ok.body)).toBe(200)
      expect(ok.data.status).toBe('ESTIMATE_APPROVED')
      expect(ok.data.money).toMatchObject({ approvedTotal: 1180, advanceRequired: 354, amountPaid: 0, amountDue: 1180 })
    })

    it('work cannot start until the advance is paid; payments are exact and idempotent', async () => {
      const blocked = await call('POST', `${M}/${id}/start`, T.vendA)
      expect(blocked.status).toBe(409)
      expect(blocked.body.code).toBe('ADVANCE_REQUIRED')
      // service centres and customers cannot record money
      expect((await call('POST', `${M}/${id}/payments`, T.vendA, { kind: 'ADVANCE', method: 'CASH', amount: 354, idempotencyKey: 'abcdefgh1' })).status).toBe(403)
      expect((await call('POST', `${M}/${id}/payments`, T.cust, { kind: 'ADVANCE', method: 'CASH', amount: 354, idempotencyKey: 'abcdefgh1' })).status).toBe(403)
      expect((await pay(id, { kind: 'ADVANCE', amount: 5000 })).body.code).toBe('OVERPAYMENT')
      expect((await pay(id, { kind: 'ADVANCE', amount: 0 })).status).toBe(422)
      expect((await pay(id, { kind: 'ADVANCE', amount: 10.005 })).status).toBe(422)
      expect((await pay(id, { kind: 'NOPE', amount: 10 })).status).toBe(422)
      const key = crypto.randomUUID()
      const first = await pay(id, { kind: 'ADVANCE', amount: 354, idempotencyKey: key })
      expect(first.data.money.amountPaid).toBe(354)
      const replay = await pay(id, { kind: 'ADVANCE', amount: 354, idempotencyKey: key })
      expect(replay.status).toBe(200)
      expect(replay.data.duplicate).toBe(true)
      expect(replay.data.money.amountPaid).toBe(354)                                  // not 708
      expect((await q(`SELECT COUNT(*)::int AS n FROM repair_payments WHERE request_id = $1`, [id])).rows[0].n).toBe(1)
    })

    it('starts, goes to QC, and a QC failure sends it back for rework', async () => {
      expect((await call('POST', `${M}/${id}/start`, T.vendA)).data.status).toBe('IN_REPAIR')
      expect((await call('POST', `${M}/${id}/send-to-qc`, T.vendA)).data.status).toBe('QC_PENDING')
      const cur = (await call('GET', `${M}/${id}`, T.vendA)).data
      const iid = cur.items[0].id
      expect((await call('POST', `${M}/${id}/qc`, T.vendA, { results: [] })).status).toBe(422)
      expect((await call('POST', `${M}/${id}/qc`, T.vendA, { results: [{ itemId: iid, passed: false }] })).status).toBe(422)   // fail needs a reason
      const fail = await call('POST', `${M}/${id}/qc`, T.vendA, { results: [{ itemId: iid, passed: false, notes: 'Touch lag at the edges' }] })
      expect(fail.data).toMatchObject({ status: 'IN_REPAIR', reworkCount: 1 })
      expect(fail.data.items[0]).toMatchObject({ status: 'PENDING', qcPassed: false })
      await call('POST', `${M}/${id}/send-to-qc`, T.vendA)
      const pass = await call('POST', `${M}/${id}/qc`, T.vendA, { results: [{ itemId: iid, passed: true }] })
      expect(pass.data.status).toBe('REPAIRED')
      expect(pass.data.items[0].status).toBe('REPAIRED')
    })

    it('cannot be delivered while a balance is due; then completes with warranty and commission', async () => {
      expect((await call('POST', `${M}/${id}/ready`, T.vendA)).data.status).toBe('READY_FOR_DELIVERY')
      const blocked = await call('POST', `${M}/${id}/deliver`, T.vendA)
      expect(blocked.status).toBe(409)
      expect(blocked.body).toMatchObject({ code: 'PAYMENT_DUE', due: 826 })
      expect((await pay(id, { kind: 'BALANCE', amount: 826, method: 'COD' })).data.money.amountDue).toBe(0)
      const done = await call('POST', `${M}/${id}/deliver`, T.vendA)
      expect(done.status, JSON.stringify(done.body)).toBe(200)
      expect(done.data.status).toBe('COMPLETED')
      const warranty = new Date(); warranty.setUTCDate(warranty.getUTCDate() + 90)
      expect(done.data.warrantyUntil).toBe(warranty.toISOString().slice(0, 10))
      expect(done.data.settlement).toEqual({ commissionPct: 10, commission: 100, vendorPayable: 900 })   // on the pre-tax ₹1000
      const mine = (await call('GET', `${C}/${id}`, T.cust)).data
      expect(mine.settlement).toBeUndefined()                                          // customers never see the split
      expect(mine.timeline.map((t) => t.to).filter(Boolean)).toEqual(expect.arrayContaining(['ACCEPTED', 'INSPECTION', 'ESTIMATE_SENT', 'ESTIMATE_APPROVED', 'IN_REPAIR', 'QC_PENDING', 'REPAIRED', 'READY_FOR_DELIVERY', 'COMPLETED']))
    })

    it('warranty: the customer can reopen within the period, not after it, and not twice at once', async () => {
      const r = await call('POST', `${C}/${id}/reopen`, T.cust, { reason: 'Screen flickers again' })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(r.data).toMatchObject({ status: 'IN_REPAIR', reopenedCount: 1 })
      expect((await call('POST', `${C}/${id}/reopen`, T.cust, { reason: 'again' })).status).toBe(409)
      // finish it again, then let the warranty lapse
      await call('POST', `${M}/${id}/send-to-qc`, T.vendA)
      const cur = (await call('GET', `${M}/${id}`, T.vendA)).data
      await call('POST', `${M}/${id}/qc`, T.vendA, { results: [{ itemId: cur.items[0].id, passed: true }] })
      await call('POST', `${M}/${id}/ready`, T.vendA)
      expect((await call('POST', `${M}/${id}/deliver`, T.vendA)).data.status).toBe('COMPLETED')
      await q(`UPDATE repair_requests SET warranty_until = CURRENT_DATE - 1 WHERE id = $1`, [id])
      const late = await call('POST', `${C}/${id}/reopen`, T.cust, { reason: 'late' })
      expect(late.status).toBe(409)
      expect(late.body.code).toBe('WARRANTY_EXPIRED')
    })
  })

  // ── other exits ───────────────────────────────────────────────────────
  describe('rejection, cancellation and failure', () => {
    it('customer can cancel before the device arrives, not after; a closed request cannot move', async () => {
      const a = await call('POST', C, T.cust, b2c())
      expect((await call('POST', `${C}/${a.data.id}/cancel`, T.cust, {})).status).toBe(422)   // reason required
      expect((await call('POST', `${C}/${a.data.id}/cancel`, T.other, { reason: 'x' })).status).toBe(404)
      expect((await call('POST', `${C}/${a.data.id}/cancel`, T.cust, { reason: 'Found it under the sofa' })).data.status).toBe('CANCELLED')
      expect((await call('POST', `${M}/${a.data.id}/accept`, T.admin)).status).toBe(409)
      const b = await toEstimate(T.cust, b2c())
      expect((await call('POST', `${C}/${b.id}/cancel`, T.cust, { reason: 'x' })).status).toBe(409)   // device is in the shop
    })

    it('admin can reject a new request with a reason', async () => {
      const a = await call('POST', C, T.cust, b2c())
      expect((await call('POST', `${M}/${a.data.id}/reject`, T.admin, {})).status).toBe(422)
      const r = await call('POST', `${M}/${a.data.id}/reject`, T.admin, { reason: 'Device model not supported' })
      expect(r.data).toMatchObject({ status: 'REJECTED', note: 'Device model not supported' })
    })

    it('estimate rejected: only the diagnostic fee is due, then the device is returned', async () => {
      const { id } = await toEstimate(T.cust, b2c())
      const rej = await call('POST', `${C}/${id}/reject-estimate`, T.cust, { reason: 'Too expensive' })
      expect(rej.data.status).toBe('ESTIMATE_REJECTED')
      expect(rej.data.money).toMatchObject({ approvedTotal: 199, amountDue: 199 })
      await call('POST', `${M}/${id}/ready`, T.vendA)
      expect((await call('POST', `${M}/${id}/deliver`, T.vendA)).body.code).toBe('PAYMENT_DUE')
      await pay(id, { kind: 'DIAGNOSTIC', amount: 199, method: 'CASH' })
      const done = await call('POST', `${M}/${id}/deliver`, T.vendA)
      expect(done.data.status).toBe('COMPLETED')
      expect(done.data.warrantyUntil).toBeNull()                                         // nothing was repaired
      expect(done.data.settlement).toBeNull()
    })

    it('in-warranty devices pay no diagnostic fee', async () => {
      const { id } = await toEstimate(T.cust, b2c({ items: [device({ warrantyStatus: 'IN_WARRANTY' })] }))
      const rej = await call('POST', `${C}/${id}/reject-estimate`, T.cust, { reason: 'No thanks' })
      expect(rej.data.money).toMatchObject({ approvedTotal: 0, amountDue: 0 })
    })

    it('an unrepairable device ends as FAILED and is returned; an advance already paid must be refunded first', async () => {
      const { id } = await toEstimate(T.cust, b2c())
      await call('POST', `${C}/${id}/approve-estimate`, T.cust)
      await pay(id, { kind: 'ADVANCE', amount: 354 })
      await call('POST', `${M}/${id}/start`, T.vendA)
      expect((await call('POST', `${M}/${id}/fail`, T.vendA, {})).status).toBe(422)
      const f = await call('POST', `${M}/${id}/fail`, T.vendA, { reason: 'Board is corroded beyond repair' })
      expect(f.data.status).toBe('FAILED')
      expect(f.data.items[0].status).toBe('FAILED')
      expect(f.data.money).toMatchObject({ approvedTotal: 199, amountPaid: 354, refundable: 155 })
      await call('POST', `${M}/${id}/ready`, T.vendA)
      expect((await call('POST', `${M}/${id}/deliver`, T.vendA)).body.code).toBe('REFUND_PENDING')
      expect((await pay(id, { kind: 'REFUND', amount: 155 })).status).toBe(422)                      // reason required
      expect((await pay(id, { kind: 'REFUND', amount: 500, note: 'too much' })).body.code).toBe('REFUND_TOO_HIGH')
      expect((await pay(id, { kind: 'REFUND', amount: 155, note: 'Advance returned' })).data.money).toMatchObject({ amountPaid: 199, refundable: 0 })
      expect((await call('POST', `${M}/${id}/deliver`, T.vendA)).data.status).toBe('COMPLETED')
    })

    it('an expired estimate cannot be approved', async () => {
      const { id } = await toEstimate(T.cust, b2c())
      await q(`UPDATE repair_quotes SET valid_until = NOW() - INTERVAL '1 hour' WHERE request_id = $1`, [id])
      const r = await call('POST', `${C}/${id}/approve-estimate`, T.cust)
      expect(r.status).toBe(409)
      expect(r.body.code).toBe('QUOTE_EXPIRED')
      expect((await call('GET', `${C}/${id}`, T.cust)).data.quotes[0].expired).toBe(true)
    })
  })

  // ── B2B ───────────────────────────────────────────────────────────────
  describe('B2B bulk repairs', () => {
    it('needs business details and a valid GSTIN; consumers are limited to a few devices', async () => {
      expect((await call('POST', C, T.cust, b2bBody(2, { gstin: 'BADGSTIN' }))).status).toBe(422)
      expect((await call('POST', C, T.cust, b2bBody(2, { businessName: '' }))).status).toBe(422)
      expect((await call('POST', C, T.cust, b2bBody(2, { contactPerson: '' }))).status).toBe(422)
      expect((await call('POST', C, T.cust, b2c({ items: Array.from({ length: 4 }, () => device()) }))).status).toBe(422)
      const dup = imei()
      expect((await call('POST', C, T.cust, b2bBody(0, { items: [device({ imeiSerial: dup }), device({ imeiSerial: dup })] }))).status).toBe(422)
      expect((await call('POST', C, T.cust, b2c({ items: [] }))).status).toBe(422)
      const ok = await call('POST', C, T.cust, b2bBody(25))
      expect(ok.status).toBe(201)
      expect(ok.data).toMatchObject({ channel: 'B2B', deviceCount: 25, business: { name: 'Acme Retail Pvt Ltd', poReference: 'PO-77' } })
    })

    it('one live repair per physical device', async () => {
      const serial = imei()
      expect((await call('POST', C, T.cust, b2c({ items: [device({ imeiSerial: serial })] }))).status).toBe(201)
      const again = await call('POST', C, T.other, b2c({ items: [device({ imeiSerial: serial })] }))
      expect(again.status).toBe(409)
      expect(again.body.code).toBe('DEVICE_ACTIVE')
    })

    it('every repairable device must be priced', async () => {
      const created = await call('POST', C, T.cust, b2bBody(3))
      const id = created.data.id
      await call('POST', `${M}/${id}/accept`, T.admin, { vendorId: T.vendA.vendorId })
      await call('POST', `${M}/${id}/receive`, T.vendA)
      const cur = (await call('GET', `${M}/${id}`, T.vendA)).data
      const partial = await call('POST', `${M}/${id}/quotes`, T.vendA, { lines: labour(cur.items.slice(0, 2)) })
      expect(partial.status).toBe(422)
      expect(partial.body.code).toBe('UNPRICED_DEVICE')
      // marking the third device unrepairable removes the need to price it
      await call('POST', `${M}/${id}/items/${cur.items[2].id}/diagnosis`, T.vendA, { diagnosis: 'Dead board', repairable: false })
      expect((await call('POST', `${M}/${id}/quotes`, T.vendA, { lines: labour(cur.items.slice(0, 2)) })).status).toBe(200)
    })

    it('contract discount and credit terms apply: no advance, partial delivery, due date, overdue, collections', async () => {
      const gstin = GSTIN()
      expect((await call('PUT', `${M}/config/terms`, T.admin, { gstin, businessName: 'Credit Co', discountPct: 10, paymentTermsDays: 30, creditLimit: 0 })).status).toBe(422)   // terms need a limit
      const t = await call('PUT', `${M}/config/terms`, T.admin, { gstin, businessName: 'Credit Co', discountPct: 10, paymentTermsDays: 30, creditLimit: 100000 })
      expect(t.status, JSON.stringify(t.body)).toBe(200)
      const { id, req } = await toEstimate(T.cust, b2bBody(3, { gstin, businessName: 'Credit Co' }), 1000)
      expect(req.business).toMatchObject({ contractDiscountPct: 10, paymentTermsDays: 30 })
      expect(req.quotes[0]).toMatchObject({ subtotal: 3000, discountAmount: 300, taxable: 2700, taxAmount: 486, total: 3186 })

      expect((await call('POST', `${M}/${id}/approve-estimate`, T.admin, {})).status).toBe(422)
      const ap = await call('POST', `${M}/${id}/approve-estimate`, T.admin, { note: 'Approved by Priya (priya@credit.co) vs PO-77' })
      expect(ap.data.money).toMatchObject({ approvedTotal: 3186, advanceRequired: 0 })
      expect((await call('POST', `${M}/${id}/start`, T.vendA)).data.status).toBe('IN_REPAIR')   // no advance needed on credit
      await call('POST', `${M}/${id}/send-to-qc`, T.vendA)
      const cur = (await call('GET', `${M}/${id}`, T.vendA)).data
      await call('POST', `${M}/${id}/qc`, T.vendA, { results: cur.items.map((i) => ({ itemId: i.id, passed: true })) })
      await call('POST', `${M}/${id}/ready`, T.vendA)

      const p1 = await call('POST', `${M}/${id}/deliver`, T.vendA, { itemIds: [cur.items[0].id] })
      expect(p1.data.status).toBe('READY_FOR_DELIVERY')
      expect(p1.data).toMatchObject({ deliveredCount: 1, deviceCount: 3 })
      expect((await call('POST', `${M}/${id}/deliver`, T.vendA, { itemIds: [cur.items[0].id] })).status).toBe(422)   // already delivered
      const p2 = await call('POST', `${M}/${id}/deliver`, T.vendA)
      expect(p2.data.status).toBe('COMPLETED')
      expect(p2.data.money.amountDue).toBe(3186)                                                   // delivered on credit
      const due = new Date(); due.setUTCDate(due.getUTCDate() + 30)
      expect(p2.data.money.dueDate).toBe(due.toISOString().slice(0, 10))
      expect(p2.data.money.overdue).toBe(false)

      await q(`UPDATE repair_requests SET due_date = CURRENT_DATE - 2 WHERE id = $1`, [id])
      expect((await call('GET', `${M}/${id}`, T.admin)).data.money.overdue).toBe(true)
      const overdue = await call('GET', `${M}?overdue=1`, T.admin)
      expect(overdue.data.items.map((i) => i.id)).toContain(id)
      expect((await call('GET', `${M}/stats`, T.admin)).data.overdue).toBeGreaterThanOrEqual(1)

      // collections arrive in parts
      expect((await pay(id, { kind: 'BALANCE', amount: 1000, method: 'BANK', reference: 'UTR1' })).data.money.amountDue).toBe(2186)
      expect((await pay(id, { kind: 'BALANCE', amount: 2186, method: 'BANK', reference: 'UTR2' })).data.money).toMatchObject({ amountDue: 0, overdue: false })
    })

    it('a business cannot exceed its credit limit', async () => {
      const gstin = GSTIN()
      await call('PUT', `${M}/config/terms`, T.admin, { gstin, businessName: 'Tiny Credit', paymentTermsDays: 15, creditLimit: 1500 })
      const { id } = await toEstimate(T.cust, b2bBody(2, { gstin, businessName: 'Tiny Credit' }), 1000)   // total 2360
      const r = await call('POST', `${M}/${id}/approve-estimate`, T.admin, { note: 'Approved by owner' })
      expect(r.status).toBe(409)
      expect(r.body.code).toBe('CREDIT_LIMIT')
    })

    it('without credit terms a business pays the advance like anyone else', async () => {
      const { id } = await toEstimate(T.cust, b2bBody(2), 1000)
      const ap = await call('POST', `${M}/${id}/approve-estimate`, T.admin, { note: 'Approved by owner via email' })
      expect(ap.data.money.advanceRequired).toBe(708)                                                // 30% of 2360
      expect((await call('POST', `${M}/${id}/start`, T.vendA)).body.code).toBe('ADVANCE_REQUIRED')
    })
  })

  // ── money safety ──────────────────────────────────────────────────────
  describe('payments', () => {
    it('parallel replays of the same payment record exactly one', async () => {
      const { id } = await toEstimate(T.cust, b2c())
      await call('POST', `${C}/${id}/approve-estimate`, T.cust)
      const key = crypto.randomUUID()
      const results = await Promise.all(Array.from({ length: 6 }, () => pay(id, { kind: 'ADVANCE', amount: 100, idempotencyKey: key })))
      expect(results.every((r) => r.status === 200)).toBe(true)
      expect((await q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS s FROM repair_payments WHERE request_id = $1`, [id])).rows[0]).toMatchObject({ n: 1, s: '100.00' })
      expect((await q(`SELECT amount_paid FROM repair_requests WHERE id = $1`, [id])).rows[0].amount_paid).toBe('100.00')
    })

    it('parallel different payments can never exceed what is due', async () => {
      const { id } = await toEstimate(T.cust, b2c())
      await call('POST', `${C}/${id}/approve-estimate`, T.cust)                                     // total 1180
      const results = await Promise.all(Array.from({ length: 5 }, () => pay(id, { kind: 'BALANCE', amount: 500 })))
      const okCount = results.filter((r) => r.status === 200).length
      expect(okCount).toBe(2)                                                                         // 500 + 500; the third would exceed 1180
      expect((await q(`SELECT amount_paid FROM repair_requests WHERE id = $1`, [id])).rows[0].amount_paid).toBe('1000.00')
    })

    it('payments and refunds are append-only; no payments before an estimate is approved', async () => {
      const a = await call('POST', C, T.cust, b2c())
      expect((await pay(a.data.id, { kind: 'ADVANCE', amount: 100 })).status).toBe(409)
      const { id } = await toEstimate(T.cust, b2c())
      await call('POST', `${C}/${id}/approve-estimate`, T.cust)
      await pay(id, { kind: 'ADVANCE', amount: 100 })
      await expect(q(`UPDATE repair_payments SET amount = 1 WHERE request_id = $1`, [id])).rejects.toThrow(/append-only/)
      await expect(q(`DELETE FROM repair_payments WHERE request_id = $1`, [id])).rejects.toThrow(/append-only/)
      await expect(q(`UPDATE repair_events SET label = 'x' WHERE request_id = $1`, [id])).rejects.toThrow(/append-only/)
    })
  })

  // ── lists, stats, config ──────────────────────────────────────────────
  describe('dashboard reads and configuration', () => {
    it('lists by channel and queue, searches by PO and IMEI, and reports stats', async () => {
      const serial = imei()
      const po = `PO-${crypto.randomUUID().slice(0, 8)}`
      const biz = await call('POST', C, T.cust, b2bBody(1, { poReference: po, items: [device({ imeiSerial: serial })] }))
      const onlyB2b = await call('GET', `${M}?channel=B2B&limit=100`, T.admin)
      expect(onlyB2b.data.items.every((r) => r.channel === 'B2B')).toBe(true)
      expect(onlyB2b.data.items.map((r) => r.id)).toContain(biz.data.id)
      expect((await call('GET', `${M}?q=${po}`, T.admin)).data.items.map((r) => r.id)).toEqual([biz.data.id])
      expect((await call('GET', `${M}?q=${serial}`, T.admin)).data.items.map((r) => r.id)).toEqual([biz.data.id])
      const queue = await call('GET', `${M}?tab=new&limit=100`, T.admin)
      expect(queue.data.items.every((r) => r.status === 'REQUESTED')).toBe(true)
      expect(queue.data.counts.all).toBeGreaterThan(5)
      expect((await call('GET', `${M}?tab=bogus`, T.admin)).status).toBe(422)
      const st = (await call('GET', `${M}/stats`, T.admin)).data
      expect(st.total).toBe(st.b2b + st.b2c)
    })

    it('service centres only list their own jobs; customers cannot open the dashboard API', async () => {
      const a = await call('GET', `${M}?limit=100`, T.vendA)
      expect(a.status).toBe(200)
      expect(a.data.items.every((r) => r.serviceCenterId === T.vendA.vendorId)).toBe(true)
      const b = await call('GET', `${M}?limit=100`, T.vendB)
      expect(b.data.items).toHaveLength(0)
      for (const url of [M, `${M}/stats`, `${M}/config/settings`]) expect((await call('GET', url, T.cust)).status, url).toBe(403)
      expect((await call('GET', M, { token: 'nope' })).status).toBe(401)
    })

    it('settings: validated, admin-only, and read back; services and terms are managed from the dashboard', async () => {
      expect((await call('PUT', `${M}/config/settings`, T.cust, { taxPct: 5 })).status).toBe(403)
      expect((await call('PUT', `${M}/config/settings`, T.vendA, { taxPct: 5 })).status).toBe(403)
      expect((await call('PUT', `${M}/config/settings`, T.admin, { taxPct: 99 })).status).toBe(422)
      expect((await call('PUT', `${M}/config/settings`, T.admin, { advancePct: 'abc' })).status).toBe(422)
      expect((await call('PUT', `${M}/config/settings`, T.admin, { defaultWarrantyDays: 1.5 })).status).toBe(422)
      const ok = await call('PUT', `${M}/config/settings`, T.admin, { diagnosticFee: 250, advancePct: 40, defaultWarrantyDays: 60 })
      expect(ok.data).toMatchObject({ diagnosticFee: 250, advancePct: 40, defaultWarrantyDays: 60, taxPct: 18 })
      await setSettings({ diagnostic_fee: 199, advance_pct: 30, default_warranty_days: 90 })

      const svcs = await call('GET', `${M}/config/services`, T.admin)
      expect(svcs.data.length).toBeGreaterThanOrEqual(12)
      const code = `TEST_${Date.now().toString(36).toUpperCase()}`
      expect((await call('POST', `${M}/config/services`, T.admin, { code: 'bad code', name: 'x', category: 'SCREEN', labourPrice: 1 })).status).toBe(422)
      const created = await call('POST', `${M}/config/services`, T.admin, { code, name: 'Test service', category: 'OTHER', labourPrice: 450 })
      expect(created.status, JSON.stringify(created.body)).toBe(201)
      expect((await call('POST', `${M}/config/services`, T.admin, { code, name: 'Dup', category: 'OTHER', labourPrice: 1 })).status).toBe(409)
      expect((await call('PUT', `${M}/config/services/${created.data.id}`, T.admin, { labourPrice: 500, isActive: false })).data).toMatchObject({ labourPrice: 500, isActive: false })
      // customers see only active services, plus the booking limits
      const cfg = await call('GET', `${C}/config`, T.cust)
      expect(cfg.data.services.map((s) => s.code)).not.toContain(code)
      expect(cfg.data.settings).toMatchObject({ enabled: true, maxB2cDevices: 3 })
      expect(cfg.data.settings.platformCommissionPct).toBeUndefined()                              // internal economics stay private
    })

    it('a channel can be switched off without touching the other', async () => {
      await setSettings({ b2b_enabled: 'FALSE' })
      const blocked = await call('POST', C, T.cust, b2bBody(1))
      expect(blocked.status).toBe(409)
      expect(blocked.body.code).toBe('CHANNEL_DISABLED')
      expect((await call('POST', C, T.cust, b2c())).status).toBe(201)
      await setSettings({ b2b_enabled: 'TRUE', b2c_enabled: 'FALSE' })
      expect((await call('POST', C, T.cust, b2c())).body.code).toBe('CHANNEL_DISABLED')
      expect((await call('POST', C, T.cust, b2bBody(1))).status).toBe(201)
      await setSettings({ b2c_enabled: 'TRUE', enabled: 'FALSE' })
      expect((await call('POST', C, T.cust, b2c())).body.code).toBe('DISABLED')
      await setSettings({ enabled: 'TRUE' })
    })
  })

  // ── evidence ──────────────────────────────────────────────────────────
  describe('evidence', () => {
    it('service centre adds intake/progress photos; customers cannot add staff stages; other users cannot attach someone else’s upload', async () => {
      const { id } = await toEstimate(T.cust, b2c())
      const up = async (who, base) => {
        const m = multipart('p.png', 'image/png', PNG)
        const r = await app.inject({ method: 'POST', url: `${base}/media`, headers: auth(who, m.headers), payload: m.payload })
        expect(r.statusCode).toBe(201)
        return r.json().data.files[0].media
      }
      const mine = await up(T.vendA, M)
      const ok = await call('POST', `${M}/${id}/media`, T.vendA, { mediaIds: [mine.id], stage: 'DIAGNOSIS' })
      expect(ok.status, JSON.stringify(ok.body)).toBe(200)
      expect(ok.data.media.map((m) => m.stage)).toContain('DIAGNOSIS')

      const cm = await up(T.cust, C)
      expect((await call('POST', `${C}/${id}/media`, T.cust, { mediaIds: [cm.id], stage: 'FINAL_QC' })).status).toBe(403)
      expect((await call('POST', `${C}/${id}/media`, T.cust, { mediaIds: [mine.id], stage: 'DISPUTE' })).status).toBe(404)   // not theirs
      expect((await call('POST', `${C}/${id}/media`, T.other, { mediaIds: [cm.id], stage: 'DISPUTE' })).status).toBe(404)
      expect((await call('POST', `${C}/${id}/media`, T.cust, { mediaIds: [cm.id], stage: 'DISPUTE' })).status).toBe(200)
      expect((await call('POST', `${C}/${id}/media`, T.cust, { mediaIds: [cm.id], stage: 'DISPUTE' })).status).toBe(409)       // already attached
      await expect(q(`DELETE FROM repair_media WHERE entity_id = $1`, [id])).rejects.toThrow(/cannot be deleted/)
      // unrelated service centre cannot mint a link to it
      expect((await call('GET', `${M}/media/${mine.id}/link`, T.vendB)).status).toBe(404)
      expect((await call('GET', `${M}/media/${mine.id}/link`, T.vendA)).status).toBe(200)
    })

    it('rejects files that are not really images or videos', async () => {
      const m = multipart('x.png', 'image/png', Buffer.from('<html>nope</html>'))
      const r = await app.inject({ method: 'POST', url: `${C}/media`, headers: auth(T.cust, m.headers), payload: m.payload })
      expect(r.statusCode).toBe(422)
      expect(r.json().data.files[0].code).toBe('UNSUPPORTED_MEDIA')
    })
  })
})
