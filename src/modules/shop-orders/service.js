import { logger } from '../../config/logger.js'
import { ERROR_CODES } from '../../constants/errors.js'
import { emitInTx as emitAuditInTx } from '../../utils/audit-log.js'
import { ShopProductsRepository } from '../shop-products/shop-products.repository.js'
import { ShopProductsService } from '../shop-products/shop-products.service.js'

/**
 * Shop Orders service — wraps the existing order workflow with
 * shop-scoped state-machine enforcement, rider assignment, cancel /
 * refund, and audit emission.
 *
 * Design source: §6.5 (endpoint catalog) and §7 (state machine).
 *
 * State machine (R22 AC#5–AC#7, AC#13):
 *
 *   PENDING            ──/confirm──▶  CONFIRMED
 *   CONFIRMED          ──/preparing─▶ PREPARING
 *   PREPARING          ──/packed────▶ PACKED
 *   PACKED             ──assign─────▶ PACKED  (state unchanged; rider attached)
 *   PENDING|CONFIRMED|PREPARING|PACKED ──/cancel─▶ CANCELLED
 *   DELIVERED          ──/refund────▶ REFUNDED
 *
 * Anything else → 409 ORDER_STATE_INVALID.
 *
 * Every mutation runs inside a single pg transaction:
 *   BEGIN
 *     SELECT … FOR UPDATE on the order row
 *     assert shop_id matches the caller's shop scope
 *     assert from-state is allowed
 *     UPDATE orders ...
 *     INSERT order_status_history
 *     emitAuditInTx('order_status_changed' | 'rider_assigned', …)
 *   COMMIT
 *
 * Audit row commits atomically with the data mutation (R22 AC#14, R28).
 */

/**
 * Allowed forward transitions for the staff-driven endpoints. Keys are
 * the destination state, values are the set of source states. The cancel
 * and refund handlers use their own allowed-source sets because they
 * are reachable from multiple sources.
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  CONFIRMED: new Set(['PENDING', 'PLACED']),
  PREPARING: new Set(['CONFIRMED']),
  PACKED: new Set(['PREPARING']),
})

const CANCELLABLE_FROM = new Set([
  'PENDING',
  'PLACED',
  'CONFIRMED',
  'PREPARING',
  'PACKED',
])

const REFUNDABLE_FROM = new Set(['DELIVERED'])

const ASSIGN_RIDER_FROM = new Set(['CONFIRMED', 'PREPARING', 'PACKED'])

/**
 * Create a typed service error so the controller can map it to an HTTP
 * envelope without parsing the message.
 */
function serviceError(code, message, statusCode) {
  const err = new Error(message)
  err.code = code
  err.statusCode = statusCode
  return err
}

export class ShopOrdersService {
  /**
   * @param {object} repository - ShopOrdersRepository instance
   * @param {object} [options]
   * @param {object} [options.fastify] - Fastify instance for socket.io fanout
   */
  constructor(repository, options = {}) {
    this.repo = repository
    this.fastify = options.fastify || null
    this.shopProductsRepo = options.shopProductsRepo || new ShopProductsRepository()
  }

  // ─── R22 AC#3, AC#4 — Listing ───────────────────────────────────

