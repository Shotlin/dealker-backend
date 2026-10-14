/**
 * Vendor KYC documents — private storage, attach/replace, submit-for-review and signed read links.
 *
 * Files live under PRIVATE_DIR/vendor-kyc/<vendorId>/<uuid>.<ext>, never under the public /uploads tree.
 * The type comes from the file's real bytes (JPG, PNG, WebP or PDF), not from what the client claims.
 * Reads go through short-lived HMAC-signed links minted only for the owning vendor or platform staff.
 *
 * @module modules/vendor-kyc-files/vendor-kyc-files.service
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { query } from '../../config/database.js'
import { PRIVATE_DIR } from '../invoices/invoice-storage.js'
import { VendorKycRepository } from '../vendors/vendor-kyc.repository.js'

const ROOT = () => path.join(PRIVATE_DIR, 'vendor-kyc')
export const MAX_BYTES = 8 * 1024 * 1024
export const DOC_TYPES = ['TRADE_LICENSE', 'GSTIN_CERTIFICATE', 'FSSAI_LICENSE', 'PAN_CARD', 'BANK_CANCELLED_CHEQUE', 'OTHER']
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]))
/** What a vendor must have on file (and not rejected) before the application can go for review. */
export const REQUIRED_DOCS = ['PAN_CARD', 'GSTIN_CERTIFICATE']
const REQUIRED_PROFILE = [['legal_name', 'Legal business name'], ['gstin', 'GSTIN'], ['pan_number', 'PAN'], ['address_line1', 'Address'], ['city', 'City'], ['pincode', 'Pincode']]

const err = (statusCode, message, code = 'KYC_FILE_ERROR', extra = {}) => Object.assign(new Error(message), { statusCode, code, ...extra })

function sniff(head) {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (head.length >= 5 && head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf'
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') return 'heif'
  return null
}

const keyRe = (vendorId) => new RegExp(`^${vendorId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(jpg|png|webp|pdf)$`)
export const isOwnKey = (vendorId, key) => typeof key === 'string' && keyRe(vendorId).test(key)
export const isPrivateKey = (key) => typeof key === 'string' && /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp|pdf)$/.test(key)
const abs = (key) => {
  const p = path.resolve(ROOT(), key)
  if (!p.startsWith(path.resolve(ROOT()) + path.sep)) throw err(400, 'Invalid file key', 'VALIDATION')
  return p
}
export const fileExists = (key) => fs.promises.stat(abs(key)).then((s) => s.isFile()).catch(() => false)
export const removeFile = (key) => fs.promises.unlink(abs(key)).catch(() => {})

/** Stream one uploaded file into private storage. Returns { file_key, mime, size, filename }. */
export async function saveDocumentFile(vendorId, part) {
  const dir = path.join(ROOT(), vendorId)
  await fs.promises.mkdir(path.join(ROOT(), '_tmp'), { recursive: true })
  await fs.promises.mkdir(dir, { recursive: true })
  const tmp = path.join(ROOT(), '_tmp', crypto.randomUUID())
  let size = 0
  let head = Buffer.alloc(0)
  let mime = null
  const gate = new Transform({
    transform(chunk, _e, cb) {
      size += chunk.length
      if (head.length < 16) head = Buffer.concat([head, chunk]).subarray(0, 16)
      if (!mime && head.length >= 12) {
        mime = sniff(head) || 'bad'
        if (mime === 'heif') return cb(err(422, 'HEIC photos are not supported. Set the camera to "Most Compatible" or export as JPG.', 'UNSUPPORTED_MEDIA'))
        if (mime === 'bad') return cb(err(422, 'Upload a JPG, PNG, WebP or PDF file.', 'UNSUPPORTED_MEDIA'))
      }
      if (size > MAX_BYTES) return cb(err(413, 'File is larger than 8 MB', 'TOO_LARGE'))
      cb(null, chunk)
    },
  })
  try {
    await pipeline(part.file, gate, fs.createWriteStream(tmp, { mode: 0o600, flags: 'wx' }))
    if (part.file.truncated) throw err(413, 'File is larger than 8 MB', 'TOO_LARGE')
    if (size === 0) throw err(422, 'The file is empty', 'EMPTY')
    mime = mime || sniff(head)
    if (!mime || mime === 'bad' || mime === 'heif') throw err(422, 'Upload a JPG, PNG, WebP or PDF file.', 'UNSUPPORTED_MEDIA')
    const key = `${vendorId}/${crypto.randomUUID()}.${EXT[mime]}`
    await fs.promises.rename(tmp, abs(key))
    return { file_key: key, mime, size, filename: String(part.filename || '').slice(0, 120) }
  } catch (e) {
    await fs.promises.unlink(tmp).catch(() => {})
    if (e.statusCode) throw e
    if (e?.code === 'ERR_STREAM_PREMATURE_CLOSE' || e?.message === 'aborted') throw err(400, 'The upload was interrupted. Please retry.', 'UPLOAD_INTERRUPTED')
    throw err(503, 'The file could not be stored. Please retry.', 'STORAGE_FAILED')
  }
}

const vendorRow = async (vendorId) => {
  const v = (await query('SELECT id, status FROM vendors WHERE id = $1 AND deleted_at IS NULL', [vendorId])).rows[0]
  if (!v) throw err(404, 'Vendor not found', 'VENDOR_NOT_FOUND')
  return v
}

