/**
 * Seller Orders Service — the per-vendor slice of a parent customer order.
 *
 * A vendor can only ever read/act on rows where seller_orders.vendor_id
 * matches their scoped vendor claim. The WHERE clause is applied in SQL,
 * not in the UI (spec §28/§33/§49).
 *
 * @module modules/seller-orders/seller-orders.service
 */

import { query, getClient } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { ShopProductsRepository } from '../shop-products/shop-products.repository.js'

const shopProductsRepo = new ShopProductsRepository()
const TERMINAL = new Set(['CANCELLED', 'DELIVERED', 'CLOSED', 'RETURNED'])

const ALLOWED_STATUS = new Set([
  'ORDER_PLACED', 'CONFIRMED', 'PACKED', 'READY_TO_SHIP', 'SHIPPED',
  'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'RETURN_REQUESTED',
  'RETURNED', 'CLOSED',
])

export class SellerOrdersService {
  /**
   * List seller orders. vendorId null = platform-wide (admin, permissioned).
   */
  async list({ vendorId = null, orderId = null, status = '', fulfilmentStatus = '', search = '', page = 1, limit = 20 } = {}) {
    const params = []
    const where = []
    if (vendorId) {
      params.push(vendorId)
      where.push(`so.vendor_id = $${params.length}`)
    }
    if (orderId) {
      params.push(orderId)
      where.push(`so.order_id = $${params.length}`)
    }
    if (status) {
      params.push(status)
      where.push(`so.status = $${params.length}`)
    }
    if (fulfilmentStatus) {
      params.push(fulfilmentStatus)
      where.push(`so.fulfilment_status = $${params.length}`)
    }
    if (search) {
      params.push(`%${search}%`)
      where.push(`(so.seller_order_number ILIKE $${params.length} OR o.order_number ILIKE $${params.length})`)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const offset = (Math.max(1, page) - 1) * limit
    params.push(limit)
    params.push(offset)
    const { rows } = await query(
      `SELECT so.id, so.seller_order_number, so.order_id, so.vendor_id, so.shop_id,
              so.status, so.fulfilment_status, so.item_subtotal, so.seller_discount,
              so.platform_discount, so.commission_rate, so.commission_amount,
              so.tax_amount, so.shipping_charge, so.payable_to_seller,
              so.shipping_provider, so.payout_status, so.estimated_delivery,
              so.shipped_at, so.delivered_at, so.created_at,
              o.order_number AS parent_order_number,
              o.payment_method, o.payment_status, o.delivery_address,
              v.name AS vendor_name, s.name AS shop_name, s.pincode AS shop_pincode,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.seller_order_id = so.id) AS item_count
         FROM seller_orders so
         JOIN orders o ON o.id = so.order_id
         LEFT JOIN vendors v ON v.id = so.vendor_id
         LEFT JOIN shops s ON s.id = so.shop_id
         ${whereSql}
        ORDER BY so.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    const { rows: count } = await query(
      `SELECT COUNT(*) AS total
         FROM seller_orders so
         JOIN orders o ON o.id = so.order_id
         ${whereSql}`,
      params.slice(0, -2)
    )
    return { data: rows, pagination: { page: Number(page), limit, total: Number(count[0]?.total || 0) } }
  }

  /** Detail with items + shipment; vendorId enforced server-side. */
  async getById(id, vendorId = null) {
    const params = [id]
    let vendorClause = ''
    if (vendorId) {
      params.push(vendorId)
      vendorClause = `AND so.vendor_id = $2`
    }
    const { rows } = await query(
      `SELECT so.*, o.order_number AS parent_order_number, o.payment_method,
              o.payment_status, o.delivery_address, o.customer_id,
              v.name AS vendor_name, s.name AS shop_name
         FROM seller_orders so
         JOIN orders o ON o.id = so.order_id
         LEFT JOIN vendors v ON v.id = so.vendor_id
         LEFT JOIN shops s ON s.id = so.shop_id
        WHERE so.id = $1 ${vendorClause}
        LIMIT 1`,
      params
    )
    if (!rows[0]) return null
    const { rows: items } = await query(
      `SELECT oi.*, p.thumbnail, p.slug
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.seller_order_id = $1
        ORDER BY oi.created_at`,
      [id]
    )
    const { rows: shipments } = await query(
      `SELECT * FROM shipments WHERE seller_order_id = $1 ORDER BY created_at DESC`,
      [id]
    )
    return { ...rows[0], items, shipment: shipments[0] || null }
  }

  /**
   * Status transition. Platform admins may set any target; vendors may
   * drive fulfilment (confirm → pack → ready → cancel while not shipped).
   */
  async updateStatus(id, vendorId, nextStatus, actorId = null, reason = null) {
    if (!ALLOWED_STATUS.has(nextStatus)) {
      const err = new Error(`Invalid seller order status: ${nextStatus}`)
      err.code = 'INVALID_STATUS'
      throw err
    }
    const params = [id]
    let vendorClause = ''
    if (vendorId) {
      params.push(vendorId)
      vendorClause = `AND vendor_id = $2`
    }
    const { rows } = await query(
      `SELECT * FROM seller_orders WHERE id = $1 ${vendorClause} LIMIT 1 FOR UPDATE`,
      params
    )
    const current = rows[0]
    if (!current) {
      const err = new Error('Seller order not found')
      err.code = 'NOT_FOUND'
      err.statusCode = 404
      throw err
    }
    if (current.status === nextStatus) return current

    // A finished order cannot be re-opened by a vendor (a cancelled order used to be confirmable again).
    if (vendorId && TERMINAL.has(current.status)) {
      const err = new Error(`This order is already ${current.status.toLowerCase()}`)
      err.code = 'FORBIDDEN_TRANSITION'
      err.statusCode = 409
      throw err
    }

    if (nextStatus === 'CANCELLED') return this.#cancel(current, vendorId, actorId, reason)

    // Dispatch / delivery must go through shipment tracking: it rolls the parent
    // order up and posts the vendor settlement. Setting them here would skip both.
    if (['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(nextStatus)) {
      const err = new Error('Add shipment tracking to mark this order shipped or delivered')
      err.code = 'FORBIDDEN_TRANSITION'
      err.statusCode = 409
      throw err
    }

    if (vendorId) {
      const vendorAllowed = new Set(['CONFIRMED', 'PACKED', 'READY_TO_SHIP', 'CANCELLED'])
      if (!vendorAllowed.has(nextStatus)) {
        const err = new Error(`Vendors cannot set status to ${nextStatus}`)
        err.code = 'FORBIDDEN_TRANSITION'
        err.statusCode = 403
        throw err
      }
      if (['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CLOSED'].includes(current.status)) {
        const err = new Error('Seller order has already shipped')
        err.code = 'FORBIDDEN_TRANSITION'
        err.statusCode = 409
        throw err
      }
    }

    const now = new Date()
    const stamps =
      nextStatus === 'SHIPPED' ? ', shipped_at = NOW()' :
      nextStatus === 'DELIVERED' ? ', delivered_at = NOW()' :
      nextStatus === 'CANCELLED' ? ', cancelled_at = NOW()' : ''
    const fulfilmentMap = {
      CONFIRMED: 'PROCESSING', PACKED: 'PACKED', READY_TO_SHIP: 'READY_TO_SHIP',
      SHIPPED: 'DISPATCHED', OUT_FOR_DELIVERY: 'DISPATCHED', DELIVERED: 'DELIVERED',
      CANCELLED: 'CANCELLED',
    }

    // Explicit placeholders: with a vendor scope `params` already holds two
    // values, which left $2 untyped and made every vendor status change a 500.
    const sets = ['status = $2', 'updated_at = NOW()']
    const updateParams = [id, nextStatus]
    if (reason) {
      updateParams.push(reason)
      sets.push(`cancellation_reason = $${updateParams.length}`)
    }
    await query(
      `UPDATE seller_orders SET ${sets.join(', ')}${stamps}
        WHERE id = $1`,
      updateParams
    )
    if (fulfilmentMap[nextStatus]) {
      await query(
        `UPDATE seller_orders SET fulfilment_status = $2 WHERE id = $1`,
        [id, fulfilmentMap[nextStatus]]
      )
    }
    return this.getById(id, vendorId)
  }

  /**
   * Cancel one vendor's slice: restore its stock, and when every slice of the parent order is
   * cancelled, cancel the parent too. Prepaid parents are flagged for refund, never silently dropped.
   */
  async #cancel(current, vendorId, actorId, reason) {
    const client = await getClient()
    let parentCancelled = false
    let refundRequired = false
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE seller_orders
            SET status = 'CANCELLED', fulfilment_status = 'CANCELLED', cancelled_at = NOW(),
                cancellation_reason = COALESCE($2, cancellation_reason), updated_at = NOW()
          WHERE id = $1`,
        [current.id, reason || null]
      )
      const { rows: items } = await client.query(
        `SELECT shop_product_id AS "shopProductId", quantity, product_name AS name
           FROM order_items WHERE seller_order_id = $1`,
        [current.id]
      )
      await shopProductsRepo.restoreStockForCancelledOrder(client, {
        orderId: current.order_id, items, source: 'API', actor: { userId: actorId },
      })
      const { rows: left } = await client.query(
        `SELECT 1 FROM seller_orders WHERE order_id = $1 AND status <> 'CANCELLED' LIMIT 1`,
        [current.order_id]
      )
      if (!left.length) {
        const { rows: parent } = await client.query(
          `SELECT status, payment_status FROM orders WHERE id = $1 FOR UPDATE`, [current.order_id]
        )
        const o = parent[0]
        if (o && !['CANCELLED', 'REFUNDED', 'DELIVERED'].includes(o.status)) {
          await client.query(
            `UPDATE orders SET status = 'CANCELLED', cancelled_reason = COALESCE($2, cancelled_reason), updated_at = NOW() WHERE id = $1`,
            [current.order_id, reason || 'Cancelled by seller']
          )
          await client.query(
            `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note) VALUES ($1,$2,'CANCELLED',$3,$4)`,
            [current.order_id, o.status, actorId, reason || 'Cancelled by seller']
          )
          parentCancelled = true
          // Wallet money goes straight back (idempotent per order); gateway money still needs a refund from finance.
          const { rows: po } = await client.query(
            `SELECT customer_id, wallet_amount, amount_paid FROM orders WHERE id = $1`, [current.order_id]
          )
          const walletBack = Number(po[0]?.wallet_amount || 0)
          if (walletBack > 0 && po[0]?.customer_id) {
            const { rows: done } = await client.query(
              `SELECT 1 FROM wallet_transactions WHERE reference_id = $1 AND sub_type = 'REFUND' AND description LIKE 'Order cancelled by seller%' LIMIT 1`,
              [String(current.order_id)]
            )
            if (!done[0]) {
              await client.query('INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING', [po[0].customer_id])
              const { rows: w } = await client.query('SELECT id FROM wallets WHERE user_id = $1 FOR UPDATE', [po[0].customer_id])
              const up = await client.query('UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2 RETURNING balance', [walletBack, w[0].id])
              await client.query(
                `INSERT INTO wallet_transactions (wallet_id, type, amount, description, reference_id, balance_after, sub_type, order_id)
                 VALUES ($1, 'CREDIT', $2, 'Order cancelled by seller — wallet amount refunded', $3, $4, 'REFUND', $5)`,
                [w[0].id, walletBack, String(current.order_id), up.rows[0].balance, current.order_id]
              )
            }
          }
          refundRequired = Number(po[0]?.amount_paid || 0) > 0
        }
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
    if (refundRequired) logger.warn({ orderId: current.order_id, sellerOrderId: current.id }, 'Seller cancelled a prepaid order — refund must be issued')
    const row = await this.getById(current.id, vendorId)
    return { ...row, parent_cancelled: parentCancelled, refund_required: refundRequired }
  }
}