  /**
   * Paginated list scoped to one shop.
   *
   * @param {string} shopId
   * @param {object} filters - validated by listOrdersQuerySchema
   * @returns {Promise<{ orders: object[], pagination: object }>}
   */
  async list(shopId, filters) {
    const page = Math.max(1, Number(filters.page) || 1)
    const limit = Math.min(100, Math.max(1, Number(filters.limit) || 20))
    const offset = (page - 1) * limit

    const { orders, total } = await this.repo.list(
      shopId,
      {
        status: filters.status,
        payment_status: filters.payment_status,
        created_at_from: filters.created_at_from,
        created_at_to: filters.created_at_to,
        q: filters.q,
      },
      { limit, offset }
    )

    return {
      orders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }

  /**
   * Read a single order belonging to the given shop. Returns `null` when
   * it does not exist (or exists but belongs to another shop).
   */
  async getById(shopId, orderId) {
    return this.repo.findByIdAndShop(orderId, shopId)
  }

  // ─── R22 AC#5–AC#7, AC#13 — State transitions ───────────────────

  /**
   * Generic state-transition runner used by /confirm /preparing /packed.
   *
   * @param {string} shopId
   * @param {string} orderId
   * @param {string} toStatus - destination state
   * @param {{ id: string, role?: string, platform_role?: string,
   *           shopRole?: string, ip?: string|null,
   *           userAgent?: string|null }} actor
   * @returns {Promise<object>} the updated order
   */
  async transition(shopId, orderId, toStatus, actor) {
    const allowedFrom = ALLOWED_TRANSITIONS[toStatus]
    if (!allowedFrom) {
      throw serviceError(
        ERROR_CODES.VALIDATION_ERROR,
        `Unknown target state: ${toStatus}`,
        400
      )
    }

    const client = await this.repo.getClient()
    try {
      await client.query('BEGIN')

      const current = await this.repo.lockForUpdate(client, orderId)
      if (!current) {
        await client.query('ROLLBACK')
        throw serviceError('ORDER_NOT_FOUND', 'Order not found', 404)
      }
      this._assertShopScope(current.shop_id, shopId)

      if (!allowedFrom.has(current.status)) {
        await client.query('ROLLBACK')
        throw serviceError(
          ERROR_CODES.ORDER_STATE_INVALID,
          `Cannot transition order from ${current.status} to ${toStatus}`,
          409
        )
      }

      const updated = await this.repo.updateStatusInTx(client, orderId, toStatus)
      await this.repo.insertStatusHistoryInTx(client, {
        orderId,
        fromStatus: current.status,
        toStatus,
        changedBy: actor.id || null,
        note: `Status changed by shop staff via /${toStatus.toLowerCase()}`,
      })

      await emitAuditInTx(client, 'order_status_changed', {
        actor_user_id: actor.id || null,
        actor_role:
          actor.platform_role || actor.shopRole || actor.role || null,
        actor_shop_id: shopId,
        target_type: 'order',
        target_id: orderId,
        before: { status: current.status },
        after: { status: toStatus },
        ip_address: actor.ip || null,
        user_agent: actor.userAgent || null,
      })

      await client.query('COMMIT')

      this._emitSocket('shop_orders.status_changed', {
        shopId,
        orderId,
        fromStatus: current.status,
        toStatus,
      })

      return updated
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore rollback errors */
      }
      throw err
    } finally {
      client.release()
    }
  }

  // ─── R22 AC#8 — Assign rider ────────────────────────────────────

