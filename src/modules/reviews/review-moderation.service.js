/**
 * Review moderation — Submitted → Admin moderation → Approved → Published
 * (or Rejected / Hidden / Removed). Product reviews and vendor (shop) reviews
 * are separate lists. Only PUBLISHED reviews are shown to customers and
 * counted in ratings; every status change re-computes the rating it feeds.
 *
 * @module modules/reviews/review-moderation.service
 */

import { query, getClient } from '../../config/database.js'
import { cacheDeletePattern } from '../../utils/cache.js'
import { logger } from '../../config/logger.js'

const httpError = (statusCode, message, code = 'REVIEW_ERROR') => Object.assign(new Error(message), { statusCode, code })

export const STATUSES = ['SUBMITTED', 'APPROVED', 'PUBLISHED', 'REJECTED', 'HIDDEN', 'REMOVED']
export const KINDS = ['PRODUCT', 'VENDOR']

/** action → allowed source states, target state, whether a reason is mandatory */
export const ACTIONS = {
  APPROVE: { from: ['SUBMITTED'], to: 'APPROVED' },
  PUBLISH: { from: ['SUBMITTED', 'APPROVED', 'HIDDEN'], to: 'PUBLISHED' },
  REJECT: { from: ['SUBMITTED', 'APPROVED'], to: 'REJECTED', reason: true },
  HIDE: { from: ['PUBLISHED'], to: 'HIDDEN' },
  REMOVE: { from: ['SUBMITTED', 'APPROVED', 'PUBLISHED', 'REJECTED', 'HIDDEN'], to: 'REMOVED', reason: true },
  RESTORE: { from: ['REJECTED', 'REMOVED'], to: 'SUBMITTED' },
}

const TABLE = { PRODUCT: 'reviews', VENDOR: 'vendor_reviews' }
const kindOf = (k) => {
  const kind = String(k || '').toUpperCase()
  if (!KINDS.includes(kind)) throw httpError(400, 'kind must be PRODUCT or VENDOR', 'VALIDATION')
  return kind
}

/**
 * Re-computes the stored rating a review feeds, counting PUBLISHED reviews only.
 * Product: avg_rating (customer app), rating_avg (ranking), rating_count.
 * Vendor: vendors.avg_rating / review_count and the vendor's shops' seller_rating.
 */
export async function recomputeRating(kind, subjectId, run = query) {
  if (kind === 'PRODUCT') {
    await run(
      `UPDATE products p
          SET avg_rating = COALESCE(s.avg1, 0), rating_avg = COALESCE(s.avg2, 0), rating_count = s.cnt
         FROM (SELECT ROUND(AVG(rating)::numeric, 1) AS avg1, ROUND(AVG(rating)::numeric, 2) AS avg2, COUNT(*)::int AS cnt
                 FROM reviews WHERE product_id = $1 AND status = 'PUBLISHED') s
        WHERE p.id = $1`, [subjectId])
    return
  }
  const { rows } = await run(
    `SELECT COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS avg, COUNT(*)::int AS cnt
       FROM vendor_reviews WHERE vendor_id = $1 AND status = 'PUBLISHED'`, [subjectId])
  await run(`UPDATE vendors SET avg_rating = $2, review_count = $3 WHERE id = $1`, [subjectId, rows[0].avg, rows[0].cnt])
  await run(`UPDATE shops SET seller_rating = $2, rating_count = $3 WHERE vendor_id = $1`, [subjectId, rows[0].avg, rows[0].cnt])
}

/** Product listing/detail responses are cached — drop them so the new rating shows. */
export async function bustProductCache(productId) {
  try {
    await cacheDeletePattern(`products:detail:*:${productId}`)
    await cacheDeletePattern('products:list:*')
    await cacheDeletePattern('products:featured*')
  } catch (err) {
    logger.warn({ err: err.message }, 'Could not bust product cache after review change')
  }
}

const SELECT = {
  PRODUCT: `SELECT r.id, r.rating, r.comment, r.status, r.flagged, r.flag_reason, r.moderation_note, r.moderated_at,
                   r.admin_reply, r.replied_at, r.created_at, r.order_id, r.is_verified_purchase,
                   u.name AS user_name, u.phone AS user_phone,
                   r.product_id AS subject_id, p.name AS subject_name, p.owner_vendor_id AS vendor_id, v.name AS vendor_name,
                   (SELECT COUNT(*)::int FROM review_reports rr WHERE rr.kind = 'PRODUCT' AND rr.review_id = r.id) AS report_count
              FROM reviews r
              JOIN users u ON u.id = r.user_id
              JOIN products p ON p.id = r.product_id
              LEFT JOIN vendors v ON v.id = p.owner_vendor_id`,
  VENDOR: `SELECT r.id, r.rating, r.comment, r.status, r.flagged, r.flag_reason, r.moderation_note, r.moderated_at,
                  r.admin_reply, r.replied_at, r.created_at, r.order_id, TRUE AS is_verified_purchase,
                  u.name AS user_name, u.phone AS user_phone,
                  r.vendor_id AS subject_id, v.name AS subject_name, r.vendor_id, v.name AS vendor_name,
                  (SELECT COUNT(*)::int FROM review_reports rr WHERE rr.kind = 'VENDOR' AND rr.review_id = r.id) AS report_count
             FROM vendor_reviews r
             JOIN users u ON u.id = r.user_id
             JOIN vendors v ON v.id = r.vendor_id`,
}

