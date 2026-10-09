/**
 * Order stages — the 9-step timeline of an order and the admin's manual
 * override of any stage.
 *
 *   Order Placed → Payment → Vendor Confirmation → QC → Packing → Shipping
 *   → Out for Delivery → Delivered → Completed
 *
 * Stage state is derived from real data (payment, seller-order status,
 * listing QC). An override moves the real data forward (never backward), keeps
 * who / why in `order_stage_overrides`, and for Delivered runs the same
 * side-effects as a normal delivery (COD collected, loyalty, referrals,
 * vendor settlement). Payment must be settled first for online orders.
 *
 * @module modules/order-stages/order-stages.service
 */

import { query, getClient } from '../../config/database.js'
import { logger } from '../../config/logger.js'

export const STAGES = [
  { key: 'PLACED', label: 'Order placed' },
  { key: 'PAYMENT', label: 'Payment' },
  { key: 'VENDOR_CONFIRMATION', label: 'Vendor confirmation' },
  { key: 'QC', label: 'QC' },
  { key: 'PACKING', label: 'Packing' },
  { key: 'SHIPPING', label: 'Shipping' },
  { key: 'OUT_FOR_DELIVERY', label: 'Out for delivery' },
  { key: 'DELIVERED', label: 'Delivered' },
  { key: 'COMPLETED', label: 'Completed' },
]

/** Seller-order status ladder. */
const RANK = { ORDER_PLACED: 0, CONFIRMED: 1, PACKED: 2, READY_TO_SHIP: 2, SHIPPED: 3, OUT_FOR_DELIVERY: 4, DELIVERED: 5, CLOSED: 6 }
const TARGET = {
  VENDOR_CONFIRMATION: { seller: 'CONFIRMED', fulfilment: 'PROCESSING', parent: 'CONFIRMED' },
  PACKING: { seller: 'PACKED', fulfilment: 'PACKED', parent: 'PACKED' },
  SHIPPING: { seller: 'SHIPPED', fulfilment: 'DISPATCHED', parent: 'SHIPPED' },
  OUT_FOR_DELIVERY: { seller: 'OUT_FOR_DELIVERY', fulfilment: 'DISPATCHED', parent: 'OUT_FOR_DELIVERY' },
  DELIVERED: { seller: 'DELIVERED', fulfilment: 'DELIVERED', parent: 'DELIVERED' },
  COMPLETED: { seller: 'CLOSED', fulfilment: 'DELIVERED', parent: 'COMPLETED' },
}
const CLOSED_STATES = ['CANCELLED', 'REFUNDED', 'RETURNED']
const httpError = (statusCode, message, code = 'STAGE_ERROR') => Object.assign(new Error(message), { statusCode, code })

const isCodLike = (o) => o.payment_method === 'COD' || o.payment_plan === 'COD'
const paymentDone = (o) => ['PAID', 'PARTIALLY_PAID'].includes(o.payment_status) || isCodLike(o)

export function computeStages({ order, sellerOrders, qc, overrides }) {
  const live = sellerOrders.filter((s) => s.status !== 'CANCELLED')
  const minRank = live.length ? Math.min(...live.map((s) => RANK[s.status] ?? 0)) : 0
  const ovr = new Map()
  for (const o of overrides) if (!ovr.has(o.stage)) ovr.set(o.stage, o)       // newest first

  const done = {
    PLACED: true,
    PAYMENT: paymentDone(order),
    VENDOR_CONFIRMATION: minRank >= 1,
    QC: ovr.has('QC') || (qc.total > 0 && qc.passed === qc.total),
    PACKING: minRank >= 2,
    SHIPPING: minRank >= 3,
    OUT_FOR_DELIVERY: minRank >= 4,
    DELIVERED: ['DELIVERED', 'COMPLETED'].includes(order.status) || minRank >= 5,
    COMPLETED: order.status === 'COMPLETED' || minRank >= 6,
  }
  const terminal = CLOSED_STATES.includes(order.status)
  const firstOpen = STAGES.find((s) => !done[s.key])?.key ?? null

  const stages = STAGES.map((s) => {
    const o = ovr.get(s.key)
    let detail = null
    if (s.key === 'PAYMENT') detail = done.PAYMENT ? (isCodLike(order) ? 'Cash on delivery' : order.payment_status === 'PARTIALLY_PAID' ? 'Advance paid' : 'Paid') : 'Waiting for payment'
    if (s.key === 'QC') detail = `${qc.passed} of ${qc.total} item${qc.total === 1 ? '' : 's'} QC passed`
    let blocked = null
    if (!done[s.key] && !terminal && s.key !== 'PLACED') {
      if (s.key !== 'PAYMENT' && !done.PAYMENT) blocked = 'Mark the payment as received first'
    }
    return {
      key: s.key, label: s.label, done: done[s.key], current: s.key === firstOpen && !terminal, detail,
      override: o ? { reason: o.reason, by: o.actor_name, at: o.created_at } : null,
      canOverride: s.key !== 'PLACED' && !done[s.key] && !terminal && !blocked,
      blocked,
    }
  })
  return { stages, terminal, status: order.status }
}

