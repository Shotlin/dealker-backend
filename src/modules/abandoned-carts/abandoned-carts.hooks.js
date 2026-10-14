import { logger } from '../../config/logger.js'
import { AbandonedCartsRepository } from './abandoned-carts.repository.js'

const repo = new AbandonedCartsRepository()

/**
 * Side-effect hooks other modules call so the Abandoned Carts dashboard
 * stays truthful. They never throw: a bookkeeping failure must never break
 * checkout, payment confirmation or a cart mutation.
 */

/** An order was placed/paid — close the user's OPEN episode as CONVERTED. */
export async function markCartConverted({ userId, orderId, priceMode = null, fastify = null }) {
  try {
    const row = await repo.markConvertedByUserId(userId, orderId, priceMode)
    if (row) fastify?.emitAbandonedCartUpdate?.({ userId, abandonedCartId: row.id, status: 'CONVERTED' })
    return row
  } catch (err) {
    logger.warn({ userId, orderId, err: err.message }, 'Abandoned-cart conversion flip failed (non-critical)')
    return null
  }
}

/** The customer emptied their cart by hand — nothing left to recover. */
export async function markCartCleared({ userId, priceMode = null, fastify = null }) {
  try {
    const row = await repo.closeOpenByUserId(userId, 'CART_CLEARED', priceMode)
    if (row) fastify?.emitAbandonedCartUpdate?.({ userId, abandonedCartId: row.id, status: 'EXPIRED' })
    return row
  } catch (err) {
    logger.warn({ userId, err: err.message }, 'Abandoned-cart clear flip failed (non-critical)')
    return null
  }
}