export class ReviewModerationService {
  async settings() {
    const { rows } = await query(`SELECT auto_publish, updated_at FROM review_settings WHERE id = 1`)
    return rows[0] || { auto_publish: false, updated_at: null }
  }

  async updateSettings({ autoPublish }) {
    if (typeof autoPublish !== 'boolean') throw httpError(400, 'autoPublish must be true or false', 'VALIDATION')
    const { rows } = await query(
      `INSERT INTO review_settings (id, auto_publish, updated_at) VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET auto_publish = EXCLUDED.auto_publish, updated_at = NOW()
       RETURNING auto_publish, updated_at`, [autoPublish])
    return rows[0]
  }

  /** Queue counts for both lists + rating of what customers actually see. */
  async summary() {
    const out = { settings: await this.settings() }
    for (const kind of KINDS) {
      const t = TABLE[kind]
      const { rows } = await query(
        `SELECT status, COUNT(*)::int AS n FROM ${t} GROUP BY status`)
      const by = Object.fromEntries(STATUSES.map((s) => [s, 0]))
      for (const r of rows) by[r.status] = r.n
      const extra = (await query(
        `SELECT (SELECT COUNT(*)::int FROM ${t} WHERE flagged AND status <> 'REMOVED') AS flagged,
                (SELECT COUNT(DISTINCT rr.review_id)::int FROM review_reports rr JOIN ${t} x ON x.id = rr.review_id
                  WHERE rr.kind = $1 AND x.status <> 'REMOVED') AS reported,
                COALESCE((SELECT ROUND(AVG(rating)::numeric, 2) FROM ${t} WHERE status = 'PUBLISHED'), 0) AS avg_published,
                (SELECT COUNT(*)::int FROM ${t} WHERE status = 'SUBMITTED' AND rating <= 2) AS low_pending`, [kind])).rows[0]
      out[kind.toLowerCase()] = {
        byStatus: by,
        pending: by.SUBMITTED,
        total: Object.values(by).reduce((a, b) => a + b, 0),
        flagged: extra.flagged,
        reported: extra.reported,
        lowPending: extra.low_pending,
        avgPublished: Number(extra.avg_published),
      }
    }
    return out
  }