export class OrderStagesService {
  async #load(orderId, runner = query) {
    const order = (await runner(`SELECT * FROM orders WHERE id = $1`, [orderId])).rows[0]
    if (!order) throw httpError(404, 'Order not found', 'NOT_FOUND')
    const sellerOrders = (await runner(`SELECT id, status, vendor_id FROM seller_orders WHERE order_id = $1`, [orderId])).rows
    const qc = (await runner(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE sp.qc_status = 'QC_PASSED')::int AS passed
         FROM order_items oi LEFT JOIN shop_products sp ON sp.id = oi.shop_product_id WHERE oi.order_id = $1`, [orderId])).rows[0]
    const overrides = (await runner(
      `SELECT o.stage, o.reason, o.created_at, u.name AS actor_name FROM order_stage_overrides o LEFT JOIN users u ON u.id = o.actor_id
        WHERE o.order_id = $1 ORDER BY o.created_at DESC, o.id DESC`, [orderId])).rows
    return { order, sellerOrders, qc, overrides }
  }

  async get(orderId) {
    const d = await this.#load(orderId)
    return { orderId, orderNumber: d.order.order_number, ...computeStages(d), history: d.overrides.slice(0, 20).map((o) => ({ stage: o.stage, reason: o.reason, by: o.actor_name, at: o.created_at })) }
  }

  async override(orderId, stage, reason, actorId) {
    const key = String(stage || '').toUpperCase()
    if (!STAGES.some((s) => s.key === key) || key === 'PLACED') throw httpError(400, 'Choose a stage after “Order placed”', 'VALIDATION')
    const text = String(reason || '').trim()
    if (text.length < 5) throw httpError(400, 'Write why you are overriding this stage (at least 5 characters)', 'REASON_REQUIRED')

    const client = await getClient()
    let after
    try {
      await client.query('BEGIN')
      await client.query(`SELECT id FROM orders WHERE id = $1 FOR UPDATE`, [orderId])
      const d = await this.#load(orderId, client.query.bind(client))
      if (CLOSED_STATES.includes(d.order.status)) throw httpError(409, `This order is ${d.order.status.toLowerCase()} and cannot be moved`, 'ORDER_CLOSED')
      const state = computeStages(d).stages.find((s) => s.key === key)
      if (state.done) throw httpError(409, 'That stage is already done — overrides only move an order forward', 'ALREADY_DONE')
      if (state.blocked) throw httpError(409, state.blocked, 'PAYMENT_PENDING')

      const fromStatus = d.order.status
      let toStatus = fromStatus
      if (key === 'PAYMENT') {
        const total = Number(d.order.total_payable || 0) + Number(d.order.wallet_amount || 0)
        await client.query(`UPDATE orders SET payment_status = 'PAID', amount_paid = $2, amount_due = 0, updated_at = NOW() WHERE id = $1`, [orderId, total])
      } else if (key !== 'QC') {
        const t = TARGET[key]
        const targetRank = RANK[t.seller]
        await client.query(
          `UPDATE seller_orders SET status = $2, fulfilment_status = $3,
                  shipped_at = CASE WHEN $4 >= 3 AND shipped_at IS NULL THEN NOW() ELSE shipped_at END,
                  delivered_at = CASE WHEN $4 >= 5 AND delivered_at IS NULL THEN NOW() ELSE delivered_at END, updated_at = NOW()
            WHERE order_id = $1 AND status <> 'CANCELLED'
              AND CASE status WHEN 'ORDER_PLACED' THEN 0 WHEN 'CONFIRMED' THEN 1 WHEN 'PACKED' THEN 2 WHEN 'READY_TO_SHIP' THEN 2
                              WHEN 'SHIPPED' THEN 3 WHEN 'OUT_FOR_DELIVERY' THEN 4 WHEN 'DELIVERED' THEN 5 ELSE 6 END < $4`,
          [orderId, t.seller, t.fulfilment, targetRank])
        toStatus = t.parent
        await client.query(
          `UPDATE orders SET status = $2, updated_at = NOW(),
                  delivered_at = CASE WHEN $2 IN ('DELIVERED','COMPLETED') AND delivered_at IS NULL THEN NOW() ELSE delivered_at END
            WHERE id = $1`, [orderId, toStatus])
        await client.query(
          `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note) VALUES ($1,$2,$3,$4,$5)`,
          [orderId, fromStatus, toStatus, actorId || null, `Admin override (${key.replace(/_/g, ' ').toLowerCase()}): ${text}`])
      }
      await client.query(
        `INSERT INTO order_stage_overrides (order_id, stage, reason, from_status, to_status, actor_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [orderId, key, text, fromStatus, toStatus, actorId || null])
      await client.query('COMMIT')

      if (['DELIVERED', 'COMPLETED'].includes(key)) {
        // same side-effects as a normal delivery: COD collected, loyalty, referrals, vendor settlement
        try {
          const { OrdersService } = await import('../orders/orders.service.js')
          const svc = new OrdersService(null, null, {})
          await svc._runMarketplaceSideEffects(orderId, toStatus, { ...d.order, status: toStatus }, actorId)
        } catch (err) {
          logger.warn({ err: err.message, orderId }, 'Delivery side-effects after stage override failed (non-critical)')
        }
      }
      after = await this.get(orderId)
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    return after
  }
}
