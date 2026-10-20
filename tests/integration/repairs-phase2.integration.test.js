/**
 * Repair marketplace phase 2 — offer discount, estimate, technician, chat, mismatch, wallet payment, bulk (B2B). Customer posts a repair, nearby vendors quote, customer compares, selects, tracks, rates.
 * Real app over HTTP, real Postgres.
 *
 *   SELL_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=repair_test DB_USER=dealker_user \
 *   DB_PASSWORD=dealker_password_dev REDIS_HOST=localhost REDIS_PORT=6380 \
 *   JWT_ACCESS_SECRET=… JWT_REFRESH_SECRET=… COOKIE_SECRET=… SETTINGS_ENCRYPTION_KEY=… \
 *   npx vitest run tests/integration/repairs-phase2.integration.test.js
 * The database must be fully migrated (npm run db:migrate). Do not set LOG_LEVEL=silent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import jwt from 'jsonwebtoken'

const d = process.env.SELL_TEST_DB ? describe : describe.skip
const C = '/api/v1/repairs'
const M = '/api/v1/manage/repairs'
const tomorrow = () => new Date(Date.now() + 86400_000).toISOString()

d('repair marketplace phase 2', () => {
  let app, q, tmp
  const T = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const imei = () => `MK${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`.toUpperCase()
  const call = async (method, url, who, payload) => {
    const res = await app.inject({ method, url, headers: { authorization: `Bearer ${who.token}` }, payload })
    let body; try { body = res.json() } catch { body = null }
    return { status: res.statusCode, body, data: body?.data }
  }
  const mkToken = async (role, name) => {
    const { rows } = await q(`INSERT INTO users (phone, name, role) VALUES ($1,$2,$3) RETURNING id, session_version`, [`9${rand()}`, name, role])
    return { id: rows[0].id, token: jwt.sign({ id: rows[0].id, role, session_version: rows[0].session_version }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) }
  }
  const mkVendor = async (key, { lat, lng, pincode = '700001', price = null, brand = 'Apple' } = {}) => {
    const n = rand()
    const v = await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`, [`Shop ${key} ${n}`, `mk-${n}`, `m${n}@x.test`, `7${n}`])
    T[key] = await mkToken('CUSTOMER', `Owner ${key}`)
    T[key].vendorId = v.rows[0].id
    await q(`INSERT INTO vendor_users (vendor_id, user_id, role) VALUES ($1,$2,'VENDOR_OWNER')`, [T[key].vendorId, T[key].id])
    await q(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, vendor_id, is_active)
             VALUES ($1,$2,$3,'1 Main Rd','Kolkata','WB',$4,$5,$6,$7,TRUE)`, [`Shop ${key}`, `s-${n}`, `B${n.slice(0, 8)}`, pincode, lat, lng, T[key].vendorId])
    if (price) {
      const r = await call('POST', `${M}/market/services/bulk`, T[key], {
        deviceCategory: 'Smartphone', brand, model: 'iPhone 14 Pro', services: [
          { problemCategory: 'SCREEN', partsPrice: price.screenParts, labourPrice: price.screenLabour, estDaysMin: 1, estDaysMax: 2, warrantyDays: 90 },
          { problemCategory: 'BATTERY', partsPrice: price.batParts, labourPrice: 300, estDaysMin: 1, estDaysMax: 1, warrantyDays: 60 },
        ],
      })
      expect(r.status, JSON.stringify(r.body)).toBe(201)
    }
  }
  const body = (extra = {}) => ({
    channel: 'B2C', description: 'Display not working',
    items: [{ brand: 'Apple', model: 'iPhone 14 Pro', imeiSerial: imei(), problemCategories: ['SCREEN'], problemDescription: 'Display not working, touch not responding', warrantyStatus: 'OUT_OF_WARRANTY' }],
    location: { lat: 22.5726, lng: 88.3639, pincode: '700001' }, ...extra,
  })

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-phase2-'))
    Object.assign(process.env, { NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000', PRIVATE_UPLOAD_DIR: path.join(tmp, 'private'), UPLOAD_DIR: path.join(tmp, 'public'), REPAIR_NO_NOTIFY: '1' })
    q = (await import('../../src/config/database.js')).query
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
    await q(`UPDATE repair_settings SET enabled = TRUE, b2c_enabled = TRUE, marketplace_enabled = TRUE, auto_quote_enabled = TRUE, search_radius_km = 15, offer_window_hours = 24,
             max_offers = 12, require_advance = TRUE, advance_pct = 30, tax_pct = 18, platform_commission_pct = 10, default_warranty_days = 90 WHERE id = TRUE`)
    // earlier runs leave vendors behind; park them so only this run's shops are in range
    await q(`UPDATE vendors SET is_active = FALSE WHERE slug LIKE 'mk-%'`)
    T.admin = await mkToken('ADMIN', 'Admin')
    T.cust = await mkToken('CUSTOMER', 'Rahul Sharma')
    T.other = await mkToken('CUSTOMER', 'Someone Else')
    // A ≈ 1 km, B ≈ 5 km (both near); C is ~600 km away; D is near but sells nothing the customer needs.
    await mkVendor('vendA', { lat: 22.5800, lng: 88.3700, price: { screenParts: 3200, screenLabour: 800, batParts: 1500 } })
    await mkVendor('vendB', { lat: 22.6200, lng: 88.3900, price: { screenParts: 2500, screenLabour: 600, batParts: 1200 } })
    await mkVendor('vendC', { lat: 28.6139, lng: 77.2090, pincode: '110001', price: { screenParts: 1000, screenLabour: 100, batParts: 900 } })
    await mkVendor('vendD', { lat: 22.5700, lng: 88.3600 })
  }, 90000)
  afterAll(async () => { await app?.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

  const bulk = (n = 3) => ({
    channel: 'B2B', businessName: 'Acme Mobiles Pvt Ltd', gstin: '27ABCDE1234F1Z5', contactPerson: 'Rahul Sharma', description: 'Bulk screen replacement',
    items: Array.from({ length: n }, () => ({ brand: 'Apple', model: 'iPhone 14 Pro', imeiSerial: imei(), problemCategories: ['SCREEN'], warrantyStatus: 'OUT_OF_WARRANTY' })),
    location: { lat: 22.5726, lng: 88.3639, pincode: '700001' },
  })
  const till = async (x, w, steps) => { for (const s of steps) { const r = await call('POST', `${M}/${x}/${s}`, w, s === 'qc' ? undefined : {}); expect(r.status, `${s} ${JSON.stringify(r.body)}`).toBe(200) } }

  describe('offer price (discount) and estimate', () => {
    it('incoming requests carry the shop\'s own estimate from its price list', async () => {
      const r = await call('POST', C, T.cust, body())
      const inc = (await call('GET', `${M}/market/incoming?tab=all`, T.vendA)).data.items.find((i) => i.id === r.data.id)
      expect(inc.estimate).toMatchObject({ total: 4720, complete: true })
      const d = await call('GET', `${M}/market/incoming/${r.data.id}`, T.vendD)   // D has no price list
      expect(d.data.estimate).toBeNull()
    })

    it('a discount becomes a negative line, the original price is struck through, and totals follow', async () => {
      const r = await call('POST', C, T.cust, body())
      const lines = [{ kind: 'PART', description: 'Display', unitPrice: 3000, problemCategory: 'SCREEN' }, { kind: 'LABOUR', description: 'Fitting', unitPrice: 1000 }]
      expect((await call('POST', `${M}/market/incoming/${r.data.id}/offer`, T.vendD, { lines, discount: 4000 })).status).toBe(422)
      const ok = await call('POST', `${M}/market/incoming/${r.data.id}/offer`, T.vendD, { lines, discount: 500 })
      expect(ok.status, JSON.stringify(ok.body)).toBe(201)
      expect(ok.data).toMatchObject({ subtotal: 3500, taxAmount: 630, total: 4130, mrpTotal: 4720 })
      expect(ok.data.lines.at(-1)).toMatchObject({ kind: 'OTHER', unitPrice: -500 })
    })
  })

  describe('a discounted repair, end to end with chat, technician, mismatch and wallet payment', () => {
    let x, itemId, w
    it('customer picks the discounted offer; the shop sees the agreed price', async () => {
      await q(`INSERT INTO vendor_profiles (vendor_id, legal_name, gstin, address_line1, city, state, pincode) VALUES ($1,'Shop D Pvt Ltd','19ABCDE1234F1Z5','1 Main Rd','Kolkata','West Bengal','700001') ON CONFLICT (vendor_id) DO UPDATE SET legal_name = EXCLUDED.legal_name, gstin = EXCLUDED.gstin, address_line1 = EXCLUDED.address_line1, city = EXCLUDED.city, state = EXCLUDED.state, pincode = EXCLUDED.pincode`, [T.vendD.vendorId])
      const r = await call('POST', C, T.cust, body())
      x = r.data.id; itemId = r.data.items[0].id
      const lines = [{ kind: 'PART', description: 'Display', unitPrice: 1000, problemCategory: 'SCREEN', itemId }, { kind: 'LABOUR', description: 'Fitting', unitPrice: 500, itemId }]
      const o = await call('POST', `${M}/market/incoming/${x}/offer`, T.vendD, { lines, discount: 100, estDaysMin: 1, estDaysMax: 1, shopVisit: true })
      expect(o.status, JSON.stringify(o.body)).toBe(201)
      const sel = await call('POST', `${C}/${x}/offers/${o.data.id}/select`, T.cust, { fulfilment: 'SHOP_VISIT', appointmentAt: tomorrow() })
      expect(sel.status, JSON.stringify(sel.body)).toBe(200)
      w = T.vendD
      const job = (await call('GET', `${M}/${x}`, w)).data
      expect(job.selectedOffer.total).toBe(1652)   // (1500 - 100) * 1.18
      expect(job.money.agreedTotal).toBe(1652)
    })

    it('chat opens once a shop is chosen; both sides see messages and unread counts', async () => {
      expect((await call('GET', `${C}/${x}/messages`, T.other)).status).toBe(404)
      expect((await call('POST', `${C}/${x}/messages`, T.cust, { body: '   ' })).status).toBe(422)
      expect((await call('POST', `${C}/${x}/messages`, T.cust, { body: 'Is the display original?' })).status).toBe(201)
      expect((await call('GET', `${M}/${x}`, w)).data.unreadMessages).toBe(1)
      const seen = await call('GET', `${M}/${x}/messages`, w)
      expect(seen.data.messages).toEqual([expect.objectContaining({ mine: false, from: 'CUSTOMER', body: 'Is the display original?' })])
      expect((await call('GET', `${M}/${x}`, w)).data.unreadMessages).toBe(0)
      expect((await call('POST', `${M}/${x}/messages`, w, { body: 'Yes, OEM.' })).status).toBe(201)
      const mine = (await call('GET', `${C}/${x}/messages`, T.cust)).data.messages
      expect(mine.map((m) => m.mine)).toEqual([true, false])
      expect((await call('POST', `${M}/${x}/messages`, T.cust, { body: 'x' })).status).toBe(403)
    })

    it('the shop names the technician; the customer sees it', async () => {
      expect((await call('PUT', `${M}/${x}/technician`, w, { name: 'A' })).status).toBe(422)
      expect((await call('PUT', `${M}/${x}/technician`, w, { name: 'Amit Sharma', phone: '+91 98765 43210' })).status).toBe(200)
      const mine = (await call('GET', `${C}/${x}`, T.cust)).data
      expect(mine).toMatchObject({ technician: 'Amit Sharma', technicianPhone: '+91 98765 43210' })
    })

    it('shop flags a QC mismatch; only the customer can answer, once', async () => {
      await till(x, w, ['receive', 'confirm-price'])
      const m = await call('POST', `${M}/${x}/mismatch`, w, { itemId, title: 'Screen colour mismatch', note: 'Different shade' })
      expect(m.status, JSON.stringify(m.body)).toBe(200)
      const ev = m.data.timeline.find((t) => t.kind === 'QC_MISMATCH')
      expect(ev.progress).toMatchObject({ title: 'Screen colour mismatch' })
      expect((await call('POST', `${M}/${x}/mismatch`, T.cust, { title: 'x y z' })).status).toBe(403)
      expect((await call('POST', `${C}/${x}/mismatch/respond`, w, { mismatchId: ev.id, choice: 'APPROVE' })).status).toBe(404)
      expect((await call('POST', `${C}/${x}/mismatch/respond`, T.cust, { mismatchId: ev.id, choice: 'MAYBE' })).status).toBe(422)
      const ans = await call('POST', `${C}/${x}/mismatch/respond`, T.cust, { mismatchId: ev.id, choice: 'APPROVE' })
      expect(ans.status, JSON.stringify(ans.body)).toBe(200)
      expect(ans.data.timeline.find((t) => t.kind === 'QC_MISMATCH_RESPONSE').response).toMatchObject({ mismatchId: ev.id, choice: 'APPROVE' })
      expect((await call('POST', `${C}/${x}/mismatch/respond`, T.cust, { mismatchId: ev.id, choice: 'REPLACE' })).status).toBe(409)
    })

    it('before/after photos ride on the progress update', async () => {
      const up = async () => {
        const fd = new FormData(); fd.append('files', new Blob([Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc000000301010018dd8db00000000049454e44ae426082', 'hex')], { type: 'image/png' }), 'a.png')
        const res = await app.inject({ method: 'POST', url: `${M}/media`, headers: { authorization: `Bearer ${w.token}` }, payload: fd })
        return res
      }
      void up
      const upd = await call('POST', `${M}/${x}/update`, w, { stage: 'REPAIR_IN_PROGRESS', issue: 'SCREEN', issueStatus: 'STARTED', itemId, note: 'Started' })
      expect(upd.status, JSON.stringify(upd.body)).toBe(200)
    })

    it('the customer pays the advance from the wallet; the balance cannot be paid twice', async () => {
      const opt = await call('GET', `${C}/${x}/pay`, T.cust)
      expect(opt.status).toBe(200)
      expect(opt.data.payNow).toMatchObject({ kind: 'ADVANCE' })
      expect(opt.data.methods).toMatchObject({ online: false, wallet: true })
      const low = await call('POST', `${C}/${x}/pay/wallet`, T.cust, { idempotencyKey: 'wallet-test-0001' })
      expect(low.body.code).toBe('INSUFFICIENT_WALLET')
      await q(`INSERT INTO wallets (user_id, balance) VALUES ($1, 5000) ON CONFLICT (user_id) DO UPDATE SET balance = 5000`, [T.cust.id])
      const paid = await call('POST', `${C}/${x}/pay/wallet`, T.cust, { idempotencyKey: 'wallet-test-0001' })
      expect(paid.status, JSON.stringify(paid.body)).toBe(200)
      expect(paid.data.money.amountPaid).toBe(opt.data.payNow.amount)
      const again = await call('POST', `${C}/${x}/pay/wallet`, T.cust, { idempotencyKey: 'wallet-test-0001' })
      expect(again.data.money.amountPaid, 'same key must not pay twice').toBeGreaterThanOrEqual(opt.data.payNow.amount)
      const bal = (await q(`SELECT balance FROM wallets WHERE user_id = $1`, [T.cust.id])).rows[0].balance
      expect(Number(bal)).toBeLessThan(5000)
      expect((await call('POST', `${C}/${x}/pay/wallet`, w, { idempotencyKey: 'wallet-test-0002' })).status).toBe(404)
      expect((await call('POST', `${C}/${x}/pay/razorpay/order`, T.cust)).body.code).toBe('PAYMENTS_UNAVAILABLE')
    })

    it('finishes: repair, ready, balance paid, delivered — and the discount appears on the invoice', async () => {
      const adv = (await call('GET', `${M}/${x}`, w)).data.money
      if (adv.amountPaid < adv.advanceRequired) await call('POST', `${M}/${x}/payments`, w, { kind: 'ADVANCE', method: 'CASH', amount: adv.advanceRequired - adv.amountPaid, idempotencyKey: crypto.randomUUID() })
      await till(x, w, ['start'])
      await till(x, w, ['send-to-qc'])
      expect((await call('POST', `${M}/${x}/qc`, w, { results: [{ itemId, passed: true }] })).status).toBe(200)
      await till(x, w, ['ready'])
      const cur = (await call('GET', `${M}/${x}`, w)).data
      if (cur.money.amountDue > 0) await call('POST', `${M}/${x}/payments`, w, { kind: 'BALANCE', method: 'CASH', amount: cur.money.amountDue, idempotencyKey: crypto.randomUUID() })
      const fin = await call('POST', `${M}/${x}/deliver`, w)
      expect(fin.status, JSON.stringify(fin.body)).toBe(200)
      expect(fin.data.status).toBe('COMPLETED')
      const total = (await call('GET', `${C}/${x}`, T.cust)).data
      expect(total.money.approvedTotal).toBe(1652)
      expect(total.invoice, 'an invoice is issued on completion').toBeTruthy()
    })
  })

  describe('bulk (business) repairs quote like consumer ones', () => {
    it('a business request with several devices gets live quotes and can be accepted', async () => {
      const r = await call('POST', C, T.cust, bulk(3))
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      expect(r.data).toMatchObject({ channel: 'B2B', flow: 'MARKETPLACE', deviceCount: 3 })
      expect(r.data.offerCount).toBeGreaterThan(0)
      const offers = (await call('GET', `${C}/${r.data.id}/offers`, T.cust)).data.offers
      const a = offers.find((o) => o.vendorId === T.vendA.vendorId)
      expect(a.subtotal).toBe(12000)   // 3 × (3200 + 800)
      const inc = (await call('GET', `${M}/market/incoming?tab=all`, T.vendA)).data.items.find((i) => i.id === r.data.id)
      expect(inc).toMatchObject({ channel: 'B2B', businessName: 'Acme Mobiles Pvt Ltd', deviceCount: 3 })
      const sel = await call('POST', `${C}/${r.data.id}/offers/${a.id}/select`, T.cust, { fulfilment: 'SHOP_VISIT', appointmentAt: tomorrow() })
      expect(sel.status, JSON.stringify(sel.body)).toBe(200)
    })

    it('business details are still validated', async () => {
      const bad = await call('POST', C, T.cust, { ...bulk(2), gstin: 'nope' })
      expect(bad.status).toBe(422)
    })
  })
})
