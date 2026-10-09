/**
 * Sales documents — tax invoices, bills of supply, credit notes and debit notes for B2C and B2B.
 *
 * Invariants
 *  - Numbers are gapless per (issuer, type, channel, financial year): allocated by an atomic upsert inside the
 *    same transaction that stores the document and its PDF. If anything fails, the number is not consumed.
 *  - An issued document is a frozen snapshot (seller, buyer, lines, tax split, totals). The database refuses to
 *    update or delete it; corrections are credit/debit notes that reference it.
 *  - One invoice per source (repair / seller order): issuing again returns the first one.
 *  - We never print a tax we cannot stand behind: an issuer without GSTIN cannot charge GST, an order whose tax
 *    cannot be reconciled with what the customer was charged is refused.
 *  - Visibility: platform staff see all, a vendor only documents it issued, a customer only their own.
 *
 * @module modules/sales-invoices/sales-invoices.service
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getClient, query } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { PRIVATE_DIR, sha256 } from '../invoices/invoice-storage.js'
import { renderDocumentPdf } from './invoice-pdf.js'
import { STATES, computeDocument, financialYear, stateCodeFromGstin, stateCodeFromName } from './invoice-tax.js'

export class InvoiceError extends Error {
  constructor(code, message, statusCode = 400, details = {}) {
    super(message)
    this.name = 'InvoiceError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const GST_SLABS = [0, 0.25, 3, 5, 12, 18, 28]
const PREFIX = { B2C: 'CI', B2B: 'BI' }
const DOC_PREFIX = { BILL_OF_SUPPLY: 'BS', CREDIT_NOTE: 'CN', DEBIT_NOTE: 'DN' }
const num = (v) => (v == null ? null : Number(v))
const text = (v, max) => String(v ?? '').trim().slice(0, max)
const p = (r) => Math.round(Number(r) * 100)
const r2 = (paise) => paise / 100
/** node-pg returns DATE columns as local-midnight Date objects; format them back as YYYY-MM-DD. */
const ymd = (d) => {
  if (d == null) return null
  if (typeof d === 'string') return d.slice(0, 10)
  const z = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`
}
const istDate = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)

async function tx(fn) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// ── settings ────────────────────────────────────────────────────────────

export async function getSettings(client = null) {
  const run = client ? client.query.bind(client) : query
  const { rows } = await run('SELECT * FROM invoice_settings WHERE id = TRUE')
  return rows[0]
}

export const serializeSettings = (s) => ({
  legalName: s.legal_name, gstin: s.gstin, pan: s.pan, address: s.address, stateCode: s.state_code, email: s.email, phone: s.phone,
  repairServiceSac: s.repair_service_sac, repairPartsHsn: s.repair_parts_hsn, terms: s.terms, footer: s.footer,
})

export async function updateSettings(actor, input = {}) {
  const cols = {}
  const set = (k, col, v) => { if (v !== undefined) cols[col] = v }
  const str = (k, max, req = false) => {
    if (input[k] === undefined) return undefined
    const v = text(input[k], max)
    if (req && !v) throw new InvoiceError('VALIDATION', `${k} cannot be empty`, 422)
    return v || null
  }
  set('legalName', 'legal_name', str('legalName', 200))
  set('address', 'address', str('address', 600))
  set('email', 'email', str('email', 160)); set('phone', 'phone', str('phone', 30)); set('pan', 'pan', str('pan', 10))
  set('terms', 'terms', str('terms', 1500, true)); set('footer', 'footer', str('footer', 300, true))
  if (input.gstin !== undefined) {
    const g = text(input.gstin, 15).toUpperCase() || null
    if (g && !GSTIN_RE.test(g)) throw new InvoiceError('VALIDATION', 'Enter a valid 15-character GSTIN', 422)
    cols.gstin = g
    if (g) cols.state_code = stateCodeFromGstin(g)
  }
  if (input.stateCode !== undefined && input.gstin === undefined) {
    if (input.stateCode && !STATES[input.stateCode]) throw new InvoiceError('VALIDATION', 'Unknown state code', 422)
    cols.state_code = input.stateCode || null
  }
  for (const [k, col] of [['repairServiceSac', 'repair_service_sac'], ['repairPartsHsn', 'repair_parts_hsn']]) {
    if (input[k] === undefined) continue
    if (!/^\d{4,8}$/.test(String(input[k]))) throw new InvoiceError('VALIDATION', `${k} must be a 4–8 digit HSN/SAC code`, 422)
    cols[col] = String(input[k])
  }
  const keys = Object.keys(cols)
  if (keys.length) {
    await query(`UPDATE invoice_settings SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_by = $1, updated_at = NOW() WHERE id = TRUE`, [actor.userId, ...keys.map((k) => cols[k])])
  }
  return serializeSettings(await getSettings())
}

// ── parties ─────────────────────────────────────────────────────────────

const addr = (...parts) => parts.map((x) => text(x, 200)).filter(Boolean).join(', ')

/** Issuer snapshot from the vendor's legal profile, or the platform's own details. */
async function sellerFor(client, vendorId) {
  const s = await getSettings(client)
  const base = { terms: s.terms, footer: s.footer }
  if (!vendorId) {
    return { ...base, vendorId: null, legalName: s.legal_name, gstin: s.gstin, pan: s.pan, address: s.address, state: STATES[s.state_code] ?? null, stateCode: s.state_code, phone: s.phone, email: s.email }
  }
  const { rows } = await client.query(
    `SELECT v.name, v.phone, v.email, vp.legal_name, vp.gstin, vp.pan_number, vp.address_line1, vp.address_line2, vp.city, vp.state, vp.pincode
       FROM vendors v LEFT JOIN vendor_profiles vp ON vp.vendor_id = v.id WHERE v.id = $1`, [vendorId])
  const v = rows[0]
  if (!v) throw new InvoiceError('NO_ISSUER', 'The selling vendor no longer exists', 409)
  const gstin = text(v.gstin, 15).toUpperCase()
  const validGstin = GSTIN_RE.test(gstin) ? gstin : null
  const stateCode = stateCodeFromGstin(validGstin) || stateCodeFromName(v.state)
  return {
    ...base, vendorId, legalName: v.legal_name || v.name, gstin: validGstin, pan: v.pan_number || null,
    address: addr(v.address_line1, v.address_line2, v.city, v.pincode), state: stateCode ? STATES[stateCode] : v.state || null, stateCode, phone: v.phone, email: v.email,
  }
}

/** A document can only be issued by a seller with a name, an address and a known state. */
function assertIssuerComplete(seller) {
  const missing = []
  if (!seller.legalName) missing.push('legal name')
  if (!seller.address) missing.push('address')
  if (!seller.stateCode) missing.push('state / GSTIN')
  if (missing.length) {
    throw new InvoiceError('ISSUER_PROFILE_INCOMPLETE', `The seller's ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} missing. Complete the seller's legal profile before issuing an invoice.`, 409, { missing })
  }
}

function buyerSnapshot(channel, b = {}) {
  const gstin = text(b.gstin, 15).toUpperCase() || null
  if (channel === 'B2B') {
    if (!gstin || !GSTIN_RE.test(gstin)) throw new InvoiceError('VALIDATION', 'A B2B document needs the buyer’s valid 15-character GSTIN', 422)
    if (!text(b.businessName, 200)) throw new InvoiceError('VALIDATION', 'A B2B document needs the buyer’s business name', 422)
  }
  const stateCode = (gstin && stateCodeFromGstin(gstin)) || stateCodeFromName(b.state) || (b.stateCode && STATES[b.stateCode] ? b.stateCode : null)
  if (channel === 'B2B' && !stateCode) throw new InvoiceError('VALIDATION', 'The buyer’s GSTIN has an unknown state code', 422)
  return {
    name: text(b.name, 200) || null, businessName: channel === 'B2B' ? text(b.businessName, 200) : null, gstin: channel === 'B2B' ? gstin : undefined,
    address: text(b.address, 500) || null, shipTo: text(b.shipTo, 500) || null, state: stateCode ? STATES[stateCode] : text(b.state, 100) || null, stateCode,
    phone: text(b.phone, 30) || null, email: text(b.email, 160) || null,
  }
}

/** Place of supply = recipient's state; when unknown (B2C only) the supplier's state is used and flagged. */
function placeOfSupply(seller, buyer) {
  if (buyer.stateCode) return { pos: buyer.stateCode, assumed: false, supply: buyer.stateCode === seller.stateCode ? 'INTRA' : 'INTER' }
  return { pos: seller.stateCode, assumed: true, supply: 'INTRA' }
}

// ── numbering, storage, issuing ─────────────────────────────────────────

async function nextNumber(client, issuerKey, docType, channel, issueDate) {
  const fy = financialYear(issueDate)
  const { rows } = await client.query(
    `INSERT INTO sales_document_series (issuer_key, doc_type, channel, fy, last_number) VALUES ($1,$2,$3,$4,1)
     ON CONFLICT (issuer_key, doc_type, channel, fy) DO UPDATE SET last_number = sales_document_series.last_number + 1
     RETURNING last_number`, [issuerKey, docType, channel, fy])
  const seq = rows[0].last_number
  const prefix = docType === 'TAX_INVOICE' ? PREFIX[channel] : DOC_PREFIX[docType]
  return { fy, seq, number: `${prefix}/${fy}/${String(seq).padStart(6, '0')}` }
}

const pdfPath = (key) => {
  const abs = path.resolve(PRIVATE_DIR, key)
  if (!abs.startsWith(path.resolve(PRIVATE_DIR) + path.sep)) throw new Error('Invalid document path')
  return abs
}

/**
 * Store a fully-computed document. Runs inside the caller's transaction (client).
 * @param {object} d {docType, channel, seller, buyer, buyerUserId, source:{type,id}, ref?, issueDate, dueDate, orderRef, poReference,
 *                    calc (computeDocument result), roundOff, payments, notes, reason, pos, assumed, supply}
 */
async function persist(client, d, actor) {
  const issuerKey = d.seller.vendorId || 'PLATFORM'
  const { fy, seq, number } = await nextNumber(client, issuerKey, d.docType, d.channel, d.issueDate)
  const grand = r2(p(d.calc.total) + p(d.roundOff || 0))
  const { rows } = await client.query(
    `INSERT INTO sales_documents (doc_type, doc_number, fy, seq, channel, issuer_key, issuer_vendor_id, buyer_user_id, source_type, source_id, ref_document_id, reason,
        issue_date, due_date, order_ref, po_reference, seller, buyer, place_of_supply, pos_assumed, supply_type, lines, tax_summary,
        taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total, payments, notes, terms, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33) RETURNING *`,
    [d.docType, number, fy, seq, d.channel, issuerKey, d.seller.vendorId || null, d.buyerUserId || null, d.source.type, d.source.id || null, d.ref?.id || null, d.reason || null,
      d.issueDate, d.dueDate || null, d.orderRef || null, d.poReference || null, JSON.stringify(d.seller), JSON.stringify(d.buyer), d.pos, d.assumed, d.supply,
      JSON.stringify(d.calc.lines), JSON.stringify(d.calc.taxSummary), d.calc.taxable, d.calc.cgst, d.calc.sgst, d.calc.igst, d.roundOff || 0, grand,
      JSON.stringify(d.payments || []), d.notes || null, d.seller.terms || null, actor?.userId || null])
  const row = rows[0]

  // Render from the stored row, write the file, then attach it — all before commit.
  const pdf = await renderDocumentPdf({ ...row, issue_date: d.issueDate, due_date: d.dueDate || null }, { original: d.ref && { ...d.ref, issue_date: ymd(d.ref.issue_date) } })
  const key = path.join('sales-invoices', fy, `${row.id}.pdf`)
  const abs = pdfPath(key)
  await fs.promises.mkdir(path.dirname(abs), { recursive: true })
  await fs.promises.writeFile(abs, pdf, { flag: 'wx', mode: 0o600 })
  try {
    await client.query('UPDATE sales_documents SET pdf_key = $2, pdf_checksum = $3, pdf_bytes = $4 WHERE id = $1', [row.id, key, sha256(pdf), pdf.length])
    await client.query(`INSERT INTO sales_document_events (document_id, kind, actor_id, actor_role, meta) VALUES ($1,'ISSUED',$2,$3,$4)`,
      [row.id, actor?.userId || null, actor?.kind || 'SYSTEM', { number, total: grand, source: d.source.type }])
  } catch (e) {
    await fs.promises.unlink(abs).catch(() => {})
    throw e
  }
  // If the surrounding transaction rolls back later the file would be orphaned; callers remove it via cleanup().
  client.__written = [...(client.__written || []), abs]
  return { ...row, pdf_key: key }
}

/** Run an issuing transaction; on rollback, delete any PDF written inside it. */
async function issuing(fn) {
  const client = await getClient()
  try {
    client.__written = []        // pooled clients are reused: never inherit another call's file list
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    for (const f of client.__written || []) await fs.promises.unlink(f).catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function existingFor(client, sourceType, sourceId) {
  const { rows } = await client.query(`SELECT * FROM sales_documents WHERE source_type = $1 AND source_id = $2 AND doc_type IN ('TAX_INVOICE','BILL_OF_SUPPLY')`, [sourceType, sourceId])
  return rows[0] || null
}

/** Pick the document type from the issuer's registration: GST can only be charged by a registered seller. */
function docTypeFor(seller, calc) {
  if (seller.gstin) return 'TAX_INVOICE'
  if (p(calc.cgst) + p(calc.sgst) + p(calc.igst) === 0) return 'BILL_OF_SUPPLY'
  throw new InvoiceError('ISSUER_NOT_GST_REGISTERED', 'This sale includes GST but the seller has no valid GSTIN on file, so a tax invoice cannot be issued. Add the seller’s GSTIN to its legal profile.', 409)
}

// ── issue: repairs ──────────────────────────────────────────────────────

export async function issueForRepair(repairId, actor) {
  return issuing(async (client) => {
    const { rows: rr } = await client.query('SELECT * FROM repair_requests WHERE id = $1 FOR UPDATE', [repairId])
    const r = rr[0]
    if (!r) throw new InvoiceError('NOT_FOUND', 'Repair not found', 404)
    const found = await existingFor(client, 'REPAIR', repairId)
    if (found) return { ...found, existing: true }
    if (r.status !== 'COMPLETED') throw new InvoiceError('NOT_BILLABLE', 'An invoice is issued once the repair is completed and delivered', 409)
    if (!r.assigned_vendor_id) throw new InvoiceError('NO_ISSUER', 'No service centre is recorded for this repair', 409)
    if (Number(r.approved_total) <= 0) throw new InvoiceError('NOT_BILLABLE', 'There is nothing to invoice on this repair', 409)

    const settings = await getSettings(client)
    const seller = await sellerFor(client, r.assigned_vendor_id)
    assertIssuerComplete(seller)
    const channel = r.channel
    const buyer = buyerSnapshot(channel, channel === 'B2B'
      ? { name: r.contact_person, businessName: r.business_name, gstin: r.gstin, phone: r.customer_phone, email: r.customer_email, address: r.customer_city }
      : { name: r.customer_name, phone: r.customer_phone, email: r.customer_email, address: r.customer_city })
    const { pos, assumed, supply } = placeOfSupply(seller, buyer)

    const { rows: items } = await client.query('SELECT * FROM repair_items WHERE request_id = $1 ORDER BY line_no', [repairId])
    const byId = new Map(items.map((i) => [i.id, i]))
    const label = (i) => (i ? `${i.brand} ${i.model}${i.imei_serial ? ` (${i.imei_serial})` : ''}` : '')
    let lines, taxInclusive = false

    if (r.approved_quote_id) {
      const { rows: qs } = await client.query('SELECT * FROM repair_quotes WHERE id = $1', [r.approved_quote_id])
      const q = qs[0]
      const rate = Number(q.tax_pct)
      const discPct = Number(q.discount_pct)
      lines = q.lines.map((l, n) => {
        const gross = Math.round(l.qty * p(l.unitPrice))
        return {
          description: [label(byId.get(l.itemId)), l.description].filter(Boolean).join(' — '), hsnSac: l.kind === 'PART' ? settings.repair_parts_hsn : settings.repair_service_sac,
          unit: 'NOS', qty: l.qty, unitPrice: l.unitPrice, discount: r2(Math.round((gross * discPct) / 100)), taxRate: rate, meta: { line: n },
        }
      })
    } else {
      // Estimate declined / device unrepairable: only the diagnostic fee is payable, and it is already the amount charged (tax-inclusive).
      const s = await client.query('SELECT diagnostic_fee, tax_pct FROM repair_settings WHERE id = TRUE')
      const billable = items.filter((i) => i.warranty_status !== 'IN_WARRANTY')
      const fee = Number(s.rows[0].diagnostic_fee)
      taxInclusive = true
      lines = billable.map((i) => ({ description: `Diagnostic charges — ${label(i)}`, hsnSac: settings.repair_service_sac, unit: 'NOS', qty: 1, unitPrice: fee, taxRate: Number(s.rows[0].tax_pct), meta: { diagnostic: true } }))
    }
    if (!lines.length) throw new InvoiceError('NOT_BILLABLE', 'There is nothing to invoice on this repair', 409)
    const calc = computeDocument(lines, { supply, taxInclusive })
    const roundOff = r2(p(r.approved_total) - p(calc.total))
    if (Math.abs(roundOff) > 1) throw new InvoiceError('TOTAL_MISMATCH', `The invoice total (₹${calc.total}) does not match the approved repair total (₹${r.approved_total}). Review the repair before invoicing.`, 409)

    const { rows: pays } = await client.query('SELECT kind, method, amount, reference, created_at FROM repair_payments WHERE request_id = $1 ORDER BY created_at, id', [repairId])
    const doc = await persist(client, {
      docType: docTypeFor(seller, calc), channel, seller, buyer, buyerUserId: r.user_id, source: { type: 'REPAIR', id: repairId }, issueDate: istDate(),
      dueDate: ymd(r.due_date), orderRef: r.code, poReference: r.po_reference, calc, roundOff,
      payments: pays.map((x) => ({ kind: x.kind, method: x.method, amount: Number(x.amount), reference: x.reference, at: x.created_at })), pos, assumed, supply,
      notes: r.warranty_until ? `Repair warranty valid until ${new Date(r.warranty_until).toLocaleDateString('en-IN')}.` : null,
    }, actor)
    return { ...doc, existing: false }
  })
}

// ── issue: marketplace seller orders (guarded) ──────────────────────────

/**
 * Checkout adds tax on each item's undiscounted subtotal using the product's current rate and does not store a
 * per-line tax snapshot. We therefore only invoice an order when recomputing that tax today reproduces exactly
 * what the customer was charged, and refuse otherwise rather than print a number that disagrees with the payment.
 */
export async function issueForSellerOrder(sellerOrderId, actor) {
  return issuing(async (client) => {
    const { rows: so } = await client.query('SELECT * FROM seller_orders WHERE id = $1 FOR UPDATE', [sellerOrderId])
    const s = so[0]
    if (!s) throw new InvoiceError('NOT_FOUND', 'Seller order not found', 404)
    const found = await existingFor(client, 'SELLER_ORDER', sellerOrderId)
    if (found) return { ...found, existing: true }
    if (!['DELIVERED', 'CLOSED'].includes(s.status)) throw new InvoiceError('NOT_BILLABLE', 'An invoice is issued once the order is delivered', 409)
    const { rows: ord } = await client.query('SELECT * FROM orders WHERE id = $1', [s.order_id])
    const o = ord[0]
    if (Number(s.seller_discount) > 0 || Number(s.platform_discount) > 0 || Number(o.coupon_discount_amount || 0) > 0 || Number(o.loyalty_redeemed_amount || 0) > 0 || Number(o.discount_amount || 0) > 0) {
      throw new InvoiceError('TAX_BASIS_UNSUPPORTED', 'This order used a discount, coupon or points. Checkout currently charges GST on the undiscounted value, so a compliant invoice cannot be produced automatically until the tax-profile layer is in place. Issue it manually after review.', 409)
    }
    const { rows: gs } = await client.query(`SELECT gst_enabled, gst_rate FROM fee_settings WHERE scope = 'GLOBAL' AND is_active LIMIT 1`).catch(() => ({ rows: [] }))
    const gstOn = gs[0]?.gst_enabled !== false && gs[0]
    const defaultRate = gstOn ? Number(gs[0].gst_rate) : 0

    const { rows: items } = await client.query(
      `SELECT oi.*, pr.name AS pname, pr.hsn_code, pr.gst_rate FROM order_items oi LEFT JOIN products pr ON pr.id = oi.product_id WHERE oi.order_id = $1`, [s.order_id])
    const rateOf = (i) => (gstOn ? (i.gst_rate != null ? Number(i.gst_rate) : defaultRate) : 0)
    // Reconcile the whole parent order against its stored tax, then take this seller's share.
    const total = items.reduce((n, i) => n + Math.round((p(i.subtotal) * rateOf(i)) / 100), 0)
    if (Math.abs(total - p(o.tax_amount || 0)) > 5) {
      throw new InvoiceError('TAX_MISMATCH', `The tax recomputed from today's product rates (₹${r2(total)}) differs from the tax charged on the order (₹${o.tax_amount}). Product tax rates have changed since checkout, so this invoice needs a manual review.`, 409, { recomputed: r2(total), charged: Number(o.tax_amount) })
    }
    const mine = items.filter((i) => i.seller_order_id === sellerOrderId)
    if (!mine.length) throw new InvoiceError('NOT_BILLABLE', 'This seller order has no items', 409)

    const seller = await sellerFor(client, s.vendor_id)
    assertIssuerComplete(seller)
    const channel = s.channel
    const a = typeof o.delivery_address === 'string' ? JSON.parse(o.delivery_address) : o.delivery_address || {}
    const { rows: us } = await client.query('SELECT name, phone, email FROM users WHERE id = $1', [o.customer_id])
    const full = addr(a.line1, a.line2, a.city, a.state, a.pincode)
    const buyer = buyerSnapshot('B2C', { name: a.name || us[0]?.name, phone: a.phone || us[0]?.phone, email: us[0]?.email, address: full, shipTo: full, state: a.state })
    const { pos, assumed, supply } = placeOfSupply(seller, buyer)

    const lines = mine.map((i) => ({ description: i.pname || i.product_name, hsnSac: i.hsn_code || '', unit: (i.unit || 'NOS').toUpperCase(), qty: Number(i.quantity), unitPrice: Number(i.unit_price), taxRate: rateOf(i) }))
    if (Number(s.shipping_charge) > 0) lines.push({ description: 'Delivery charges', hsnSac: '', unit: 'NOS', qty: 1, unitPrice: Number(s.shipping_charge), taxRate: 0 })
    const calc = computeDocument(lines, { supply })
    const doc = await persist(client, {
      docType: docTypeFor(seller, calc), channel, seller, buyer, buyerUserId: o.customer_id, source: { type: 'SELLER_ORDER', id: sellerOrderId }, issueDate: istDate(),
      orderRef: s.seller_order_number, calc, roundOff: 0, payments: [], pos, assumed, supply,
      notes: `Payment: ${o.payment_method || '—'} (${String(o.payment_status || '').toLowerCase() || 'unknown'}).`,
    }, actor)
    await client.query('UPDATE seller_orders SET invoice_number = $2 WHERE id = $1', [sellerOrderId, doc.doc_number])
    return { ...doc, existing: false }
  })
}