/** Attach an uploaded file as a KYC document; replaces a pending/rejected one of the same type. */
export async function attachDocument(vendorId, { document_type, document_number, file_key }) {
  const v = await vendorRow(vendorId)
  if (['REJECTED', 'DEACTIVATED', 'SUSPENDED'].includes(v.status)) throw err(409, 'Documents cannot be changed for this account. Contact support.', 'NOT_ALLOWED')
  if (!DOC_TYPES.includes(document_type)) throw err(400, 'Unknown document type', 'VALIDATION')
  if (!isOwnKey(vendorId, file_key) || !(await fileExists(file_key))) throw err(400, 'Upload the file first, then attach it', 'FILE_NOT_FOUND')
  const num = document_number == null || String(document_number).trim() === '' ? null : String(document_number).trim().slice(0, 100)
  const cur = (await query(
    `SELECT * FROM vendor_documents WHERE vendor_id = $1 AND document_type = $2 ORDER BY (status = 'VERIFIED') DESC, created_at DESC LIMIT 1`, [vendorId, document_type])).rows[0]
  if (cur?.status === 'VERIFIED') throw err(409, 'This document is already verified. Contact support to change it.', 'DOCUMENT_VERIFIED')
  let row
  if (cur) {
    row = (await query(
      `UPDATE vendor_documents SET file_key = $2, file_url = NULL, document_number = $3, status = 'PENDING', rejection_reason = NULL,
              reviewed_by = NULL, reviewed_at = NULL, updated_at = NOW() WHERE id = $1 RETURNING *`, [cur.id, file_key, num])).rows[0]
    if (cur.file_key !== file_key && isPrivateKey(cur.file_key)) await removeFile(cur.file_key)
  } else {
    row = (await query(
      `INSERT INTO vendor_documents (vendor_id, document_type, document_number, file_key, file_url, status) VALUES ($1,$2,$3,$4,NULL,'PENDING') RETURNING *`,
      [vendorId, document_type, num, file_key])).rows[0]
  }
  return publicDoc(row)
}

export const publicDoc = (d) => ({
  id: d.id, document_type: d.document_type, document_number: d.document_number, status: d.status,
  rejection_reason: d.rejection_reason, created_at: d.created_at, updated_at: d.updated_at,
})

/** Move an onboarding vendor to KYC_SUBMITTED using the documents and profile already on file. */
export async function submitForReview(vendorId) {
  const v = await vendorRow(vendorId)
  if (!['PENDING_ONBOARDING', 'CORRECTION_REQUIRED'].includes(v.status)) {
    throw err(409, v.status === 'KYC_SUBMITTED' || v.status === 'UNDER_REVIEW' ? 'Your documents are already with our team.' : 'There is nothing to submit for this account.', 'INVALID_STATE')
  }
  const docs = (await query('SELECT document_type, status FROM vendor_documents WHERE vendor_id = $1', [vendorId])).rows
  const profile = (await query('SELECT * FROM vendor_profiles WHERE vendor_id = $1', [vendorId])).rows[0] || {}
  const missing = []
  for (const t of REQUIRED_DOCS) {
    const ok = docs.some((d) => d.document_type === t && d.status !== 'REJECTED' && d.status !== 'EXPIRED')
    if (!ok) missing.push(t === 'PAN_CARD' ? 'PAN card document' : 'GSTIN certificate')
  }
  for (const [k, label] of REQUIRED_PROFILE) if (!String(profile[k] ?? '').trim()) missing.push(label)
  if (missing.length) throw err(400, `Add these first: ${missing.join(', ')}`, 'INCOMPLETE', { missing })
  const repo = new VendorKycRepository()
  const updated = await repo.updateVendorStatus(vendorId, 'KYC_SUBMITTED')
  await repo.logReview({ vendor_id: vendorId, action: 'SUBMIT', previous_status: v.status, new_status: 'KYC_SUBMITTED', comments: 'Submitted for review from the vendor app' })
  return { status: updated.status }
}

// ── signed read links ───────────────────────────────────────────────────
const secret = () => {
  const s = process.env.JWT_ACCESS_SECRET
  if (!s) throw new Error('JWT_ACCESS_SECRET is required to sign KYC links')
  return `vendor-kyc:${s}`
}
const mac = (id, exp) => crypto.createHmac('sha256', secret()).update(`${id}.${exp}`).digest('base64url')
export function signDoc(id, ttl = 30 * 60) {
  const exp = Math.floor(Date.now() / 1000) + ttl
  return { exp, sig: mac(id, exp) }
}
export function verifyDoc(id, exp, sig) {
  const e = Number(exp)
  if (!Number.isInteger(e) || e < Math.floor(Date.now() / 1000) || typeof sig !== 'string') return false
  const want = Buffer.from(mac(id, e)); const got = Buffer.from(sig)
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}
const apiOrigin = () => (process.env.UPLOADS_PUBLIC_URL || 'http://localhost:4500/uploads').replace(/\/uploads\/?$/, '')
/** Absolute signed URL for a privately stored document (null for legacy/external ones). */
export function signedUrl(doc, ttl) {
  if (!isPrivateKey(doc.file_key)) return null
  const { exp, sig } = signDoc(doc.id, ttl)
  return `${apiOrigin()}/api/v1/vendor-kyc/file/${doc.id}?exp=${exp}&sig=${sig}`
}
export async function loadDocForRead(docId) {
  const d = (await query('SELECT id, vendor_id, file_key FROM vendor_documents WHERE id = $1', [docId])).rows[0]
  if (!d || !isPrivateKey(d.file_key)) return null
  return { ...d, abs: abs(d.file_key), mime: MIME[path.extname(d.file_key).slice(1)] || 'application/octet-stream' }
}
export async function linkFor(vendorId, docId) {
  const d = (await query('SELECT id, vendor_id, file_key FROM vendor_documents WHERE id = $1 AND vendor_id = $2', [docId, vendorId])).rows[0]
  if (!d || !isPrivateKey(d.file_key)) throw err(404, 'Document not found', 'NOT_FOUND')
  return { url: signedUrl(d, 30 * 60) }
}
