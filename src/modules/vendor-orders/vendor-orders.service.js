/**
 * Vendor order management — ONE inbox for everything a vendor sells.
 *
 *   PRODUCT  a normal marketplace order (B2C or B2B)      → seller_orders, order has no auction
 *   AUCTION  an order created when a winner paid          → seller_orders, order.auction_id set
 *   REPAIR   a repair job assigned to this service centre → repair_requests
 *
 * Each row is normalised to the same shape and a coarse `stage` the app filters by:
 *   NEW (needs the vendor) · ACTIVE (being prepared) · SHIPPED (on its way / ready) · DONE · CANCELLED
 * Doing the work itself (confirm, pack, ship, repair steps) stays in the owning modules; this only lists and counts.
 *
 * @module modules/vendor-orders/vendor-orders.service
 */

import { query } from '../../config/database.js'

export const TYPES = ['all', 'product', 'auction', 'repair']
export const STAGES = ['all', 'new', 'active', 'shipped', 'done', 'cancelled']

// NEW = needs the vendor now. An online order the buyer has not paid for yet cannot be acted on, so it waits under ACTIVE.
const SELLER_STAGE = `CASE
  WHEN so.status = 'ORDER_PLACED' AND (o.payment_status = 'PAID' OR o.payment_method = 'COD') THEN 'NEW'
  WHEN so.status = 'ORDER_PLACED' THEN 'ACTIVE'
  WHEN so.status IN ('CONFIRMED','PACKED','READY_TO_SHIP') THEN 'ACTIVE'
  WHEN so.status IN ('SHIPPED','OUT_FOR_DELIVERY') THEN 'SHIPPED'
  WHEN so.status IN ('DELIVERED','CLOSED') THEN 'DONE'
  ELSE 'CANCELLED' END`

const REPAIR_STAGE = `CASE
  WHEN r.status IN ('REQUESTED','ACCEPTED') THEN 'NEW'
  WHEN r.status IN ('INSPECTION','ESTIMATE_SENT','ESTIMATE_APPROVED','IN_REPAIR','QC_PENDING','FAILED','ESTIMATE_REJECTED') THEN 'ACTIVE'
  WHEN r.status IN ('REPAIRED','READY_FOR_DELIVERY') THEN 'SHIPPED'
  WHEN r.status = 'COMPLETED' THEN 'DONE'
  ELSE 'CANCELLED' END`

/** The single button a row offers, if any. `dashboard` marks steps that need the web dashboard (estimates, payments). */
export function nextAction(row) {
  const s = String(row.raw_status).toUpperCase()
  if (row.kind === 'REPAIR') {
    return {
      ACCEPTED: { key: 'receive', label: 'Receive device' },
      INSPECTION: { key: 'estimate', label: 'Send estimate', dashboard: true },
      ESTIMATE_APPROVED: { key: 'start', label: 'Start repair' },
      IN_REPAIR: { key: 'send-to-qc', label: 'Send to QC' },
      QC_PENDING: { key: 'qc', label: 'Record QC result' },
      REPAIRED: { key: 'ready', label: 'Mark ready' },
      FAILED: { key: 'ready', label: 'Mark ready to return' },
      ESTIMATE_REJECTED: { key: 'ready', label: 'Mark ready to return' },
      READY_FOR_DELIVERY: { key: 'deliver', label: 'Hand over' },
    }[s] || null
  }
  const payable = String(row.payment_status).toUpperCase() === 'PAID' || String(row.payment_method).toUpperCase() === 'COD'
  if (s === 'ORDER_PLACED') return payable ? { key: 'confirm', label: 'Confirm order' } : null
  if (s === 'CONFIRMED') return { key: 'pack', label: 'Mark as packed' }
  if (s === 'PACKED' || s === 'READY_TO_SHIP') return { key: 'ship', label: 'Ship it' }
  return null
}