// ── issue: manual (offline B2B sales, auctions, anything staff must bill) ─

function cleanManualLines(raw, channel) {
  if (!Array.isArray(raw) || !raw.length) throw new InvoiceError('VALIDATION', 'Add at least one line', 422)
  if (raw.length > 200) throw new InvoiceError('VALIDATION', 'At most 200 lines per document', 422)
  return raw.map((l, n) => {
    const d = text(l.description, 300)
    if (d.length < 2) throw new InvoiceError('VALIDATION', `Line ${n + 1}: add a description`, 422)
    const qty = Number(l.qty ?? 1), unit = Number(l.unitPrice), disc = Number(l.discount ?? 0), rate = Number(l.taxRate)
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000 || Math.abs(Math.round(qty * 1000) / 1000 - qty) > 1e-9) throw new InvoiceError('VALIDATION', `Line ${n + 1}: quantity must be above zero (up to 3 decimals)`, 422)
    if (!Number.isFinite(unit) || unit < 0 || unit > 100_000_000 || Math.abs(Math.round(unit * 100) / 100 - unit) > 1e-9) throw new InvoiceError('VALIDATION', `Line ${n + 1}: unit price is invalid`, 422)
    if (!Number.isFinite(disc) || disc < 0) throw new InvoiceError('VALIDATION', `Line ${n + 1}: discount is invalid`, 422)
    if (!GST_SLABS.includes(rate)) throw new InvoiceError('VALIDATION', `Line ${n + 1}: GST rate must be one of ${GST_SLABS.join(', ')}%`, 422)
    const hsn = text(l.hsnSac, 8)
    if (hsn && !/^\d{4,8}$/.test(hsn)) throw new InvoiceError('VALIDATION', `Line ${n + 1}: HSN/SAC must be 4–8 digits`, 422)
    if (channel === 'B2B' && !hsn) throw new InvoiceError('VALIDATION', `Line ${n + 1}: HSN/SAC is required on business invoices`, 422)
    return { description: d, hsnSac: hsn, unit: text(l.unit, 8).toUpperCase() || 'NOS', qty, unitPrice: unit, discount: disc, taxRate: rate }
  })
}

