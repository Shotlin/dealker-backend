/**
 * Abandoned Cart Sweep Worker
 *
 * Polls every 15s for carts inactive past ABANDONMENT_THRESHOLD_MS
 * (see src/constants/abandonedCart.js; ABANDONED_CART_THRESHOLD_MINUTES), following the same
 * in-process setInterval pattern as payment-expiry.worker.js rather than a
 * BullMQ repeatable job, since this runs inside the main API server and
 * needs no dedicated worker-process infrastructure.
 *
 * The poll interval is intentionally shorter than the threshold itself —
 * with a 60s poll and a 60s threshold, a cart that goes idle right after a
 * sweep wouldn't be caught until up to ~2 sweeps later (worst case ~120s),
 * which reads as "way more than a minute" to whoever's watching the
 * dashboard. 15s keeps worst-case detection latency close to the actual
 * 1-minute threshold.
 *
 * Unlike payment-expiry.worker.js's single shared batch transaction, each
 * candidate user here is processed independently (its own try/catch) —
 * abandoned-cart records have no cross-user dependency, so one user's
 * failure must never block or roll back another's.
 *
 * "Recovery" (user resumes shopping) and "conversion" (user completes
 * checkout) are detected immediately elsewhere — CartService and
 * OrdersService respectively — NOT here. This worker only ever creates or
 * refreshes OPEN episodes and expires stale ones.
 */
import { query } from '../config/database.js'
import { logger } from '../config/logger.js'
import { CartRepository } from '../modules/cart/cart.repository.js'
import { CartService } from '../modules/cart/cart.service.js'
import { AbandonedCartsRepository } from '../modules/abandoned-carts/abandoned-carts.repository.js'
import { computeRecoveryPriorityScore } from '../modules/abandoned-carts/priority-score.js'
import {
  ABANDONMENT_THRESHOLD_MS,
  ABANDONED_CART_SWEEP_BATCH_LIMIT,
} from '../constants/abandonedCart.js'

let _intervalHandle = null
let _fastify = null
const POLL_INTERVAL_MS = 15 * 1000 // 15 seconds

const cartRepository = new CartRepository()
const cartService = new CartService(cartRepository)
const abandonedCartsRepository = new AbandonedCartsRepository()

/**
 * @param {import('fastify').FastifyInstance} [fastify] Optional — when
 * passed (server.js does, at startup), a newly-DETECTED episode also emits
 * `emitAbandonedCartUpdate` so an open admin dashboard tab updates live
 * instead of only refreshing on next mount/refocus, matching the recovery
 * and conversion signals already pushed elsewhere.
 */
export function startAbandonedCartWorker(fastify) {
  if (_intervalHandle) return
  _fastify = fastify || null

  logger.info('Abandoned cart sweep worker started (polling every 15s)')

  _intervalHandle = setInterval(async () => {
    try {
      await _sweep()
    } catch (err) {
      logger.error({ err: err.message }, 'Abandoned cart worker poll error')
    }
  }, POLL_INTERVAL_MS)

  // Also run immediately on startup
  _sweep().catch((err) =>
    logger.error({ err: err.message }, 'Abandoned cart worker initial poll error')
  )
}

export function stopAbandonedCartWorker() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle)
    _intervalHandle = null
    logger.info('Abandoned cart sweep worker stopped')
  }
}

async function _sweep() {
  const cutoff = Date.now() - ABANDONMENT_THRESHOLD_MS
  const candidates = await cartRepository.getInactiveUserIds(
    cutoff,
    ABANDONED_CART_SWEEP_BATCH_LIMIT
  )

  if (candidates.length > 0) {
    const excluded = await _excludeUsersWithPendingPayment(
      candidates.map((c) => c.userId)
    )

    for (const { userId, lastActivityMs } of candidates) {
      if (excluded.has(userId)) continue
      try {
        await _processCandidate(userId, lastActivityMs)
      } catch (err) {
        logger.error({ userId, err: err.message }, 'Abandoned cart: failed to process candidate')
      }
    }

    logger.info(
      { candidates: candidates.length, excluded: excluded.size },
      'Abandoned cart sweep tick complete'
    )
  }

  const expiredIds = await abandonedCartsRepository.expireStale()
  if (expiredIds.length > 0) {
    logger.info({ count: expiredIds.length }, 'Abandoned cart: episodes expired')
  }
}

async function _processCandidate(userId, lastActivityMs) {
  // A customer can hold a retail and a wholesale cart; snapshot whichever
  // has live items (retail first).
  let enrichedCart = await cartService.getCart(userId, 'retail')
  if (!enrichedCart.items || enrichedCart.items.length === 0) {
    enrichedCart = await cartService.getCart(userId, 'wholesale')
  }

  if (!enrichedCart.items || enrichedCart.items.length === 0) {
    // Every line item's shop/product went inactive since the last
    // activity, or the cart is genuinely empty — self-heal so this
    // user isn't reprocessed forever.
    await cartRepository.removeActivity(userId)
    return
  }

  // Priority scoring is only ever used by recordAbandonment() on a first
  // detection (ignored on resweep of an already-OPEN episode) — computed
  // unconditionally here anyway since it's cheap (two small indexed
  // queries) and simpler than pre-checking whether an OPEN row exists.
  const [{ ltv }, recoveryRate] = await Promise.all([
    abandonedCartsRepository.getCustomerLTV(userId),
    abandonedCartsRepository.getUserRecoveryRate(userId),
  ])
  const minutesSinceAbandonment = (Date.now() - lastActivityMs) / 60000
  const priorityScoring = computeRecoveryPriorityScore({
    cartValue: enrichedCart.subtotal,
    itemCount: enrichedCart.items.length,
    ltv,
    minutesSinceAbandonment,
    recoveryRate,
  })

  const { id, isNew } = await abandonedCartsRepository.recordAbandonment(
    userId,
    enrichedCart,
    lastActivityMs,
    priorityScoring
  )

  if (isNew) {
    logger.info(
      { userId, cartValue: enrichedCart.subtotal, priorityScore: priorityScoring.score },
      'Abandoned cart detected'
    )
    if (_fastify?.emitAbandonedCartUpdate) {
      _fastify.emitAbandonedCartUpdate({ userId, abandonedCartId: id, status: 'DETECTED' })
    }
  }

  // A user who's just been recorded (new detection or resweep) has no
  // reason to occupy a slot in the next tick's candidate batch — nothing
  // about their cart will change again until they touch it, which
  // independently re-adds them here with a fresh score via saveCart's own
  // zadd. Without this, a user who was detected once stays in the ZSET at
  // their original (increasingly ancient) score forever, and since
  // getInactiveUserIds selects the LOWEST scores first, a backlog of
  // already-detected users can permanently starve genuinely fresh
  // candidates out of every batch once it reaches the per-tick limit.
  await cartRepository.removeActivity(userId)
}

/**
 * Users with a PENDING order awaiting ONLINE/WALLET payment confirmation
 * are excluded from this sweep — that lifecycle already belongs to
 * payment-expiry.worker.js, and treating a mid-payment cart as "abandoned"
 * would be a confusing double-signal for admins.
 */
async function _excludeUsersWithPendingPayment(userIds) {
  if (userIds.length === 0) return new Set()
  const { rows } = await query(
    `SELECT DISTINCT customer_id AS user_id FROM orders
      WHERE customer_id = ANY($1::uuid[])
        AND status = 'PENDING'
        AND payment_status = 'PENDING'
        AND payment_method IN ('ONLINE', 'WALLET')`,
    [userIds]
  )
  return new Set(rows.map((r) => r.user_id))
}
