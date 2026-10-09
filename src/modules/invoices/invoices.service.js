/**
 * Invoices service — seller purchase invoices mapped to a listing.
 *
 * Seller uploads → mapped to the listing (and its IMEI/serial) → admin
 * verifies → verified invoices are permanent (DB trigger blocks edits and
 * deletes). Rejected/unverified ones can be replaced or removed.
 *
 * @module modules/invoices/invoices.service
 */

import { query, getClient } from '../../config/database.js'
import { saveInvoiceFile, removeInvoiceFile, sha256, sniffMime, INVOICE_TYPES, MAX_INVOICE_BYTES } from './invoice-storage.js'

const httpError = (statusCode, message, code = 'INVOICE_ERROR') => Object.assign(new Error(message), { statusCode, code })

const SELECT = `
  SELECT i.id, i.shop_product_id, i.product_id, i.vendor_id, i.invoice_number, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
         i.purchase_amount, i.gst_amount, i.supplier_name, i.imei_serial, i.file_name, i.mime_type,
         i.file_size, i.status, i.rejection_reason, i.verified_at, i.created_at,
         p.name AS product_name, p.imei AS product_imei, COALESCE(v.name, 'Dealker') AS vendor_name,
         vu.name AS verified_by_name, uu.name AS uploaded_by_name
    FROM listing_invoices i
    JOIN shop_products sp ON sp.id = i.shop_product_id
    JOIN products p ON p.id = sp.product_id
    LEFT JOIN vendors v ON v.id = i.vendor_id
    LEFT JOIN users vu ON vu.id = i.verified_by
    LEFT JOIN users uu ON uu.id = i.uploaded_by`

const shape = (r) => ({
  ...r,
  purchase_amount: Number(r.purchase_amount),
  gst_amount: Number(r.gst_amount),
  file_size: Number(r.file_size),
})