  /**
   * Attach a rider to an order belonging to the caller's shop. Creates
   * a new ASSIGNED row in `delivery_assignments` (mirroring
   * admin/orders/orders.repository.js#assignRider so the rider screen
   * picks up the order through the normal accept flow). Emits a
   * `rider_assigned` audit row inside the same transaction.
   */
  async assignRider(shopId, orderId, riderId, actor) {
    const client = await this.repo.getClient()
    try {
      await client.query('BEGIN')

      const current = await this.repo.lockForUpdate(client, orderId)
      if (!current) {
        await client.query('ROLLBACK')
        throw serviceError('ORDER_NOT_FOUND', 'Order not found', 404)
      }
      this._assertShopScope(current.shop_id, shopId)

      if (!ASSIGN_RIDER_FROM.has(current.status)) {
        await client.query('ROLLBACK')
        throw serviceError(
          ERROR_CODES.ORDER_STATE_INVALID,
          `Cannot assign a rider while order is in ${current.status}`,
          409
        )
      }

      // Cancel any open assignment, then insert a fresh ASSIGNED row.
      // Mirrors admin/orders pattern so the rider's existing accept-flow
      // works without modification.
      await this.repo.cancelOpenAssignmentsInTx(client, orderId)
      const assignment = await this.repo.insertAssignmentInTx(
        client,
        orderId,
        riderId
      )
      const updated = await this.repo.setRiderInTx(client, orderId, riderId)

      await emitAuditInTx(client, 'rider_assigned', {
        actor_user_id: actor.id || null,
        actor_role:
          actor.platform_role || actor.shopRole || actor.role || null,
        actor_shop_id: shopId,
        target_type: 'order',
        target_id: orderId,
        before: { rider_id: current.rider_id || null },
        after: {
          rider_id: riderId,
          assignment_id: assignment?.id || null,
        },
        ip_address: actor.ip || null,
        user_agent: actor.userAgent || null,
      })

      await client.query('COMMIT')

      this._emitSocket('shop_orders.rider_assigned', {
        shopId,
        orderId,
        riderId,
        assignmentId: assignment?.id || null,
      })

      return { order: updated, assignment }
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore rollback errors */
      }
      throw err
    } finally {
      client.release()
    }
  }

  // ─── R22 AC#9, AC#14 — Cancel ───────────────────────────────────

  async cancel(shopId, orderId, reason, actor) {
    const client = await this.repo.getClient()
    try {
      await client.query('BEGIN')

      const current = await this.repo.lockForUpdate(client, orderId)
      if (!current) {
        await client.query('ROLLBACK')
        throw serviceError('ORDER_NOT_FOUND', 'Order not found', 404)
      }
      this._assertShopScope(current.shop_id, shopId)

      if (!CANCELLABLE_FROM.has(current.status)) {
        await client.query('ROLLBACK')
        throw serviceError(
          ERROR_CODES.ORDER_STATE_INVALID,
          `Cannot cancel order in ${current.status}`,
          409
        )
      }

      const updated = await this.repo.updateStatusInTx(
        client,
        orderId,
        'CANCELLED',
        { cancelledReason: reason }
      )
      await this.repo.insertStatusHistoryInTx(client, {
        orderId,
        fromStatus: current.status,
        toStatus: 'CANCELLED',
        changedBy: actor.id || null,
        note: reason,
      })

      // Previously missing entirely — a shop-staff cancel never gave the
      // deducted stock back, so every staff-cancelled order permanently
      // understated real available stock. CANCELLABLE_FROM excludes
      // DELIVERED, so the product never physically left the store and
      // restoring is always correct here. restoreStockForCancelledOrder()
      // never throws (per-item failures are caught and logged internally),
      // so this can't roll back the cancellation itself.
      const { rows: orderItems } = await client.query(
        `SELECT shop_product_id, quantity FROM order_items WHERE order_id = $1`,
        [orderId]
      )
      await this.shopProductsRepo.restoreStockForCancelledOrder(client, {
        orderId,
        items: orderItems,
        source: 'DASHBOARD',
        actor: { userId: actor.id || null, shopRole: actor.shopRole || null },
      })

      await emitAuditInTx(client, 'order_status_changed', {
        actor_user_id: actor.id || null,
        actor_role:
          actor.platform_role || actor.shopRole || actor.role || null,
        actor_shop_id: shopId,
        target_type: 'order',
        target_id: orderId,
        before: {
          status: current.status,
          cancelled_reason: current.cancelled_reason,
        },
        after: { status: 'CANCELLED', cancelled_reason: reason },
        ip_address: actor.ip || null,
        user_agent: actor.userAgent || null,
      })

      await client.query('COMMIT')

      // Cache invalidation happens after COMMIT per applyStockChange()'s
      // contract — every other stock-mutating path does the same, so the
      // shop's Inventory list reflects the restored stock immediately
      // instead of serving a stale cached number for up to CACHE_TTL_SECONDS.
      try {
        await new ShopProductsService(this.shopProductsRepo).invalidateShopCache(shopId)
      } catch (err) {
        logger.warn({ err: err.message, shopId, orderId }, 'Cache invalidation failed after cancel (non-blocking)')
      }

      this._emitSocket('shop_orders.cancelled', {
        shopId,
        orderId,
        fromStatus: current.status,
      })

      return updated
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore rollback errors */
      }
      throw err
    } finally {
      client.release()
    }
  }

  // ─── R22 AC#10, AC#14 — Refund ──────────────────────────────────

  async refund(shopId, orderId, { reason, amount }, actor) {
    const client = await this.repo.getClient()
    try {
      await client.query('BEGIN')

      const current = await this.repo.lockForUpdate(client, orderId)
      if (!current) {
        await client.query('ROLLBACK')
        throw serviceError('ORDER_NOT_FOUND', 'Order not found', 404)
      }
      this._assertShopScope(current.shop_id, shopId)

      if (!REFUNDABLE_FROM.has(current.status)) {
        await client.query('ROLLBACK')
        throw serviceError(
          ERROR_CODES.ORDER_STATE_INVALID,
          `Cannot refund order in ${current.status}`,
          409
        )
      }

      const total = Number(current.total_amount) || 0
      if (amount > total + 0.01) {
        await client.query('ROLLBACK')
        throw serviceError(
          ERROR_CODES.VALIDATION_ERROR,
          'Refund amount cannot exceed order total',
          400
        )
      }

      const updated = await this.repo.updateStatusInTx(
        client,
        orderId,
        'REFUNDED',
        { paymentStatus: 'REFUNDED', cancelledReason: reason }
      )
      await this.repo.insertStatusHistoryInTx(client, {
        orderId,
        fromStatus: current.status,
        toStatus: 'REFUNDED',
        changedBy: actor.id || null,
        note: `Refund ₹${amount.toFixed(2)} — ${reason}`,
      })

      await emitAuditInTx(client, 'order_status_changed', {
        actor_user_id: actor.id || null,
        actor_role:
          actor.platform_role || actor.shopRole || actor.role || null,
        actor_shop_id: shopId,
        target_type: 'order',
        target_id: orderId,
        before: {
          status: current.status,
          payment_status: current.payment_status,
        },
        after: {
          status: 'REFUNDED',
          payment_status: 'REFUNDED',
          refund_amount: amount,
          refund_reason: reason,
        },
        ip_address: actor.ip || null,
        user_agent: actor.userAgent || null,
      })

      await client.query('COMMIT')

      this._emitSocket('shop_orders.refunded', {
        shopId,
        orderId,
        amount,
      })

      return { order: updated, refundAmount: amount, reason }
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore rollback errors */
      }
      throw err
    } finally {
      client.release()
    }
  }

  // ─── R22 AC#11 — Packing slip (HTML) ────────────────────────────

  /**
   * Build a self-contained HTML packing slip suitable for printing from
   * the dashboard. We deliberately avoid a PDF dependency — HTML print
   * works on every browser and keeps the binary footprint small for the
   * 4GB RAM constraint (project-standards.md).
   *
   * @param {string} shopId
   * @param {string} orderId
   * @returns {Promise<string|null>} HTML body or null when not found
   */
  async packingSlipHtml(shopId, orderId) {
    const data = await this.repo.findForPackingSlip(orderId, shopId)
    if (!data) return null
    return renderPackingSlipHtml(data)
  }

  // ─── R22 AC#12 — CSV export ─────────────────────────────────────

  /**
   * Stream a CSV of orders into the supplied writable. Uses the
   * repository's async generator so memory stays bounded by the row
   * formatter, not the full result set.
   *
   * @param {string} shopId
   * @param {object} filters
   * @param {NodeJS.WritableStream} writable
   */
  async streamExportCsv(shopId, filters, writable) {
    const headers = [
      'order_number',
      'created_at',
      'status',
      'payment_status',
      'payment_method',
      'customer_name',
      'customer_phone',
      'subtotal',
      'discount_amount',
      'delivery_fee',
      'tax_amount',
      'total_amount',
      'rider_name',
    ]

    if (!writable.write(headers.join(',') + '\n')) {
      await once(writable, 'drain')
    }

    let count = 0
    for await (const order of this.repo.streamForExport(shopId, filters)) {
      const row = [
        order.orderNumber,
        order.createdAt
          ? new Date(order.createdAt).toISOString()
          : '',
        order.status,
        order.paymentStatus,
        order.paymentMethod,
        order.customerName ?? '',
        order.customerPhone ?? '',
        order.subtotal,
        order.discountAmount,
        order.deliveryFee,
        order.taxAmount,
        order.totalAmount,
        order.riderName ?? '',
      ].map(csvCell)

      if (!writable.write(row.join(',') + '\n')) {
        // Backpressure — wait for drain so we never queue more than a
        // single chunk in the writable's internal buffer.
        await once(writable, 'drain')
      }
      count++
      if (count >= 10000) break // R22 AC#12 hard cap
    }

    return count
  }

  // ─── R25 AC#6 — Currently-assigned riders for shop ──────────────

  /**
   * Paginated list of riders currently engaged on deliveries for the
   * caller's shop.
   */
  async listAssignedRidersForShop(shopId, filters) {
    const page = Math.max(1, Number(filters.page) || 1)
    const limit = Math.min(100, Math.max(1, Number(filters.limit) || 20))
    const offset = (page - 1) * limit

    const { riders, total } = await this.repo.listAssignedRidersForShop(
      shopId,
      { limit, offset }
    )
    return {
      riders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }

  // ─── helpers ─────────────────────────────────────────────────────

  /**
   * Defensive shop-scope check inside the transaction. The route layer
   * already enforces this via `requireShopScope`, but a second check at
   * the service prevents any bug elsewhere from leaking cross-shop data.
   */
  _assertShopScope(orderShopId, requesterShopId) {
    if (!orderShopId || orderShopId !== requesterShopId) {
      throw serviceError(
        ERROR_CODES.CROSS_SHOP_ACCESS_DENIED,
        'Order does not belong to your shop',
        403
      )
    }
  }

  /**
   * Best-effort socket.io fanout. Failures are logged but never propagate
   * — the DB transaction has already committed, so the customer/dashboard
   * eventual-consistency is acceptable.
   */
  _emitSocket(event, payload) {
    if (!this.fastify || !this.fastify.io) return
    try {
      this.fastify.io.to(`shop:${payload.shopId}`).emit(event, payload)
    } catch (err) {
      logger.warn(
        { err: err.message, event, shopId: payload.shopId },
        'shop-orders socket emit failed'
      )
    }
  }
}

