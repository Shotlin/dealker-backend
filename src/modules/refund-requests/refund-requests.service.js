import { logAdminActivity } from '../../utils/activityLogger.js'
import { logger } from '../../config/logger.js'
import { RefundRequestsRepository } from './refund-requests.repository.js'
import { publishOrderStatus, publishRefundStatus } from '../orders/order-events.js'

const RETURN_ELIGIBLE_ORDER_STATUSES = ['DELIVERED']

function fail(message, code, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}

export const REASON_CODES = [
  'PRODUCT_NOT_WORKING', 'SCREEN_DISPLAY', 'BATTERY', 'CAMERA', 'WRONG_PRODUCT', 'DEFECTIVE_DAMAGED', 'OTHER',
]

const money = (n) => Number(Number(n).toFixed(2))

/**
 * Customer-visible shape of a refund request — exactly what the mobile
 * `RefundRequestRemoteDataSource._parseStatus` reads. `PROCESSING` (the
 * transient money-movement claim) is shown as `PENDING`.
 */
export function toCustomerView(row) {
  if (!row) return null
  const status = row.status === 'PROCESSING' ? 'PENDING' : row.status
  const approved = status === 'APPROVED'
  return {
    id: row.id,
    order_id: row.order_id,
    order_number: row.order_number,
    item_scope: row.scope === 'FULL_ORDER' ? 'ALL' : 'SPECIFIC',
    description: row.reason,
    status,
    admin_note: row.admin_notes || null,
    refund_amount: money(approved ? (row.resolved_amount ?? row.computed_amount) : row.computed_amount),
    refund_to: approved ? (row.refund_destination === 'WALLET' ? 'wallet' : 'original') : null,
    items: row.items || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at || null,
    return_number: `RTN${String(row.id).replace(/-/g, '').slice(0, 8).toUpperCase()}`,
    reason_code: row.reason_code || null,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    seller_name: row.shop_name || null,
    refund_reference: approved ? (row.refund_reference || null) : null,
    refunded_at: row.refunded_at || null,
    timeline: customerTimeline(row, status),
  }
}

/** The customer-facing journey, built only from timestamps the row really holds. */
function customerTimeline(row, status) {
  const steps = [{ key: 'REQUESTED', title: 'Return Requested', at: row.created_at }]
  if (status === 'PENDING') steps.push({ key: 'UNDER_REVIEW', title: 'Under Review', at: null, current: true })
  if (status === 'APPROVED') {
    steps.push({ key: 'APPROVED', title: 'Return Approved', at: row.resolved_at })
    steps.push({ key: 'REFUNDED', title: 'Refund Processed', at: row.refunded_at || row.resolved_at })
  }
  if (status === 'REJECTED') steps.push({ key: 'REJECTED', title: 'Return Rejected', at: row.resolved_at })
  if (status === 'CANCELLED') steps.push({ key: 'CANCELLED', title: 'Return Cancelled', at: row.resolved_at })
  return steps
}

/**
 * Refund-request lifecycle shared by the customer app (`/refund-requests`)
 * and the dashboard (`/admin/returns`).
 *
 *   customer create → PENDING → admin approve → PROCESSING (claim) → APPROVED
 *                              → admin reject  → REJECTED
 *                              → customer/admin cancel → CANCELLED
 *
 * Money is only ever moved by `approve`, behind an atomic PENDING→PROCESSING
 * claim, and the amount is always server-computed from the real order.
 */
export class RefundRequestsService {
  constructor({ repository, fastify, notifier, paymentsService, adminOrdersRepo, customersRepo } = {}) {
    this.repo = repository || new RefundRequestsRepository()
    this.fastify = fastify || null
    this.notifier = notifier || null
    this._paymentsService = paymentsService || null
    this._adminOrdersRepo = adminOrdersRepo || null
    this._customersRepo = customersRepo || null
  }