export function validateFields(f) {
  const e = []
  const num = String(f.invoiceNumber || '').trim()
  if (!num) e.push('Invoice number is required')
  else if (num.length > 60) e.push('Invoice number is too long (max 60 characters)')
  const d = new Date(`${f.invoiceDate}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f.invoiceDate || '')) || Number.isNaN(d.getTime())) e.push('Invoice date is required (YYYY-MM-DD)')
  else if (d.getTime() > Date.now() + 24 * 3600 * 1000) e.push('Invoice date cannot be in the future')
  else if (d.getUTCFullYear() < 2000) e.push('Invoice date looks wrong')
  const amount = Number(f.purchaseAmount)
  if (!(amount > 0)) e.push('Purchase amount must be greater than 0')
  const gst = Number(f.gstAmount || 0)
  if (!(gst >= 0)) e.push('GST cannot be negative')
  else if (amount > 0 && gst > amount) e.push('GST cannot be more than the purchase amount')
  if (String(f.imeiSerial || '').length > 100) e.push('IMEI / serial is too long')
  if (e.length) throw httpError(400, e.join('. '), 'VALIDATION')
  return { num, amount, gst }
}

export class InvoicesService {
  constructor({ qc } = {}) {
    this.qc = qc || null
  }

  async #listingFor(listingId, vendorId) {
    const { rows } = await query(
      `SELECT sp.id, sp.product_id, p.owner_vendor_id, p.imei, p.serial_number
         FROM shop_products sp JOIN products p ON p.id = sp.product_id
        WHERE sp.id = $1 AND sp.deleted_at IS NULL ${vendorId ? 'AND p.owner_vendor_id = $2' : ''}`,
      vendorId ? [listingId, vendorId] : [listingId])
    if (!rows[0]) throw httpError(404, 'Listing not found', 'NOT_FOUND')
    return rows[0]
  }

  async #syncHasInvoice(listingId, runner = query) {
    await runner(
      `UPDATE products SET has_invoice = EXISTS (
          SELECT 1 FROM listing_invoices i WHERE i.shop_product_id = $1 AND i.status <> 'REJECTED'
       ), updated_at = NOW()
        WHERE id = (SELECT product_id FROM shop_products WHERE id = $1)`, [listingId])
  }

  async #afterChange(listingId) {
    await this.#syncHasInvoice(listingId)
    if (this.qc) await this.qc.autoIfEnabled(listingId)
  }

  async stats(vendorId = null) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'UPLOADED')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'VERIFIED')::int AS verified,
              COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
              COALESCE(SUM(purchase_amount) FILTER (WHERE status = 'VERIFIED'), 0) AS verified_amount
         FROM listing_invoices ${vendorId ? 'WHERE vendor_id = $1' : ''}`, vendorId ? [vendorId] : [])
    return { ...rows[0], verified_amount: Number(rows[0].verified_amount) }
  }

  async list({ status = '', search = '', vendorId = null, listingId = null, page = 1, limit = 25 } = {}) {
    const where = []
    const params = []
    const p = (v) => { params.push(v); return `$${params.length}` }
    if (vendorId) where.push(`i.vendor_id = ${p(vendorId)}`)
    if (listingId) where.push(`i.shop_product_id = ${p(listingId)}`)
    if (status) where.push(`i.status = ${p(status)}`)
    if (search) {
      const s = p(`%${search}%`)
      where.push(`(i.invoice_number ILIKE ${s} OR i.imei_serial ILIKE ${s} OR p.name ILIKE ${s} OR v.name ILIKE ${s} OR i.supplier_name ILIKE ${s})`)
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const lim = Math.min(100, Math.max(1, Number(limit) || 25))
    const off = (Math.max(1, Number(page)) - 1) * lim
    const total = (await query(
      `SELECT COUNT(*)::int n FROM listing_invoices i
         JOIN shop_products sp ON sp.id = i.shop_product_id JOIN products p ON p.id = sp.product_id
         LEFT JOIN vendors v ON v.id = i.vendor_id ${w}`, params)).rows[0].n
    const { rows } = await query(
      `${SELECT} ${w} ORDER BY (i.status = 'UPLOADED') DESC, i.created_at DESC LIMIT ${lim} OFFSET ${off}`, params)
    return { data: rows.map(shape), meta: { page: Number(page), limit: lim, total, totalPages: Math.ceil(total / lim) } }
  }

  async get(id, vendorId = null) {
    const { rows } = await query(`${SELECT} WHERE i.id = $1 ${vendorId ? 'AND i.vendor_id = $2' : ''}`, vendorId ? [id, vendorId] : [id])
    if (!rows[0]) throw httpError(404, 'Invoice not found', 'NOT_FOUND')
    return shape(rows[0])
  }

  /**
   * @param {{buffer:Buffer, filename:string, mime:string}} file already size-limited by the route
   */
  async create(listingId, fields, file, { vendorId = null, actorId = null } = {}) {
    const { num, amount, gst } = validateFields(fields)
    if (!file?.buffer?.length) throw httpError(400, 'Attach the invoice file (PDF, JPG, PNG or WebP)', 'FILE_REQUIRED')
    if (file.buffer.length > MAX_INVOICE_BYTES) throw httpError(413, 'Invoice file is larger than 10 MB', 'FILE_TOO_LARGE')
    const real = sniffMime(file.buffer)
    if (!real || !INVOICE_TYPES[real]) throw httpError(400, 'Only PDF, JPG, PNG or WebP files are accepted', 'FILE_TYPE')
    const listing = await this.#listingFor(listingId, vendorId)

    const imeiSerial = String(fields.imeiSerial || '').trim() || listing.imei || listing.serial_number || null
    const rel = await saveInvoiceFile(file.buffer, real)
    try {
      const { rows } = await query(
        `INSERT INTO listing_invoices
           (shop_product_id, product_id, vendor_id, invoice_number, invoice_date, purchase_amount, gst_amount,
            supplier_name, imei_serial, file_path, file_name, mime_type, file_size, sha256, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [listingId, listing.product_id, listing.owner_vendor_id, num, fields.invoiceDate, amount, gst,
          String(fields.supplierName || '').trim() || null, imeiSerial, rel,
          String(file.filename || `invoice.${INVOICE_TYPES[real]}`).slice(0, 255), real, file.buffer.length, sha256(file.buffer), actorId])
      await this.#afterChange(listingId)
      return this.get(rows[0].id)
    } catch (e) {
      await removeInvoiceFile(rel)
      if (e.code === '23505') throw httpError(409, 'This invoice number is already on file for this seller and IMEI/serial', 'DUPLICATE_INVOICE')
      throw e
    }
  }

  async verify(id, actorId) {
    const client = await getClient()
    let listingId
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(`SELECT * FROM listing_invoices WHERE id = $1 FOR UPDATE`, [id])
      const inv = rows[0]
      if (!inv) throw httpError(404, 'Invoice not found', 'NOT_FOUND')
      if (inv.status === 'VERIFIED') throw httpError(409, 'Invoice is already verified', 'ALREADY_VERIFIED')
      if (inv.status === 'REJECTED') throw httpError(409, 'A rejected invoice cannot be verified — the seller must upload a new one', 'REJECTED')
      listingId = inv.shop_product_id
      await client.query(
        `UPDATE listing_invoices SET status = 'VERIFIED', verified_by = $2, verified_at = NOW(), rejection_reason = NULL, updated_at = NOW() WHERE id = $1`,
        [id, actorId])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    await this.#afterChange(listingId)
    return this.get(id)
  }

  async reject(id, reason, actorId) {
    const text = String(reason || '').trim()
    if (text.length < 5) throw httpError(400, 'Tell the seller what is wrong with the invoice (at least 5 characters)', 'REASON_REQUIRED')
    const { rows } = await query(`SELECT status, shop_product_id FROM listing_invoices WHERE id = $1`, [id])
    if (!rows[0]) throw httpError(404, 'Invoice not found', 'NOT_FOUND')
    if (rows[0].status === 'VERIFIED') throw httpError(409, 'A verified invoice is permanent and cannot be rejected', 'PERMANENT')
    await query(
      `UPDATE listing_invoices SET status = 'REJECTED', rejection_reason = $2, verified_by = $3, verified_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id, text, actorId])
    await this.#afterChange(rows[0].shop_product_id)
    return this.get(id)
  }

  async remove(id, vendorId = null) {
    const { rows } = await query(
      `SELECT status, file_path, shop_product_id FROM listing_invoices WHERE id = $1 ${vendorId ? 'AND vendor_id = $2' : ''}`,
      vendorId ? [id, vendorId] : [id])
    if (!rows[0]) throw httpError(404, 'Invoice not found', 'NOT_FOUND')
    if (rows[0].status === 'VERIFIED') throw httpError(409, 'A verified invoice is permanent and cannot be deleted', 'PERMANENT')
    await query(`DELETE FROM listing_invoices WHERE id = $1`, [id])
    await removeInvoiceFile(rows[0].file_path)
    await this.#afterChange(rows[0].shop_product_id)
  }

  async fileInfo(id, vendorId = null) {
    const { rows } = await query(
      `SELECT file_path, file_name, mime_type FROM listing_invoices WHERE id = $1 ${vendorId ? 'AND vendor_id = $2' : ''}`,
      vendorId ? [id, vendorId] : [id])
    if (!rows[0]) throw httpError(404, 'Invoice not found', 'NOT_FOUND')
    return rows[0]
  }
}