export async function issueManual(actor, input = {}) {
  const channel = input.channel === 'B2B' ? 'B2B' : 'B2C'
  const lines = cleanManualLines(input.lines, channel)
  return issuing(async (client) => {
    const seller = await sellerFor(client, input.issuerVendorId || null)
    assertIssuerComplete(seller)
    const buyer = buyerSnapshot(channel, input.buyer)
    if (!buyer.name && !buyer.businessName) throw new InvoiceError('VALIDATION', 'Buyer name is required', 422)
    const { pos, assumed, supply } = placeOfSupply(seller, buyer)
    let calc
    try { calc = computeDocument(lines, { supply, taxInclusive: !!input.taxInclusive }) } catch (e) { if (e instanceof RangeError) throw new InvoiceError('VALIDATION', e.message, 422); throw e }
    let buyerUserId = null
    if (input.buyerUserId) {
      const { rows } = await client.query('SELECT id FROM users WHERE id = $1', [input.buyerUserId])
      buyerUserId = rows[0]?.id || null
    }
    const due = input.dueDate ? text(input.dueDate, 10) : null
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new InvoiceError('VALIDATION', 'Due date must be YYYY-MM-DD', 422)
    return persist(client, {
      docType: docTypeFor(seller, calc), channel, seller, buyer, buyerUserId, source: { type: 'MANUAL', id: null }, issueDate: istDate(), dueDate: due,
      orderRef: text(input.orderRef, 60) || null, poReference: channel === 'B2B' ? text(input.poReference, 60) || null : null, calc, roundOff: 0, payments: [], pos, assumed, supply,
      notes: text(input.notes, 600) || null,
    }, actor)
  })
}

