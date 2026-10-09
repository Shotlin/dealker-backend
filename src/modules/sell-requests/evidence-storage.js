/**
 * Private storage for sell/exchange request evidence (photos + QC video).
 *
 *  - Files live under PRIVATE_DIR/sell-evidence (a persistent volume in compose), never under the
 *    public /uploads tree.
 *  - The type is decided from the file's real bytes. The browser-supplied mimetype/extension is ignored.
 *  - Reads happen through short-lived HMAC-signed URLs that are only minted after the caller has
 *    passed the normal request-visibility check.
 *
 * The storage API (save / open / remove) is the only seam: moving to S3/GCS later means replacing
 * this file, nothing else.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { PRIVATE_DIR } from '../invoices/invoice-storage.js'

const ROOT = () => path.join(PRIVATE_DIR, 'sell-evidence')

export class EvidenceError extends Error {
  constructor(code, message, statusCode = 422) {
    super(message)
    this.name = 'EvidenceError'
    this.code = code
    this.statusCode = statusCode
  }
}

export const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
export const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' }
export const EXT = { ...IMAGE_TYPES, ...VIDEO_TYPES }

const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4A ', 'dash', '3gp4', '3gp5', '3gp6', '3gp7', '3g2a', 'MSNV', 'f4v '])
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis'])

/**
 * Decide the real type from the first bytes of a file.
 * @returns {{mime:string, kind:'IMAGE'|'VIDEO'}|{unsupported:string}|null}
 */
export function sniffEvidence(head) {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { mime: 'image/jpeg', kind: 'IMAGE' }
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', kind: 'IMAGE' }
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', kind: 'IMAGE' }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return { mime: 'video/webm', kind: 'VIDEO' }
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1')
    if (brand === 'qt  ') return { mime: 'video/quicktime', kind: 'VIDEO' }
    if (HEIF_BRANDS.has(brand)) return { unsupported: 'HEIC/HEIF photos are not supported. Set the camera to "Most Compatible" (JPEG) or export as JPG.' }
    if (MP4_BRANDS.has(brand)) return { mime: 'video/mp4', kind: 'VIDEO' }
  }
  return null
}

/**
 * Stream an upload to a temp file, enforcing a byte ceiling while hashing, then move it into place.
 * `limitsFor(kind)` is consulted once the type is known so the image and video ceilings differ.
 */
export async function saveEvidence(file, { limitsFor }) {
  const tmpDir = path.join(ROOT(), '_tmp')
  await fs.promises.mkdir(tmpDir, { recursive: true })
  const tmp = path.join(tmpDir, crypto.randomUUID())

  const hash = crypto.createHash('sha256')
  let size = 0
  let head = Buffer.alloc(0)
  let verdict = null

  const gate = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length
      if (head.length < 32) head = Buffer.concat([head, chunk]).subarray(0, 32)
      if (!verdict && head.length >= 12) {
        verdict = sniffEvidence(head) || { bad: true }
        if (verdict.unsupported) return cb(new EvidenceError('UNSUPPORTED_MEDIA', verdict.unsupported))
        if (verdict.bad) return cb(new EvidenceError('UNSUPPORTED_MEDIA', 'This file is not a JPG, PNG, WebP, MP4, MOV or WebM file'))
      }
      if (verdict?.mime && size > limitsFor(verdict.kind)) {
        return cb(new EvidenceError('TOO_LARGE', `${verdict.kind === 'VIDEO' ? 'Video' : 'Photo'} is larger than ${Math.round(limitsFor(verdict.kind) / 1048576)} MB`, 413))
      }
      hash.update(chunk)
      cb(null, chunk)
    },
  })

  try {
    await pipeline(file.file, gate, fs.createWriteStream(tmp, { mode: 0o600, flags: 'wx' }))
    if (file.file.truncated) throw new EvidenceError('TOO_LARGE', 'File is larger than the allowed size', 413)
    if (size === 0) throw new EvidenceError('EMPTY', 'The file is empty')
    if (!verdict) verdict = sniffEvidence(head) || { bad: true }
    if (verdict.unsupported) throw new EvidenceError('UNSUPPORTED_MEDIA', verdict.unsupported)
    if (verdict.bad) throw new EvidenceError('UNSUPPORTED_MEDIA', 'This file is not a JPG, PNG, WebP, MP4, MOV or WebM file')
    if (size > limitsFor(verdict.kind)) throw new EvidenceError('TOO_LARGE', `${verdict.kind === 'VIDEO' ? 'Video' : 'Photo'} is larger than ${Math.round(limitsFor(verdict.kind) / 1048576)} MB`, 413)

    const key = path.join(new Date().toISOString().slice(0, 7), `${crypto.randomUUID()}.${EXT[verdict.mime]}`)
    const dest = path.join(ROOT(), key)
    await fs.promises.mkdir(path.dirname(dest), { recursive: true })
    await fs.promises.rename(tmp, dest)
    return { storageKey: key, mime: verdict.mime, kind: verdict.kind, size, checksum: hash.digest('hex') }
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {})
    // A client that aborts mid-upload surfaces as a premature close — report it as a retryable failure.
    if (!(err instanceof EvidenceError)) {
      if (err?.code === 'ERR_STREAM_PREMATURE_CLOSE' || err?.code === 'ECONNRESET' || err?.message === 'aborted') {
        throw new EvidenceError('UPLOAD_INTERRUPTED', 'The upload was interrupted. Please retry.', 400)
      }
      throw new EvidenceError('STORAGE_FAILED', 'The file could not be stored. Please retry.', 503)
    }
    throw err
  }
}

export function evidencePath(storageKey) {
  const abs = path.resolve(ROOT(), storageKey)
  if (!abs.startsWith(path.resolve(ROOT()) + path.sep)) throw new Error('Invalid evidence path')
  return abs
}

export const removeEvidence = (storageKey) => fs.promises.unlink(evidencePath(storageKey)).catch(() => {})

// ── Signed, expiring read URLs ──────────────────────────────────────────

const secret = () => {
  const s = process.env.JWT_ACCESS_SECRET
  if (!s) throw new Error('JWT_ACCESS_SECRET is required to sign evidence URLs')
  return `sell-evidence:${s}`
}
const mac = (id, exp) => crypto.createHmac('sha256', secret()).update(`${id}.${exp}`).digest('base64url')

export const SIGNED_TTL_SECONDS = 30 * 60

const BUCKET_SECONDS = 15 * 60

/**
 * Links are valid for at least `ttl` seconds. The expiry is rounded up to a 15-minute boundary so the
 * same file gets the same URL across re-reads — browsers keep their cached copy and lazy-loaded
 * thumbnails are not swapped out from under the page by every refetch.
 */
export function signEvidence(id, ttl = SIGNED_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000)
  const exp = ttl >= BUCKET_SECONDS ? Math.ceil((now + ttl) / BUCKET_SECONDS) * BUCKET_SECONDS : now + ttl
  return { exp, sig: mac(id, exp) }
}

export function verifyEvidence(id, exp, sig) {
  const e = Number(exp)
  if (!Number.isInteger(e) || e < Math.floor(Date.now() / 1000) || typeof sig !== 'string') return false
  const want = Buffer.from(mac(id, e))
  const got = Buffer.from(sig)
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}
