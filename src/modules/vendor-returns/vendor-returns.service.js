/**
 * Vendor returns — the vendor's view of customer refund / return requests that touch their own order lines.
 *
 * What a vendor CAN do (vendor-scoped, mounted at /api/v1/manage/returns):
 *   - list + open the returns raised on their seller orders (reason, photos, items, status timeline, pickup, QC)
 *   - answer a return once ("I agree" / "I dispute" + note + photos); the team sees it in the staff case file
 *   - open a chat with Dealkr Support about a return (a support ticket owned by the vendor user)
 *
 * What a vendor can NOT do (by design — the Dealkr team decides and moves the money): approve, reject,
 * refund, schedule the pickup or mark the item received. The customer's contact details are never returned.
 *
 * @module modules/vendor-returns/vendor-returns.service
 */

import { query, getClient } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { toCustomerView } from '../refund-requests/refund-requests.service.js'
import { ReturnJourneyService } from '../refund-requests/return-journey.service.js'
import { supportService } from '../support/support.service.js'

export class VendorReturnError extends Error {
  constructor(statusCode, code, message, details = {}) {
    super(message)
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

const OPEN = ['PENDING', 'PROCESSING']
const money = (n) => Number(Number(n || 0).toFixed(2))
const returnNumber = (id) => `RTN${String(id).replace(/-/g, '').slice(0, 8).toUpperCase()}`
const journey = new ReturnJourneyService()

export const REASON_LABELS = {
  PRODUCT_NOT_WORKING: 'Product not working',
  SCREEN_DISPLAY: 'Screen / display problem',
  BATTERY: 'Battery problem',
  CAMERA: 'Camera problem',
  WRONG_PRODUCT: 'Wrong product received',
  DEFECTIVE_DAMAGED: 'Defective or damaged',
  OTHER: 'Other',
}

/**
 * A request is the vendor's when the vendor owns a seller order of that order AND the request covers
 * the whole order or at least one line that sits on that seller order. $1 is always the vendor id.
 */
const MINE = `EXISTS (
  SELECT 1 FROM seller_orders so
   WHERE so.order_id = rr.order_id AND so.vendor_id = $1
     AND (rr.scope = 'FULL_ORDER' OR EXISTS (
           SELECT 1 FROM order_items oi
            WHERE oi.seller_order_id = so.id
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(rr.items) = 'array' THEN rr.items ELSE '[]'::jsonb END) e
                 WHERE e->>'orderItemId' = oi.id::text OR e->>'productId' = oi.product_id::text)))
)`

/** The vendor's own lines that the request covers (never another seller's). */
async function myLines(vendorId, rr) {
  const { rows } = await query(
    `SELECT oi.id, oi.product_id, oi.product_name, oi.quantity, oi.unit_price, oi.subtotal, p.thumbnail,
            so.seller_order_number, so.id AS seller_order_id, so.status AS seller_order_status
       FROM order_items oi
       JOIN seller_orders so ON so.id = oi.seller_order_id
       LEFT JOIN products p ON p.id = oi.product_id
      WHERE so.order_id = $2 AND so.vendor_id = $1
      ORDER BY oi.created_at, oi.id`,
    [vendorId, rr.order_id])
  const flagged = new Set((Array.isArray(rr.items) ? rr.items : []).flatMap((i) => [i.orderItemId, i.productId].filter(Boolean).map(String)))
  return rows
    .filter((l) => rr.scope === 'FULL_ORDER' || flagged.has(String(l.id)) || flagged.has(String(l.product_id)))
    .map((l) => ({
      id: l.id,
      product_id: l.product_id,
      name: l.product_name,
      quantity: Number(l.quantity),
      unit_price: money(l.unit_price),
      line_total: money(l.subtotal ?? Number(l.unit_price) * Number(l.quantity)),
      image: l.thumbnail || null,
      parcel: l.seller_order_number,
      seller_order_id: l.seller_order_id,
      seller_order_status: l.seller_order_status,
    }))
}

const SELECT = `
  SELECT rr.id, rr.order_id, rr.customer_id, rr.status, rr.scope, rr.items, rr.reason, rr.reason_code, rr.evidence,
         rr.computed_amount, rr.resolved_amount, rr.admin_notes, rr.created_at, rr.updated_at, rr.resolved_at,
         rr.return_approved_at, rr.refunded_at, rr.refund_destination, rr.refund_reference, rr.shop_id,
         o.order_number, o.delivered_at, o.delivery_address,
         u.name AS customer_name,
         s.name AS shop_name,
         vr.stance AS my_stance, vr.updated_at AS my_responded_at,
         (SELECT t.customer_unread FROM support_tickets t
           WHERE t.refund_request_id = rr.id AND t.user_id = $2 AND t.channel = 'VENDOR_APP'
           ORDER BY t.created_at DESC LIMIT 1) AS chat_unread
    FROM refund_requests rr
    JOIN orders o ON o.id = rr.order_id
    JOIN users u ON u.id = rr.customer_id
    LEFT JOIN shops s ON s.id = rr.shop_id
    LEFT JOIN refund_vendor_responses vr ON vr.refund_request_id = rr.id AND vr.vendor_id = $1`

/** Where in the vendor's day the return sits. */
function vendorStage(row) {
  if (row.status === 'APPROVED') return 'REFUNDED'
  if (row.status === 'REJECTED') return 'REJECTED'
  if (row.status === 'CANCELLED') return 'CANCELLED'
  return row.my_stance ? 'WITH_TEAM' : 'NEEDS_RESPONSE'
}

const STAGE_LABEL = {
  NEEDS_RESPONSE: 'Needs your answer',
  WITH_TEAM: 'With Dealkr team',
  REFUNDED: 'Refunded to customer',
  REJECTED: 'Return rejected',
  CANCELLED: 'Cancelled by customer',
}

function toRow(row, lines) {
  const status = row.status === 'PROCESSING' ? 'PENDING' : row.status
  const stage = vendorStage(row)
  return {
    id: row.id,
    return_number: returnNumber(row.id),
    order_id: row.order_id,
    order_number: row.order_number,
    status,
    stage,
    stage_label: STAGE_LABEL[stage],
    reason_code: row.reason_code || null,
    reason_label: REASON_LABELS[row.reason_code] || null,
    reason: row.reason,
    scope: row.scope === 'FULL_ORDER' ? 'ALL' : 'SPECIFIC',
    item_count: lines.reduce((a, l) => a + l.quantity, 0),
    items_preview: lines.slice(0, 2).map((l) => ({ name: l.name, image: l.image })),
    // What the covered lines on THIS vendor's parcels are worth — never another seller's money.
    at_risk_amount: money(lines.reduce((a, l) => a + l.line_total, 0)),
    created_at: row.created_at,
    updated_at: row.updated_at,
    my_stance: row.my_stance || null,
    chat_unread: Number(row.chat_unread || 0),
  }
}

export async function summary(vendorId, userId) {
  const { rows } = await query(
    `SELECT rr.status, (vr.id IS NOT NULL) AS answered
       FROM refund_requests rr
       LEFT JOIN refund_vendor_responses vr ON vr.refund_request_id = rr.id AND vr.vendor_id = $1
      WHERE ${MINE}`, [vendorId])
  const open = rows.filter((r) => OPEN.includes(r.status))
  const { rows: [u] } = await query(
    `SELECT COALESCE(SUM(t.customer_unread), 0)::int AS unread
       FROM support_tickets t WHERE t.user_id = $1 AND t.channel = 'VENDOR_APP' AND t.refund_request_id IS NOT NULL`, [userId])
  return {
    total: rows.length,
    open: open.length,
    needs_response: open.filter((r) => !r.answered).length,
    with_team: open.filter((r) => r.answered).length,
    closed: rows.length - open.length,
    unread_chat: u.unread,
  }
}

/** state: 'open' | 'needs_response' | 'closed' | '' (all) */
export async function list(vendorId, userId, { state = '', search = '', sellerOrderId = '', page = 1, limit = 20 } = {}) {
  const params = [vendorId, userId]
  const where = [MINE]
  if (state === 'open') where.push(`rr.status IN ('PENDING','PROCESSING')`)
  else if (state === 'needs_response') where.push(`rr.status IN ('PENDING','PROCESSING') AND vr.id IS NULL`)
  else if (state === 'closed') where.push(`rr.status NOT IN ('PENDING','PROCESSING')`)
  const s = String(search || '').trim()
  if (s) { params.push(`%${s}%`); where.push(`(o.order_number ILIKE $${params.length} OR rr.id::text ILIKE $${params.length})`) }
  if (sellerOrderId) {
    params.push(sellerOrderId)
    where.push(`EXISTS (SELECT 1 FROM seller_orders s2 WHERE s2.id = $${params.length}::uuid AND s2.order_id = rr.order_id AND s2.vendor_id = $1)`)
  }
  const lim = Math.min(100, Math.max(1, Number(limit) || 20))
  const pg = Math.max(1, Number(page) || 1)
  const { rows } = await query(
    `${SELECT} WHERE ${where.join(' AND ')}
      ORDER BY (rr.status IN ('PENDING','PROCESSING') AND vr.id IS NULL) DESC, rr.created_at DESC
      LIMIT ${lim} OFFSET ${(pg - 1) * lim}`, params)
  const { rows: [c] } = await query(
    `SELECT COUNT(*)::int AS n FROM refund_requests rr JOIN orders o ON o.id = rr.order_id
       LEFT JOIN refund_vendor_responses vr ON vr.refund_request_id = rr.id AND vr.vendor_id = $1
      WHERE $2::uuid IS NOT NULL AND ${where.join(' AND ')}`, params)
  const data = []
  for (const r of rows) data.push(toRow(r, await myLines(vendorId, r)))
  return { data, pagination: { page: pg, limit: lim, total: c.n } }
}

async function loadMine(vendorId, userId, id) {
  const { rows } = await query(`${SELECT} WHERE rr.id = $3 AND ${MINE}`, [vendorId, userId, id])
  if (!rows[0]) throw new VendorReturnError(404, 'NOT_FOUND', 'Return not found')
  return rows[0]
}

async function chatFor(userId, refundRequestId) {
  const { rows } = await query(
    `SELECT id, ticket_number, status, customer_unread FROM support_tickets
      WHERE refund_request_id = $1 AND user_id = $2 AND channel = 'VENDOR_APP'
      ORDER BY (status <> 'CLOSED') DESC, created_at DESC LIMIT 1`, [refundRequestId, userId])
  const t = rows[0]
  return t ? { ticket_id: t.id, ticket_number: t.ticket_number, status: t.status, unread: Number(t.customer_unread || 0) } : null
}

export async function detail(vendorId, userId, id) {
  const rr = await loadMine(vendorId, userId, id)
  const lines = await myLines(vendorId, rr)
  const j = await journey.journey(id)
  const view = toCustomerView(rr, j)
  const { rows: [resp] } = await query(
    `SELECT stance, note, evidence, created_at, updated_at FROM refund_vendor_responses WHERE refund_request_id = $1 AND vendor_id = $2`, [id, vendorId])

  // The customer-facing journey, plus the vendor's own answer slotted in right after the request.
  const timeline = [...view.timeline]
  if (resp) {
    timeline.splice(1, 0, {
      key: 'SELLER_RESPONDED',
      title: resp.stance === 'AGREE' ? 'You agreed to the return' : 'You disputed the return',
      at: resp.updated_at,
    })
  }

  const row = toRow(rr, lines)
  return {
    ...row,
    order: { id: rr.order_id, number: rr.order_number, delivered_at: rr.delivered_at },
    // Name only — the phone number and address stay with the team and the courier.
    customer: { name: rr.customer_name || 'Customer' },
    items: lines,
    evidence: Array.isArray(rr.evidence) ? rr.evidence : [],
    timeline,
    pickup: view.pickup,
    qc: view.qc ? { checks: view.qc.checks, summary: view.qc.summary, inspected_at: view.qc.inspected_at } : null,
    team_note: rr.status === 'REJECTED' ? (rr.admin_notes || null) : null,
    response: resp ? { stance: resp.stance, note: resp.note, evidence: resp.evidence, at: resp.updated_at } : null,
    can_respond: OPEN.includes(rr.status),
    chat: await chatFor(userId, id),
  }
}

/** "I agree" / "I dispute" — advisory; the Dealkr team still decides. */
export async function respond(vendorId, userId, id, { stance, note, evidence = [] }) {
  const rr = await loadMine(vendorId, userId, id)
  if (!OPEN.includes(rr.status)) {
    throw new VendorReturnError(409, 'RETURN_CLOSED', `This return is already ${rr.status.toLowerCase()}, so it can no longer be answered.`)
  }
  const text = String(note || '').trim()
  if (text.length < 3) throw new VendorReturnError(400, 'VALIDATION_ERROR', 'Please write a short note for the Dealkr team.')

  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { rows: [lock] } = await client.query(`SELECT status, investigation_status FROM refund_requests WHERE id = $1 FOR UPDATE`, [id])
    if (!OPEN.includes(lock.status)) throw new VendorReturnError(409, 'RETURN_CLOSED', `This return is already ${lock.status.toLowerCase()}, so it can no longer be answered.`)

    const { rows: [prev] } = await client.query(`SELECT case_evidence_ids FROM refund_vendor_responses WHERE refund_request_id = $1 AND vendor_id = $2`, [id, vendorId])
    if (prev?.case_evidence_ids?.length) await client.query(`DELETE FROM refund_case_evidence WHERE id = ANY($1::uuid[])`, [prev.case_evidence_ids])

    const label = stance === 'AGREE' ? 'Seller agreed to the return' : 'Seller disputed the return'
    const ids = []
    let n = 0
    for (const e of evidence) {
      n += 1
      const { rows: [ev] } = await client.query(
        `INSERT INTO refund_case_evidence (refund_request_id, side, kind, url, title, note, uploaded_by)
         VALUES ($1,'SELLER',$2,$3,$4,$5,$6) RETURNING id`,
        [id, e.kind, e.url, `Seller's proof ${n}`, text.slice(0, 240), userId])
      ids.push(ev.id)
    }
    await client.query(
      `INSERT INTO refund_vendor_responses (refund_request_id, vendor_id, responded_by, stance, note, evidence, case_evidence_ids)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::uuid[])
       ON CONFLICT (refund_request_id, vendor_id) DO UPDATE
         SET stance = EXCLUDED.stance, note = EXCLUDED.note, evidence = EXCLUDED.evidence, case_evidence_ids = EXCLUDED.case_evidence_ids,
             responded_by = EXCLUDED.responded_by, updated_at = NOW()`,
      [id, vendorId, userId, stance, text, JSON.stringify(evidence), ids])
    await client.query(
      `INSERT INTO refund_case_events (refund_request_id, type, party, title, body, metadata, actor_id)
       VALUES ($1,'SELLER_RESPONDED','SELLER',$2,$3,$4::jsonb,$5)`,
      [id, label, text, JSON.stringify({ vendorId, stance, evidenceCount: evidence.length }), userId])
    // The team was waiting for the seller — they are no longer.
    if (lock.investigation_status === 'WAITING_SELLER') {
      await client.query(`UPDATE refund_requests SET investigation_status = 'OPEN' WHERE id = $1`, [id])
    }
    await client.query(`UPDATE refund_requests SET updated_at = NOW() WHERE id = $1`, [id])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
  return detail(vendorId, userId, id)
}

/** Get-or-create the vendor's chat with Dealkr Support about this return. */
export async function openChat(vendorId, userId, id, { message } = {}) {
  const rr = await loadMine(vendorId, userId, id)
  const existing = await chatFor(userId, id)
  if (existing && existing.status !== 'CLOSED') return existing
  const rn = returnNumber(id)
  const text = String(message || '').trim() || `Hi Dealkr team, I need help with return ${rn} for order ${rr.order_number}.`
  const out = await supportService.create({
    userId,
    subject: `Seller · Return ${rn} · Order ${rr.order_number}`,
    message: text,
    category: 'RETURN_REFUND',
    orderId: rr.order_id,
    refundRequestId: id,
    channel: 'VENDOR_APP',
    verifiedOrder: true, // access to the order was proven by loadMine (seller order of this vendor)
  })
  return { ticket_id: out.ticket.id, ticket_number: out.ticket.ticket_number, status: out.ticket.status, unread: 0 }
}

/**
 * New return on one of my orders → tell the vendor's staff (in-app row + push to the vendor app only).
 * Never throws; called after the customer's request is already saved.
 */
export async function notifyVendorsOfNewReturn(rr, notifier) {
  if (!notifier || !rr?.order_id) return
  try {
    const { rows } = await query(
      `SELECT DISTINCT vu.user_id, so.vendor_id
         FROM seller_orders so
         JOIN vendor_users vu ON vu.vendor_id = so.vendor_id AND vu.is_active = true AND vu.deleted_at IS NULL
        WHERE so.order_id = $1 AND so.vendor_id IS NOT NULL
          AND ($2 = 'FULL_ORDER' OR EXISTS (
                SELECT 1 FROM order_items oi
                 WHERE oi.seller_order_id = so.id
                   AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof($3::jsonb) = 'array' THEN $3::jsonb ELSE '[]'::jsonb END) e
                                WHERE e->>'orderItemId' = oi.id::text OR e->>'productId' = oi.product_id::text)))`,
      [rr.order_id, rr.scope, JSON.stringify(rr.items ?? null)])
    await Promise.allSettled(rows.map((r) => notifier.sendNotification(r.user_id, {
      title: 'Customer return request',
      body: `A customer asked to return items from order ${rr.order_number}. Open it and tell Dealkr what you think.`,
      type: 'RETURN',
      data: { type: 'RETURN', refundRequestId: rr.id, orderId: rr.order_id, orderNumber: rr.order_number, vendorId: r.vendor_id },
      app: 'vendor',
    })))
  } catch (err) {
    logger.warn({ err: err?.message, id: rr?.id }, 'Vendor return notification failed (non-blocking)')
  }
}
