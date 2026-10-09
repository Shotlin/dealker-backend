/**
 * Admin alert feed — one place every module reports "something needs the
 * admin's attention". `emit` is idempotent through `dedupeKey` and never
 * throws (an alert must not break the action that raised it).
 *
 * @module modules/alerts/alerts.service
 */

import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'

export const ALERT_TYPES = [
  'NEW_ORDER', 'ORDER_CANCELLED', 'PAYMENT_RECEIVED', 'AUCTION_WON', 'AUCTION_STARTED', 'AUCTION_ENDING',
  'CAMPAIGN_PURCHASED', 'PRODUCT_APPROVED', 'PRODUCT_REJECTED', 'QC_FAILED', 'REFUND_REQUEST', 'EXCHANGE_REQUEST',
  'NEW_VENDOR', 'NEW_CUSTOMER', 'SUBSCRIPTION_EXPIRING', 'SUBSCRIPTION_EXPIRED', 'WALLET_CREDIT', 'WALLET_DEBIT',
  'LOW_STOCK', 'DELIVERY_FAILED', 'RTO', 'NEW_REVIEW', 'NEW_SUPPORT_TICKET',
]

export async function emitAlert({ type, severity = 'INFO', title, body = null, entityType = null, entityId = null, link = null, data = null, dedupeKey = null }) {
  try {
    const { rows } = await query(
      `INSERT INTO admin_alerts (type, severity, title, body, entity_type, entity_id, link, data, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [type, severity, title, body, entityType, entityId ? String(entityId) : null, link, data ? JSON.stringify(data) : null, dedupeKey])
    return rows[0]?.id ?? null
  } catch (err) {
    logger.warn({ err: err.message, type }, 'Could not record admin alert')
    return null
  }
}

// ── Reading side: feed, unread counts, per-admin read state, Notification Control ──

const httpError = (statusCode, message, code = 'ALERT_ERROR') => Object.assign(new Error(message), { statusCode, code })
const SEVERITIES = ['INFO', 'WARNING', 'CRITICAL']

export class AlertsService {
  async list(userId, { type = '', severity = '', group = '', unread = false, search = '', page = 1, limit = 30 } = {}) {
    const where = []
    const params = [userId]
    const p = (v) => { params.push(v); return `$${params.length}` }
    if (type) where.push(`a.type = ${p(type)}`)
    if (severity) where.push(`a.severity = ${p(severity)}`)
    if (group) where.push(`s.grp = ${p(group)}`)
    if (unread) where.push('r.alert_id IS NULL')
    if (search) { const s = p(`%${search}%`); where.push(`(a.title ILIKE ${s} OR a.body ILIKE ${s})`) }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const from = `FROM admin_alerts a LEFT JOIN alert_settings s ON s.type = a.type LEFT JOIN admin_alert_reads r ON r.alert_id = a.id AND r.user_id = $1 ${w}`
    const lim = Math.min(100, Math.max(1, Number(limit) || 30))
    const off = (Math.max(1, Number(page)) - 1) * lim
    const total = (await query(`SELECT COUNT(*)::int n ${from}`, params)).rows[0].n
    const { rows } = await query(
      `SELECT a.id, a.type, a.severity, a.title, a.body, a.entity_type, a.entity_id, a.link, a.created_at,
              s.label AS type_label, s.grp AS grp, (r.alert_id IS NOT NULL) AS is_read
         ${from} ORDER BY a.created_at DESC, a.id DESC LIMIT ${lim} OFFSET ${off}`, params)
    return { data: rows, meta: { page: Number(page), limit: lim, total, totalPages: Math.ceil(total / lim) } }
  }

  async unreadCount(userId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE a.severity = 'CRITICAL')::int AS critical
         FROM admin_alerts a LEFT JOIN admin_alert_reads r ON r.alert_id = a.id AND r.user_id = $1
        WHERE r.alert_id IS NULL AND a.created_at >= NOW() - interval '30 days'`, [userId])
    return rows[0]
  }

  async summary() {
    const { rows } = await query(
      `SELECT s.grp, a.type, s.label, COUNT(*)::int AS n
         FROM admin_alerts a JOIN alert_settings s ON s.type = a.type
        WHERE a.created_at >= NOW() - interval '7 days' GROUP BY s.grp, a.type, s.label, s.sort_order ORDER BY s.sort_order`)
    return rows
  }

  async markRead(userId, ids) {
    if (!Array.isArray(ids) || !ids.length) throw httpError(400, 'Select at least one notification', 'VALIDATION')
    const clean = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500)
    const { rowCount } = await query(
      `INSERT INTO admin_alert_reads (alert_id, user_id) SELECT id, $2 FROM admin_alerts WHERE id = ANY($1::bigint[]) ON CONFLICT DO NOTHING`, [clean, userId])
    return { marked: rowCount }
  }

  async markAllRead(userId, { type = '' } = {}) {
    const { rowCount } = await query(
      `INSERT INTO admin_alert_reads (alert_id, user_id)
         SELECT a.id, $1 FROM admin_alerts a WHERE ($2 = '' OR a.type = $2) ON CONFLICT DO NOTHING`, [userId, type])
    return { marked: rowCount }
  }

  async settings() {
    const { rows } = await query(`SELECT type, label, grp, enabled, severity, min_amount FROM alert_settings ORDER BY sort_order`)
    return rows.map((r) => ({ ...r, min_amount: r.min_amount != null ? Number(r.min_amount) : null }))
  }

  async updateSettings(changes) {
    if (!Array.isArray(changes) || !changes.length) throw httpError(400, 'Nothing to change', 'VALIDATION')
    const valid = new Set((await query(`SELECT type FROM alert_settings`)).rows.map((r) => r.type))
    for (const c of changes) {
      if (!valid.has(c.type)) throw httpError(400, `Unknown notification type ${c.type}`, 'VALIDATION')
      if (c.severity !== undefined && !SEVERITIES.includes(c.severity)) throw httpError(400, 'severity must be INFO, WARNING or CRITICAL', 'VALIDATION')
      if (c.minAmount !== undefined && c.minAmount !== null && !(Number(c.minAmount) >= 0)) throw httpError(400, 'The minimum amount cannot be negative', 'VALIDATION')
    }
    for (const c of changes) {
      await query(
        `UPDATE alert_settings SET enabled = COALESCE($2, enabled), severity = COALESCE($3, severity),
                min_amount = CASE WHEN $4::boolean THEN $5::numeric ELSE min_amount END, updated_at = NOW() WHERE type = $1`,
        [c.type, typeof c.enabled === 'boolean' ? c.enabled : null, c.severity ?? null, c.minAmount !== undefined, c.minAmount ?? null])
    }
    return this.settings()
  }

  /** Time-based alerts a trigger cannot raise: auctions about to end. Safe to run often. */
  async sweep() {
    const { rows } = await query(
      `SELECT id, auction_number, title, ends_at FROM auctions WHERE status = 'LIVE' AND ends_at > NOW() AND ends_at <= NOW() + interval '1 hour'`)
    let raised = 0
    for (const a of rows) {
      const id = await emitAlert({ type: 'AUCTION_ENDING', severity: 'WARNING', title: `Auction ${a.auction_number} ends within the hour`, body: a.title,
        entityType: 'auction', entityId: a.id, link: `/auctions/${a.id}`, dedupeKey: `auction-ending:${a.id}` })
      if (id) raised += 1
    }
    return { raised }
  }
}
