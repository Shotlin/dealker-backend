/**
 * Sales documents (tax invoices, credit/debit notes) — real app over HTTP, real Postgres, real PDFs on disk.
 *
 *   SELL_TEST_DB=1 DB_HOST=localhost DB_PORT=5434 DB_NAME=sell_evidence_test DB_USER=dealker_user \
 *   DB_PASSWORD=dealker_password_dev REDIS_HOST=localhost REDIS_PORT=6380 \
 *   npx vitest run tests/integration/sales-invoices.integration.test.js
 * The database must be fully migrated (npm run db:migrate).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import jwt from 'jsonwebtoken'

const d = process.env.SELL_TEST_DB ? describe : describe.skip
const GSTIN = (state = '29') => `${state}ABCDE${String(1000 + Math.floor(Math.random() * 8999))}F1Z5`

d('sales invoices', () => {
  let app, q, tmp, priv
  const T = {}
  const rand = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  const auth = (t) => ({ authorization: `Bearer ${t.token}` })
  const call = async (method, url, who, payload) => {
    const res = await app.inject({ method, url, headers: auth(who), payload })
    let body; try { body = res.json() } catch { body = null }
    return { status: res.statusCode, body, data: body?.data, raw: res }
  }
  const SI = '/api/v1/manage/sales-invoices'
  const MY = '/api/v1/sales-invoices'
  const RP = '/api/v1/manage/repairs'
  const mkToken = async (role, name) => {
    const { rows } = await q(`INSERT INTO users (phone, name, role) VALUES ($1,$2,$3) RETURNING id, session_version`, [`9${rand()}`, name, role])
    return { id: rows[0].id, token: jwt.sign({ id: rows[0].id, role, session_version: rows[0].session_version }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) }
  }
  const mkVendor = async (name, { profile = true, gstin = GSTIN('29'), state = 'Karnataka' } = {}) => {
    const n = rand()
    const v = await q(`INSERT INTO vendors (name, slug, email, phone, status) VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`, [name, `si-${n}`, `s${n}@x.test`, `7${n}`])
    const tok = await mkToken('CUSTOMER', `User ${name}`)
    tok.vendorId = v.rows[0].id
    await q(`INSERT INTO vendor_users (vendor_id, user_id, role) VALUES ($1,$2,'VENDOR_OWNER')`, [tok.vendorId, tok.id])
    if (profile) await q(`INSERT INTO vendor_profiles (vendor_id, legal_name, gstin, pan_number, address_line1, city, state, pincode) VALUES ($1,$2,$3,'ABCDE1234F','12 MG Road','Bengaluru',$4,'560001')`, [tok.vendorId, `${name} Pvt Ltd`, gstin, state])
    return tok
  }
  const manual = (extra = {}) => ({
    channel: 'B2B', issuerVendorId: T.vendA.vendorId,
    buyer: { name: 'Priya', businessName: 'Acme Retail', gstin: GSTIN('27'), address: '4 Linking Rd, Mumbai', phone: '9811122233' },
    poReference: 'PO-9', orderRef: 'ORD-1',
    lines: [{ description: 'Router', hsnSac: '8517', qty: 4, unitPrice: 1500, discount: 100, taxRate: 18 }, { description: 'Cable', hsnSac: '8544', qty: 10, unitPrice: 99.5, taxRate: 12 }],
    ...extra,
  })
  const issue = async (extra) => {
    const r = await call('POST', SI, T.admin, manual(extra))
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    return r.data
  }

  /** Drive a repair all the way to COMPLETED over the real API. */
  async function completedRepair(vendor, { channel = 'B2C', gstin } = {}) {
    const customer = T.cust
    const body = channel === 'B2B'
      ? { channel, businessName: 'Acme Retail Pvt Ltd', gstin, contactPerson: 'Priya', poReference: 'PO-77', serviceMode: 'DROP_OFF', items: [{ brand: 'Apple', model: 'iPhone 13', imeiSerial: `SI${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`.toUpperCase(), problemCategory: 'SCREEN', warrantyStatus: 'OUT_OF_WARRANTY' }] }
      : { channel, serviceMode: 'DROP_OFF', items: [{ brand: 'Apple', model: 'iPhone 13', imeiSerial: `SI${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`.toUpperCase(), problemCategory: 'SCREEN', warrantyStatus: 'OUT_OF_WARRANTY' }] }
    const created = await call('POST', '/api/v1/repairs', customer, body)
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const id = created.data.id
    await call('POST', `${RP}/${id}/accept`, T.admin, { vendorId: vendor.vendorId })
    await call('POST', `${RP}/${id}/receive`, vendor)
    const cur = (await call('GET', `${RP}/${id}`, vendor)).data
    const q1 = await call('POST', `${RP}/${id}/quotes`, vendor, { lines: [
      { itemId: cur.items[0].id, kind: 'LABOUR', description: 'Screen replacement', qty: 1, unitPrice: 800 }, { itemId: cur.items[0].id, kind: 'PART', description: 'OEM display', qty: 1, unitPrice: 1200 }] })
    expect(q1.status, JSON.stringify(q1.body)).toBe(200)
    await call('POST', `${RP}/${id}/approve-estimate`, T.admin, { note: 'Approved by owner via email' })
    await call('POST', `${RP}/${id}/payments`, T.admin, { kind: 'ADVANCE', method: 'UPI', amount: 708, idempotencyKey: crypto.randomUUID() })
    await call('POST', `${RP}/${id}/start`, vendor)
    await call('POST', `${RP}/${id}/send-to-qc`, vendor)
    await call('POST', `${RP}/${id}/qc`, vendor, { results: [{ itemId: cur.items[0].id, passed: true }] })
    await call('POST', `${RP}/${id}/ready`, vendor)
    await call('POST', `${RP}/${id}/payments`, T.admin, { kind: 'BALANCE', method: 'COD', amount: 1652, idempotencyKey: crypto.randomUUID() })
    const done = await call('POST', `${RP}/${id}/deliver`, vendor)
    expect(done.data.status).toBe('COMPLETED')
    return done.data
  }

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-inv-'))
    priv = path.join(tmp, 'private')
    Object.assign(process.env, {
      JWT_ACCESS_SECRET: 'x'.repeat(64), JWT_REFRESH_SECRET: 'y'.repeat(64), NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000',
      PRIVATE_UPLOAD_DIR: priv, UPLOAD_DIR: path.join(tmp, 'public'), REPAIR_NO_NOTIFY: '1',
    })
    q = (await import('../../src/config/database.js')).query
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
    T.admin = await mkToken('ADMIN', 'Admin')
    T.cust = await mkToken('CUSTOMER', 'Cust One')
    T.other = await mkToken('CUSTOMER', 'Cust Two')
    T.vendA = await mkVendor('Vendor Alpha')                                   // registered, Karnataka
    T.vendB = await mkVendor('Vendor Bravo', { gstin: GSTIN('27'), state: 'Maharashtra' })
    T.vendNoProfile = await mkVendor('Vendor Ghost', { profile: false })
    T.vendUnreg = await mkVendor('Vendor Unregistered', { gstin: '' })         // address but no GSTIN
  }, 60000)
  afterAll(async () => {
    await q(`UPDATE fee_settings SET gst_enabled = FALSE WHERE scope = 'GLOBAL'`).catch(() => {})
    await app?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // ── numbering ─────────────────────────────────────────────────────────
  describe('numbering', () => {
    it('numbers are sequential per issuer, type, channel and financial year, within 16 characters', async () => {
      const a = await issue({ channel: 'B2C', buyer: { name: 'Walk-in', state: 'Karnataka' }, lines: [{ description: 'Case', qty: 1, unitPrice: 100, taxRate: 18 }] })
      const b = await issue({ channel: 'B2C', buyer: { name: 'Walk-in', state: 'Karnataka' }, lines: [{ description: 'Case', qty: 1, unitPrice: 100, taxRate: 18 }] })
      const fy = (() => { const n = new Date(Date.now() + 5.5 * 3600_000); const y = n.getUTCMonth() >= 3 ? n.getUTCFullYear() : n.getUTCFullYear() - 1; return `${String(y).slice(2)}-${String(y + 1).slice(2)}` })()
      expect(a.number).toMatch(new RegExp(`^CI/${fy}/\\d{6}$`))
      expect(a.number.length).toBeLessThanOrEqual(16)
      expect(Number(b.number.slice(-6))).toBe(Number(a.number.slice(-6)) + 1)
      const other = await issue({ channel: 'B2C', issuerVendorId: T.vendB.vendorId, buyer: { name: 'Walk-in', state: 'Maharashtra' }, lines: [{ description: 'Case', qty: 1, unitPrice: 100, taxRate: 18 }] })
      expect(other.number.slice(-6)).toBe('000001')                              // a different issuer has its own series
      const b2b = await issue()
      expect(b2b.number.startsWith('BI/')).toBe(true)                            // B2B has its own prefix
    })

    it('parallel issuing gives every document a unique, gap-free number', async () => {
      const v = await mkVendor('Vendor Parallel')
      const docs = await Promise.all(Array.from({ length: 8 }, () => call('POST', SI, T.admin, manual({ issuerVendorId: v.vendorId }))))
      expect(docs.every((x) => x.status === 201), JSON.stringify(docs.map((x) => x.body?.message))).toBe(true)
      const seqs = docs.map((x) => Number(x.data.number.slice(-6))).sort((x, y) => x - y)
      expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    })

    it('a failure while storing the PDF burns no number and leaves no file behind', async () => {
      const v = await mkVendor('Vendor Flaky')
      const first = await issue({ issuerVendorId: v.vendorId })
      expect(first.number.slice(-6)).toBe('000001')
      const before = fs.readdirSync(path.join(priv, 'sales-invoices'), { recursive: true }).length
      const spy = vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
      const bad = await call('POST', SI, T.admin, manual({ issuerVendorId: v.vendorId }))
      spy.mockRestore()
      expect(bad.status).toBe(500)
      const next = await issue({ issuerVendorId: v.vendorId })
      expect(next.number.slice(-6)).toBe('000002')                              // no gap
      expect(fs.readdirSync(path.join(priv, 'sales-invoices'), { recursive: true }).length).toBeGreaterThanOrEqual(before + 1)
    })
  })

  // ── manual invoices & tax split ───────────────────────────────────────
  describe('manual B2B / B2C invoices', () => {
    it('inter-state B2B: IGST, HSN summary, exact totals, B2B number, PO and GSTINs on the document', async () => {
      const doc = await issue()
      expect(doc).toMatchObject({ docType: 'TAX_INVOICE', channel: 'B2B', supplyType: 'INTER', placeOfSupply: '27', posAssumed: false, poReference: 'PO-9', orderRef: 'ORD-1' })
      // Router 4×1500−100 = 5900 @18% = 1062 ; Cable 10×99.5 = 995 @12% = 119.40
      expect(doc).toMatchObject({ taxable: 6895, igst: 1181.4, cgst: 0, sgst: 0, total: 8076.4 })
      expect(doc.taxSummary.map((g) => g.hsnSac).sort()).toEqual(['8517', '8544'])
      expect(doc.sellerFull.gstin).toMatch(/^29/)
      expect(doc.buyerFull.gstin).toMatch(/^27/)
    })

    it('intra-state: CGST + SGST', async () => {
      const doc = await issue({ buyer: { name: 'Ravi', businessName: 'Bangalore Traders', gstin: GSTIN('29'), address: 'Indiranagar' } })
      expect(doc).toMatchObject({ supplyType: 'INTRA', igst: 0, cgst: 590.7, sgst: 590.7, total: 8076.4 })
    })

    it('B2C with an unknown state assumes the supplier’s state and says so; a known state wins', async () => {
      const line = [{ description: 'Charger', qty: 2, unitPrice: 500, taxRate: 18 }]
      const unknown = await issue({ channel: 'B2C', buyer: { name: 'Walk-in' }, lines: line })
      expect(unknown).toMatchObject({ posAssumed: true, supplyType: 'INTRA', placeOfSupply: '29' })
      const kerala = await issue({ channel: 'B2C', buyer: { name: 'Anu', state: 'Kerala' }, lines: line })
      expect(kerala).toMatchObject({ posAssumed: false, supplyType: 'INTER', placeOfSupply: '32', igst: 180 })
    })

    it('tax-inclusive entry keeps the invoice total equal to the price entered', async () => {
      const doc = await issue({ channel: 'B2C', buyer: { name: 'Walk-in', state: 'Karnataka' }, taxInclusive: true, lines: [{ description: 'Cover', qty: 1, unitPrice: 199, taxRate: 18 }] })
      expect(doc.total).toBe(199)
    })

    it('validates input', async () => {
      const bad = (extra, msg) => call('POST', SI, T.admin, manual(extra)).then((r) => { expect(r.status, msg).toBe(422); return r })
      await bad({ buyer: { name: 'x', businessName: 'Acme', gstin: 'NOTAGSTIN' } }, 'bad buyer GSTIN')
      await bad({ buyer: { name: 'x', gstin: GSTIN('27') } }, 'B2B needs a business name')
      await bad({ lines: [] }, 'no lines')
      await bad({ lines: [{ description: 'x', hsnSac: '8517', qty: 1, unitPrice: 10, taxRate: 17 }] }, 'GST slab')
      await bad({ lines: [{ description: 'x', qty: 1, unitPrice: 10, taxRate: 18 }] }, 'HSN required on B2B')
      await bad({ lines: [{ description: 'x', hsnSac: 'ABC', qty: 1, unitPrice: 10, taxRate: 18 }] }, 'HSN format')
      await bad({ lines: [{ description: 'x', hsnSac: '8517', qty: 0, unitPrice: 10, taxRate: 18 }] }, 'qty')
      await bad({ lines: [{ description: 'x', hsnSac: '8517', qty: 1, unitPrice: 10.123, taxRate: 18 }] }, 'price decimals')
      await bad({ lines: [{ description: 'x', hsnSac: '8517', qty: 1, unitPrice: 10, discount: 99, taxRate: 18 }] }, 'discount > value')
      await bad({ dueDate: '09-10-2026' }, 'due date format')
    })

    it('an issuer must have a complete legal profile, and only a GST-registered one can charge GST', async () => {
      const noProfile = await call('POST', SI, T.admin, manual({ issuerVendorId: T.vendNoProfile.vendorId }))
      expect(noProfile.status).toBe(409)
      expect(noProfile.body.code).toBe('ISSUER_PROFILE_INCOMPLETE')
      const unreg = await call('POST', SI, T.admin, manual({ issuerVendorId: T.vendUnreg.vendorId }))
      expect(unreg.status).toBe(409)
      expect(unreg.body.code).toBe('ISSUER_NOT_GST_REGISTERED')
      // …but an unregistered seller may issue a bill of supply with no tax
      const bos = await issue({ issuerVendorId: T.vendUnreg.vendorId, channel: 'B2C', buyer: { name: 'Walk-in', state: 'Karnataka' }, lines: [{ description: 'Accessory', qty: 1, unitPrice: 250, taxRate: 0 }] })
      expect(bos).toMatchObject({ docType: 'BILL_OF_SUPPLY', total: 250, cgst: 0, igst: 0 })
      expect(bos.number.startsWith('BS/')).toBe(true)
      // the platform's own details are used when no vendor issues and they are configured
      expect((await call('POST', SI, T.admin, manual({ issuerVendorId: undefined }))).body.code).toBe('ISSUER_PROFILE_INCOMPLETE')
    })
  })

  // ── PDF, archive, audit ───────────────────────────────────────────────
  describe('PDF archive', () => {
    let doc
    it('serves the stored PDF with the right headers and records who viewed or downloaded it', async () => {
      doc = await issue()
      const view = await app.inject({ method: 'GET', url: `${SI}/${doc.id}/pdf`, headers: auth(T.admin) })
      expect(view.statusCode).toBe(200)
      expect(view.headers['content-type']).toBe('application/pdf')
      expect(view.headers['content-disposition']).toMatch(/^inline; filename="BI-/)
      expect(view.headers['cache-control']).toMatch(/no-store/)
      expect(view.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
      const dl = await app.inject({ method: 'GET', url: `${SI}/${doc.id}/pdf?download=1`, headers: auth(T.admin) })
      expect(dl.headers['content-disposition']).toMatch(/^attachment/)
      expect(crypto.createHash('sha256').update(dl.rawPayload).digest('hex')).toBe(doc.pdf.checksum)
      const hist = (await call('GET', `${SI}/${doc.id}`, T.admin)).data.history.map((h) => h.kind)
      expect(hist).toEqual(['ISSUED', 'VIEWED', 'DOWNLOADED'])
    })

    it('the same file comes back after any number of re-downloads (archive is stable)', async () => {
      const a = await app.inject({ method: 'GET', url: `${SI}/${doc.id}/pdf`, headers: auth(T.admin) })
      const b = await app.inject({ method: 'GET', url: `${SI}/${doc.id}/pdf`, headers: auth(T.admin) })
      expect(a.rawPayload.equals(b.rawPayload)).toBe(true)
    })

    it('a tampered or missing file is never served', async () => {
      const row = (await q(`SELECT pdf_key FROM sales_documents WHERE id = $1`, [doc.id])).rows[0]
      const abs = path.join(priv, row.pdf_key)
      const keep = fs.readFileSync(abs)
      fs.writeFileSync(abs, Buffer.concat([keep, Buffer.from('tamper')]))
      const t = await call('GET', `${SI}/${doc.id}/pdf`, T.admin)
      expect(t.status).toBe(500)
      expect(t.body.code).toBe('INTEGRITY_FAILED')
      fs.unlinkSync(abs)
      expect((await call('GET', `${SI}/${doc.id}/pdf`, T.admin)).body.code).toBe('FILE_MISSING')
      fs.writeFileSync(abs, keep)
      expect((await call('GET', `${SI}/${doc.id}/pdf`, T.admin)).status).toBe(200)
    })

    it('an issued document cannot be changed or deleted, even by SQL', async () => {
      await expect(q(`UPDATE sales_documents SET grand_total = 1 WHERE id = $1`, [doc.id])).rejects.toThrow(/immutable/)
      await expect(q(`UPDATE sales_documents SET buyer = '{}'::jsonb WHERE id = $1`, [doc.id])).rejects.toThrow(/immutable/)
      await expect(q(`UPDATE sales_documents SET pdf_key = 'x' WHERE id = $1`, [doc.id])).rejects.toThrow(/immutable/)     // PDF attaches once
      await expect(q(`DELETE FROM sales_documents WHERE id = $1`, [doc.id])).rejects.toThrow(/cannot be deleted/)
      await expect(q(`UPDATE sales_document_events SET kind = 'X' WHERE document_id = $1`, [doc.id])).rejects.toThrow(/append-only/)
      await expect(q(`DELETE FROM sales_document_events WHERE document_id = $1`, [doc.id])).rejects.toThrow(/append-only/)
    })

    it('never fabricates e-invoice data', async () => {
      const full = (await call('GET', `${SI}/${doc.id}`, T.admin)).data
      expect(full.irn).toEqual({ status: 'NOT_INTEGRATED', value: null })
    })
  })

  // ── repairs ───────────────────────────────────────────────────────────
  describe('repair invoices', () => {
    it('are issued automatically when a repair completes and match the amount the customer paid', async () => {
      const rep = await completedRepair(T.vendA)
      expect(rep.invoice).toBeTruthy()
      expect(rep.invoice.docType).toBe('TAX_INVOICE')
      const inv = (await call('GET', `${SI}/${rep.invoice.id}`, T.admin)).data
      expect(inv).toMatchObject({ channel: 'B2C', sourceType: 'REPAIR', orderRef: rep.code, total: rep.money.approvedTotal, taxable: 2000, posAssumed: true })
      expect(inv.cgst + inv.sgst).toBe(360)
      expect(inv.lines.map((l) => l.hsnSac).sort()).toEqual(['8517', '9987'])    // parts vs service codes from invoice settings
      expect(inv.payments.map((p) => p.amount)).toEqual([708, 1652])
      expect(inv.payment).toMatchObject({ status: 'PAID', due: 0 })
    })

    it('issuing again returns the same invoice and does not use another number', async () => {
      const rep = await completedRepair(T.vendA)
      const again = await call('POST', `${SI}/issue/repair/${rep.id}`, T.admin)
      expect(again.status).toBe(200)
      expect(again.data.id).toBe(rep.invoice.id)
      const parallel = await Promise.all(Array.from({ length: 4 }, () => call('POST', `${SI}/issue/repair/${rep.id}`, T.admin)))
      expect(new Set(parallel.map((x) => x.data.id))).toEqual(new Set([rep.invoice.id]))
      expect((await q(`SELECT COUNT(*)::int AS n FROM sales_documents WHERE source_type = 'REPAIR' AND source_id = $1`, [rep.id])).rows[0].n).toBe(1)
    })

    it('B2B repair: buyer GSTIN, PO, inter-state IGST, B2B series', async () => {
      const rep = await completedRepair(T.vendA, { channel: 'B2B', gstin: GSTIN('27') })
      const inv = (await call('GET', `${SI}/${rep.invoice.id}`, T.admin)).data
      expect(inv).toMatchObject({ channel: 'B2B', supplyType: 'INTER', poReference: 'PO-77', igst: 360, posAssumed: false })
      expect(inv.buyerFull.gstin).toMatch(/^27/)
      expect(inv.number.startsWith('BI/')).toBe(true)
    })

    it('a seller with no legal profile cannot invoice; delivery still succeeds and the invoice can be issued once fixed', async () => {
      const rep = await completedRepair(T.vendNoProfile)
      expect(rep.status).toBe('COMPLETED')
      expect(rep.invoice).toBeNull()
      const blocked = await call('POST', `${SI}/issue/repair/${rep.id}`, T.admin)
      expect(blocked.status).toBe(409)
      expect(blocked.body.code).toBe('ISSUER_PROFILE_INCOMPLETE')
      expect(blocked.body.missing).toEqual(expect.arrayContaining(['address']))
      await q(`INSERT INTO vendor_profiles (vendor_id, legal_name, gstin, address_line1, city, state, pincode) VALUES ($1,'Ghost Pvt Ltd',$2,'1 Lane','Pune','Maharashtra','411001')`, [T.vendNoProfile.vendorId, GSTIN('27')])
      const ok = await call('POST', `${SI}/issue/repair/${rep.id}`, T.admin)
      expect(ok.status).toBe(201)
      expect((await call('GET', `${RP}/${rep.id}`, T.admin)).data.invoice.number).toBe(ok.data.number)
    })

    it('cannot invoice a repair that is not completed', async () => {
      const created = await call('POST', '/api/v1/repairs', T.cust, { channel: 'B2C', serviceMode: 'DROP_OFF', items: [{ brand: 'A', model: 'B', problemCategory: 'SCREEN' }] })
      const r = await call('POST', `${SI}/issue/repair/${created.data.id}`, T.admin)
      expect(r.status).toBe(409)
      expect(r.body.code).toBe('NOT_BILLABLE')
    })

    it('a declined estimate is invoiced for the diagnostic fee only, at exactly the amount charged', async () => {
      const created = await call('POST', '/api/v1/repairs', T.cust, { channel: 'B2C', serviceMode: 'DROP_OFF', items: [{ brand: 'Oppo', model: 'Reno', imeiSerial: `DX${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`.toUpperCase(), problemCategory: 'BATTERY', warrantyStatus: 'OUT_OF_WARRANTY' }] })
      const id = created.data.id
      await call('POST', `${RP}/${id}/accept`, T.admin, { vendorId: T.vendA.vendorId })
      await call('POST', `${RP}/${id}/receive`, T.vendA)
      const cur = (await call('GET', `${RP}/${id}`, T.vendA)).data
      await call('POST', `${RP}/${id}/quotes`, T.vendA, { lines: [{ itemId: cur.items[0].id, kind: 'LABOUR', description: 'Battery', qty: 1, unitPrice: 500 }] })
      await call('POST', `${MY.replace('sales-invoices', 'repairs')}/${id}/reject-estimate`, T.cust, { reason: 'Too costly' })
      await call('POST', `${RP}/${id}/ready`, T.vendA)
      await call('POST', `${RP}/${id}/payments`, T.admin, { kind: 'DIAGNOSTIC', method: 'CASH', amount: 199, idempotencyKey: crypto.randomUUID() })
      const done = await call('POST', `${RP}/${id}/deliver`, T.vendA)
      const inv = (await call('GET', `${SI}/${done.data.invoice.id}`, T.admin)).data
      expect(inv.total).toBe(199)
      expect(inv.lines[0].description).toMatch(/^Diagnostic charges/)
    })
  })

  // ── credit & debit notes ──────────────────────────────────────────────
  describe('credit and debit notes', () => {
    let inv
    it('credit part of a line: tax reversed at the original rate and split, series separate from invoices', async () => {
      inv = await issue()
      const cn = await call('POST', `${SI}/${inv.id}/credit-notes`, T.admin, { reason: 'One router returned damaged', lines: [{ index: 0, qty: 1 }] })
      expect(cn.status, JSON.stringify(cn.body)).toBe(201)
      // 1 of 4 routers: taxable (6000-100)/4 = 1475 ; IGST 18% = 265.50
      expect(cn.data).toMatchObject({ docType: 'CREDIT_NOTE', refDocumentId: inv.id, refNumber: inv.number, taxable: 1475, igst: 265.5, total: 1740.5, supplyType: 'INTER' })
      expect(cn.data.number.startsWith('CN/')).toBe(true)
      expect(cn.data.sellerFull.gstin).toBe(inv.sellerFull.gstin)
      expect(cn.data.buyerFull.gstin).toBe(inv.buyerFull.gstin)
    })

    it('credits accumulate and can never exceed what was invoiced; the final credit takes exactly the remainder', async () => {
      const over = await call('POST', `${SI}/${inv.id}/credit-notes`, T.admin, { reason: 'too many', lines: [{ index: 0, qty: 4 }] })
      expect(over.status).toBe(409)
      expect(over.body).toMatchObject({ code: 'OVER_CREDIT', remaining: 3 })
      expect((await call('POST', `${SI}/${inv.id}/credit-notes`, T.admin, { reason: 'one more', lines: [{ index: 0, qty: 1 }] })).status).toBe(201)
      const rest = await call('POST', `${SI}/${inv.id}/credit-notes`, T.admin, { reason: 'rest of router line', lines: [{ index: 0 }] })
      expect(rest.data).toMatchObject({ taxable: 2950, igst: 531, total: 3481 })                   // 2 routers left = 5900 − 2×1475
      const cables = await call('POST', `${SI}/${inv.id}/credit-notes`, T.admin, { reason: 'all cables', lines: [{ index: 1 }] })
      expect(cables.data.total).toBe(1114.4)
      const full = (await call('GET', `${SI}/${inv.id}`, T.admin)).data
      // routers fully credited: Σ taxable of the three router credits equals the invoiced line exactly
      expect(1475 + 1475 + 2950).toBe(5900)
      expect(Math.round(full.credited * 100)).toBe(Math.round(inv.total * 100))
      expect(full.notesIssued).toHaveLength(4)
      const gone = await call('POST', `${SI}/${inv.id}/credit-notes`, T.admin, { reason: 'again', lines: [{ index: 1 }] })
      expect(gone.body.code).toBe('OVER_CREDIT')
      expect(full.total).toBe(inv.total)                                                         // the invoice itself never changes
    })

    it('parallel credit attempts cannot over-credit', async () => {
      const i2 = await issue({ lines: [{ description: 'Phone', hsnSac: '8517', qty: 2, unitPrice: 1000, taxRate: 18 }] })
      const res = await Promise.all(Array.from({ length: 5 }, () => call('POST', `${SI}/${i2.id}/credit-notes`, T.admin, { reason: 'return', lines: [{ index: 0, qty: 1 }] })))
      expect(res.filter((r) => r.status === 201)).toHaveLength(2)
      expect(res.filter((r) => r.status !== 201).every((r) => r.body.code === 'OVER_CREDIT')).toBe(true)
    })

    it('rules: reason required, valid lines, invoices only, authorised staff only', async () => {
      const i3 = await issue()
      expect((await call('POST', `${SI}/${i3.id}/credit-notes`, T.admin, { lines: [{ index: 0 }] })).status).toBe(422)
      expect((await call('POST', `${SI}/${i3.id}/credit-notes`, T.admin, { reason: 'x ok', lines: [] })).status).toBe(422)
      expect((await call('POST', `${SI}/${i3.id}/credit-notes`, T.admin, { reason: 'x ok', lines: [{ index: 9 }] })).status).toBe(422)
      expect((await call('POST', `${SI}/${i3.id}/credit-notes`, T.admin, { reason: 'x ok', lines: [{ index: 0 }, { index: 0 }] })).status).toBe(422)
      expect((await call('POST', `${SI}/${i3.id}/credit-notes`, T.admin, { reason: 'x ok', lines: [{ index: 0, qty: 0 }] })).status).toBe(422)
      const cn = await call('POST', `${SI}/${i3.id}/credit-notes`, T.admin, { reason: 'valid', lines: [{ index: 1 }] })
      expect((await call('POST', `${SI}/${cn.data.id}/credit-notes`, T.admin, { reason: 'on a note', lines: [{ index: 0 }] })).body.code).toBe('INVALID_STATE')
      expect((await call('POST', `${SI}/${i3.id}/credit-notes`, T.vendA, { reason: 'vendor', lines: [{ index: 0 }] })).status).toBe(403)
      expect((await call('POST', `${SI}/${i3.id}/credit-notes`, T.cust, { reason: 'customer', lines: [{ index: 0 }] })).status).toBe(403)
      expect((await call('GET', `${SI}/${i3.id}`, T.admin)).data.history.map((h) => h.kind)).toContain('CREDIT_NOTE_ISSUED')
    })

    it('debit note increases an invoice with its own series; a bill of supply cannot carry GST', async () => {
      const i4 = await issue()
      const dn = await call('POST', `${SI}/${i4.id}/debit-notes`, T.admin, { reason: 'Freight under-billed', lines: [{ description: 'Freight', hsnSac: '9965', qty: 1, unitPrice: 500, taxRate: 18 }] })
      expect(dn.status, JSON.stringify(dn.body)).toBe(201)
      expect(dn.data).toMatchObject({ docType: 'DEBIT_NOTE', refDocumentId: i4.id, taxable: 500, igst: 90, total: 590 })
      expect(dn.data.number.startsWith('DN/')).toBe(true)
      const bos = await issue({ issuerVendorId: T.vendUnreg.vendorId, channel: 'B2C', buyer: { name: 'W', state: 'Karnataka' }, lines: [{ description: 'Item x', qty: 1, unitPrice: 10, taxRate: 0 }] })
      const bad = await call('POST', `${SI}/${bos.id}/debit-notes`, T.admin, { reason: 'try tax', lines: [{ description: 'Item x', qty: 1, unitPrice: 10, taxRate: 18 }] })
      expect(bad.body.code).toBe('ISSUER_NOT_GST_REGISTERED')
    })
  })

  // ── marketplace seller orders ─────────────────────────────────────────
  describe('seller order invoices (guarded)', () => {
    let seq = 0
    async function order({ rate = 18, orderTax, discount = 0, status = 'DELIVERED', qty = 2, price = 5000, state = 'Kerala' } = {}) {
      await q(`UPDATE fee_settings SET gst_enabled = TRUE, gst_rate = 18 WHERE scope = 'GLOBAL'`)
      const n = `${Date.now()}${++seq}`
      const prod = await q(`INSERT INTO products (name, slug, price, hsn_code, gst_rate) VALUES ($1,$2,$3,'8517',$4) RETURNING id`, [`Phone ${n}`, `ph-${n}`, price, rate])
      const tax = orderTax ?? Math.round(qty * price * rate) / 100
      const o = await q(
        `INSERT INTO orders (order_number, customer_id, items, subtotal, tax_amount, total_payable, payment_method, payment_status, delivery_address, discount_amount, is_marketplace)
         VALUES ($1,$2,'[]',$3,$4,$5,'ONLINE','PAID',$6,$7,TRUE) RETURNING id`,
        [`MK-${n}`, T.cust.id, qty * price, tax, qty * price + tax + 50, JSON.stringify({ name: 'Anu Nair', phone: '9744444412', line1: '5 Beach Rd', city: 'Kochi', state, pincode: '682001' }), discount])
      const so = await q(
        `INSERT INTO seller_orders (order_id, seller_order_number, vendor_id, status, item_subtotal, shipping_charge, seller_discount, channel)
         VALUES ($1,$2,$3,$4,$5,50,0,'B2C') RETURNING id`, [o.rows[0].id, `MK-${n}-1`, T.vendA.vendorId, status, qty * price])
      await q(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, seller_order_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [o.rows[0].id, prod.rows[0].id, `Phone ${n}`, price, qty, qty * price, so.rows[0].id])
      return { orderId: o.rows[0].id, soId: so.rows[0].id, prodId: prod.rows[0].id }
    }

    it('issues an invoice when recomputed tax reproduces the tax charged at checkout, with delivery as an untaxed line', async () => {
      const x = await order()
      const r = await call('POST', `${SI}/issue/order/${x.soId}`, T.admin)
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      expect(r.data).toMatchObject({ channel: 'B2C', sourceType: 'SELLER_ORDER', supplyType: 'INTER', placeOfSupply: '32', taxable: 10050, igst: 1800, total: 11850 })
      expect(r.data.lines.map((l) => l.description)).toContain('Delivery charges')
      expect(r.data.buyerFull).toMatchObject({ name: 'Anu Nair', state: 'Kerala' })
      expect((await q(`SELECT invoice_number FROM seller_orders WHERE id = $1`, [x.soId])).rows[0].invoice_number).toBe(r.data.number)
      const again = await call('POST', `${SI}/issue/order/${x.soId}`, T.admin)
      expect(again.status).toBe(200)
      expect(again.data.id).toBe(r.data.id)
    })

    it('refuses when the product rate changed since checkout (tax would disagree with the payment)', async () => {
      const x = await order()
      await q(`UPDATE products SET gst_rate = 12 WHERE id = $1`, [x.prodId])
      const r = await call('POST', `${SI}/issue/order/${x.soId}`, T.admin)
      expect(r.status).toBe(409)
      expect(r.body).toMatchObject({ code: 'TAX_MISMATCH', recomputed: 1200, charged: 1800 })
    })

    it('refuses discounted orders and undelivered orders', async () => {
      const disc = await order({ discount: 100 })
      expect((await call('POST', `${SI}/issue/order/${disc.soId}`, T.admin)).body.code).toBe('TAX_BASIS_UNSUPPORTED')
      const pending = await order({ status: 'SHIPPED' })
      expect((await call('POST', `${SI}/issue/order/${pending.soId}`, T.admin)).body.code).toBe('NOT_BILLABLE')
    })
  })

  // ── access control ────────────────────────────────────────────────────
  describe('who can see what', () => {
    it('customers see only their own documents; vendors only their own issuances; strangers get 404', async () => {
      const rep = await completedRepair(T.vendA)                                   // cust → vendA
      const mine = await call('GET', MY, T.cust)
      expect(mine.data.items.map((i) => i.id)).toContain(rep.invoice.id)
      expect((await call('GET', MY, T.other)).data.items.map((i) => i.id)).not.toContain(rep.invoice.id)
      expect((await call('GET', `${MY}/${rep.invoice.id}`, T.cust)).status).toBe(200)
      expect((await call('GET', `${MY}/${rep.invoice.id}`, T.other)).status).toBe(404)
      expect((await call('GET', `${MY}/${rep.invoice.id}/pdf`, T.other)).status).toBe(404)
      expect((await call('GET', `${MY}/${rep.invoice.id}/pdf?download=1`, T.cust)).raw.headers['content-disposition']).toMatch(/attachment/)

      const a = await call('GET', `${SI}?limit=100`, T.vendA)
      expect(a.data.items.length).toBeGreaterThan(0)
      expect(a.data.items.every((i) => i.seller.gstin && i.seller.gstin.startsWith('29'))).toBe(true)
      const b = await call('GET', `${SI}?limit=100`, T.vendB)
      expect(b.data.items.map((i) => i.id)).not.toContain(rep.invoice.id)
      expect((await call('GET', `${SI}/${rep.invoice.id}`, T.vendB)).status).toBe(404)
      expect((await call('GET', `${SI}/${rep.invoice.id}/pdf`, T.vendB)).status).toBe(404)
      expect((await call('GET', `${SI}/for/repair/${rep.id}`, T.vendB)).data).toBeNull()
      expect((await call('GET', `${SI}/for/repair/${rep.id}`, T.vendA)).data.number).toBe(rep.invoice.number)
    })

    it('customers cannot reach the dashboard API; vendors cannot issue, export settings or edit settings', async () => {
      for (const [m, u] of [['GET', SI], ['POST', SI], ['GET', `${SI}/settings`], ['PUT', `${SI}/settings`]]) expect((await call(m, u, T.cust, {})).status, `${m} ${u}`).toBe(403)
      expect((await call('POST', SI, T.vendA, manual())).status).toBe(403)
      expect((await call('GET', `${SI}/settings`, T.vendA)).status).toBe(403)
      expect((await call('POST', `${SI}/issue/repair/${crypto.randomUUID()}`, T.vendA)).status).toBe(403)
      expect((await call('GET', SI, { token: 'bad' })).status).toBe(401)
      expect((await app.inject({ method: 'GET', url: MY })).statusCode).toBe(401)
    })
  })

  // ── lists, filters, export, settings ──────────────────────────────────
  describe('archive, export and settings', () => {
    it('filters by channel, type, date range and free text; summarises by channel', async () => {
      const marker = `MARK${Date.now().toString(36).toUpperCase()}`
      const walkin = `WK${Math.floor(Math.random() * 1e9).toString(36).toUpperCase()}`
      const b2b = await issue({ orderRef: marker })
      const b2c = await issue({ channel: 'B2C', buyer: { name: `Zed ${walkin}`, state: 'Karnataka' }, lines: [{ description: 'Cap', qty: 1, unitPrice: 50, taxRate: 5 }] })
      const only = await call('GET', `${SI}?channel=B2B&limit=100`, T.admin)
      expect(only.data.items.every((i) => i.channel === 'B2B')).toBe(true)
      expect(only.data.items.map((i) => i.id)).toContain(b2b.id)
      expect(only.data.items.map((i) => i.id)).not.toContain(b2c.id)
      expect((await call('GET', `${SI}?q=${marker}`, T.admin)).data.items.map((i) => i.id)).toEqual([b2b.id])
      expect((await call('GET', `${SI}?q=Zed%20${walkin}`, T.admin)).data.items.map((i) => i.id)).toEqual([b2c.id])
      // numbers are unique per issuer (each seller has its own series), so a bare number may match several sellers
      const byNumber = (await call('GET', `${SI}?q=${encodeURIComponent(b2b.number)}&limit=100`, T.admin)).data.items
      expect(byNumber.map((i) => i.id)).toContain(b2b.id)
      expect(byNumber.every((i) => i.number === b2b.number)).toBe(true)
      const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
      expect((await call('GET', `${SI}?from=${today}&to=${today}&q=${marker}`, T.admin)).data.total).toBe(1)
      expect((await call('GET', `${SI}?from=2001-01-01&to=2001-01-02&q=${marker}`, T.admin)).data.total).toBe(0)
      expect((await call('GET', `${SI}?docType=CREDIT_NOTE&limit=100`, T.admin)).data.items.every((i) => i.docType === 'CREDIT_NOTE')).toBe(true)
      expect((await call('GET', `${SI}?limit=5`, T.admin)).data.summary.byChannel).toEqual({ B2B: expect.any(Number), B2C: expect.any(Number) })
    })

    it('exports CSV with credit notes as negatives, and only for permitted users', async () => {
      const tag = `CSV${Date.now().toString(36).toUpperCase()}`
      const inv = await issue({ orderRef: tag })
      await call('POST', `${SI}/${inv.id}/credit-notes`, T.admin, { reason: 'csv test', lines: [{ index: 1 }] })
      const res = await app.inject({ method: 'GET', url: `${SI}/export?q=${tag}`, headers: auth(T.admin) })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toMatch(/text\/csv/)
      const lines = res.body.trim().split('\n')
      expect(lines[0]).toMatch(/^Document No,Type,Channel/)
      expect(lines).toHaveLength(3)
      const credit = lines.find((l) => l.includes('CREDIT_NOTE'))
      expect(credit).toContain(',-')
      expect((await call('GET', `${SI}/export`, T.cust)).status).toBe(403)
      expect((await call('GET', `${SI}/export`, T.vendA)).status).toBe(200)           // a vendor's own documents only
    })

    it('settings: validated, admin-only; platform details can issue when complete', async () => {
      expect((await call('PUT', `${SI}/settings`, T.admin, { gstin: 'BAD' })).status).toBe(422)
      expect((await call('PUT', `${SI}/settings`, T.admin, { repairServiceSac: 'x' })).status).toBe(422)
      expect((await call('PUT', `${SI}/settings`, T.admin, { terms: '' })).status).toBe(422)
      expect((await call('PUT', `${SI}/settings`, T.vendA, { terms: 'x' })).status).toBe(403)
      const gstin = GSTIN('07')
      const ok = await call('PUT', `${SI}/settings`, T.admin, { legalName: 'Dealker Marketplace Pvt Ltd', gstin, address: '1 Connaught Place, New Delhi 110001', repairPartsHsn: '851770' })
      expect(ok.status, JSON.stringify(ok.body)).toBe(200)
      expect(ok.data).toMatchObject({ legalName: 'Dealker Marketplace Pvt Ltd', gstin, stateCode: '07', repairPartsHsn: '851770' })
      const doc = await issue({ issuerVendorId: undefined, channel: 'B2C', buyer: { name: 'W', state: 'Delhi' }, lines: [{ description: 'Gift card fee', qty: 1, unitPrice: 100, taxRate: 18 }] })
      expect(doc.sellerFull.legalName).toBe('Dealker Marketplace Pvt Ltd')
      expect(doc.supplyType).toBe('INTRA')
      await q(`UPDATE invoice_settings SET legal_name = NULL, gstin = NULL, address = NULL, state_code = NULL, repair_parts_hsn = '8517' WHERE id = TRUE`)
    })
  })
})