const UNION = `
  SELECT CASE WHEN o.auction_id IS NULL THEN 'PRODUCT' ELSE 'AUCTION' END AS kind,
         so.id, so.seller_order_number AS number, o.order_number AS parent_number, so.status AS raw_status,
         ${SELLER_STAGE} AS stage, so.created_at,
         (SELECT oi.product_name FROM order_items oi WHERE oi.seller_order_id = so.id ORDER BY oi.created_at LIMIT 1) AS title,
         (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.seller_order_id = so.id)::int AS quantity,
         (SELECT p.thumbnail_url FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.seller_order_id = so.id ORDER BY oi.created_at LIMIT 1) AS thumbnail,
         COALESCE(u.name, 'Customer') AS customer, o.order_channel AS channel,
         so.item_subtotal AS amount, so.payable_to_seller AS payable,
         o.payment_method, o.payment_status, o.auction_id AS ref_id, so.delivered_at AS finished_at
    FROM seller_orders so
    JOIN orders o ON o.id = so.order_id
    LEFT JOIN users u ON u.id = o.customer_id
   WHERE so.vendor_id = $1
  UNION ALL
  SELECT 'REPAIR', r.id, r.code, r.code, r.status,
         ${REPAIR_STAGE}, r.created_at,
         COALESCE((SELECT i.brand || ' ' || i.model FROM repair_items i WHERE i.request_id = r.id ORDER BY i.line_no LIMIT 1), 'Repair'),
         (SELECT COUNT(*) FROM repair_items i WHERE i.request_id = r.id)::int, NULL,
         r.customer_name, r.channel, r.approved_total, r.vendor_payable,
         NULL, CASE WHEN r.approved_total > 0 AND r.amount_paid >= r.approved_total THEN 'PAID' ELSE 'PENDING' END, NULL, NULL
    FROM repair_requests r
   WHERE r.assigned_vendor_id = $1`

export async function list(vendorId, { type = 'all', tab = 'all', q = '', page = 1, limit = 20 } = {}) {
  if (!vendorId) throw Object.assign(new Error('Vendor access required'), { statusCode: 403, code: 'FORBIDDEN' })
  const t = TYPES.includes(String(type).toLowerCase()) ? String(type).toLowerCase() : 'all'
  const s = STAGES.includes(String(tab).toLowerCase()) ? String(tab).toLowerCase() : 'all'
  const lim = Math.min(100, Math.max(1, Number(limit) || 20))
  const pg = Math.max(1, Number(page) || 1)

  const filters = []
  const params = [vendorId]
  if (t !== 'all') { params.push(t.toUpperCase()); filters.push(`kind = $${params.length}`) }
  if (q) { params.push(`%${String(q).slice(0, 80)}%`); filters.push(`(number ILIKE $${params.length} OR parent_number ILIKE $${params.length} OR title ILIKE $${params.length} OR customer ILIKE $${params.length})`) }
  const base = filters.length ? `WHERE ${filters.join(' AND ')}` : ''

  // counts ignore the stage filter so every tab keeps its number; type counts ignore the type filter
  const [byStage, byKind] = await Promise.all([
    query(`SELECT stage, COUNT(*)::int AS n FROM (${UNION}) u ${base} GROUP BY stage`, params),
    query(`SELECT kind, COUNT(*)::int AS n FROM (${UNION}) u ${q ? `WHERE (number ILIKE $2 OR parent_number ILIKE $2 OR title ILIKE $2 OR customer ILIKE $2)` : ''} GROUP BY kind`,
      q ? [vendorId, `%${String(q).slice(0, 80)}%`] : [vendorId]),
  ])
  const stages = Object.fromEntries(byStage.rows.map((r) => [r.stage.toLowerCase(), r.n]))
  const counts = { all: byStage.rows.reduce((n, r) => n + r.n, 0), ...Object.fromEntries(STAGES.slice(1).map((k) => [k, stages[k] || 0])) }
  const types = { all: byKind.rows.reduce((n, r) => n + r.n, 0), product: 0, auction: 0, repair: 0, ...Object.fromEntries(byKind.rows.map((r) => [r.kind.toLowerCase(), r.n])) }

  const rowParams = [...params]
  let where = base
  if (s !== 'all') { rowParams.push(s.toUpperCase()); where += `${where ? ' AND' : 'WHERE'} stage = $${rowParams.length}` }
  rowParams.push(lim, (pg - 1) * lim)
  const { rows } = await query(
    `SELECT * FROM (${UNION}) u ${where}
      ORDER BY CASE stage WHEN 'NEW' THEN 0 WHEN 'ACTIVE' THEN 1 WHEN 'SHIPPED' THEN 2 ELSE 3 END, created_at DESC
      LIMIT $${rowParams.length - 1} OFFSET $${rowParams.length}`, rowParams)

  return {
    data: rows.map((r) => ({
      kind: r.kind, id: r.id, number: r.number, parent_number: r.parent_number, status: r.raw_status, stage: r.stage,
      title: r.title, quantity: r.quantity, thumbnail: r.thumbnail, customer: r.customer, channel: r.channel,
      amount: Number(r.amount || 0), payable: Number(r.payable || 0), payment_method: r.payment_method, payment_status: r.payment_status,
      ref_id: r.ref_id, created_at: r.created_at,
      awaiting_payment: r.kind !== 'REPAIR' && String(r.raw_status).toUpperCase() === 'ORDER_PLACED' && !nextAction(r),
      next_action: nextAction(r),
    })),
    counts, types,
    pagination: { page: pg, limit: lim, total: s === 'all' ? counts.all : counts[s] },
  }
}