// ─── HTML packing slip ─────────────────────────────────────────────

/**
 * Escape a string for safe interpolation into HTML body text. Only the
 * five HTML-significant characters are escaped — sufficient for printable
 * server-rendered output (R22 AC#11).
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtMoney(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '₹0.00'
  return `₹${n.toFixed(2)}`
}

function renderPackingSlipHtml({ order, items, shop }) {
  const addr = order.deliveryAddress || {}
  const lines = items
    .map(
      (it) => `
        <tr>
          <td>${escapeHtml(it.name)}</td>
          <td class="num">${escapeHtml(it.quantity)} ${escapeHtml(
            it.unit ?? ''
          )}</td>
          <td class="num">${fmtMoney(it.price)}</td>
          <td class="num">${fmtMoney(it.total)}</td>
        </tr>`
    )
    .join('')

  const shopHeader = shop
    ? `<div class="shop">
        <strong>${escapeHtml(shop.name)}</strong><br/>
        ${escapeHtml(shop.address || '')}<br/>
        ${escapeHtml([shop.city, shop.state, shop.pincode].filter(Boolean).join(', '))}<br/>
        ${shop.phone ? `Phone: ${escapeHtml(shop.phone)}` : ''}
      </div>`
    : ''

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Packing Slip — ${escapeHtml(order.orderNumber)}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
             color: #111; margin: 24px; }
      h1 { margin: 0 0 8px; font-size: 22px; }
      .meta { color: #555; margin-bottom: 16px; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
      .box { border: 1px solid #ddd; padding: 12px; border-radius: 6px; }
      table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #eee; }
      th { background: #fafafa; font-weight: 600; font-size: 13px; }
      td.num, th.num { text-align: right; }
      .totals { margin-top: 12px; display: flex; justify-content: flex-end; }
      .totals table { width: 280px; }
      .totals td { border: none; padding: 4px 6px; }
      .totals .grand { font-weight: 700; border-top: 2px solid #111; }
      @media print { body { margin: 12px; } }
    </style>
  </head>
  <body>
    <h1>Packing Slip</h1>
    <div class="meta">
      Order <strong>${escapeHtml(order.orderNumber)}</strong>
      &middot; Placed ${escapeHtml(
        order.createdAt ? new Date(order.createdAt).toLocaleString() : ''
      )}
      &middot; Status ${escapeHtml(order.status)}
    </div>
    <div class="grid">
      <div class="box">
        <strong>Ship from</strong>
        ${shopHeader}
      </div>
      <div class="box">
        <strong>Ship to</strong>
        <div>
          ${escapeHtml(order.customerName || '')}<br/>
          ${escapeHtml(addr.addressLine1 || addr.address_line1 || '')}<br/>
          ${escapeHtml(addr.addressLine2 || addr.address_line2 || '')}<br/>
          ${escapeHtml(
            [addr.city, addr.state, addr.pincode].filter(Boolean).join(', ')
          )}<br/>
          ${order.customerPhone ? `Phone: ${escapeHtml(order.customerPhone)}` : ''}
        </div>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Item</th>
          <th class="num">Qty</th>
          <th class="num">Price</th>
          <th class="num">Line total</th>
        </tr>
      </thead>
      <tbody>
        ${lines}
      </tbody>
    </table>

    <div class="totals">
      <table>
        <tr><td>Subtotal</td><td class="num">${fmtMoney(order.subtotal)}</td></tr>
        <tr><td>Discount</td><td class="num">- ${fmtMoney(order.discountAmount)}</td></tr>
        <tr><td>Delivery</td><td class="num">${fmtMoney(order.deliveryFee)}</td></tr>
        <tr><td>Tax</td><td class="num">${fmtMoney(order.taxAmount)}</td></tr>
        <tr class="grand"><td>Total</td><td class="num">${fmtMoney(
          order.totalAmount
        )}</td></tr>
      </table>
    </div>
  </body>
</html>`
}

// ─── CSV / stream helpers ──────────────────────────────────────────

/**
 * Escape a single value for CSV. Wraps in double quotes and doubles any
 * embedded double quotes when the value contains delimiter / newline /
 * quote characters — RFC 4180.
 */
function csvCell(value) {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/**
 * Promise-based wait for a stream `drain` event. Used between writes to
 * apply backpressure when the underlying writable's buffer fills up.
 */
function once(emitter, event) {
  return new Promise((resolve, reject) => {
    const onEvent = (...args) => {
      emitter.removeListener('error', onError)
      resolve(args[0])
    }
    const onError = (err) => {
      emitter.removeListener(event, onEvent)
      reject(err)
    }
    emitter.once(event, onEvent)
    emitter.once('error', onError)
  })
}

// Re-export for tests so they can drive the renderer / state-machine
// constants without touching internals.
export {
  ALLOWED_TRANSITIONS as _ALLOWED_TRANSITIONS,
  CANCELLABLE_FROM as _CANCELLABLE_FROM,
  REFUNDABLE_FROM as _REFUNDABLE_FROM,
  ASSIGN_RIDER_FROM as _ASSIGN_RIDER_FROM,
  renderPackingSlipHtml as _renderPackingSlipHtml,
  csvCell as _csvCell,
}
