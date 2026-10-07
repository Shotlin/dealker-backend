/**
 * Payment Expiry Worker
 * Polls every 2 minutes for PENDING online payments past their 15-minute window.
 * Marks them EXPIRED and cancels the associated order.
 *
 * Safe: uses SELECT FOR UPDATE SKIP LOCKED to avoid double-processing
 * on multi-instance deployments.
 *
 * Stock correctness: restores shop_products.stock_quantity for each
 * cancelled order's items so stock is not permanently lost on payment expiry.
 *
 * Reconciliation safety (critical — see CLAUDE.md §"payment reconciliation
 * hardening"): a payment timeout is NOT proof the payment failed. Before
 * cancelling+restocking any candidate that actually has a
 * razorpay_order_id, this worker asks Razorpay directly
 * (PaymentsService#reconcileWithRazorpay) whether a payment was actually
 * captured. If Razorpay confirms a capture, the order is finalized through
 * the same centralized path every other confirmation uses instead of being
 * cancelled. If the Razorpay check itself throws (network/API outage) the
 * candidate is left PENDING for the next poll — a temporary inability to
 * ask Razorpay is never treated as proof of failure. Only once Razorpay is
 * successfully reached AND shows no captured payment does the worker
 * proceed to cancel + restore stock. Legacy candidates (pre-`expires_at`
 * orders with no payment/razorpay_order_id at all) skip the Razorpay check
 * entirely, same as before, since there is nothing to reconcile.
 *
 * A second sweep, `_recoverRecentlyFailedPayments`, re-checks payments the
 * app marked FAILED within the last 48 hours against Razorpay — this is
 * how a payment that was actually captured but got a spurious local FAILED
 * (e.g. a client-side signature-mismatch false alarm) gets corrected
 * automatically instead of staying wrong forever.
 */
import { getClient, query } from '../config/database.js'
import { logger } from '../config/logger.js'
import { razorpay } from '../config/razorpay.js'
import { PaymentsRepository } from '../modules/payments/payments.repository.js'
import { PaymentsService } from '../modules/payments/payments.service.js'

let _intervalHandle = null
const POLL_INTERVAL_MS = 2 * 60 * 1000 // 2 minutes
const RECENTLY_FAILED_WINDOW_HOURS = 48

const paymentsService = new PaymentsService(new PaymentsRepository())

export function startPaymentExpiryWorker() {
  if (_intervalHandle) return

  logger.info('Payment expiry worker started (polling every 2 min)')

  _intervalHandle = setInterval(async () => {
    try {
      await _processExpiredPayments()
      await _recoverRecentlyFailedPayments()
    } catch (err) {
      logger.error({ err: err.message }, 'Payment expiry worker poll error')
    }
  }, POLL_INTERVAL_MS)

  // Also run immediately on startup
  _processExpiredPayments().catch(err =>
    logger.error({ err: err.message }, 'Payment expiry worker initial poll error')
  )
}

export function stopPaymentExpiryWorker() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle)
    _intervalHandle = null
    logger.info('Payment expiry worker stopped')
  }
}

async function _processExpiredPayments() {
  // 1. Find expired pending payments (new flow with expires_at)
  const { rows: expired } = await query(
    `SELECT p.id AS payment_id, p.order_id, p.razorpay_order_id
     FROM payments p
     WHERE p.status = 'PENDING'
       AND p.expires_at IS NOT NULL
       AND p.expires_at <= NOW()
     LIMIT 20`
  )

  // 2. Also find legacy ONLINE PENDING orders without expires_at older than 30 min
  const { rows: legacy } = await query(
    `SELECT id AS order_id, NULL::uuid AS payment_id, NULL::text AS razorpay_order_id
     FROM orders
     WHERE status = 'PENDING'
       AND payment_method = 'ONLINE'
       AND payment_status = 'PENDING'
       AND payment_expires_at IS NULL
       AND created_at < NOW() - INTERVAL '30 minutes'
     LIMIT 20`
  )

  const all = [
    ...expired.map(r => ({ paymentId: r.payment_id, orderId: r.order_id, razorpayOrderId: r.razorpay_order_id, isLegacy: false })),
    ...legacy.map(r => ({ paymentId: null, orderId: r.order_id, razorpayOrderId: null, isLegacy: true })),
  ]

  if (all.length === 0) return

  logger.info({ count: all.length, legacy: legacy.length }, 'Processing expired pending payments')

  for (const row of all) {
    await _processOneExpiredPayment(row)
  }
}

/**
 * Reconciliation happens OUTSIDE any transaction of this worker's own —
 * `reconcileWithRazorpay` manages its own transaction (via
 * `completeVerifiedPayment`) when it finds a capture, and the Razorpay API
 * call itself must never be made while holding a row lock (an outage there
 * would hold locks open for however long the HTTP call hangs). Only the
 * actual cancel+restock, once genuinely warranted, is wrapped in its own
 * short transaction below.
 */
async function _processOneExpiredPayment(row) {
  if (razorpay && row.razorpayOrderId) {
    try {
      const result = await paymentsService.reconcileWithRazorpay(row.razorpayOrderId, 'PAYMENT_EXPIRY_RECONCILE')
      if (result.captured) {
        logger.info(
          { orderId: row.orderId, paymentId: row.paymentId, success: result.success },
          'Payment expiry: Razorpay showed a captured payment — finalized instead of cancelling'
        )
        return
      }
    } catch (err) {
      // The Razorpay check itself failed (network/API error) — do not
      // cancel blind. Leave this candidate PENDING for the next poll
      // rather than risk cancelling+restocking an order whose payment
      // status we simply failed to verify.
      logger.warn(
        { err: err.message, orderId: row.orderId },
        'Payment expiry: Razorpay verification check failed, leaving PENDING for next poll'
      )
      return
    }
  }

  await _cancelExpiredOrder(row)
}