  async list(kindIn, { status = '', rating = '', flagged = '', reported = '', search = '', vendorId = '', page = 1, limit = 25 } = {}) {
    const kind = kindOf(kindIn)
    const where = []
    const params = []
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)) }

    const st = String(status || '').toUpperCase()
    if (st && st !== 'ALL') {
      if (!STATUSES.includes(st)) throw httpError(400, `status must be one of ${STATUSES.join(', ')}`, 'VALIDATION')
      add('r.status = ?', st)
    }
    if (rating !== '' && rating != null) {
      const n = Number(rating)
      if (!Number.isInteger(n) || n < 1 || n > 5) throw httpError(400, 'rating must be 1–5', 'VALIDATION')
      add('r.rating = ?', n)
    }
    if (String(flagged) === 'true') where.push('r.flagged = TRUE')
    if (String(reported) === 'true') where.push(`EXISTS (SELECT 1 FROM review_reports rr WHERE rr.kind = '${kind}' AND rr.review_id = r.id)`)
    if (vendorId) add(kind === 'PRODUCT' ? 'p.owner_vendor_id = ?' : 'r.vendor_id = ?', vendorId)
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`)
      const i = params.length
      where.push(`(r.comment ILIKE $${i} OR u.name ILIKE $${i} OR ${kind === 'PRODUCT' ? 'p.name' : 'v.name'} ILIKE $${i})`)
    }

    const lim = Math.min(100, Math.max(1, Number(limit) || 25))
    const pg = Math.max(1, Number(page) || 1)
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const base = SELECT[kind]
    const count = await query(`SELECT COUNT(*)::int AS n FROM (${base} ${whereSql}) x`, params)
    // oldest pending first so the queue is worked in order; everything else newest first
    const order = st === 'SUBMITTED' ? 'r.created_at ASC' : 'r.created_at DESC'
    const { rows } = await query(`${base} ${whereSql} ORDER BY ${order} LIMIT ${lim} OFFSET ${(pg - 1) * lim}`, params)
    return {
      data: rows.map((r) => ({ ...r, kind })),
      pagination: { page: pg, limit: lim, total: count.rows[0].n, totalPages: Math.max(1, Math.ceil(count.rows[0].n / lim)) },
    }
  }

  async get(kindIn, id) {
    const kind = kindOf(kindIn)
    const { rows } = await query(`${SELECT[kind]} WHERE r.id = $1`, [id])
    if (!rows[0]) throw httpError(404, 'Review not found', 'NOT_FOUND')
    const reports = (await query(
      `SELECT rr.id, rr.reason, rr.created_at, u.name AS reporter_name
         FROM review_reports rr JOIN users u ON u.id = rr.reporter_id
        WHERE rr.kind = $1 AND rr.review_id = $2 ORDER BY rr.created_at DESC`, [kind, id])).rows
    return { ...rows[0], kind, reports }
  }

  /** One moderation step. Atomic: the status move and the rating recompute commit together. */
  async moderate(kindIn, id, actionIn, { note } = {}, actorId = null) {
    const kind = kindOf(kindIn)
    const action = String(actionIn || '').toUpperCase()
    const rule = ACTIONS[action]
    if (!rule) throw httpError(400, `action must be one of ${Object.keys(ACTIONS).join(', ')}`, 'VALIDATION')
    const reason = note == null ? '' : String(note).trim()
    if (rule.reason && reason.length < 3) throw httpError(400, 'A reason is required for this action', 'REASON_REQUIRED')
    if (reason.length > 500) throw httpError(400, 'Reason is too long (max 500 characters)', 'VALIDATION')

    const t = TABLE[kind]
    const client = await getClient()
    let subjectId
    try {
      await client.query('BEGIN')
      const cur = (await client.query(`SELECT status, ${kind === 'PRODUCT' ? 'product_id' : 'vendor_id'} AS subject_id FROM ${t} WHERE id = $1 FOR UPDATE`, [id])).rows[0]
      if (!cur) throw httpError(404, 'Review not found', 'NOT_FOUND')
      if (!rule.from.includes(cur.status)) {
        throw httpError(409, `Cannot ${action.toLowerCase()} a review that is ${cur.status.toLowerCase()}`, 'BAD_STATE')
      }
      subjectId = cur.subject_id
      await client.query(
        `UPDATE ${t} SET status = $2, moderated_by = $3, moderated_at = NOW(), moderation_note = $4, updated_at = NOW() WHERE id = $1`,
        [id, rule.to, actorId, reason || null])
      // someone's report is settled once a decision is made
      if (['PUBLISH', 'REJECT', 'REMOVE', 'HIDE'].includes(action)) {
        await client.query(`UPDATE ${t} SET flagged = FALSE WHERE id = $1`, [id])
      }
      await recomputeRating(kind, subjectId, client.query.bind(client))
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
    if (kind === 'PRODUCT') await bustProductCache(subjectId)
    return this.get(kind, id)
  }

  /** Same action on many reviews; each one succeeds or fails on its own. */
  async bulk(kindIn, ids, action, opts = {}, actorId = null) {
    const kind = kindOf(kindIn)
    if (!Array.isArray(ids) || !ids.length) throw httpError(400, 'Select at least one review', 'VALIDATION')
    if (ids.length > 100) throw httpError(400, 'At most 100 reviews at a time', 'VALIDATION')
    const done = []
    const failed = []
    for (const id of [...new Set(ids)]) {
      try {
        await this.moderate(kind, id, action, opts, actorId)
        done.push(id)
      } catch (err) {
        if (!err.statusCode) throw err
        failed.push({ id, reason: err.message })
      }
    }
    return { done, failed }
  }

  /** Public reply from the platform, shown under a published review. Empty text clears it. */
  async reply(kindIn, id, text, actorId = null) {
    const kind = kindOf(kindIn)
    const body = text == null ? '' : String(text).trim()
    if (body.length > 1000) throw httpError(400, 'Reply is too long (max 1000 characters)', 'VALIDATION')
    const t = TABLE[kind]
    const { rowCount } = await query(
      `UPDATE ${t}
          SET admin_reply = $2, replied_at = CASE WHEN $2::text IS NULL THEN NULL ELSE NOW() END,
              replied_by = CASE WHEN $2::text IS NULL THEN NULL ELSE $3::uuid END, updated_at = NOW()
        WHERE id = $1 AND status <> 'REMOVED'`, [id, body || null, actorId])
    if (!rowCount) throw httpError(404, 'Review not found', 'NOT_FOUND')
    return this.get(kind, id)
  }

  async flag(kindIn, id, { flagged = true, reason } = {}) {
    const kind = kindOf(kindIn)
    const why = reason == null ? '' : String(reason).trim()
    if (flagged && why.length < 3) throw httpError(400, 'A reason is required to flag a review', 'REASON_REQUIRED')
    const { rowCount } = await query(
      `UPDATE ${TABLE[kind]} SET flagged = $2, flag_reason = $3, updated_at = NOW() WHERE id = $1 AND status <> 'REMOVED'`,
      [id, !!flagged, flagged ? why : null])
    if (!rowCount) throw httpError(404, 'Review not found', 'NOT_FOUND')
    return this.get(kind, id)
  }
}

export const reviewModeration = new ReviewModerationService()