// ── credit & debit notes ────────────────────────────────────────────────

async function creditedSoFar(client, docId) {
  const { rows } = await client.query(`SELECT lines FROM sales_documents WHERE ref_document_id = $1 AND doc_type = 'CREDIT_NOTE'`, [docId])
  const used = new Map()
  for (const cn of rows) for (const l of cn.lines) {
    const k = l.meta?.origIndex
    if (k == null) continue
    const cur = used.get(k) || { qty: 0, taxable: 0 }
    cur.qty += Number(l.qty); cur.taxable += p(l.taxable)
    used.set(k, cur)
  }
  return used
}

/**
 * Credit part or all of an issued invoice, line by line. Tax is reversed at the original rate and split,
 * the buyer, seller and place of supply are copied, and the total can never exceed what was invoiced.
 */
export async function issueCreditNote(actor, docId, input = {}) {
  const reason = text(input.reason, 500)
  if (reason.length < 3) throw new InvoiceError('VALIDATION', 'A reason is required for a credit note', 422)
  if (!Array.isArray(input.lines) || !input.lines.length) throw new InvoiceError('VALIDATION', 'Choose at least one line to credit', 422)
  return issuing(async (client) => {
    const { rows } = await client.query('SELECT * FROM sales_documents WHERE id = $1 FOR UPDATE', [docId])
    const orig = rows[0]
    if (!orig || !canSee(actor, orig)) throw new InvoiceError('NOT_FOUND', 'Document not found', 404)
    if (!['TAX_INVOICE', 'BILL_OF_SUPPLY'].includes(orig.doc_type)) throw new InvoiceError('INVALID_STATE', 'Credit notes can only be issued against an invoice', 409)
    const used = await creditedSoFar(client, docId)
    const out = []
    const seen = new Set()
    for (const sel of input.lines) {
      const idx = Number(sel.index)
      const ol = orig.lines[idx]
      if (!Number.isInteger(idx) || !ol) throw new InvoiceError('VALIDATION', 'Unknown invoice line', 422)
      if (seen.has(idx)) throw new InvoiceError('VALIDATION', 'A line can only be selected once', 422)
      seen.add(idx)
      const done = used.get(idx) || { qty: 0, taxable: 0 }
      const remQty = Math.round((Number(ol.qty) - done.qty) * 1000) / 1000
      if (remQty <= 1e-9) throw new InvoiceError('OVER_CREDIT', `"${ol.description}" has already been credited in full`, 409, { index: idx, remaining: 0 })
      const qty = Number(sel.qty ?? remQty)
      if (!Number.isFinite(qty) || qty <= 0) throw new InvoiceError('VALIDATION', 'Quantity to credit must be above zero', 422)
      if (qty > remQty + 1e-9) throw new InvoiceError('OVER_CREDIT', `Only ${remQty} of "${ol.description}" can still be credited`, 409, { index: idx, remaining: remQty })
      // Crediting the full remainder takes exactly what is left, so partial credits always sum to the original line.
      const remTaxable = p(ol.taxable) - done.taxable
      const taxable = Math.abs(qty - remQty) < 1e-9 ? remTaxable : Math.round((p(ol.taxable) * qty) / Number(ol.qty))
      if (taxable < 0 || taxable > remTaxable) throw new InvoiceError('OVER_CREDIT', 'That would credit more than was invoiced', 409)
      out.push({ description: ol.description, hsnSac: ol.hsnSac, unit: ol.unit, qty, unitPrice: 0, taxRate: ol.taxRate, taxablePaise: taxable, meta: { origIndex: idx } })
    }
    const supply = orig.supply_type
    const calc = computeDocument(out, { supply })
    const { rows: prior } = await client.query(`SELECT COALESCE(SUM(grand_total),0) AS s FROM sales_documents WHERE ref_document_id = $1 AND doc_type = 'CREDIT_NOTE'`, [docId])
    const credited = p(prior[0].s) + p(calc.total)
    // The invoice's round-off (if any) belongs to the last credit, so allow its total as the ceiling.
    if (credited > p(orig.grand_total)) throw new InvoiceError('OVER_CREDIT', `Credit notes cannot exceed the invoice total (₹${orig.grand_total})`, 409)
    const seller = { ...orig.seller }
    const note = await persist(client, {
      docType: 'CREDIT_NOTE', channel: orig.channel, seller, buyer: orig.buyer, buyerUserId: orig.buyer_user_id, source: { type: orig.source_type, id: orig.source_id },
      ref: { id: orig.id, doc_number: orig.doc_number, issue_date: orig.issue_date }, reason, issueDate: istDate(), orderRef: orig.order_ref, poReference: orig.po_reference,
      calc, roundOff: 0, payments: [], pos: orig.place_of_supply, assumed: orig.pos_assumed, supply, notes: text(input.notes, 600) || null,
    }, actor)
    await client.query(`INSERT INTO sales_document_events (document_id, kind, actor_id, actor_role, meta) VALUES ($1,'CREDIT_NOTE_ISSUED',$2,$3,$4)`,
      [docId, actor.userId, actor.kind, { creditNote: note.doc_number, total: num(note.grand_total), reason }])
    return note
  })
}

