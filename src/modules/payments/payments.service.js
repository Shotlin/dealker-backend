import crypto from 'node:crypto'
import RazorpaySdk from 'razorpay'
import { logger } from '../../config/logger.js'
import { razorpay, getRazorpayKeyId, getRazorpayKeySecret, getRazorpayWebhookSecret } from '../../config/razorpay.js'
import { orderQueue } from '../../config/bullmq.js'
import { getClient } from '../../config/database.js'
import { getOffsetLimit, buildPagination } from '../../utils/paginate.js'
import { OrdersRepository } from '../orders/orders.repository.js'
import { PaymentSettingsService } from '../payment-settings/payment-settings.service.js'
import { WalletService } from '../wallet/wallet.service.js'
import { WalletRepository } from '../wallet/wallet.repository.js'

const INLINE_AUTO_ASSIGN_IN_NON_PROD =
  process.env.AUTO_ASSIGN_INLINE === 'true' ||
  process.env.NODE_ENV !== 'production'

/**
 * Payments service — Razorpay integration + payment management
 */
export class PaymentsService {
  constructor(repository, fastify = null) {
    this.fastify = fastify
    this.repo = repository
    this.ordersRepo = new OrdersRepository()
    this.paymentSettingsService = new PaymentSettingsService()
    this.walletRepo = new WalletRepository()
    this.walletService = new WalletService(this.walletRepo)
  }

