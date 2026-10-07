import { logger } from '../config/logger.js'
import { query } from '../config/database.js'
import { WishlistRepository } from '../modules/wishlist/wishlist.repository.js'
import { NotificationsRepository } from '../modules/notifications/notifications.repository.js'
import { NotificationsService } from '../modules/notifications/notifications.service.js'

/**
 * Stock-notifications worker — processes BullMQ `stock-notifications`
 * queue jobs (Requirements 3.4, 11.6).
 *
 * Job types:
 *   - `wishlist-restock` — Fan out push + in-app notifications to every
 *     customer who has wishlisted a `product_id` after the underlying
 *     `Shop_Product` transitions from stock_quantity = 0 to a positive
 *     value (enqueued by ShopProductsService post-commit; see task 13.1).
 *
 * Resource budget (design.md Background Job Architecture):
 *   - Concurrency 2 (configured at worker registration in bullmq.js)
 *   - 2 attempts with fixed backoff (queue defaults) — restock alerts are
 *     best-effort, not retried indefinitely
 *   - Per-job target: process within 30 seconds
 *   - Pagination batch size: 200 wishlist users — keeps memory bounded
 *     for the 2-core/4GB box. Inner sends are sequential within a batch
 *     to avoid hammering FCM with hundreds of concurrent calls.
 *
 * Idempotency: the worker writes one in-app notification row per (user,
 * job-run) so a retry produces a duplicate notification. That's an
 * accepted tradeoff for a best-effort fan-out — design.md classifies the
 * queue as 2x fixed retry, not exactly-once. Each push is best-effort
 * (FCM errors are logged, never thrown, so a single bad token doesn't
 * fail the whole job and trigger a retry storm).
 */

const DEFAULT_BATCH_SIZE = 200

/**
 * Build a job processor bound to fresh repository/service instances. The
 * factory lets tests substitute a mock wishlist repo or notifications
 * service and keeps module imports side-effect free (no DB / Redis at
 * import time).
 *
 * @param {object} [deps]
 * @param {WishlistRepository} [deps.wishlistRepository]
 * @param {NotificationsService} [deps.notificationsService]
 * @param {(productId: string) => Promise<{name: string|null}|null>} [deps.findProductMeta]
 *   Override the product lookup (used by tests). Defaults to a single
 *   parameterized SELECT against `products`.
 * @param {number} [deps.batchSize] - Override pagination batch size.
 * @returns {(job: import('bullmq').Job) => Promise<object>}
 */
export function createStockNotificationsProcessor(deps = {}) {
  const wishlistRepository = deps.wishlistRepository || new WishlistRepository()
  const notificationsService =
    deps.notificationsService ||
    new NotificationsService(new NotificationsRepository(), null)
  const findProductMeta = deps.findProductMeta || defaultFindProductMeta
  // Resolve batch size: invalid (NaN / not a number) → DEFAULT_BATCH_SIZE,
  // otherwise clamp into [1, 1000] so callers can't accidentally request
  // 0 / negative / huge batches.
  const rawBatch = Number(deps.batchSize)
  const resolvedBatch = Number.isFinite(rawBatch) ? rawBatch : DEFAULT_BATCH_SIZE
  const batchSize = Math.max(1, Math.min(1000, resolvedBatch))

  return async function processStockNotificationsJob(job) {
    const type = job?.data?.type || job?.name

    if (type === 'wishlist-restock') {
      return handleWishlistRestock(job, {
        wishlistRepository,
        notificationsService,
        findProductMeta,
        batchSize,
      })
    }

    logger.warn(
      {
        jobId: job?.id,
        type,
        action: 'stock_notifications_unknown_job_type',
      },
      'Unknown stock-notifications job type'
    )
    return { ignored: true }
  }
}