/** Increase an issued invoice (e.g. under-billed freight). Same pipeline with new lines at a chosen rate. */
export async function issueDebitNote(actor, docId, input = {}) {
  const reason = text(input.reason, 500)
  if (reason.length < 3) throw new InvoiceError('VALIDATION', 'A reason is required for a debit note', 422)
  return issuing(async (client) => {
    const { rows } = await client.query('SELECT * FROM sales_documents WHERE id = $1 FOR UPDATE', [docId])
    const orig = rows[0]
    if (!orig || !canSee(actor, orig)) throw new InvoiceError('NOT_FOUND', 'Document not found', 404)
    if (!['TAX_INVOICE', 'BILL_OF_SUPPLY'].includes(orig.doc_type)) throw new InvoiceError('INVALID_STATE', 'Debit notes can only be issued against an invoice', 409)
    const lines = cleanManualLines(input.lines, orig.channel)
    const calc = computeDocument(lines, { supply: orig.supply_type, taxInclusive: !!input.taxInclusive })
    if (orig.doc_type === 'BILL_OF_SUPPLY' && p(calc.cgst) + p(calc.sgst) + p(calc.igst) > 0) throw new InvoiceError('ISSUER_NOT_GST_REGISTERED', 'A bill of supply cannot carry GST', 409)
    const note = await persist(client, {
      docType: 'DEBIT_NOTE', channel: orig.channel, seller: { ...orig.seller }, buyer: orig.buyer, buyerUserId: orig.buyer_user_id, source: { type: orig.source_type, id: orig.source_id },
      ref: { id: orig.id, doc_number: orig.doc_number, issue_date: orig.issue_date }, reason, issueDate: istDate(), orderRef: orig.order_ref, poReference: orig.po_reference,
      calc, roundOff: 0, payments: [], pos: orig.place_of_supply, assumed: orig.pos_assumed, supply: orig.supply_type, notes: text(input.notes, 600) || null,
    }, actor)
    await client.query(`INSERT INTO sales_document_events (document_id, kind, actor_id, actor_role, meta) VALUES ($1,'DEBIT_NOTE_ISSUED',$2,$3,$4)`,
      [docId, actor.userId, actor.kind, { debitNote: note.doc_number, total: num(note.grand_total), reason }])
    return note
  })
}

