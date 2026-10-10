/**
 * Media cleanup sweeper — deletes replaced/removed public images.
 *
 * Triggers (migration 193) queue every Cloudinary / local-upload URL that disappears from a
 * tracked column. This sweeper drains the queue: for each URL it checks that no tracked column
 * still references the file, then deletes it from Cloudinary (or local disk). Failures are
 * retried with backoff. Only files inside our own cloud + CLOUDINARY_FOLDER are ever deleted.
 * Safe to run on several instances (rows are claimed with FOR UPDATE SKIP LOCKED).
 */
import fs from 'node:fs'
import path from 'node:path'

import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { getClient, query } from '../../config/database.js'
import { cloudinary, extractCloudinaryAssetInfo } from '../../config/cloudinary.js'
import { UPLOAD_DIR, PUBLIC_BASE } from './local-uploads.routes.js'

const EVERY_MS = 60_000
const BATCH = 50
const MAX_ATTEMPTS = 8

let handle = null
let running = false

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function rawPublicId(url) {
  const segs = (url.split('/raw/upload/')[1] || '').split(/[?#]/)[0].split('/')
  const v = segs.findIndex((x) => /^v\d+$/.test(x))
  return (v >= 0 ? segs.slice(v + 1) : segs).join('/') || null
}

/** → { kind:'cloudinary', resourceType, publicId, rawId } | { kind:'local', rel } | null (not ours) */
export function classifyMediaUrl(url) {
  if (typeof url !== 'string') return null

  if (url.startsWith(`${PUBLIC_BASE}/`)) {
    const rel = decodeURIComponent(url.slice(PUBLIC_BASE.length + 1).split(/[?#]/)[0])
    return rel && !rel.includes('..') ? { kind: 'local', rel } : null
  }

  const cloud = env.CLOUDINARY_CLOUD_NAME
  const m = cloud && url.match(new RegExp(`^https?://res\\.cloudinary\\.com/${escapeRegex(cloud)}/(image|video|raw)/upload/`))
  if (!m) return null
  const info = extractCloudinaryAssetInfo(url)
  if (!info?.publicId || !info.publicId.startsWith(`${env.CLOUDINARY_FOLDER}/`) || info.publicId.includes('..')) return null

  // Raw assets keep their file extension inside the public_id.
  const rawId = m[1] === 'raw' ? rawPublicId(url) : null
  return { kind: 'cloudinary', resourceType: m[1], publicId: info.publicId, rawId }
}

let trackedCache = null
async function trackedColumns() {
  if (trackedCache && Date.now() - trackedCache.at < 10 * 60_000) return trackedCache.rows
  const { rows } = await query('SELECT table_name, column_name FROM media_tracked_columns')
  trackedCache = { at: Date.now(), rows }
  return rows
}

/** True if any tracked column still mentions this file. */
async function isStillReferenced(needle) {
  const pattern = `${escapeRegex(needle)}([^A-Za-z0-9_-]|$)`
  for (const { table_name, column_name } of await trackedColumns()) {
    const { rowCount } = await query(
      `SELECT 1 FROM "${table_name}" WHERE "${column_name}"::text ~ $1 LIMIT 1`,
      [pattern]
    )
    if (rowCount) return true
  }
  return false
}

async function removeOne(url) {
  const asset = classifyMediaUrl(url)
  if (!asset) return 'skipped'

  if (asset.kind === 'local') {
    if (await isStillReferenced(asset.rel)) return 'in-use'
    const file = path.resolve(UPLOAD_DIR, asset.rel)
    if (!file.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) return 'skipped'
    await fs.promises.unlink(file).catch((e) => { if (e.code !== 'ENOENT') throw e })
    return 'deleted'
  }

  if (await isStillReferenced(asset.publicId)) return 'in-use'
  const ids = asset.resourceType === 'raw' && asset.rawId ? [asset.rawId, asset.publicId] : [asset.publicId]
  for (const id of ids) {
    const res = await cloudinary.uploader.destroy(id, { resource_type: asset.resourceType, invalidate: true })
    if (res.result === 'ok') return 'deleted'
  }
  return 'not-found'
}

export async function sweepMediaQueue() {
  if (running) return 0
  running = true
  const client = await getClient()
  let processed = 0
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT id, url, attempts FROM media_deletion_queue
        WHERE run_after <= NOW() ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [BATCH]
    )
    for (const row of rows) {
      try {
        const outcome = await removeOne(row.url)
        if (outcome === 'deleted') logger.info({ action: 'media_cleanup', url: row.url }, 'Deleted replaced media')
        await client.query('DELETE FROM media_deletion_queue WHERE id = $1', [row.id])
        processed++
      } catch (err) {
        const msg = String(err?.error?.message || err?.message || err).slice(0, 300)
        logger.warn({ url: row.url, err: msg }, 'Media cleanup failed')
        if (row.attempts + 1 >= MAX_ATTEMPTS) {
          await client.query('DELETE FROM media_deletion_queue WHERE id = $1', [row.id])
        } else {
          await client.query(
            `UPDATE media_deletion_queue SET attempts = attempts + 1, last_error = $2,
                    run_after = NOW() + (INTERVAL '1 minute' * power(2, attempts + 1)) WHERE id = $1`,
            [row.id, msg]
          )
        }
      }
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error({ err: err.message }, 'Media cleanup sweep failed')
  } finally {
    client.release()
    running = false
  }
  return processed
}

export function startMediaCleanup() {
  if (handle) return
  const configured = env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET
  if (!configured) logger.warn('Media cleanup: Cloudinary not configured — only local files will be removed')
  handle = setInterval(() => sweepMediaQueue().catch(() => {}), EVERY_MS)
  handle.unref?.()
  setTimeout(() => sweepMediaQueue().catch(() => {}), 20_000).unref?.()
  logger.info('Media cleanup started (every 60s)')
}
