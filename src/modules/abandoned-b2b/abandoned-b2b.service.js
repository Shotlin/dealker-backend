/**
 * B2B abandoned carts — vendor-to-vendor orders left unpaid.
 *
 *   abandoned  = PENDING_PAYMENT + UNPAID and older than `hours` (default 24)
 *   recovered  = it had a follow-up and was paid afterwards
 *
 * @module modules/abandoned-b2b/abandoned-b2b.service
 */

import { query, getClient } from '../../config/database.js'

const httpError = (statusCode, message, code = 'ABANDONED_ERROR') => Object.assign(new Error(message), { statusCode, code })
const FOLLOW_UP = ['CONTACTED', 'WILL_PAY', 'LOST']

const BASE = `
  FROM b2b_orders o
  JOIN b2b_requirements r ON r.id = o.requirement_id
  JOIN vendors bv ON bv.id = o.buyer_vendor_id
  JOIN vendors sv ON sv.id = o.seller_vendor_id
  LEFT JOIN vendor_profiles bp ON bp.vendor_id = bv.id
  LEFT JOIN LATERAL (
    SELECT f.status, f.note, f.created_at, u.name AS by_name, (SELECT COUNT(*)::int FROM b2b_checkout_followups x WHERE x.order_id = o.id) AS touches
      FROM b2b_checkout_followups f LEFT JOIN users u ON u.id = f.actor_id WHERE f.order_id = o.id ORDER BY f.created_at DESC, f.id DESC LIMIT 1
  ) fu ON TRUE`

/** state: OPEN (no follow-up) | CONTACTED | WILL_PAY | LOST | RECOVERED */
const STATE = `CASE WHEN o.payment_status <> 'UNPAID' THEN 'RECOVERED' WHEN fu.status IS NULL THEN 'OPEN' ELSE fu.status END`

export class AbandonedB2bService {
  /** Rows that belong in the list: stale unpaid ones, plus anything we chased that was later paid. */
  #scope(hours) {
    return `((o.status = 'PENDING_PAYMENT' AND o.payment_status = 'UNPAID' AND o.created_at < NOW() - ($1 || ' hours')::interval)
             OR (fu.status IS NOT NULL AND o.payment_status <> 'UNPAID' AND o.status <> 'CANCELLED'))`
  }

  async summary(hours = 24) {
    const { rows } = await query(
      `SELECT ${STATE} AS state, COUNT(*)::int AS n, COALESCE(SUM(o.subtotal), 0) AS value ${BASE} WHERE ${this.#scope(hours)} GROUP BY 1`, [String(hours)])
    const by = Object.fromEntries(rows.map((r) => [r.state, { n: r.n, value: Number(r.value) }]))
    const get = (k) => by[k] ?? { n: 0, value: 0 }
    const open = get('OPEN'); const contacted = get('CONTACTED'); const will = get('WILL_PAY')
    return {
      hours,
      open: open.n, contacted: contacted.n, willPay: will.n, lost: get('LOST').n, recovered: get('RECOVERED').n,
      atRiskValue: open.value + contacted.value + will.value,
      recoveredValue: get('RECOVERED').value,
    }
  }

  async list({ state = '', search = '', hours = 24, page = 1, limit = 25 } = {}) {
    const params = [String(hours)]
    const where = [this.#scope(hours)]
    if (state) { params.push(state); where.push(`(${STATE}) = $${params.length}`) }
    if (search) { params.push(`%${search}%`); where.push(`(o.order_number ILIKE $${params.length} OR bv.name ILIKE $${params.length} OR sv.name ILIKE $${params.length} OR r.product_name ILIKE $${params.length})`) }
    const lim = Math.min(100, Math.max(1, Number(limit) || 25))
    const off = (Math.max(1, Number(page)) - 1) * lim
    const total = (await query(`SELECT COUNT(*)::int n ${BASE} WHERE ${where.join(' AND ')}`, params)).rows[0].n
    const { rows } = await query(
      `SELECT o.id, o.order_number, o.quantity, o.unit_price, o.subtotal, o.created_at, o.updated_at, o.payment_status,
              r.title AS requirement_title, r.product_name, r.brand,
              bv.id AS buyer_id, bv.name AS buyer_name, bv.phone AS buyer_phone, bv.email AS buyer_email, bp.city AS buyer_city,
              sv.name AS seller_name, ${STATE} AS state, fu.status AS follow_up_status, fu.note AS follow_up_note,
              fu.created_at AS follow_up_at, fu.by_name AS follow_up_by, COALESCE(fu.touches, 0) AS touches,
              FLOOR(EXTRACT(EPOCH FROM (NOW() - o.updated_at)) / 3600)::int AS idle_hours
         ${BASE} WHERE ${where.join(' AND ')}
        ORDER BY (${STATE} IN ('OPEN','CONTACTED','WILL_PAY')) DESC, o.subtotal DESC LIMIT ${lim} OFFSET ${off}`, params)
    return {
      data: rows.map((r) => ({ ...r, unit_price: Number(r.unit_price), subtotal: Number(r.subtotal), touches: Number(r.touches) })),
      meta: { page: Number(page), limit: lim, total, totalPages: Math.ceil(total / lim) },
    }
  }

  async history(orderId) {
    const { rows } = await query(
      `SELECT f.id, f.status, f.note, f.created_at, u.name AS by_name FROM b2b_checkout_followups f LEFT JOIN users u ON u.id = f.actor_id
        WHERE f.order_id = $1 ORDER BY f.created_at DESC, f.id DESC`, [orderId])
    return rows
  }

  async followUp(orderId, { status, note }, actorId) {
    if (!FOLLOW_UP.includes(status)) throw httpError(400, `status must be one of ${FOLLOW_UP.join(', ')}`, 'VALIDATION')
    const text = String(note || '').trim()
    if (text.length < 3) throw httpError(400, 'Write a short note about the follow-up', 'NOTE_REQUIRED')
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const o = (await client.query(`SELECT id, status, payment_status FROM b2b_orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0]
      if (!o) throw httpError(404, 'Order not found', 'NOT_FOUND')
      if (o.payment_status !== 'UNPAID' || o.status !== 'PENDING_PAYMENT') throw httpError(409, 'This order is already paid or closed — nothing to chase', 'NOT_ABANDONED')
      await client.query(`INSERT INTO b2b_checkout_followups (order_id, status, note, actor_id) VALUES ($1,$2,$3,$4)`, [orderId, status, text, actorId || null])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    return this.history(orderId)
  }
}