// ── reads ───────────────────────────────────────────────────────────────

const canSee = (actor, d) =>
  actor.kind === 'ADMIN' ||
  (actor.kind === 'VENDOR' && !!actor.vendorId && d.issuer_vendor_id === actor.vendorId) ||
  (actor.kind === 'CUSTOMER' && d.buyer_user_id === actor.userId)

function payment(d) {
  if (d.doc_type === 'CREDIT_NOTE' || d.doc_type === 'DEBIT_NOTE') return null
  if (d.source_type === 'REPAIR' && d.rr_total != null) {
    const paid = Number(d.rr_paid), total = Number(d.grand_total)
    return { status: paid >= total ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID', paid, due: Math.max(0, r2(p(total) - p(paid))) }
  }
  if (d.source_type === 'SELLER_ORDER' && d.o_status) return { status: d.o_status === 'PAID' ? 'PAID' : 'UNPAID', paid: d.o_status === 'PAID' ? Number(d.grand_total) : 0, due: d.o_status === 'PAID' ? 0 : Number(d.grand_total) }
  return { status: 'UNTRACKED', paid: null, due: null }
}

function serialize(d, { full = false } = {}) {
  const out = {
    id: d.id, docType: d.doc_type, number: d.doc_number, channel: d.channel, issueDate: String(d.issue_date_s ?? '').slice(0, 10) || new Date(d.issue_date).toISOString().slice(0, 10),
    dueDate: d.due_date_s ? String(d.due_date_s).slice(0, 10) : null, orderRef: d.order_ref, poReference: d.po_reference, sourceType: d.source_type, sourceId: d.source_id,
    refDocumentId: d.ref_document_id, refNumber: d.ref_number || null, reason: d.reason,
    seller: { name: d.seller.legalName, gstin: d.seller.gstin, state: d.seller.state }, buyer: { name: d.buyer.businessName || d.buyer.name, gstin: d.buyer.gstin ?? null },
    taxable: num(d.taxable_total), cgst: num(d.cgst_total), sgst: num(d.sgst_total), igst: num(d.igst_total), roundOff: num(d.round_off), total: num(d.grand_total),
    supplyType: d.supply_type, createdAt: d.created_at.toISOString(), payment: payment(d), irn: { status: d.irn_status, value: d.irn },
    credited: d.credited != null ? num(d.credited) : undefined,
  }
  if (full) Object.assign(out, {
    sellerFull: d.seller, buyerFull: d.buyer, placeOfSupply: d.place_of_supply, posAssumed: d.pos_assumed, lines: d.lines, taxSummary: d.tax_summary, payments: d.payments,
    notes: d.notes, terms: d.terms, pdf: { bytes: d.pdf_bytes, checksum: d.pdf_checksum },
  })
  return out
}

const SELECT = `
  SELECT d.*, d.issue_date::text AS issue_date_s, d.due_date::text AS due_date_s, ref.doc_number AS ref_number,
         rr.approved_total AS rr_total, rr.amount_paid AS rr_paid, o.payment_status AS o_status,
         (SELECT COALESCE(SUM(c.grand_total), 0) FROM sales_documents c WHERE c.ref_document_id = d.id AND c.doc_type = 'CREDIT_NOTE') AS credited
    FROM sales_documents d
    LEFT JOIN sales_documents ref ON ref.id = d.ref_document_id
    LEFT JOIN repair_requests rr ON d.source_type = 'REPAIR' AND rr.id = d.source_id
    LEFT JOIN seller_orders so ON d.source_type = 'SELLER_ORDER' AND so.id = d.source_id
    LEFT JOIN orders o ON o.id = so.order_id`

function scope(actor, params) {
  if (actor.kind === 'ADMIN') return 'TRUE'
  if (actor.kind === 'CUSTOMER') { params.push(actor.userId); return `d.buyer_user_id = $${params.length}` }
  params.push(actor.vendorId || null)
  return `d.issuer_vendor_id = $${params.length}`
}

function filters(actor, f, params) {
  const where = [scope(actor, params)]
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)) }
  if (f.channel === 'B2B' || f.channel === 'B2C') add('d.channel = ?', f.channel)
  if (['TAX_INVOICE', 'BILL_OF_SUPPLY', 'CREDIT_NOTE', 'DEBIT_NOTE'].includes(f.docType)) add('d.doc_type = ?', f.docType)
  if (f.issuerVendorId && actor.kind === 'ADMIN') add('d.issuer_vendor_id = ?', f.issuerVendorId)
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.from || '')) add('d.issue_date >= ?', f.from)
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.to || '')) add('d.issue_date <= ?', f.to)
  if (f.q) {
    params.push(`%${String(f.q).slice(0, 100)}%`)
    where.push(`((d.doc_number || ' ' || COALESCE(d.order_ref,'') || ' ' || COALESCE(d.po_reference,'') || ' ' || (d.buyer ->> 'name') || ' ' || COALESCE(d.buyer ->> 'businessName','') || ' ' || COALESCE(d.buyer ->> 'gstin','')) ILIKE $${params.length})`)
  }
  return where.join(' AND ')
}

