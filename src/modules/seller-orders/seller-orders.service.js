/**
 * Seller Orders Service — the per-vendor slice of a parent customer order.
 *
 * A vendor can only ever read/act on rows where seller_orders.vendor_id
 * matches their scoped vendor claim. The WHERE clause is applied in SQL,
 * not in the UI (spec §28/§33/§49).
 *
 * @module modules/seller-orders/seller-orders.service
 */

import { query } from '../../config/database.js'

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

    const sets = ['status = $' + (params.length + 1), 'updated_at = NOW()']
    const updateParams = [...params, nextStatus]
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
}
