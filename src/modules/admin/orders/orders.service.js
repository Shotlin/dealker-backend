import { notificationQueue, orderQueue } from '../../../config/bullmq.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import { generateInvoicePDF, generatePackingSlipPDF } from '../../../utils/invoiceGenerator.js'
import { query as dbQuery, getClient } from '../../../config/database.js'
import { logger } from '../../../config/logger.js'
import { NotificationsRepository } from '../../notifications/notifications.repository.js'
import { NotificationsService } from '../../notifications/notifications.service.js'
import { buildCustomerOrderEventNotification } from '../../notifications/customer-order-event.helper.js'
import { ShopProductsRepository } from '../../shop-products/shop-products.repository.js'
import { ShopProductsService } from '../../shop-products/shop-products.service.js'
import ExcelJS from 'exceljs'

const ASSIGNABLE_ORDER_STATUSES = new Set(['CONFIRMED', 'PREPARING', 'PACKED'])
const INLINE_AUTO_ASSIGN_IN_NON_PROD =
  process.env.AUTO_ASSIGN_INLINE === 'true' ||
  process.env.NODE_ENV !== 'production'

const ALLOWED_TRANSITIONS = {
  // 'ORDER_PLACED' is the REAL status a live mobile order actually has
  // immediately after checkout (orders.service.js#placeOrder writes this,
  // not 'PENDING' — see that module's own status vocabulary, distinct
  // from this one). Before this fix, every freshly-placed order an admin
  // looked at was unconditionally rejected by `updateStatus`/`cancelOrder`
  // ("Cannot transition from ORDER_PLACED to X") because this map had no
  // entry for it at all — the exact same disease already documented for
  // `shop-orders/service.js`'s own ALLOWED_TRANSITIONS. 'PENDING' is kept
  // too since some order-creation paths (e.g. createManualOrder) or older
  // rows may still use it.
  ORDER_PLACED: ['CONFIRMED', 'CANCELLED'],
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['PACKED', 'CANCELLED'],
  PACKED: ['OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: ['REFUNDED'],
  REFUNDED: [],
}

export class AdminOrdersService {
  constructor(repository, fastify) {
    this.repository = repository
    this.fastify = fastify
    this.notificationsService = fastify
      ? new NotificationsService(new NotificationsRepository(), fastify)
      : null
    this.shopProductsRepo = new ShopProductsRepository()
  }

  /**
   * Restore stock for every line item of an order being cancelled
   * pre-delivery (Requirements 23 — CANCELLATION_RESTORE). Best-effort: a
   * restore failure must never block the cancellation response, since the
   * order's CANCELLED status has already committed by the time this runs —
   * but the result IS returned (previously only logged) so the caller can
   * surface a warning instead of silently reporting "Order cancelled" when
   * stock wasn't actually restored (e.g. the listing was deleted between
   * order placement and cancellation).
   *
   * @returns {Promise<{ restoredCount: number, failedItems: Array<{shopProductId: string, productName: string|null, reason: string}> }>}
   */
  async _restoreStockForCancellation(orderId, shopId, adminId) {
    try {
      const items = await this.repository.getOrderItems(orderId)
      const client = await getClient()
      let result
      try {
        await client.query('BEGIN')
        result = await this.shopProductsRepo.restoreStockForCancelledOrder(client, {
          orderId,
          items,
          source: 'DASHBOARD',
          actor: { userId: adminId, shopRole: null },
        })
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
      // Cache invalidation happens after COMMIT per applyStockChange()'s
      // contract — every other stock-mutating path does the same.
      if (shopId) {
        await new ShopProductsService(this.shopProductsRepo).invalidateShopCache(shopId)
      }
      return result
    } catch (err) {
      logger.warn(
        { err: err.message, orderId },
        'Stock restore failed during admin cancellation (non-blocking)'
      )
      return {
        restoredCount: 0,
        failedItems: [{ shopProductId: null, productName: null, reason: err.message }],
      }
    }
  }

  /**
   * Send a customer push/in-app notification, best-effort. Mirrors the
   * working pattern already used by delivery.service.js — the previous
   * `notificationQueue.add('order-status-changed', ...)` calls here were a
   * dead path: the BullMQ notification worker only handles job.data.type
   * values 'push'/'in-app'/'order-status', but these calls never set a
   * `type` field, so every admin-driven order-status/cancel/refund
   * notification silently no-op'd since the feature was first built.
   */
  async _queueNotification(userId, notif) {
    if (!this.notificationsService || !userId || !notif) return
    try {
      await this.notificationsService.sendNotification(userId, notif)
    } catch (err) {
      console.error('Failed to send customer notification:', err?.message || err)
    }
  }

  async findAll(filters) {
    const offset = ((filters.page || 1) - 1) * (filters.limit || 20)
    const result = await this.repository.findAll({ ...filters, offset, limit: filters.limit || 20 })
    return {
      orders: result.orders,
      pagination: {
        page: filters.page || 1,
        limit: filters.limit || 20,
        total: result.total,
        totalPages: Math.ceil(result.total / (filters.limit || 20)),
      },
    }
  }

  async getStatsByStatus() {
    return this.repository.getStatsByStatus()
  }

  async getSettlementSummary(filters) {
    return this.repository.getSettlementSummary(filters)
  }

  /**
   * Fetch an order and, when the caller is scoped to a specific shop
   * (`requestShopId` — resolved by `requireShopScope()`: a shop-staff
   * JWT's own shop, or an HQ user's optional X-Shop-Id header), refuse
   * access if the order belongs to a different shop. `requestShopId` of
   * `null`/`undefined` means "All Shops" (an HQ user with nothing
   * selected) and is never restricted. Every method below that mutates or
   * reads a single order by id calls this right after its own
   * `repository.findById` so a shop-scoped admin can never view or act on
   * another shop's order just by knowing its UUID — never trust a
   * frontend-selected shop id by itself, only what `requireShopScope()`
   * already verified onto the request.
   */
  _assertShopAccess(order, requestShopId) {
    if (requestShopId && order.shop_id && order.shop_id !== requestShopId) {
      throw { statusCode: 403, message: 'This order belongs to a different shop', code: 'CROSS_SHOP_ACCESS_DENIED' }
    }
  }

  async findById(orderId, requestShopId = null) {
    const [order, items, timeline, payment, delivery, settlementHistory, refundRequest] = await Promise.all([
      this.repository.findById(orderId),
      this.repository.getOrderItems(orderId),
      this.repository.getOrderTimeline(orderId),
      this.repository.getOrderPayment(orderId),
      this.repository.getOrderDelivery(orderId),
      this.repository.getSettlementHistory(orderId),
      // Customer-raised refund request (latest) — null when none. Failure here
      // must never take the whole order detail down.
      this._latestRefundRequest(orderId),
    ])
    if (!order) throw { statusCode: 404, message: 'Order not found' }
    this._assertShopAccess(order, requestShopId)
    const qualityEvidence = await this._getQualityEvidence(items)
    return {
      ...order,
      items,
      timeline,
      payment,
      delivery,
      settlement: this._buildSettlementSummary(order, settlementHistory),
      quality_evidence: qualityEvidence,
      refund_request: refundRequest,
    }
  }

  async _latestRefundRequest(orderId) {
    try {
      const { RefundRequestsRepository } = await import('../../refund-requests/refund-requests.repository.js')
      return await new RefundRequestsRepository().findLatestByOrder(orderId)
    } catch {
      return null
    }
  }

  /**
   * The real vendor quality-video trace for this order's items (§7.5) —
   * this is the "Vendor Cutting Evidence" the dashboard's Order Detail
   * drawer has always had a rendering slot for, but which stayed
   * permanently null since the 2026-09-23 Orders rebuild: at that time
   * there was genuinely no backend data model for it (only ever a fake
   * `CuttingEvidencePlayer`, deleted, never fabricated again since). A
   * real one now exists — a vendor's cleaning/packing video, resolved via
   * order_item → inventory_lot allocation → procurement receipt → supply
   * order → vendor — this just wires the admin view to it.
   *
   * Mirrors `orders.service.js#getQualityVideos`'s own primary-lot
   * selection (`findQualityTraceForOrderItems` orders by
   * `quantity_allocated DESC` per item, so the first row seen per
   * order_item_id already is the lot that supplied the largest share of
   * that line) — keep both in sync if either changes.
   */
  /** Meat quality-video evidence removed with the FEFO inventory subsystem. */
  async _getQualityEvidence(items) {
    return []
  }

  /**
   * Manual payment settlement — for an order delivered outside the rider
   * app / online-payment flow, an admin/finance user records that cash or
   * UPI was actually collected. `orders.payment_status` never flips to
   * PAID on its own just because the order reached DELIVERED — see the
   * (deliberately separate) order-status state machine above; a delivered
   * COD order stays PENDING/PARTIALLY_PAID until someone records the real
   * collection here. Every entry is immutable — a mistake is corrected
   * with a REVERSAL entry (see `reverseSettlement`), never an edit/delete.
   */
  _buildSettlementSummary(order, history) {
    const totalPayable = Number(order.total_payable || 0)
    const walletAmount = Number(order.wallet_amount || 0)
    const outstanding = Number((totalPayable - walletAmount).toFixed(2))
    const received = Number(
      history.reduce((sum, e) => sum + (e.entry_type === 'REVERSAL' ? -Number(e.amount) : Number(e.amount)), 0).toFixed(2)
    )
    // An order can already be PAID with zero rows in this table at all —
    // Razorpay online payment (`payments.service.js#completeVerifiedPayment`)
    // and a wallet balance covering the order in full both set
    // `payment_status = 'PAID'` directly, never touching manual
    // settlements. Without this check, `outstanding - received` would show
    // the FULL amount as still due on an already-paid online order (and
    // let an admin "collect" money nobody actually owes) — existing
    // online-paid orders must keep showing ₹0 due, exactly as before.
    const amountDue = order.payment_status === 'PAID'
      ? 0
      : Math.max(0, Number((outstanding - received).toFixed(2)))
    // The most recent entry that actually completed a PAID order — used to
    // show "Settled by / Settled at" in the summary; a reversal or a
    // still-partial history has no such entry, and the panel shows the
    // raw history list instead.
    const completingEntry = order.payment_status === 'PAID'
      ? [...history].reverse().find((e) => e.entry_type === 'SETTLEMENT')
      : null
    return {
      totalPayable,
      walletAmount,
      outstanding,
      received,
      amountDue,
      paymentStatus: order.payment_status,
      history: history.map((e) => ({
        id: e.id,
        entryType: e.entry_type,
        amount: Number(e.amount),
        method: e.method,
        cashAmount: Number(e.cash_amount || 0),
        upiAmount: Number(e.upi_amount || 0),
        reference: e.reference,
        methodNote: e.method_note,
        internalNote: e.internal_note,
        reversesEntryId: e.reverses_entry_id,
        recordedBy: e.recorded_by,
        recordedByName: e.recorded_by_name,
        createdAt: e.created_at,
      })),
      settledBy: completingEntry?.recorded_by_name || null,
      settledAt: completingEntry?.created_at || null,
    }
  }

  async getSettlementInfo(orderId, requestShopId = null) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }
    this._assertShopAccess(order, requestShopId)
    const history = await this.repository.getSettlementHistory(orderId)
    return this._buildSettlementSummary(order, history)
  }

  _deriveSettlementStatus(received, outstanding) {
    if (outstanding <= 0.005) return 'PAID'
    if (received >= outstanding - 0.005) return 'PAID'
    if (received > 0.005) return 'PARTIALLY_PAID'
    return 'PENDING'
  }

  async recordSettlement(orderId, payload, adminUserId, requestShopId = null) {
    const amount = Number(payload.amount)
    const method = String(payload.method || '').toUpperCase()
    const cashAmount = Number(payload.cashAmount || 0)
    const upiAmount = Number(payload.upiAmount || 0)
    const reference = payload.reference?.trim() || null
    const methodNote = payload.methodNote?.trim() || null
    const internalNote = payload.internalNote?.trim() || null

    if (!Number.isFinite(amount) || amount <= 0) {
      throw { statusCode: 400, message: 'Amount received must be greater than 0', code: 'INVALID_AMOUNT' }
    }
    if (!['CASH', 'UPI', 'CASH_UPI', 'OTHER'].includes(method)) {
      throw { statusCode: 400, message: 'Invalid payment method', code: 'INVALID_METHOD' }
    }
    if (method === 'CASH_UPI') {
      if (Number((cashAmount + upiAmount).toFixed(2)) !== Number(amount.toFixed(2))) {
        throw { statusCode: 400, message: 'Cash Amount + UPI Amount must equal the amount received', code: 'SPLIT_MISMATCH' }
      }
    }
    if (method === 'OTHER' && !methodNote) {
      throw { statusCode: 400, message: 'A payment-method note is required for "Other"', code: 'METHOD_NOTE_REQUIRED' }
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const order = await this.repository.findByIdForUpdate(client, orderId)
      if (!order) throw { statusCode: 404, message: 'Order not found' }
      this._assertShopAccess(order, requestShopId)

      if (order.payment_status === 'PAID') {
        throw { statusCode: 400, message: 'This order is already fully paid', code: 'NOTHING_DUE' }
      }

      const totalPayable = Number(order.total_payable || 0)
      const walletAmount = Number(order.wallet_amount || 0)
      const outstanding = Number((totalPayable - walletAmount).toFixed(2))
      const history = await this.repository.getSettlementHistory(orderId, client)
      const receivedSoFar = Number(
        history.reduce((sum, e) => sum + (e.entry_type === 'REVERSAL' ? -Number(e.amount) : Number(e.amount)), 0).toFixed(2)
      )
      const amountDue = Number((outstanding - receivedSoFar).toFixed(2))

      if (amountDue <= 0.005) {
        throw { statusCode: 400, message: 'This order has no outstanding balance to settle', code: 'NOTHING_DUE' }
      }
      // A small epsilon, not zero, so an admin entering the exact due
      // amount (e.g. ₹380.00 against a ₹380.00 balance) isn't rejected by
      // a floating-point rounding artifact.
      if (amount > amountDue + 0.01) {
        throw { statusCode: 400, message: `Amount received (₹${amount}) exceeds the outstanding balance (₹${amountDue})`, code: 'EXCEEDS_OUTSTANDING' }
      }

      const entry = await this.repository.insertSettlementEntry(client, {
        orderId, entryType: 'SETTLEMENT', amount, method, cashAmount, upiAmount,
        reference, methodNote, internalNote, recordedBy: adminUserId,
      })

      const newReceived = Number((receivedSoFar + amount).toFixed(2))
      const newStatus = this._deriveSettlementStatus(newReceived, outstanding)
      await this.repository.setPaymentStatus(client, orderId, newStatus)

      await client.query('COMMIT')

      logAdminActivity(adminUserId, `Recorded payment settlement: ₹${amount} via ${method}`, 'order', orderId,
        { paymentStatus: order.payment_status }, { paymentStatus: newStatus, entryId: entry.id }, null)

      logger.info({ orderId, amount, method, newStatus, adminUserId }, 'Payment settlement recorded')
      const updatedHistory = await this.repository.getSettlementHistory(orderId)
      const updatedOrder = await this.repository.findById(orderId)
      return this._buildSettlementSummary(updatedOrder, updatedHistory)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Corrects a mistaken settlement entry without ever editing/deleting it —
   * inserts a REVERSAL row for the same amount and recomputes
   * `payment_status` downward from there (PAID → PARTIALLY_PAID/PENDING,
   * or PARTIALLY_PAID → PENDING), exactly the same derivation
   * `recordSettlement` uses, just with the entry's amount subtracted
   * instead of added.
   */
  async reverseSettlement(orderId, entryId, reason, adminUserId, requestShopId = null) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const order = await this.repository.findByIdForUpdate(client, orderId)
      if (!order) throw { statusCode: 404, message: 'Order not found' }
      this._assertShopAccess(order, requestShopId)

      const history = await this.repository.getSettlementHistory(orderId, client)
      const original = history.find((e) => e.id === entryId && e.entry_type === 'SETTLEMENT')
      if (!original) {
        throw { statusCode: 404, message: 'Settlement entry not found', code: 'ENTRY_NOT_FOUND' }
      }
      const alreadyReversed = history.some((e) => e.entry_type === 'REVERSAL' && e.reverses_entry_id === entryId)
      if (alreadyReversed) {
        throw { statusCode: 400, message: 'This entry has already been reversed', code: 'ALREADY_REVERSED' }
      }

      const reversal = await this.repository.insertSettlementEntry(client, {
        orderId, entryType: 'REVERSAL', amount: Number(original.amount), method: original.method,
        cashAmount: Number(original.cash_amount || 0), upiAmount: Number(original.upi_amount || 0),
        reference: original.reference, methodNote: original.method_note,
        internalNote: reason?.trim() || `Reversal of settlement ${entryId}`,
        reversesEntryId: entryId, recordedBy: adminUserId,
      })

      const totalPayable = Number(order.total_payable || 0)
      const walletAmount = Number(order.wallet_amount || 0)
      const outstanding = Number((totalPayable - walletAmount).toFixed(2))
      const receivedSoFar = Number(
        history.reduce((sum, e) => sum + (e.entry_type === 'REVERSAL' ? -Number(e.amount) : Number(e.amount)), 0).toFixed(2)
      )
      const newReceived = Number((receivedSoFar - Number(original.amount)).toFixed(2))
      const newStatus = this._deriveSettlementStatus(newReceived, outstanding)
      await this.repository.setPaymentStatus(client, orderId, newStatus)

      await client.query('COMMIT')

      logAdminActivity(adminUserId, `Reversed payment settlement of ₹${original.amount} (${reason || 'no reason given'})`, 'order', orderId,
        { paymentStatus: order.payment_status }, { paymentStatus: newStatus, reversalId: reversal.id }, null)

      logger.info({ orderId, entryId, newStatus, adminUserId }, 'Payment settlement reversed')
      const updatedHistory = await this.repository.getSettlementHistory(orderId)
      const updatedOrder = await this.repository.findById(orderId)
      return this._buildSettlementSummary(updatedOrder, updatedHistory)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async getOrderNotes(orderId, requestShopId = null) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }
    this._assertShopAccess(order, requestShopId)
    return this.repository.getOrderNotes(orderId)
  }

  async addOrderNote(orderId, authorId, body, ip, requestShopId = null) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }
    this._assertShopAccess(order, requestShopId)

    const note = await this.repository.addOrderNote(orderId, authorId, body)

    logAdminActivity(authorId, `Added note to order ${order.order_number}`, 'order', orderId,
      null, { note: body }, ip)

    return note
  }

  async updateStatus(orderId, newStatus, adminId, note, ip, requestShopId = null) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }
    this._assertShopAccess(order, requestShopId)

    const allowed = ALLOWED_TRANSITIONS[order.status]
    if (!allowed || !allowed.includes(newStatus)) {
      throw { statusCode: 400, message: `Cannot transition from ${order.status} to ${newStatus}` }
    }

    const oldStatus = await this.repository.updateStatus(orderId, newStatus, adminId, note)

    logAdminActivity(adminId, `Order status: ${oldStatus} → ${newStatus}`, 'order', orderId,
      { status: oldStatus }, { status: newStatus }, ip)

    // Push/in-app notification to the customer
    await this._queueNotification(order.customer_id, buildCustomerOrderEventNotification({
      orderId, orderNumber: order.order_number, timelineType: newStatus, status: newStatus,
    }))

    this._emitOrderStatus(order, newStatus)

    // AUTO-ASSIGN RIDER when order is CONFIRMED and no rider assigned yet
    if (ASSIGNABLE_ORDER_STATUSES.has(newStatus) && !order.rider_id) {
      try {
        await this._queueAutoAssign(orderId, `ADMIN_STATUS_${newStatus}`)
      } catch (err) {
        // Don't fail the status update — admin can still manually assign
        console.error('Auto-assign failed (non-blocking):', err.message)
      }
    }

    return { orderId, oldStatus, newStatus }
  }

  /**
   * Change an order's scheduled delivery slot after the fact — the
   * mistake-correction path (e.g. store closed unexpectedly and existing
   * pending orders need their promised slot pushed). Not a status
   * transition, so it doesn't go through ALLOWED_TRANSITIONS; instead it's
   * blocked once the order has reached a state where delivery timing is
   * no longer meaningful to change.
   */
  async rescheduleDelivery(orderId, { scheduledSlotStart, scheduledSlotEnd, scheduledSlotLabel, reason }, adminId, ip, requestShopId = null) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }
    this._assertShopAccess(order, requestShopId)

    const TERMINAL_STATUSES = new Set(['OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'REFUNDED'])
    if (TERMINAL_STATUSES.has(order.status)) {
      throw {
        statusCode: 400,
        message: `Cannot reschedule delivery for an order that is ${order.status}`,
      }
    }

    const before = {
      deliveryMode: order.delivery_mode,
      scheduledSlotStart: order.scheduled_slot_start,
      scheduledSlotEnd: order.scheduled_slot_end,
      scheduledSlotLabel: order.scheduled_slot_label,
    }

    const updated = await this.repository.rescheduleDelivery(orderId, {
      scheduledSlotStart,
      scheduledSlotEnd,
      scheduledSlotLabel,
    })

    logAdminActivity(
      adminId,
      `Order delivery rescheduled${reason ? `: ${reason}` : ''}`,
      'order',
      orderId,
      before,
      { deliveryMode: 'SCHEDULED', scheduledSlotStart, scheduledSlotEnd, scheduledSlotLabel },
      ip
    )

    await notificationQueue.add('order-rescheduled', {
      orderId,
      userId: order.customer_id,
      orderNumber: order.order_number,
      scheduledSlotLabel,
    })

    this._emitOrderStatus(order, order.status) // status unchanged — just refresh delivery info

    return updated
  }

  async assignRider(orderId, riderId, adminId, ip, requestShopId = null) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }
    this._assertShopAccess(order, requestShopId)

    const assignment = await this.repository.assignRider(orderId, riderId)

    logAdminActivity(adminId, `Assigned rider to order`, 'order', orderId,
      { rider_id: order.rider_id }, { rider_id: riderId }, ip)

    await notificationQueue.add('rider-assigned', {
      orderId, riderId, orderNumber: order.order_number,
    })

    this._notifyPreviousRider(order, order.rider_id, riderId)
    this._emitAssignedOrder(order, riderId)

    return { orderId, riderId }
  }

  async bulkAssign(assignments, adminId, ip, requestShopId = null) {
    if (assignments.length > 50) throw { statusCode: 400, message: 'Max 50 assignments at once' }

    if (requestShopId) {
      // The bulk repository method has no per-row shop check of its own —
      // verify every order in this batch belongs to the caller's shop
      // BEFORE any of them run, so a shop-scoped request can't slip a
      // foreign order's id into an otherwise-legitimate batch.
      for (const { orderId } of assignments) {
        const order = await this.repository.findById(orderId)
        if (order) this._assertShopAccess(order, requestShopId)
      }
    }

    const previousRiders = new Map()
    for (const { orderId } of assignments) {
      const prev = await this.repository.findById(orderId)
      if (prev) previousRiders.set(orderId, prev)
    }

    const results = await this.repository.bulkAssign(assignments)
    logAdminActivity(adminId, `Bulk assigned ${assignments.length} orders`, 'order', null, null,
      { count: assignments.length }, ip)

    for (const result of results) {
      await notificationQueue.add('rider-assigned', {
        orderId: result.orderId,
        riderId: result.riderId,
      })

      const order = await this.repository.findById(result.orderId)
      const before = previousRiders.get(result.orderId)
      if (before) this._notifyPreviousRider(before, before.rider_id, result.riderId)
      if (order) {
        this._emitAssignedOrder(order, result.riderId)
      }
    }

    return results
  }

  async createManualOrder(data, adminId, ip) {
    const order = await this.repository.createManualOrder({ ...data, adminId })
    logAdminActivity(adminId, `Created manual order ${order.order_number}`, 'order', order.id,
      null, { order_number: order.order_number, total: order.total_payable }, ip)
    if (!order.rider_id && ASSIGNABLE_ORDER_STATUSES.has(order.status)) {
      await this._queueAutoAssign(order.id, 'ADMIN_MANUAL_ORDER')
    }
    return order
  }

  async getInvoice(orderId, requestShopId = null) {
    const order = await this.findById(orderId, requestShopId)
    return generateInvoicePDF(order)
  }

  async getPackingSlip(orderId, requestShopId = null) {
    const order = await this.findById(orderId, requestShopId)
    return generatePackingSlipPDF(order)
  }

  async exportCSV(filters) {
    const orders = await this.repository.getOrdersForExport(filters)
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Orders')

    sheet.columns = [
      { header: 'Order Number', key: 'order_number', width: 20 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Total (₹)', key: 'total_payable', width: 12 },
      { header: 'Payment', key: 'payment_method', width: 12 },
      { header: 'Payment Status', key: 'payment_status', width: 15 },
      { header: 'Customer', key: 'customer', width: 25 },
      { header: 'Phone', key: 'phone', width: 15 },
      { header: 'City', key: 'city', width: 15 },
      { header: 'Date', key: 'created_at', width: 22 },
    ]

    orders.forEach(o => sheet.addRow(o))

    return workbook.csv.writeBuffer()
  }

  /**
   * Refund a delivered/cancelled order. The refund amount is never
   * caller-supplied — it's always exactly what the customer actually paid
   * (from the `payments` row for online orders, or `total_payable` for a
   * COD order marked PAID on delivery — see `delivery.repository.js`'s
   * `payment_status = 'PAID'` write, the single source of truth for
   * "money actually changed hands" across both payment methods). An order
   * that was never paid (e.g. a COD order cancelled before delivery) has
   * nothing to refund and is rejected outright.
   */
  async refundOrder(orderId, { reason, refundTo = 'wallet' }, adminId, ip, requestShopId = null) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }
    this._assertShopAccess(order, requestShopId)

    // Only delivered or cancelled orders can be refunded
    if (!['DELIVERED', 'CANCELLED'].includes(order.status)) {
      throw { statusCode: 400, message: `Cannot refund an order with status ${order.status}` }
    }

    if (order.payment_status !== 'PAID') {
      throw { statusCode: 400, message: 'This order was never paid — there is nothing to refund' }
    }

    // This endpoint's entire purpose is moving money back to the customer —
    // 'none' previously fell through to the bottom of this method anyway,
    // marking the order REFUNDED and sending a "your refund has been
    // processed" push even though ₹0 ever moved. Customers correctly read
    // that as a lie. Cancelling without a refund is a real, valid action —
    // it belongs to cancelOrder()'s refundTo='none' branch, which already
    // skips the order status change and the refund notification entirely.
    if (refundTo === 'none') {
      throw {
        statusCode: 400,
        message: 'Choose a refund destination — this action always refunds money. To cancel the order without a refund, use Cancel Order instead.',
      }
    }

    const payment = await this.repository.getOrderPayment(orderId)
    const paidAmount = payment ? parseFloat(payment.amount) : parseFloat(order.total_payable)
    const hasGatewayPayment = !!(payment && payment.status === 'PAID' && payment.razorpay_payment_id)
    const refundAmount = paidAmount

    if (refundTo === 'original') {
      if (!hasGatewayPayment) {
        throw {
          statusCode: 400,
          message: 'No online payment on this order to refund to the original method — use Wallet instead',
        }
      }
      const { PaymentsService } = await import('../../payments/payments.service.js')
      const { PaymentsRepository } = await import('../../payments/payments.repository.js')
      const result = await new PaymentsService(new PaymentsRepository()).refund(payment.id, {
        reason: reason || `Refund for order ${order.order_number}`,
      })
      if (!result.success) {
        throw { statusCode: 400, message: result.message || 'Refund failed' }
      }
    } else if (refundTo === 'wallet') {
      const { AdminCustomersRepository } = await import('../customers/customers.repository.js')
      const customersRepo = new AdminCustomersRepository()
      await customersRepo.creditWallet(
        order.customer_id,
        refundAmount,
        reason || `Refund for order ${order.order_number}`
      )
    }
    // refundTo === 'none' moves no money — order still gets marked
    // REFUNDED below so it's recorded as closed-out, just with ₹0 back.

    // Update order status to REFUNDED (also true when PaymentsService.refund
    // already flipped it — this call is idempotent and adds the
    // admin-attributed order_status_history row for the audit trail).
    const oldStatus = await this.repository.updateStatus(orderId, 'REFUNDED', adminId, reason || 'Refund issued')

    logAdminActivity(
      adminId,
      `Refund ₹${refundAmount} (${refundTo}) for order ${order.order_number}`,
      'order', orderId,
      { status: oldStatus }, { status: 'REFUNDED', refundTo, refundAmount },
      ip
    )

    const refundDestination = refundTo === 'original' ? 'original payment method' : 'wallet'
    await this._queueNotification(order.customer_id, {
      title: '💰 Refund processed',
      body: refundAmount > 0
        ? `₹${refundAmount} has been refunded to your ${refundDestination} for order ${order.order_number}.`
        : `Your refund for order ${order.order_number} has been processed.`,
      type: 'ORDER_STATUS',
      data: {
        type: 'ORDER_STATUS', orderId, orderNumber: order.order_number,
        timelineType: 'REFUNDED', status: 'REFUNDED', refundAmount, refundTo,
      },
    })

    // Previously missing — unlike updateStatus()/rescheduleDelivery(), this
    // never emitted a Socket.IO order:status event, so the DB/notification
    // were correct but the customer's app kept showing the pre-refund
    // status until the order list/detail was manually refreshed.
    this._emitOrderStatus(order, 'REFUNDED')

    // A customer-raised request still open on this order is now moot.
    try {
      const { RefundRequestsService } = await import('../../refund-requests/refund-requests.service.js')
      await new RefundRequestsService({ fastify: this.fastify }).closeOpenRequestsForDirectRefund(orderId, {
        amount: refundAmount, resolvedBy: adminId, destination: refundTo,
      })
    } catch (err) {
      console.error('Closing open refund requests failed (non-blocking):', err?.message || err)
    }

    return { orderId, refundAmount, refundTo, status: 'REFUNDED' }
  }

  async cancelOrder(orderId, body, adminId, ip, requestShopId = null) {
    const { reason, refundTo } = body || {}
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }
    this._assertShopAccess(order, requestShopId)

    // Treat null status as PENDING
    const currentStatus = order.status || 'PENDING'
    const allowed = ALLOWED_TRANSITIONS[currentStatus]
    if (!allowed || !allowed.includes('CANCELLED')) {
      throw { statusCode: 400, message: `Cannot cancel an order with status ${currentStatus}` }
    }

    // Cancel the order
    const oldStatus = await this.repository.updateStatus(orderId, 'CANCELLED', adminId, reason || 'Cancelled by admin')

    // Previously missing entirely — an admin cancelling an order never gave
    // the deducted stock back, so every admin-cancelled order permanently
    // understated real available stock. CANCELLED is only reachable
    // pre-delivery (never from DELIVERED), so the product never physically
    // left the store and restoring is always correct here.
    const stockRestoreResult = await this._restoreStockForCancellation(orderId, order.shop_id, adminId)

    // Refund only makes sense once money has actually changed hands — most
    // cancellations happen on PENDING/CONFIRMED orders that were never
    // paid (COD, or an online order cancelled before capture), so skip any
    // money movement unless payment_status is actually PAID. Mirrors the
    // same gate as `refundOrder`.
    let refundAmount = 0
    let appliedRefundTo = 'none'
    if (refundTo && refundTo !== 'none' && order.payment_status === 'PAID') {
      const payment = await this.repository.getOrderPayment(orderId)
      const paidAmount = payment ? parseFloat(payment.amount) : parseFloat(order.total_payable)
      const hasGatewayPayment = !!(payment && payment.status === 'PAID' && payment.razorpay_payment_id)

      if (refundTo === 'original' && hasGatewayPayment) {
        const { PaymentsService } = await import('../../payments/payments.service.js')
        const { PaymentsRepository } = await import('../../payments/payments.repository.js')
        const result = await new PaymentsService(new PaymentsRepository()).refund(payment.id, {
          reason: reason || `Refund for cancelled order ${order.order_number}`,
        })
        if (result.success) {
          refundAmount = paidAmount
          appliedRefundTo = 'original'
        }
      } else {
        // 'wallet', or 'original' requested but no gateway payment on file
        // (e.g. COD collected then cancelled) — fall back to wallet credit
        // rather than silently doing nothing.
        const { AdminCustomersRepository } = await import('../customers/customers.repository.js')
        const customersRepo = new AdminCustomersRepository()
        await customersRepo.creditWallet(
          order.customer_id,
          paidAmount,
          reason || `Refund for cancelled order ${order.order_number}`
        )
        refundAmount = paidAmount
        appliedRefundTo = 'wallet'
      }
    }

    logAdminActivity(
      adminId,
      `Cancelled order ${order.order_number}${refundAmount > 0 ? ` (refunded ₹${refundAmount} via ${appliedRefundTo})` : ''}`,
      'order', orderId,
      { status: oldStatus }, { status: 'CANCELLED', refundTo: appliedRefundTo, refundAmount },
      ip
    )

    await this._queueNotification(order.customer_id, buildCustomerOrderEventNotification({
      orderId, orderNumber: order.order_number, timelineType: 'CANCELLED', status: 'CANCELLED',
    }))

    if (refundAmount > 0) {
      const refundDestination = appliedRefundTo === 'original' ? 'original payment method' : 'wallet'
      await this._queueNotification(order.customer_id, {
        title: '💰 Refund processed',
        body: `₹${refundAmount} has been refunded to your ${refundDestination} for order ${order.order_number}.`,
        type: 'ORDER_STATUS',
        data: {
          type: 'ORDER_STATUS', orderId, orderNumber: order.order_number,
          timelineType: 'REFUNDED', status: 'REFUNDED', refundAmount, refundTo: appliedRefundTo,
        },
      })
    }

    // Previously missing — unlike updateStatus()/rescheduleDelivery(), this
    // never emitted a Socket.IO order:status event, so an admin cancelling
    // an order was correct in the DB (a repeat-cancel correctly gets
    // rejected) but the customer's app kept showing the pre-cancel status
    // until they manually refreshed.
    this._emitOrderStatus(order, 'CANCELLED')

    const stockRestoreWarning = stockRestoreResult.failedItems.length > 0
      ? `Stock could not be restored for: ${stockRestoreResult.failedItems
          .map((f) => f.productName || 'an item')
          .join(', ')}. Please check inventory manually.`
      : null

    return {
      orderId,
      status: 'CANCELLED',
      refundAmount,
      refundTo: appliedRefundTo,
      ...(stockRestoreWarning && { stockRestoreWarning }),
    }
  }

  /**
   * "Re-check with Razorpay" — a live, server-to-server reconciliation for
   * one order's payment. Routes through `PaymentsService#reconcileWithRazorpay`
   * (the same shared helper the payment-expiry worker uses), which itself
   * routes any captured payment it finds through the one centralized
   * `completeVerifiedPayment` finalizer — so an admin re-check can never
   * apply a different confirmation cascade than any other path.
   */
  async reconcilePayment(orderId, requestShopId = null) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }
    this._assertShopAccess(order, requestShopId)

    const payment = await this.repository.getOrderPayment(orderId)
    if (!payment || !payment.razorpay_order_id) {
      return { orderId, captured: false, message: 'No online payment on this order to reconcile' }
    }

    const { PaymentsService } = await import('../../payments/payments.service.js')
    const { PaymentsRepository } = await import('../../payments/payments.repository.js')
    const result = await new PaymentsService(new PaymentsRepository(), this.fastify)
      .reconcileWithRazorpay(payment.razorpay_order_id, 'ADMIN_MANUAL_RECONCILE')

    return {
      orderId,
      captured: result.captured,
      needsManualReview: !!result.needsManualReview,
      skipped: !!result.skipped,
      message: result.captured
        ? (result.needsManualReview
          ? 'Razorpay confirms this was captured, but the order already moved on — flagged for manual review'
          : 'Razorpay confirmed a captured payment — order finalized')
        : 'Razorpay shows no captured payment for this order',
    }
  }

  /**
   * Same as `reconcilePayment`, batched — a historical audit tool for
   * sweeping a set of PENDING/FAILED/needs-review orders at once. Capped
   * at 50 per call (mirrors `bulkAssign`'s own cap) and never throws for
   * an individual order's failure — each result is reported independently
   * so one bad order id can't abort the whole batch.
   */
  async bulkReconcilePayments(orderIds, requestShopId = null) {
    if (orderIds.length > 50) throw { statusCode: 400, message: 'Max 50 orders at once' }

    const results = []
    for (const orderId of orderIds) {
      try {
        const result = await this.reconcilePayment(orderId, requestShopId)
        results.push(result)
      } catch (err) {
        results.push({ orderId, captured: false, error: err.message || 'Failed' })
      }
    }
    return results
  }

  /**
   * Live Razorpay payment detail — fetched server-side with our Razorpay
   * secret via `razorpay.payments.fetch`, never exposed to the browser.
   * Only the fields the dashboard actually needs are returned; nothing
   * here is mirrored/cached locally, so it always reflects Razorpay's
   * current record.
   */
  async getRazorpayDetails(orderId, requestShopId = null) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }
    this._assertShopAccess(order, requestShopId)

    const payment = await this.repository.getOrderPayment(orderId)
    if (!payment || !payment.razorpay_payment_id) {
      throw { statusCode: 404, message: 'No Razorpay payment on this order' }
    }

    const { razorpay } = await import('../../../config/razorpay.js')
    if (!razorpay) throw { statusCode: 400, message: 'Razorpay is not configured' }

    let rzpPayment
    try {
      rzpPayment = await razorpay.payments.fetch(payment.razorpay_payment_id)
    } catch (err) {
      logger.error({ err: err.error || err.message, orderId }, 'Live Razorpay payment fetch failed')
      throw { statusCode: 502, message: 'Unable to reach Razorpay right now' }
    }

    return {
      id: rzpPayment.id,
      status: rzpPayment.status,
      method: rzpPayment.method,
      amount: rzpPayment.amount != null ? rzpPayment.amount / 100 : null,
      amountRefunded: rzpPayment.amount_refunded != null ? rzpPayment.amount_refunded / 100 : null,
      refundStatus: rzpPayment.refund_status || null,
      currency: rzpPayment.currency,
      fee: rzpPayment.fee != null ? rzpPayment.fee / 100 : null,
      tax: rzpPayment.tax != null ? rzpPayment.tax / 100 : null,
      international: !!rzpPayment.international,
      email: rzpPayment.email || null,
      contact: rzpPayment.contact || null,
      vpa: rzpPayment.vpa || null,
      bank: rzpPayment.bank || null,
      wallet: rzpPayment.wallet || null,
      card: rzpPayment.card
        ? {
          last4: rzpPayment.card.last4 || null,
          network: rzpPayment.card.network || null,
          type: rzpPayment.card.type || null,
          issuer: rzpPayment.card.issuer || null,
        }
        : null,
      acquirerReference: rzpPayment.acquirer_data?.rrn || rzpPayment.acquirer_data?.arn || null,
      upiTransactionId: rzpPayment.acquirer_data?.upi_transaction_id || null,
      createdAt: rzpPayment.created_at ? new Date(rzpPayment.created_at * 1000).toISOString() : null,
      errorCode: rzpPayment.error_code || null,
      errorDescription: rzpPayment.error_description || null,
      errorReason: rzpPayment.error_reason || null,
      notes: rzpPayment.notes || null,
    }
  }

  async bulkUpdateStatus(orderIds, newStatus, adminId, ip, requestShopId = null) {
    const results = []
    for (const orderId of orderIds) {
      try {
        const res = await this.updateStatus(orderId, newStatus, adminId, null, ip, requestShopId)
        results.push({ orderId, ...res, success: true })
      } catch (err) {
        results.push({ orderId, success: false, message: err.message || 'Failed' })
      }
    }
    return { updated: results.filter(r => r.success).length, results }
  }

  // A reassigned rider's app otherwise keeps the old ACCEPTED order (and its
  // pickup-scan state) forever, since nothing tells it the assignment was cancelled.
  _notifyPreviousRider(order, previousRiderId, newRiderId) {
    try {
      if (!previousRiderId || previousRiderId === newRiderId) return
      this.fastify?.emitOrderUpdate?.(order.id, [previousRiderId], {
        orderId: order.id,
        orderNumber: order.order_number,
        status: 'CANCELLED',
        message: 'Order reassigned to another delivery partner',
      })
    } catch (_) {
      // realtime is best-effort
    }
  }

  async _emitAssignedOrder(order, riderId) {
    try {
      if (!this.fastify?.emitOrderAssignedToRider) {
        return
      }

      // Get store location from app_settings (not hardcoded)
      let storeLat = 0, storeLng = 0
      let storeName = 'Bakaloo Store', storeAddr = 'Pickup location', storePhone = ''
      try {
        const { rows } = await dbQuery(
          `SELECT key, value FROM app_settings WHERE key IN ('store_lat', 'store_lng', 'store_name', 'store_address', 'store_phone')`
        )
        for (const row of rows) {
          const val = typeof row.value === 'string' ? row.value.replace(/^"|"$/g, '') : String(row.value)
          switch (row.key) {
            case 'store_lat': storeLat = parseFloat(val) || 0; break
            case 'store_lng': storeLng = parseFloat(val) || 0; break
            case 'store_name': storeName = val; break
            case 'store_address': storeAddr = val; break
            case 'store_phone': storePhone = val; break
          }
        }
      } catch (_) { /* use defaults if settings not found */ }

      const address = this._parseAddress(order.delivery_address)
      const riderEarning = parseFloat(order.delivery_fee || 25)
      this.fastify.emitOrderAssignedToRider(riderId, {
        orderId: order.id,
        orderNumber: order.order_number,
        status: 'ASSIGNED',
        totalAmount: parseFloat(order.total_payable || 0),
        paymentMethod: order.payment_method || 'ONLINE',
        estimatedDistance: 0,
        estimatedDuration: 0,
        riderEarning,
        offerTimeoutSeconds: 0,
        offerExpiresAt: null,
        isOfferActive: true,
        items: this._parseItems(order.items),
        customerAddress: {
          name: order.customer_name || address.name || 'Customer',
          address: address.address || address.fullAddress || 'Delivery address unavailable',
          landmark: address.landmark || '',
          phone: order.customer_phone || address.phone || '',
          lat: address.lat ?? address.latitude ?? 0,
          lng: address.lng ?? address.longitude ?? 0,
        },
        storeAddress: {
          name: storeName,
          address: storeAddr,
          landmark: '',
          phone: storePhone,
          lat: storeLat,
          lng: storeLng,
        },
      })
    } catch (_) {
      // Keep admin assignment non-blocking if realtime emit fails.
    }
  }

  /**
   * Keep admin flow aligned with worker-based auto-assign.
   */
  async _autoAssignRider(orderId, _order) {
    await this._queueAutoAssign(orderId, 'ADMIN_FALLBACK')
  }

  async _queueAutoAssign(orderId, source) {
    try {
      await orderQueue.add(
        'auto-assign',
        { type: 'auto-assign', orderId, source },
        {
          jobId: `auto-assign-${orderId}`,
          removeOnComplete: true,
        }
      )
      if (INLINE_AUTO_ASSIGN_IN_NON_PROD) {
        await this._runAutoAssignFallback(orderId, `${source}_DEV_INLINE`)
      }
    } catch (err) {
      console.warn('Auto-assign queue failed, running inline fallback:', err?.message || err)
      await this._runAutoAssignFallback(orderId, source)
    }
  }

  async _runAutoAssignFallback(orderId, source) {
    try {
      const { processOrderJob } = await import('../../../workers/processors.js')
      await processOrderJob({
        data: {
          type: 'auto-assign',
          orderId,
          source: `${source}_INLINE_FALLBACK`,
        },
      })
    } catch (fallbackErr) {
      console.error('Inline auto-assign fallback failed:', fallbackErr?.message || fallbackErr)
    }
  }

  _emitOrderStatus(order, status) {
    try {
      if (!this.fastify?.emitOrderUpdate) {
        return
      }

      const userIds = [order.customer_id, order.rider_id].filter(Boolean)
      this.fastify.emitOrderUpdate(order.id, userIds, {
        orderId: order.id,
        orderNumber: order.order_number,
        status,
        timelineType: status,
        shopId: order.shop_id || undefined,
        message: this._statusMessage(status),
      })
    } catch (_) {
      // Keep admin status updates non-blocking if realtime emit fails.
    }
  }

  _statusMessage(status) {
    const messages = {
      CANCELLED: 'Order cancelled by support',
      OUT_FOR_DELIVERY: 'Order is now out for delivery',
      DELIVERED: 'Order delivered successfully',
      REFUNDED: 'Order refund processed',
    }

    return messages[status] || `Order updated to ${status}`
  }

  _parseAddress(value) {
    if (!value) return {}
    if (typeof value === 'string') {
      try {
        return JSON.parse(value)
      } catch (_) {
        return { address: value }
      }
    }
    return value
  }

  _parseItems(value) {
    if (!value) return []
    if (Array.isArray(value)) return value
    if (typeof value === 'string') {
      try {
        return JSON.parse(value)
      } catch (_) {
        return []
      }
    }
    return []
  }
}
