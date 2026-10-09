/**
 * Private invoice storage. Files never live under the public /uploads tree;
 * they are streamed through authenticated endpoints only.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { UPLOAD_DIR } from '../uploads/local-uploads.routes.js'

export const PRIVATE_DIR = process.env.PRIVATE_UPLOAD_DIR || path.resolve(UPLOAD_DIR, '..', 'private-uploads')
export const MAX_INVOICE_BYTES = 10 * 1024 * 1024

export const INVOICE_TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/** Check the real file signature, not just the declared mime type. */
export function sniffMime(buf) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

/** Persist a buffer; returns the relative path stored in the DB. */
export async function saveInvoiceFile(buffer, mime) {
  const rel = path.join('invoices', new Date().toISOString().slice(0, 7), `${crypto.randomUUID()}.${INVOICE_TYPES[mime]}`)
  const abs = path.join(PRIVATE_DIR, rel)
  await fs.promises.mkdir(path.dirname(abs), { recursive: true })
  await fs.promises.writeFile(abs, buffer, { flag: 'wx', mode: 0o600 })
  return rel
}

export function resolveInvoicePath(rel) {
  const abs = path.resolve(PRIVATE_DIR, rel)
  if (!abs.startsWith(path.resolve(PRIVATE_DIR) + path.sep)) throw new Error('Invalid invoice path')
  return abs
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
export const removeInvoiceFile = (rel) => fs.promises.unlink(resolveInvoicePath(rel)).catch(() => {})