export async function list(actor, f = {}) {
  const params = []
  const where = filters(actor, f, params)
  const { rows: cnt } = await query(`SELECT d.channel, d.doc_type, COUNT(*)::int AS n, COALESCE(SUM(d.grand_total),0) AS total FROM sales_documents d WHERE ${where} GROUP BY d.channel, d.doc_type`, params)
  const limit = Math.min(100, Math.max(1, Number(f.limit) || 20))
  const total = cnt.reduce((n, c) => n + c.n, 0)
  const pages = Math.max(1, Math.ceil(total / limit))
  const page = Math.min(Math.max(1, Number(f.page) || 1), pages)
  const { rows } = await query(`${SELECT} WHERE ${where} ORDER BY d.created_at DESC, d.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, (page - 1) * limit])
  return {
    items: rows.map((r) => serialize(r)), total, page, pages,
    summary: { byChannel: Object.fromEntries(['B2B', 'B2C'].map((c) => [c, cnt.filter((x) => x.channel === c).reduce((n, x) => n + x.n, 0)])),
      invoiced: cnt.filter((x) => ['TAX_INVOICE', 'BILL_OF_SUPPLY'].includes(x.doc_type)).reduce((n, x) => n + Number(x.total), 0),
      credited: cnt.filter((x) => x.doc_type === 'CREDIT_NOTE').reduce((n, x) => n + Number(x.total), 0) },
  }
}

export async function get(actor, id) {
  const params = [id]
  const sc = scope(actor, params)
  const { rows } = await query(`${SELECT} WHERE d.id = $1 AND ${sc}`, params)
  if (!rows[0]) throw new InvoiceError('NOT_FOUND', 'Document not found', 404)
  const d = rows[0]
  const [{ rows: notes }, { rows: events }] = await Promise.all([
    query(`${SELECT} WHERE d.ref_document_id = $1 ORDER BY d.created_at`, [id]),
    query(`SELECT e.kind, e.actor_role, e.meta, e.created_at, u.name AS actor_name FROM sales_document_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.document_id = $1 ORDER BY e.id`, [id]),
  ])
  // How much of each invoice line can still be credited (drives the credit-note screen).
  let creditable
  if (['TAX_INVOICE', 'BILL_OF_SUPPLY'].includes(d.doc_type)) {
    const used = await creditedSoFar({ query }, id)
    creditable = d.lines.map((l, index) => ({ index, remainingQty: Math.round((Number(l.qty) - (used.get(index)?.qty || 0)) * 1000) / 1000 }))
  }
  return {
    ...serialize(d, { full: true }),
    creditable,
    notesIssued: notes.map((n) => serialize(n)),
    history: events.map((e) => ({ kind: e.kind, at: e.created_at.toISOString(), actorRole: e.actor_role, actorName: e.actor_name || undefined, meta: e.meta })),
  }
}

/** Invoice (if any) for a repair or seller order, for the order/repair screens. */
export async function forSource(actor, sourceType, sourceId) {
  const params = [sourceType, sourceId]
  const sc = scope(actor, params)
  const { rows } = await query(`SELECT id, doc_number, doc_type FROM sales_documents d WHERE d.source_type = $1 AND d.source_id = $2 AND d.doc_type IN ('TAX_INVOICE','BILL_OF_SUPPLY') AND ${sc}`, params)
  return rows[0] ? { id: rows[0].id, number: rows[0].doc_number, docType: rows[0].doc_type } : null
}

/** The stored PDF, integrity-checked against the checksum recorded when it was issued. Every access is audited. */
export async function pdf(actor, id, { download = false } = {}) {
  const params = [id]
  const sc = scope(actor, params)
  const { rows } = await query(`SELECT d.id, d.doc_number, d.doc_type, d.pdf_key, d.pdf_checksum FROM sales_documents d WHERE d.id = $1 AND ${sc}`, params)
  const d = rows[0]
  if (!d) throw new InvoiceError('NOT_FOUND', 'Document not found', 404)
  let buf
  try { buf = await fs.promises.readFile(pdfPath(d.pdf_key)) } catch {
    logger.error({ documentId: id }, 'sales document file missing from storage')
    throw new InvoiceError('FILE_MISSING', 'The stored PDF is missing. Contact support — the invoice data is intact.', 500)
  }
  if (sha256(buf) !== d.pdf_checksum) {
    logger.error({ documentId: id }, 'sales document checksum mismatch')
    throw new InvoiceError('INTEGRITY_FAILED', 'The stored PDF failed its integrity check and was not served.', 500)
  }
  await query(`INSERT INTO sales_document_events (document_id, kind, actor_id, actor_role) VALUES ($1,$2,$3,$4)`, [id, download ? 'DOWNLOADED' : 'VIEWED', actor.userId, actor.kind])
  return { buffer: buf, filename: `${d.doc_number.replace(/\//g, '-')}.pdf` }
}

const csv = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

/** CSV for accounts / GST filing prep. Capped; amounts as stored. */
export async function exportCsv(actor, f = {}) {
  const params = []
  const where = filters(actor, f, params)
  const { rows } = await query(`${SELECT} WHERE ${where} ORDER BY d.issue_date, d.doc_number LIMIT 5000`, params)
  const head = ['Document No', 'Type', 'Channel', 'Date', 'Against', 'Order Ref', 'PO', 'Seller', 'Seller GSTIN', 'Buyer', 'Buyer GSTIN', 'Place of Supply', 'Supply', 'Taxable', 'CGST', 'SGST', 'IGST', 'Round Off', 'Total', 'Payment']
  const lines = rows.map((d) => {
    const s = serialize(d)
    const sign = d.doc_type === 'CREDIT_NOTE' ? -1 : 1   // credit notes reduce the period's sales
    return [d.doc_number, d.doc_type, d.channel, s.issueDate, d.ref_number || '', d.order_ref || '', d.po_reference || '', d.seller.legalName, d.seller.gstin || '', d.buyer.businessName || d.buyer.name || '', d.buyer.gstin || '',
      `${STATES[d.place_of_supply] || ''} (${d.place_of_supply})`, d.supply_type, sign * Number(d.taxable_total), sign * Number(d.cgst_total), sign * Number(d.sgst_total), sign * Number(d.igst_total), Number(d.round_off) * sign, sign * Number(d.grand_total), s.payment?.status || ''].map(csv).join(',')
  })
  return { csv: `${[head.join(','), ...lines].join('\n')}\n`, count: rows.length, truncated: rows.length === 5000 }
}
