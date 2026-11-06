/**
 * The seller's sales invoice for one order, attached at packing time.
 * Shared by marketplace seller orders (B2C, wholesale, auction, used devices) and requirement-based B2B orders.
 * Packing or shipping is refused until a vendor has uploaded one.
 *
 * @module modules/invoices/order-invoice
 */

import fs from 'node:fs'
import { query } from '../../config/database.js'
import {
  MAX_INVOICE_BYTES, INVOICE_TYPES, sniffMime, saveInvoiceFile, removeInvoiceFile, resolveInvoicePath,
} from './invoice-storage.js'

// table + owner column are fixed here, never taken from input
const TARGETS = {
  SELLER_ORDER: { table: 'seller_orders', owner: 'vendor_id' },
  B2B_ORDER: { table: 'b2b_orders', owner: 'seller_vendor_id' },
}

function fail(statusCode, code, message) {
  const e = new Error(message)
  e.statusCode = statusCode
  e.code = code
  return e
}

/** Read the multipart form: one file plus an optional invoice number. */
export async function readInvoiceUpload(request) {
  let file = null
  let number = null
  for await (const part of request.parts({ limits: { files: 1, fileSize: MAX_INVOICE_BYTES } })) {
    if (part.type === 'file') {
      const chunks = []
      for await (const c of part.file) chunks.push(c)
      if (part.file.truncated) throw fail(413, 'FILE_TOO_LARGE', 'Invoice file is larger than 10 MB')
      file = { buffer: Buffer.concat(chunks), filename: part.filename || 'invoice', mime: part.mimetype }
    } else if (part.fieldname === 'invoiceNumber' || part.fieldname === 'invoice_number') {
      number = String(part.value ?? '').trim().slice(0, 60) || null
    }
  }
  if (!file || !file.buffer.length) throw fail(400, 'FILE_REQUIRED', 'Attach your invoice (PDF or photo)')
  return { file, number }
}

/** A vendor must have an invoice on file before packing / shipping. Platform staff may override. */
export function assertInvoiceAttached(row, { isVendor }) {
  if (!isVendor) return
  if (!row?.invoice_file_path) {
    throw fail(409, 'INVOICE_REQUIRED', 'Upload your invoice for this order before packing it')
  }
}

/** Public-safe view of the invoice (never the storage path). */
export function invoiceMeta(row) {
  if (!row?.invoice_file_path) return null
  return { number: row.invoice_number || null, fileName: row.invoice_file_name, mimeType: row.invoice_mime_type, uploadedAt: row.invoice_uploaded_at }
}

/** Remove storage-only columns before a row is sent to a client. */
export function stripInvoicePath(row) {
  if (!row) return row
  const { invoice_file_path, ...rest } = row
  return { ...rest, invoice: invoiceMeta(row) }
}

/** Store (or replace) the invoice. `vendorId` null = platform staff. Returns the public meta. */
export async function attachOrderInvoice(kind, orderId, vendorId, { file, number }) {
  const t = TARGETS[kind]
  const mime = sniffMime(file.buffer)
  if (!mime || !INVOICE_TYPES[mime]) throw fail(415, 'UNSUPPORTED_FILE', 'Invoice must be a PDF, JPG, PNG or WebP file')
  const params = [orderId]
  let scope = ''
  if (vendorId) { params.push(vendorId); scope = `AND ${t.owner} = $2` }
  const { rows } = await query(`SELECT id, status, invoice_file_path FROM ${t.table} WHERE id = $1 ${scope}`, params)
  const row = rows[0]
  if (!row) throw fail(404, 'NOT_FOUND', 'Order not found')
  if (['CANCELLED', 'REFUNDED'].includes(String(row.status).toUpperCase())) throw fail(409, 'INVALID_STATE', 'This order is cancelled')
  const rel = await saveInvoiceFile(file.buffer, mime)
  const name = String(file.filename).replace(/[^\w.\- ]+/g, '_').slice(0, 120)
  const { rows: out } = await query(
    `UPDATE ${t.table}
        SET invoice_file_path = $2, invoice_file_name = $3, invoice_mime_type = $4, invoice_number = $5, invoice_uploaded_at = NOW()
      WHERE id = $1
      RETURNING invoice_file_path, invoice_file_name, invoice_mime_type, invoice_number, invoice_uploaded_at`,
    [orderId, rel, name, mime, number])
  if (row.invoice_file_path) await removeInvoiceFile(row.invoice_file_path)
  return invoiceMeta(out[0])
}

/** Stream the stored invoice (inline, or as a download). */
export async function sendOrderInvoice(kind, orderId, vendorId, reply, { download = false } = {}) {
  const t = TARGETS[kind]
  const params = [orderId]
  let scope = ''
  if (vendorId) { params.push(vendorId); scope = `AND ${t.owner} = $2` }
  const { rows } = await query(`SELECT invoice_file_path, invoice_file_name, invoice_mime_type FROM ${t.table} WHERE id = $1 ${scope}`, params)
  const r = rows[0]
  if (!r?.invoice_file_path) throw fail(404, 'NOT_FOUND', 'No invoice uploaded for this order')
  const abs = resolveInvoicePath(r.invoice_file_path)
  if (!fs.existsSync(abs)) throw fail(410, 'FILE_MISSING', 'The invoice file is missing from storage')
  return reply
    .header('Content-Type', r.invoice_mime_type)
    .header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${r.invoice_file_name}"`)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
    .header('Cache-Control', 'private, no-store')
    .send(fs.createReadStream(abs))
}