/**
 * Fan out restock notifications to every customer who wishlisted the
 * given product.
 *
 * Pagination: keyset cursor on `wishlist.user_id`, batch size 200. For
 * each user we send via the NotificationsService which handles in-app
 * insert + FCM push + Socket.IO emit (best-effort each). Per-user
 * failures are logged with structured context and counted in `skipped`
 * but never thrown — a single bad FCM token cannot fail the whole job.
 *
 * @param {import('bullmq').Job} job
 * @param {{
 *   wishlistRepository: WishlistRepository,
 *   notificationsService: NotificationsService,
 *   findProductMeta: (productId: string) => Promise<{name: string|null}|null>,
 *   batchSize: number,
 * }} ctx
 */
async function handleWishlistRestock(job, ctx) {
  const data = job?.data || {}
  const productId = data.product_id
  const shopId = data.shop_id
  const shopProductId = data.shop_product_id

  if (!productId || !shopId) {
    logger.warn(
      {
        jobId: job?.id,
        productId,
        shopId,
        action: 'stock_notifications_missing_ids',
      },
      'wishlist-restock job missing product_id or shop_id'
    )
    return { notified: 0, skipped: 0, action: 'noop' }
  }

  // Resolve the product name once. Best-effort: a missing product (deleted
  // since enqueue) still triggers a generic "back in stock" notification.
  let productName = null
  try {
    const meta = await ctx.findProductMeta(productId)
    productName = meta?.name || null
  } catch (err) {
    logger.warn(
      {
        jobId: job?.id,
        productId,
        shopId,
        err: err?.message,
        action: 'stock_notifications_product_lookup_failed',
      },
      'Product lookup failed during wishlist restock fan-out'
    )
  }

  const title = 'Back in stock 🎉'
  const body = productName
    ? `${productName} is back in stock. Grab yours before it's gone!`
    : "An item from your wishlist is back in stock. Grab yours before it's gone!"

  let notified = 0
  let skipped = 0
  let cursor = null
  // Defensive guardrail: 500 batches × 200 = 100k users, well above any
  // realistic single-product wishlist on this scale of platform.
  const MAX_ITERATIONS = 500

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const batch = await ctx.wishlistRepository.findUsersByWishlistedProduct(
      productId,
      { afterUserId: cursor, limit: ctx.batchSize }
    )

    if (batch.length === 0) break

    // Sequential within batch to keep concurrent FCM calls under control
    // on a 2-core/4GB box. Outer worker concurrency = 2 already gives us
    // useful parallelism across products.
    for (const row of batch) {
      const userId = row.user_id
      try {
        await ctx.notificationsService.sendNotification(userId, {
          title,
          body,
          type: 'restock',
          data: {
            product_id: productId,
            shop_id: shopId,
            shop_product_id: shopProductId || null,
            action: 'wishlist_restock',
          },
        })
        notified += 1
      } catch (err) {
        skipped += 1
        logger.error(
          {
            jobId: job?.id,
            userId,
            productId,
            shopId,
            err: err?.message,
            action: 'stock_notifications_send_failed',
          },
          'Failed to send restock notification to user'
        )
      }
    }

    cursor = batch[batch.length - 1].user_id
    if (batch.length < ctx.batchSize) break
  }

  logger.info(
    {
      jobId: job?.id,
      productId,
      shopId,
      shopProductId: shopProductId || null,
      notified,
      skipped,
      action: 'stock_notifications_wishlist_restock_complete',
    },
    'Wishlist restock fan-out complete'
  )

  return {
    productId,
    shopId,
    notified,
    skipped,
    action: 'wishlist-restock',
  }
}

/**
 * Default product metadata lookup — single parameterized SELECT against
 * the `products` table. Returns `null` for missing / deleted products so
 * the worker falls back to a generic restock copy.
 *
 * @param {string} productId
 * @returns {Promise<{name: string|null}|null>}
 */
async function defaultFindProductMeta(productId) {
  const { rows } = await query(
    'SELECT name FROM products WHERE id = $1 LIMIT 1',
    [productId]
  )
  return rows[0] ? { name: rows[0].name } : null
}