async function _cancelExpiredOrder(row) {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    // Verify the order is still PENDING before cancelling (idempotency guard)
    const { rows: [orderRow] } = await client.query(
      `SELECT id, status, payment_status, items FROM orders WHERE id = $1 FOR UPDATE`,
      [row.orderId]
    )

    if (!orderRow) {
      logger.warn({ orderId: row.orderId }, 'Payment expiry: order not found, skipping')
      await client.query('ROLLBACK')
      return
    }

    // Only cancel truly PENDING orders — idempotent guard against double-processing
    if (orderRow.status !== 'PENDING' || orderRow.payment_status !== 'PENDING') {
      logger.info(
        { orderId: row.orderId, status: orderRow.status, paymentStatus: orderRow.payment_status },
        'Payment expiry: order already processed, skipping stock restore'
      )
    } else {
      // Restore shop_products stock for each item in the order
      const items = typeof orderRow.items === 'string'
        ? JSON.parse(orderRow.items)
        : (orderRow.items || [])

      for (const item of items) {
        const qty = Number(item.quantity)
        if (!qty || qty <= 0) continue

        const shopProductId = item.shopProductId || item.shop_product_id || null
        const productId = item.productId || item.product_id || null
        const shopId = item.shopId || item.shop_id || null

        if (shopProductId) {
          await client.query(
            `UPDATE shop_products
             SET stock_quantity = stock_quantity + $1,
                 is_available = CASE
                   WHEN stock_quantity = 0 AND $1 > 0 THEN true
                   ELSE is_available
                 END,
                 sold_out_at = CASE
                   WHEN stock_quantity = 0 AND $1 > 0 THEN NULL
                   ELSE sold_out_at
                 END,
                 updated_at = NOW()
             WHERE id = $2 AND deleted_at IS NULL`,
            [qty, shopProductId]
          )
        } else if (productId && shopId) {
          await client.query(
            `UPDATE shop_products
             SET stock_quantity = stock_quantity + $1,
                 is_available = CASE
                   WHEN stock_quantity = 0 AND $1 > 0 THEN true
                   ELSE is_available
                 END,
                 sold_out_at = CASE
                   WHEN stock_quantity = 0 AND $1 > 0 THEN NULL
                   ELSE sold_out_at
                 END,
                 updated_at = NOW()
             WHERE product_id = $2 AND shop_id = $3 AND deleted_at IS NULL`,
            [qty, productId, shopId]
          )
        }
      }

      logger.info({ orderId: row.orderId, itemCount: items.length }, 'Payment expiry: stock restored for order items')
    }

    if (row.paymentId) {
      await client.query(
        `UPDATE payments SET status = 'EXPIRED', updated_at = NOW() WHERE id = $1`,
        [row.paymentId]
      )
    }

    // Also expire any legacy payment records for this order
    if (row.isLegacy) {
      await client.query(
        `UPDATE payments SET status = 'EXPIRED', updated_at = NOW()
         WHERE order_id = $1 AND status = 'PENDING'`,
        [row.orderId]
      )
    }

    await client.query(
      `UPDATE orders
       SET status = 'CANCELLED',
           payment_status = 'EXPIRED',
           cancelled_reason = 'Payment window expired (15 minutes)',
           updated_at = NOW()
       WHERE id = $1
         AND status = 'PENDING'
         AND payment_status = 'PENDING'`,
      [row.orderId]
    )

    await client.query('COMMIT')

    logger.info(
      { paymentId: row.paymentId, orderId: row.orderId, isLegacy: row.isLegacy },
      'Expired payment cancelled'
    )
  } catch (err) {
    await client.query('ROLLBACK')
    logger.error({ err: err.message, orderId: row.orderId }, 'Payment expiry: cancel transaction failed')
  } finally {
    client.release()
  }
}

/**
 * A payment this app marked FAILED (client signature mismatch, a
 * `payment.failed` webhook, etc.) might still have actually been captured
 * at Razorpay — this sweep is the safety net that finds and corrects that
 * automatically rather than leaving a customer permanently, wrongly told
 * their payment failed while their order sits cancelled. Bounded to the
 * last 48 hours and a small batch per poll so this never becomes an
 * unbounded full-table scan.
 */
async function _recoverRecentlyFailedPayments() {
  if (!razorpay) return

  const { rows } = await query(
    `SELECT id, order_id, razorpay_order_id
     FROM payments
     WHERE status = 'FAILED'
       AND razorpay_order_id IS NOT NULL
       AND updated_at >= NOW() - INTERVAL '${RECENTLY_FAILED_WINDOW_HOURS} hours'
     ORDER BY updated_at DESC
     LIMIT 10`
  )

  if (rows.length === 0) return

  for (const row of rows) {
    try {
      const result = await paymentsService.reconcileWithRazorpay(
        row.razorpay_order_id,
        'PAYMENT_EXPIRY_FAILED_RECOVERY_SWEEP',
        { allowRecoveryFromFailed: true }
      )
      if (result.captured) {
        logger.info(
          { paymentId: row.id, orderId: row.order_id, needsManualReview: result.needsManualReview },
          'Recovered a payment previously marked FAILED — Razorpay confirmed it was actually captured'
        )
      }
    } catch (err) {
      logger.warn({ err: err.message, paymentId: row.id }, 'Failed-payment recovery check errored, will retry next poll')
    }
  }
}

// Test-only export — internal, not part of the worker's public API.
export { _processOneExpiredPayment as __test__processOneExpiredPayment }