  async #payments() {
    if (!this._paymentsService) {
      const [{ PaymentsService }, { PaymentsRepository }] = await Promise.all([
        import('../payments/payments.service.js'),
        import('../payments/payments.repository.js'),
      ])
      this._paymentsService = new PaymentsService(new PaymentsRepository())
    }
    return this._paymentsService
  }

  async #adminOrders() {
    if (!this._adminOrdersRepo) {
      const { AdminOrdersRepository } = await import('../admin/orders/orders.repository.js')
      this._adminOrdersRepo = new AdminOrdersRepository()
    }
    return this._adminOrdersRepo
  }

  async #customers() {
    if (!this._customersRepo) {
      const { AdminCustomersRepository } = await import('../admin/customers/customers.repository.js')
      this._customersRepo = new AdminCustomersRepository()
    }
    return this._customersRepo
  }

  /** A shop-scoped caller may only touch their own shop's requests. */
  assertShopAccess(request, requestShopId) {
    if (requestShopId && request.shop_id && request.shop_id !== requestShopId) {
      throw fail('This refund request belongs to a different shop', 'CROSS_SHOP_ACCESS_DENIED', 403)
    }
  }

  // ─── Reads ──────────────────────────────────────────────────────────

  async list(filters) {
    const { rows, total } = await this.repo.findAll(filters)
    const page = filters.page || 1
    const limit = filters.limit || 20
    return { rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } }
  }

  async getDetail(id, requestShopId = null) {
    const row = await this.repo.findById(id)
    if (!row) return null
    this.assertShopAccess(row, requestShopId)
    return row
  }

  async getForCustomerByOrder(orderId, customerId) {
    return toCustomerView(await this.repo.findLatestByOrder(orderId, customerId))
  }

  // ─── Create ─────────────────────────────────────────────────────────

  /**
   * Resolve which order lines a request covers and what they are worth.
   * Lines come from the real `order_items` rows; the client only names
   * products, never amounts.
   */
  async #resolveLines(order, items, { itemScope, productIds, itemIndexes }) {
    const total = money(order.total_payable)
    if (itemScope === 'ALL') {
      return { scope: 'FULL_ORDER', lines: null, amount: total }
    }

    let picked
    if (Array.isArray(productIds) && productIds.length) {
      const wanted = new Set(productIds.map(String))
      picked = items.filter((it) => wanted.has(String(it.product_id)))
      if (picked.length !== wanted.size) {
        throw fail('One or more selected items are not part of this order', 'INVALID_REFUND_ITEMS')
      }
    } else if (Array.isArray(itemIndexes) && itemIndexes.length) {
      picked = [...new Set(itemIndexes)].map((i) => items[i])
      if (picked.some((it) => !it)) {
        throw fail('One or more selected items are not part of this order', 'INVALID_REFUND_ITEMS')
      }
    } else {
      throw fail('Select at least one item, or mark the whole order', 'REFUND_ITEMS_REQUIRED')
    }

    const lines = picked.map((it) => {
      const snap = typeof it.product_snapshot === 'string'
        ? JSON.parse(it.product_snapshot || '{}') : (it.product_snapshot || {})
      const quantity = Number(it.quantity)
      const lineTotal = money(snap.total ?? it.subtotal ?? Number(it.unit_price) * quantity)
      return {
        orderItemId: it.id,
        productId: it.product_id,
        name: snap.name || it.product_name,
        quantity,
        unitPrice: money(snap.price ?? it.unit_price),
        lineTotal,
      }
    })
    // Ticking every line is the same as a full-order request.
    const sum = money(lines.reduce((a, l) => a + l.lineTotal, 0))
    if (lines.length === items.length) {
      return { scope: 'FULL_ORDER', lines: null, amount: total }
    }
    return { scope: 'ITEMS', lines, amount: Math.min(sum, total) }
  }

  async #defaultDestination(orderId) {
    const payment = await this.repo.findPaymentForOrder(orderId)
    return payment && payment.status === 'PAID' && payment.razorpay_payment_id ? 'RAZORPAY' : 'WALLET'
  }

  /**
   * @param {{orderId, itemScope, description, productIds?, itemIndexes?, refundDestination?, adminNotes?}} input
   * @param {{userId: string, role: 'CUSTOMER'|'ADMIN', ip?: string}} actor
   */
  async create(input, actor) {
    const order = await this.repo.findOrderForRefund(input.orderId)
    // A customer must never learn another customer's order exists.
    if (!order || (actor.role === 'CUSTOMER' && order.customer_id !== actor.userId)) {
      throw fail('Order not found', 'ORDER_NOT_FOUND', 404)
    }
    if (actor.role === 'ADMIN') this.assertShopAccess({ shop_id: order.shop_id }, actor.shopId)
    if (!RETURN_ELIGIBLE_ORDER_STATUSES.includes(order.status)) {
      throw fail(
        `Refunds can only be requested for delivered orders (this one is ${order.status}).`,
        'ORDER_NOT_REFUNDABLE'
      )
    }
    const existing = await this.repo.hasBlockingRequest(order.id)
    if (existing) {
      throw fail('A refund request already exists for this order.', 'REFUND_REQUEST_EXISTS', 409)
    }

    const items = await this.repo.findOrderItems(order.id)
    const { scope, lines, amount } = await this.#resolveLines(order, items, input)
    const destination = input.refundDestination || await this.#defaultDestination(order.id)

    let created
    try {
      created = await this.repo.create({
        orderId: order.id,
        customerId: order.customer_id,
        shopId: order.shop_id,
        scope,
        items: lines,
        reason: input.description,
        reasonCode: input.reasonCode,
        evidence: input.evidence,
        refundDestination: destination,
        computedAmount: amount.toFixed(2),
        adminNotes: input.adminNotes,
        requestedBy: actor.userId,
        source: actor.role === 'CUSTOMER' ? 'CUSTOMER' : 'ADMIN',
      })
    } catch (err) {
      // Lost a race against the partial-unique "one open request per order" index.
      if (err?.code === '23505') {
        throw fail('A refund request already exists for this order.', 'REFUND_REQUEST_EXISTS', 409)
      }
      throw err
    }

    const row = await this.repo.findById(created.id)
    if (actor.role === 'ADMIN') {
      logAdminActivity(actor.userId, 'CREATE_RETURN_REQUEST', 'refund_request', created.id, null, created, actor.ip)
    }
    publishRefundStatus(row, { io: this.fastify?.io, event: 'REFUND_REQUESTED' })
    return row
  }

  // ─── Resolve ────────────────────────────────────────────────────────

  async cancel(id, actor) {
    let row
    if (actor.role === 'CUSTOMER') {
      row = await this.repo.cancelByCustomer(id, actor.userId)
      if (!row) {
        const current = await this.repo.findById(id)
        if (!current || current.customer_id !== actor.userId) throw fail('Refund request not found', 'NOT_FOUND', 404)
        throw fail(`Only a pending request can be cancelled (this one is ${current.status.toLowerCase()}).`, 'REFUND_NOT_CANCELLABLE', 409)
      }
    } else {
      const current = await this.getDetail(id, actor.shopId)
      if (!current) throw fail('Return request not found', 'NOT_FOUND', 404)
      if (current.status !== 'PENDING') {
        throw fail(`Only PENDING requests can be cancelled (this one is ${current.status})`, 'REFUND_NOT_CANCELLABLE', 409)
      }
      row = await this.repo.finalize(id, {
        status: 'CANCELLED', resolvedAmount: null, resolvedBy: actor.userId, adminNotes: actor.adminNotes,
      })
      if (!row) throw fail('This request is already being processed', 'REFUND_NOT_CANCELLABLE', 409)
      logAdminActivity(actor.userId, 'CANCEL_RETURN_REQUEST', 'refund_request', id, current, row, actor.ip)
    }
    const full = await this.repo.findById(id)
    publishRefundStatus(full, { io: this.fastify?.io, event: 'REFUND_CANCELLED' })
    return full
  }

  async reject(id, actor) {
    const current = await this.getDetail(id, actor.shopId)
    if (!current) throw fail('Return request not found', 'NOT_FOUND', 404)
    if (current.status !== 'PENDING') {
      throw fail(`Only PENDING requests can be rejected (this one is ${current.status})`, 'REFUND_NOT_PENDING', 409)
    }
    const row = await this.repo.finalize(id, {
      status: 'REJECTED', resolvedAmount: null, resolvedBy: actor.userId, adminNotes: actor.adminNotes,
    })
    if (!row) throw fail('This request is already being processed', 'REFUND_NOT_PENDING', 409)
    logAdminActivity(actor.userId, 'REJECT_RETURN_REQUEST', 'refund_request', id, current, row, actor.ip)

    const full = await this.repo.findById(id)
    publishRefundStatus(full, { io: this.fastify?.io, event: 'REFUND_REJECTED' })
    await this.#notifyCustomer(full, {
      title: 'Refund request update',
      body: `Your refund request for order ${full.order_number} was not approved.${full.admin_notes ? ` ${full.admin_notes}` : ''}`,
    })
    return full
  }

  /**
   * Approve = actually refund. `refundTo` ('WALLET'|'RAZORPAY') lets the
   * reviewer override the default destination chosen at request time.
   */
  async approve(id, actor) {
    const current = await this.getDetail(id, actor.shopId)
    if (!current) throw fail('Return request not found', 'NOT_FOUND', 404)
    if (current.status !== 'PENDING') {
      throw fail(`Only PENDING requests can be approved (this one is ${current.status})`, 'REFUND_NOT_PENDING', 409)
    }
    const destination = actor.refundTo || current.refund_destination

    // Everything that can be rejected for a business reason is checked
    // BEFORE the claim, so a plain validation failure never flips state.
    const order = await this.repo.findOrderForRefund(current.order_id)
    if (!order || !RETURN_ELIGIBLE_ORDER_STATUSES.includes(order.status)) {
      throw fail('The order is no longer in a refundable state', 'ORDER_NOT_REFUNDABLE')
    }
    if (order.payment_status !== 'PAID') {
      throw fail(
        'This order was never marked paid — record the payment settlement first, or reject the request.',
        'ORDER_NOT_PAID'
      )
    }
    const payment = await this.repo.findPaymentForOrder(order.id)
    if (destination === 'RAZORPAY' && !(payment && payment.status === 'PAID' && payment.razorpay_payment_id)) {
      throw fail('No online payment on this order to refund to the original method — refund to Wallet instead.', 'NO_GATEWAY_PAYMENT')
    }

    const claimed = await this.repo.claimForProcessing(id, destination)
    if (!claimed) throw fail('This request is already being processed', 'REFUND_NOT_PENDING', 409)

    const amount = money(claimed.computed_amount)
    const isFull = claimed.scope === 'FULL_ORDER'
    let reference = null
    try {
      if (destination === 'RAZORPAY') {
        const result = await (await this.#payments()).refund(payment.id, {
          amount,
          reason: `Refund request ${claimed.id}: ${claimed.reason}`.slice(0, 250),
          markOrderRefunded: false, // order status is set below, with audit history
        })
        if (!result.success) throw fail(result.message || 'Razorpay refund failed', 'GATEWAY_REFUND_FAILED')
        reference = result.refundId || null
      } else {
        await (await this.#customers()).creditWallet(
          claimed.customer_id,
          amount,
          `Refund for order ${order.order_number} (request ${claimed.id})`
        )
        reference = `wallet:${claimed.id}`
      }
    } catch (err) {
      await this.repo.releaseClaim(id, err.message)
      throw err.statusCode ? err : fail(err.message || 'Refund failed', 'REFUND_FAILED')
    }

    // Money has moved — record it IMMEDIATELY; a failure past this point
    // must never put the request back to PENDING (it would be refunded twice).
    const finalizeArgs = {
      status: 'APPROVED', resolvedAmount: amount, resolvedBy: actor.userId,
      adminNotes: actor.adminNotes, refundReference: reference,
    }
    let resolved = null
    for (let attempt = 1; attempt <= 3 && !resolved; attempt++) {
      try {
        resolved = await this.repo.finalize(id, finalizeArgs)
        break
      } catch (err) {
        logger.error({ err: err?.message, id, reference, attempt }, 'Refund money moved but finalize failed — retrying')
      }
    }
    if (!resolved) {
      logger.error({ id, reference }, 'Refund money moved but request could not be finalized — reconcile manually')
    }

    if (isFull) {
      try {
        await (await this.#adminOrders()).updateStatus(order.id, 'REFUNDED', actor.userId, `Refund request ${id} approved`)
        publishOrderStatus({ ...order, rider_id: null }, 'REFUNDED', {
          message: 'Order refund processed', io: this.fastify?.io,
        })
      } catch (err) {
        logger.error({ err: err?.message, orderId: order.id }, 'Refund paid but order status flip failed')
      }
    }

    logAdminActivity(actor.userId, 'APPROVE_RETURN_REQUEST', 'refund_request', id, current, resolved, actor.ip)
    const full = await this.repo.findById(id)
    publishRefundStatus(full, { io: this.fastify?.io, event: 'REFUND_APPROVED' })
    await this.#notifyCustomer(full, {
      title: '💰 Refund approved',
      body: `₹${amount} ${destination === 'WALLET' ? 'was added to your FreshCuts wallet' : 'is being refunded to your original payment method'} for order ${full.order_number}.`,
      // Wallet balance changed too — mobile's wallet refresh keys off type.
      type: 'ORDER_STATUS',
    })
    return full
  }

  /** Called by the order drawer's direct "Process Refund" — see repository. */
  async closeOpenRequestsForDirectRefund(orderId, { amount, resolvedBy, destination }) {
    const ids = await this.repo.resolvePendingForOrder(orderId, {
      amount, resolvedBy,
      destination: destination === 'original' ? 'RAZORPAY' : 'WALLET',
      note: 'Resolved by a direct order refund',
    })
    for (const id of ids) {
      const row = await this.repo.findById(id)
      publishRefundStatus(row, { io: this.fastify?.io, event: 'REFUND_APPROVED' })
    }
    return ids
  }

  async #notifyCustomer(row, { title, body, type = 'ORDER_STATUS' }) {
    if (!this.notifier) return
    try {
      await this.notifier.sendNotification(row.customer_id, {
        title,
        body,
        type,
        // No `timelineType`: this is a refund-request update, not an order
        // lifecycle stage, so it bypasses the per-stage notification settings.
        data: {
          type,
          orderId: row.order_id,
          orderNumber: row.order_number,
          refundRequestId: row.id,
          refundStatus: row.status === 'PROCESSING' ? 'PENDING' : row.status,
        },
      })
    } catch (err) {
      logger.warn({ err: err?.message, refundId: row.id }, 'Refund customer notification failed (non-blocking)')
    }
  }
}