  /**
   * A partial wallet + ONLINE order never debits the wallet at order-
   * creation time (see orders.service.js#placeOrder's doc comment) — it
   * stays a pending `wallet_amount` on the order row until payment is
   * actually confirmed, right here. `claimWalletDebit` is the atomic
   * false→true claim on `wallet_debited`, so whichever of verifyPayment()
   * or the Razorpay webhook gets here first is the only one that ever
   * touches the wallet — the loser sees nothing to claim and returns.
   */
  async _settleWalletIfPending(orderId) {
    const claim = await this.ordersRepo.claimWalletDebit(orderId)
    if (!claim) return

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const wallet = await this.walletRepo.getForUpdate(client, claim.customer_id)
      if (!wallet || Number(wallet.balance) < Number(claim.wallet_amount)) {
        // Shouldn't normally happen (the balance was already checked at
        // order-creation time) — but a payment confirmation must never
        // crash on a wallet shortfall. wallet_debited is already claimed
        // above, so this never retries; log it for manual reconciliation.
        await client.query('ROLLBACK')
        logger.error(
          { orderId, walletAmount: claim.wallet_amount },
          'Deferred wallet debit skipped — insufficient balance at payment confirmation'
        )
        return
      }
      await this.walletRepo.debit(
        client, wallet.id, Number(claim.wallet_amount),
        `Payment for order ${claim.order_number}`, orderId, { orderId }
      )
      await client.query('COMMIT')
      logger.info({ orderId, amount: claim.wallet_amount }, 'Deferred wallet debit settled after payment confirmation')
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, orderId }, 'Deferred wallet debit failed')
    } finally {
      client.release()
    }
  }

  /**
   * Create a Razorpay order for an existing app order
   */
  async createPaymentOrder(userId, orderId) {
    if (!razorpay) {
      return { success: false, message: 'Online payments are not configured' }
    }

    const { razorpayEnabled } = await this.paymentSettingsService.getConfig()
    if (!razorpayEnabled) {
      return { success: false, message: 'Online payment is currently unavailable.' }
    }

    const order = await this.ordersRepo.findByIdAndUser(orderId, userId)
    if (!order) {
      return { success: false, message: 'Order not found' }
    }

    if (order.paymentMethod !== 'ONLINE') {
      return { success: false, message: 'Order is not set for online payment' }
    }

    if (order.paymentStatus === 'PAID') {
      return { success: false, message: 'Order is already paid' }
    }

    // Check if payment record already exists
    const existing = await this.repo.findByOrderId(orderId)
    if (existing && existing.status === 'PAID') {
      return { success: false, message: 'Payment already completed' }
    }

    // Create Razorpay order. The razorpay SDK throws errors carrying a
    // `statusCode` mirrored from Razorpay's own API response (e.g. 401
    // when our API credentials are rejected) — left uncaught, that
    // error reaches the global error handler, which forwards
    // `error.statusCode` verbatim (errorHandler.plugin.js). A 401 from
    // Razorpay would then look identical to the customer's own session
    // being invalid, sending them on a wild goose chase re-logging in
    // for a problem that's actually on our Razorpay account config.
    // Catching here keeps upstream provider failures mapped to this
    // module's normal `{ success: false }` contract (→ HTTP 400).
    let rzpOrder
    try {
      rzpOrder = await razorpay.orders.create({
        amount: Math.round(order.totalAmount * 100), // paise
        currency: 'INR',
        receipt: order.orderNumber,
        notes: {
          orderId: order.id,
          userId,
        },
      })
    } catch (err) {
      logger.error(
        { err: err.error || err.message, statusCode: err.statusCode, orderId },
        'Razorpay order creation failed'
      )
      return { success: false, message: 'Unable to start online payment right now. Please try again shortly.' }
    }

    // Payment expires in 15 minutes — after this the cleanup worker will
    // cancel the order and release any reserved stock.
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000)

    // Save payment record
    const payment = await this.repo.create({
      orderId: order.id,
      userId,
      razorpayOrderId: rzpOrder.id,
      amount: order.totalAmount,
      currency: 'INR',
      status: 'PENDING',
      expiresAt,
      metadata: { receipt: order.orderNumber },
    })

    // Update the order with payment expiry so the cleanup worker can find it
    await this.ordersRepo.updateStatus(order.id, undefined, {
      paymentExpiresAt: expiresAt,
    })

    logger.info(
      { paymentId: payment.id, razorpayOrderId: rzpOrder.id, orderId },
      'Razorpay payment order created'
    )

    return {
      success: true,
      data: {
        paymentId: payment.id,
        razorpayOrderId: rzpOrder.id,
        amount: order.totalAmount,
        currency: 'INR',
        keyId: getRazorpayKeyId(),
      },
    }
  }

  /**
   * Verify payment signature from Razorpay client-side callback. This is
   * one of several callers of `completeVerifiedPayment` — see that
   * method's doc comment for why it's the only place any of them actually
   * touches the DB.
   */
  async verifyPayment(userId, { razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
    const payment = await this.repo.findByRazorpayOrderId(razorpayOrderId)
    if (!payment) {
      return { success: false, message: 'Payment record not found' }
    }

    if (payment.userId !== userId) {
      return { success: false, message: 'Unauthorized' }
    }

    // HMAC-SHA256 verification of the CLIENT callback's own signature
    // (`orderId|paymentId` signed with the key secret) — a different,
    // narrower check than the WEBHOOK's signature (§handleWebhook), which
    // Razorpay computes over the entire raw request body with the webhook
    // secret. Both are real, required checks; neither substitutes for the
    // other.
    const expectedSignature = crypto
      .createHmac('sha256', getRazorpayKeySecret())
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex')

    if (expectedSignature !== razorpaySignature) {
      logger.warn({ razorpayOrderId }, 'Payment signature verification failed')

      // A failed CLIENT-side signature check is not proof the payment
      // itself failed at Razorpay — a tampered/malformed callback and a
      // genuinely declined payment look identical from here. Reconcile
      // with Razorpay directly rather than trusting the client at all:
      // if Razorpay shows a real captured payment, finalize it for real;
      // only mark FAILED once Razorpay itself has no captured payment.
      try {
        const reconciled = await this.reconcileWithRazorpay(razorpayOrderId, 'VERIFY_SIGNATURE_MISMATCH')
        if (reconciled.captured) {
          return reconciled
        }
      } catch (err) {
        logger.warn({ err: err.message, razorpayOrderId }, 'Reconciliation after signature mismatch failed — leaving payment PENDING rather than guessing FAILED')
        return { success: false, message: 'Payment verification failed' }
      }

      if (payment.status === 'PENDING') {
        await this.repo.updatePayment(payment.id, { status: 'FAILED' })
        await this.ordersRepo.updateStatus(payment.orderId, undefined, {
          paymentStatus: 'FAILED',
        })
      }

      return { success: false, message: 'Payment verification failed' }
    }

    return this.completeVerifiedPayment(razorpayOrderId, {
      razorpayPaymentId,
      razorpaySignature,
      source: 'PAYMENT_VERIFY',
    })
  }

  /**
   * The ONE authoritative, idempotent payment-finalization path. Every
   * caller that might mark a payment PAID and confirm its order —
   * `verifyPayment` (client callback), `handleWebhook`'s
   * payment.authorized/order.paid/payment.captured cases,
   * `reconcileWithRazorpay` (used by the admin single/bulk re-check
   * endpoints and the payment-expiry worker's pre-expiry + failed-recovery
   * sweeps) — routes through here instead of repeating the confirmation
   * cascade itself. Previously `verifyPayment` and the webhook's
   * `payment.captured` handler each independently reimplemented the same
   * ~10-step sequence (mark paid → confirm order → settle wallet → queue
   * auto-assign → cashback → clear cart → coupon usage → notify), which is
   * exactly the kind of duplication that lets two copies quietly drift out
   * of sync — the client-verify path had cart-clear/notification logic the
   * webhook path never got, for instance.
   *
   * Idempotency: `SELECT ... FOR UPDATE` row-locks the `payments` row by
   * `razorpay_order_id` inside one transaction, then compares `status`.
   * Two racing finalizers (e.g. the client's `/verify` call and the
   * webhook's `payment.captured` event arriving within milliseconds of
   * each other) serialize on that lock — whichever acquires it second sees
   * the first one's already-committed `status = 'PAID'` and returns
   * `{ skipped: true }` without touching anything else.
   *
   * `allowRecoveryFromFailed: true` is the ONLY way a `FAILED` payment can
   * ever become `PAID` again here (used by the payment-expiry worker's
   * recently-failed sweep and, on this codebase's behalf, by
   * `verifyPayment`'s own signature-mismatch path via `reconcileWithRazorpay`
   * once it independently confirms a real capture) — an ordinary caller
   * can never casually resurrect a declined payment.
   *
   * If the order has already moved on from `ORDER_PLACED` by the time this
   * runs (almost always: a customer or admin cancelled it, and its stock
   * was already restored) the payment is still marked `PAID` — money
   * genuinely moved, that must never be hidden — but `needs_manual_review`
   * is set and NONE of the confirmation cascade runs: no auto-assign, no
   * cart clear, no notification claiming the order is confirmed. A human
   * decides from the dashboard whether to re-confirm (if stock allows) or
   * refund.
   */
  async completeVerifiedPayment(razorpayOrderId, {
    razorpayPaymentId,
    razorpaySignature = null,
    method = null,
    source = 'PAYMENT_VERIFY',
    allowRecoveryFromFailed = false,
  } = {}) {
    const client = await getClient()
    let outcome
    try {
      await client.query('BEGIN')

      const payment = await this.repo.findByRazorpayOrderIdForUpdate(client, razorpayOrderId)
      if (!payment) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Payment record not found' }
      }

      if (payment.status === 'PAID') {
        await client.query('ROLLBACK')
        return { success: true, skipped: true, payment }
      }

      const wasRecoveredFromFailed = allowRecoveryFromFailed && payment.status === 'FAILED'
      if (payment.status !== 'PENDING' && !wasRecoveredFromFailed) {
        await client.query('ROLLBACK')
        return { success: false, message: `Payment is ${payment.status}, cannot finalize` }
      }

      const order = await this.ordersRepo.findByIdForUpdate(client, payment.orderId)
      if (!order) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Order not found' }
      }

      // 'ORDER_PLACED' is the real, live status `placeOrder` writes for an
      // order still awaiting payment confirmation (see
      // orders.service.js#placeOrder) — NOT 'PENDING', which belongs to a
      // different status vocabulary used elsewhere in this codebase
      // (constants/orderStatus.js / admin/orders' state machine). Anything
      // else here (CANCELLED by the customer or the expiry worker,
      // already CONFIRMED by a racing finalizer that somehow got past the
      // payment-status check above, etc.) means the order moved on without
      // this payment.
      const orderStillConfirmable = order.status === 'ORDER_PLACED'

      if (!orderStillConfirmable) {
        const reviewReason = wasRecoveredFromFailed
          ? 'recovered_from_failed_but_order_moved_on'
          : 'captured_after_order_moved_on'
        const updated = await this.repo.updatePayment(payment.id, {
          razorpayPaymentId: razorpayPaymentId || null,
          razorpaySignature,
          method,
          status: 'PAID',
          needsManualReview: true,
          recoveredFromFailed: wasRecoveredFromFailed,
          reviewReason,
        }, client)
        await client.query('COMMIT')

        logger.warn(
          { paymentId: payment.id, orderId: order.id, orderStatus: order.status, reviewReason },
          'Payment captured but order already moved on — flagged for manual review, confirmation cascade skipped'
        )

        try {
          this.fastify?.emitDashboardPayment?.({
            orderId: order.id,
            orderNumber: order.order_number,
            orderStatus: order.status,
            amount: updated.amount,
            needsManualReview: true,
            recoveredFromFailed: wasRecoveredFromFailed,
            reviewReason,
          })
        } catch (_) { /* live-update is best-effort */ }

        return { success: true, needsManualReview: true, payment: updated }
      }

      const updated = await this.repo.updatePayment(payment.id, {
        razorpayPaymentId: razorpayPaymentId || null,
        razorpaySignature,
        method,
        status: 'PAID',
        recoveredFromFailed: wasRecoveredFromFailed,
      }, client)
      await this.ordersRepo.updateStatus(order.id, 'CONFIRMED', { paymentStatus: 'PAID' }, client)

      await client.query('COMMIT')
      outcome = { success: true, payment: updated, order, userId: payment.userId, wasRecoveredFromFailed }
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err: err.message, razorpayOrderId }, 'completeVerifiedPayment transaction failed')
      return { success: false, message: 'Unable to finalize payment right now' }
    } finally {
      client.release()
    }

    // Everything below runs AFTER commit, with no DB lock held — mirrors
    // the pre-existing verifyPayment()'s own "only after payment is
    // confirmed" ordering, now shared by every finalization path instead
    // of just the client-verify one.
    const { payment, order, userId } = outcome

    await this._settleWalletIfPending(order.id)
    await this._queueAutoAssign(order.id, source)

    if (outcome.wasRecoveredFromFailed) {
      try {
        this.fastify?.emitDashboardPayment?.({
          orderId: order.id,
          orderNumber: order.order_number,
          amount: payment.amount,
          recoveredFromFailed: true,
        })
      } catch (_) { /* best-effort */ }
    }

    try {
      const { CartRepository } = await import('../cart/cart.repository.js')
      const cartRepo = new CartRepository()
      await cartRepo.clearCart(userId)
      await cartRepo.clearExtras(userId)
    } catch (err) {
      logger.warn({ err: err.message, userId }, 'Cart clear after payment finalize failed (non-critical)')
    }

    try {
      const { CouponsService } = await import('../coupons/coupons.service.js')
      const { CouponsRepository } = await import('../coupons/coupons.repository.js')
      await new CouponsService(new CouponsRepository()).recordUsageForOrder(order.id)
    } catch (err) {
      logger.warn({ err: err.message, orderId: order.id }, 'Coupon usage recording after payment finalize failed (non-critical)')
    }

    try {
      const { NotificationsRepository } = await import('../notifications/notifications.repository.js')
      const { NotificationsService } = await import('../notifications/notifications.service.js')
      const { buildCustomerOrderEventNotification } = await import('../notifications/customer-order-event.helper.js')
      const notifService = new NotificationsService(new NotificationsRepository(), null)
      await notifService.sendNotification(userId, buildCustomerOrderEventNotification({
        orderId: order.id,
        orderNumber: order.order_number,
        timelineType: 'ORDER_PLACED',
        status: 'CONFIRMED',
      }))

      this.fastify?.emitDashboardNewOrder?.({
        id: order.id,
        order_number: order.order_number,
        total: order.total_payable,
        payment_method: 'ONLINE',
        delivery_mode: order.delivery_mode,
        shop_id: order.shop_id,
        created_at: order.created_at,
      })
    } catch (err) {
      logger.warn({ err: err.message, orderId: order.id }, 'Order notification after payment finalize failed (non-critical)')
    }

    logger.info(
      { paymentId: payment.id, razorpayPaymentId: payment.razorpayPaymentId, orderId: order.id, source },
      'Payment finalized successfully'
    )

    return { success: true, payment }
  }

  /**
   * Ask Razorpay directly whether a captured payment exists for this
   * Razorpay order, and if so, route it through `completeVerifiedPayment`.
   * Shared by: the admin single/bulk "Re-check with Razorpay" endpoints,
   * the payment-expiry worker (before it ever expires+cancels an
   * unresolved payment), and `verifyPayment`'s own signature-mismatch
   * fallback. Returns `{ captured: false }` (never throws) when Razorpay
   * has nothing captured — callers that need "was this a hard failure or
   * just nothing captured yet" should inspect `captured`, not just
   * `success`.
   */
  async reconcileWithRazorpay(razorpayOrderId, source = 'RECONCILIATION', { allowRecoveryFromFailed = false } = {}) {
    if (!razorpay || !razorpayOrderId) {
      return { captured: false }
    }

    const rzpPayments = await razorpay.orders.fetchPayments(razorpayOrderId)
    const captured = (rzpPayments.items || []).find((p) => p.status === 'captured')
    if (!captured) {
      return { captured: false }
    }

    const result = await this.completeVerifiedPayment(razorpayOrderId, {
      razorpayPaymentId: captured.id,
      method: captured.method,
      source,
      allowRecoveryFromFailed,
    })

    return { captured: true, ...result }
  }

  /**
   * Customer-facing "what is the real payment status?" poll — for when a
   * checkout's client-side Razorpay callback is ambiguous (network blip,
   * app backgrounded mid-payment, SDK returned neither success nor a clear
   * failure). Reads local state only; it does not itself hit Razorpay on
   * every call (that's `reconcileWithRazorpay`, used server-side by the
   * expiry worker and admin actions) — a PENDING local payment nearing its
   * `expires_at` will get a real Razorpay check from the expiry worker
   * within its normal 2-minute poll, not from this endpoint.
   */
  async getPaymentStatus(userId, razorpayOrderId) {
    const payment = await this.repo.findByRazorpayOrderId(razorpayOrderId)
    if (!payment) {
      return { success: false, message: 'Payment record not found' }
    }
    if (payment.userId !== userId) {
      return { success: false, message: 'Unauthorized' }
    }
    return {
      success: true,
      data: {
        status: payment.status,
        orderId: payment.orderId,
        errorCode: payment.errorCode,
        errorDescription: payment.errorDescription,
        errorReason: payment.errorReason,
      },
    }
  }

  /**
   * Razorpay webhook — the server-to-server source of truth Razorpay
   * pushes independently of whatever the client's own callback did.
   * Verifies the signature against the RAW request bytes (`rawBody`,
   * captured by the `rawBody: true` route config + the `fastify-raw-body`
   * plugin registered in app.js) using Razorpay's own SDK validator —
   * never a re-serialized `JSON.stringify(parsedBody)`, which is not
   * guaranteed byte-identical to what Razorpay actually signed (key
   * ordering, unicode escaping, whitespace can all differ) and would make
   * signature verification silently, intermittently wrong. Every event is
   * deduplicated by Razorpay's own event id (the `x-razorpay-event-id`
   * header when present, else a hash of the raw body) via
   * `payment_webhook_events` — a duplicate delivery (Razorpay retries on
   * anything but a 2xx) is recorded but never reprocessed.
   */
  async handleWebhook(body, signature, rawBody, eventIdHeader = null) {
    if (!getRazorpayWebhookSecret()) {
      logger.warn('Razorpay webhook secret not configured')
      return { success: false }
    }

    if (!rawBody) {
      logger.error('Razorpay webhook: raw body unavailable — cannot verify signature, rejecting')
      return { success: false }
    }

    const rawBodyString = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody
    const payloadHash = crypto.createHash('sha256').update(rawBodyString).digest('hex')

    let validSignature
    try {
      // `validateWebhookSignature` is a STATIC method on the `Razorpay`
      // class (razorpay/dist/razorpay.js), not an instance method — the
      // `razorpay` export from config/razorpay.js is `new Razorpay({...})`,
      // so it must be called on the class itself, imported separately here.
      validSignature = RazorpaySdk.validateWebhookSignature(rawBodyString, signature, getRazorpayWebhookSecret())
    } catch (err) {
      // A malformed/absent signature header throws inside the HMAC compare
      // (mismatched buffer lengths) rather than returning false — that's
      // still an invalid signature, not a server error.
      validSignature = false
    }

    const eventId = eventIdHeader || `hash:${payloadHash}`
    const eventType = body?.event || 'unknown'

    if (!validSignature) {
      logger.warn({ eventType }, 'Webhook signature mismatch')
      await this.repo.recordWebhookEvent({
        providerEventId: eventId,
        eventType,
        payloadHash,
        signatureValid: false,
        processingStatus: 'REJECTED_BAD_SIGNATURE',
      }).catch((err) => logger.warn({ err: err.message }, 'Failed to record rejected webhook event'))
      return { success: false }
    }

    const dedupRow = await this.repo.recordWebhookEvent({
      providerEventId: eventId,
      eventType,
      payloadHash,
      signatureValid: true,
      processingStatus: 'PROCESSING',
    }).catch((err) => {
      logger.warn({ err: err.message }, 'Failed to record webhook event (continuing — dedup is best-effort, not a gate)')
      return undefined // treat as "not a duplicate" if the ledger write itself fails
    })

    if (dedupRow === null) {
      // ON CONFLICT DO NOTHING returned no row — this exact event id was
      // already recorded, i.e. Razorpay is retrying a delivery we already
      // processed (or are currently processing). Acknowledge without
      // reprocessing so a retry storm can never double-confirm/double-
      // refund/double-credit anything.
      logger.info({ eventType, eventId }, 'Duplicate webhook delivery — already recorded, skipping')
      return { success: true, duplicate: true }
    }

    const payload = body.payload

    logger.info({ event: eventType }, 'Razorpay webhook received')

    switch (eventType) {
      case 'payment.authorized':
      case 'order.paid':
      case 'payment.captured': {
        const rzpPaymentId = payload.payment?.entity?.id
        const rzpOrderId = payload.payment?.entity?.order_id || payload.order?.entity?.id

        if (rzpOrderId) {
          const payment = await this.repo.findByRazorpayOrderId(rzpOrderId)
          if (payment) {
            await this.completeVerifiedPayment(rzpOrderId, {
              razorpayPaymentId: rzpPaymentId,
              method: payload.payment?.entity?.method,
              source: `PAYMENT_WEBHOOK_${eventType.toUpperCase()}`,
            })
          } else {
            // Not a checkout order payment — check whether it's a wallet
            // top-up instead (a completely separate Razorpay order created
            // directly by WalletService, not the orders/payments module).
            this.walletService.completeVerifiedTopUp(rzpOrderId).catch((err) => {
              logger.warn({ err: err.message, rzpOrderId }, 'Wallet top-up webhook completion failed')
            })
          }
        }
        break
      }

      case 'payment.failed': {
        const rzpOrderId = payload.payment?.entity?.order_id
        const entity = payload.payment?.entity || {}
        if (rzpOrderId) {
          const payment = await this.repo.findByRazorpayOrderId(rzpOrderId)
          // Only act on a payment still PENDING — a `payment.failed` event
          // arriving after this payment was already confirmed PAID by some
          // other signal (the client's own verify call, a reconciliation
          // pass that ran first) must never downgrade a real success. This
          // is the exact bug class the whole reconciliation rework exists
          // to close: money captured, customer sees "failed" anyway.
          if (payment && payment.status === 'PENDING') {
            await this.repo.updatePayment(payment.id, {
              status: 'FAILED',
              errorCode: entity.error_code || null,
              errorDescription: entity.error_description || null,
              errorSource: entity.error_source || null,
              errorStep: entity.error_step || null,
              errorReason: entity.error_reason || null,
            })
            await this.ordersRepo.updateStatus(payment.orderId, undefined, {
              paymentStatus: 'FAILED',
            })
            logger.info({ paymentId: payment.id }, 'Payment failed via webhook')
          } else if (payment) {
            logger.info(
              { paymentId: payment.id, currentStatus: payment.status },
              'Ignored late payment.failed webhook — payment is no longer PENDING (already PAID/resolved elsewhere)'
            )
          }
        }
        break
      }

      case 'refund.processed': {
        const rzpPaymentId = payload.refund?.entity?.payment_id
        const refundEntity = payload.refund?.entity || {}
        if (rzpPaymentId) {
          try {
            const resolved = await this.repo.findByRazorpayPaymentId(rzpPaymentId)
            // Only act once — a payment already REFUNDED here means our own
            // admin-initiated refund() already handled it (and already
            // updated the order), so this webhook is Razorpay's async
            // confirmation of an action we took ourselves, not new
            // information. Without this guard, a refund we initiated AND
            // Razorpay's own webhook confirming it would both try to mark
            // the order REFUNDED and re-send the "refund processed"
            // notification.
            if (resolved && resolved.status !== 'REFUNDED') {
              await this.repo.updateRefund(resolved.id, {
                refundId: refundEntity.id || null,
                refundAmount: refundEntity.amount ? refundEntity.amount / 100 : null,
                refundStatus: 'PROCESSED',
              })
              await this.ordersRepo.updateStatus(resolved.orderId, 'REFUNDED', {
                paymentStatus: 'REFUNDED',
              })
              logger.info({ paymentId: resolved.id, razorpayPaymentId: rzpPaymentId }, 'Refund processed via webhook')
            } else if (!resolved) {
              logger.warn({ razorpayPaymentId: rzpPaymentId }, 'Refund webhook: no matching payment found')
            }
          } catch (err) {
            logger.warn({ err: err.message, razorpayPaymentId: rzpPaymentId }, 'Refund webhook persistence failed')
          }
        }
        break
      }

      default:
        logger.debug({ event: eventType }, 'Unhandled webhook event')
    }

    return { success: true }
  }

  /**
   * Get payment history for a user
   */
  async getHistory(userId, filters) {
    const { offset, limit } = getOffsetLimit(filters)
    const page = Math.max(1, Math.floor(filters.page || 1))

    const { payments, total } = await this.repo.findByUser(userId, { limit, offset })

    return {
      payments,
      pagination: buildPagination({ page, limit, total }),
    }
  }

  /**
   * Admin: initiate refund
   */
  async refund(paymentId, { amount, reason, markOrderRefunded = true }) {
    if (!razorpay) {
      return { success: false, message: 'Online payments are not configured' }
    }

    const payment = await this.repo.findById(paymentId)
    if (!payment) {
      return { success: false, message: 'Payment not found' }
    }

    if (payment.status !== 'PAID') {
      return { success: false, message: 'Only paid payments can be refunded' }
    }

    if (!payment.razorpayPaymentId) {
      return { success: false, message: 'No Razorpay payment ID — cannot refund' }
    }

    const refundAmount = amount || payment.amount
    if (refundAmount > payment.amount) {
      return { success: false, message: 'Refund amount exceeds payment amount' }
    }

    try {
      const rzpRefund = await razorpay.payments.refund(payment.razorpayPaymentId, {
        amount: Math.round(refundAmount * 100),
        notes: { reason: reason || 'Admin initiated refund' },
      })

      const updated = await this.repo.updateRefund(payment.id, {
        refundId: rzpRefund.id,
        refundAmount,
        refundStatus: 'PROCESSED',
      })

      // Update order status to refunded — skipped for a PARTIAL (item-level)
      // refund, where the order itself stays DELIVERED.
      if (markOrderRefunded) {
        await this.ordersRepo.updateStatus(payment.orderId, 'REFUNDED', {
          paymentStatus: 'REFUNDED',
        })
      }

      logger.info({ paymentId, refundId: rzpRefund.id, refundAmount }, 'Refund initiated')
      return { success: true, payment: updated, refundId: rzpRefund.id }
    } catch (err) {
      logger.error({ err, paymentId }, 'Refund failed')
      return { success: false, message: 'Refund failed: ' + err.message }
    }
  }

  async _queueAutoAssign(orderId, source = 'PAYMENTS_SERVICE') {
    try {
      await orderQueue.add(
        'auto-assign',
        {
          type: 'auto-assign',
          orderId,
          source,
        },
        {
          jobId: `auto-assign-${orderId}`,
          removeOnComplete: true,
        }
      )
      if (INLINE_AUTO_ASSIGN_IN_NON_PROD) {
        await this._runAutoAssignFallback(orderId, `${source}_DEV_INLINE`)
      }
    } catch (err) {
      logger.warn({ err, orderId, source }, 'Failed to queue auto-assign job')
      await this._runAutoAssignFallback(orderId, source)
    }
  }

  async _runAutoAssignFallback(orderId, source) {
    try {
      const { processOrderJob } = await import('../../workers/processors.js')
      await processOrderJob({
        data: {
          type: 'auto-assign',
          orderId,
          source: `${source}_INLINE_FALLBACK`,
        },
      })
      logger.info({ orderId, source }, 'Inline auto-assign fallback executed')
    } catch (fallbackErr) {
      logger.error(
        { err: fallbackErr, orderId, source },
        'Inline auto-assign fallback failed'
      )
    }
  }
}
