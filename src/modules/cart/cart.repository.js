import { redis } from '../../config/redis.js'
import { query } from '../../config/database.js'

const CART_PREFIX = 'cart:'
const CART_TTL = 60 * 60 * 24 * 7 // 7 days
const CART_TIP_PREFIX = 'cart-tip:'
const CART_INSTRUCTIONS_PREFIX = 'cart-instructions:'
// Sorted set: member = userId, score = epoch-ms of last cart-related
// mutation. Powers abandoned-cart detection (src/workers/abandoned-cart.worker.js)
// without changing the cart JSON blob's shape — a cart has no
// updated_at/last_activity field of its own, only the Redis TTL.
const CART_ACTIVITY_ZSET = 'cart-activity'

function normalizePriceMode(value) {
  return value === 'wholesale' ? 'wholesale' : 'retail'
}

function cartKey(userId, priceMode) {
  return `${CART_PREFIX}${normalizePriceMode(priceMode)}:${userId}`
}

function cartExtraKey(prefix, userId, priceMode) {
  return `${prefix}${normalizePriceMode(priceMode)}:${userId}`
}

/**
 * Cart repository
 *
 * - Redis: cart line items (`{ productId, shopId, quantity }`), tip and
 *   delivery instructions
 * - PostgreSQL: per-shop product lookups gated on the customer's active
 *   user_shop_allocations and the shop's `is_active` flag (Requirements
 *   5.2, 5.3, 5.4, 5.5, 12.2)
 *
 * All SQL is parameterized ($1, $2…) and never uses `SELECT *`.
 */
export class CartRepository {
  // ────────────────────────────────────────────────────────
  // Redis — cart line items
  // ────────────────────────────────────────────────────────

  /**
   * Get all items in user's cart from Redis. Each item is shaped as
   * `{ productId, shopId, quantity }`. Legacy entries without shopId are
   * filtered out so multi-vendor checkout can group safely (Requirement 5.6).
   */
  async getCart(userId, priceMode = 'retail') {
    const data = await redis.get(cartKey(userId, priceMode))
    if (!data) return []
    let parsed
    try {
      parsed = JSON.parse(data)
    } catch {
      return []
    }
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item) => item && item.productId && item.shopId && item.quantity > 0)
      .map((item) => ({
        productId: item.productId,
        shopId: item.shopId,
        quantity: Number(item.quantity),
      }))
  }

  /**
   * Save entire cart to Redis. Caller must pass the new array shape
   * `{ productId, shopId, quantity }`.
   */
  async saveCart(userId, items, priceMode = 'retail') {
    const normalized = (items || [])
      .filter((i) => i && i.productId && i.shopId && i.quantity > 0)
      .map((i) => ({
        productId: i.productId,
        shopId: i.shopId,
        quantity: Number(i.quantity),
      }))
    await redis.set(
      cartKey(userId, priceMode),
      JSON.stringify(normalized),
      'EX',
      CART_TTL
    )
    await redis.zadd(CART_ACTIVITY_ZSET, Date.now(), userId)
  }

  /**
   * Clear cart
   */
  async clearCart(userId, priceMode = 'retail') {
    await redis.del(cartKey(userId, priceMode))
    await redis.zrem(CART_ACTIVITY_ZSET, userId)
  }

  /**
   * Used by the abandoned-cart sweep worker. Returns userIds whose cart
   * hasn't been touched since before `cutoffMs` (epoch-ms), oldest activity
   * first — so the longest-idle carts are always processed first within a
   * batch, capped at `limit`. Each entry includes the raw activity score
   * (epoch-ms of last mutation) so the caller can compute exactly how long
   * the cart has been idle.
   *
   * @returns {Promise<Array<{userId: string, lastActivityMs: number}>>}
   */
  async getInactiveUserIds(cutoffMs, limit) {
    const flat = await redis.zrangebyscore(
      CART_ACTIVITY_ZSET,
      0,
      cutoffMs,
      'WITHSCORES',
      'LIMIT',
      0,
      limit
    )
    const result = []
    for (let i = 0; i < flat.length; i += 2) {
      result.push({ userId: flat[i], lastActivityMs: Number(flat[i + 1]) })
    }
    return result
  }

  /**
   * Removes a user's cart-activity entry — used when the sweep worker finds
   * a stale ZSET member with no live items left (e.g. every line item's
   * shop/product went inactive since the last activity), so it isn't
   * reprocessed forever.
   */
  async removeActivity(userId) {
    await redis.zrem(CART_ACTIVITY_ZSET, userId)
  }

  // ────────────────────────────────────────────────────────
  // PostgreSQL — multi-vendor product lookups
  // ────────────────────────────────────────────────────────

  /**
   * Find a single shop_product accessible to the user.
   *
   * Joins user_shop_allocations + shops + shop_products + products and only
   * returns the row if:
   *   - the shop is in the user's active allocations (Requirement 5.2)
   *   - the shop is active and not soft-deleted (Requirement 5.3)
   *   - the shop_product is not soft-deleted
   *
   * `is_available` is intentionally NOT filtered here so the service can
   * surface a precise error code (OUT_OF_STOCK / SHOP_PRODUCT_UNAVAILABLE)
   * to the caller.
   *
   * Phase 3: extended SELECT projection to include option/family/badge
   * fields used by the multi-option cart enrichment response.
   *
   * @param {string} userId
   * @param {string} productId
   * @param {string} shopId
   * @returns {Promise<object|null>}
   */
  async findShopProductForUser(userId, productId, shopId) {
    const { rows } = await query(
      `SELECT sp.id            AS shop_product_id,
              sp.shop_id,
              sp.product_id,
              sp.price         AS sp_price,
              sp.sale_price    AS sp_sale_price,
              sp.wholesale_price AS sp_wholesale_price,
              sp.stock_quantity,
              sp.max_order_qty,
              sp.is_available,
              p.name,
              p.slug,
              p.unit,
              p.thumbnail_url,
              p.is_active      AS product_active,
              p.price          AS product_price,
              p.brand          AS product_brand,
              p.sale_price     AS product_sale_price,
              p.category_id,
              p.product_family_id,
              p.option_label,
              p.net_quantity,
              p.food_type,
              p.origin_tag,
              p.custom_badges,
              p.display_delivery_minutes,
              pf.name          AS family_name,
              s.name           AS shop_name,
              s.is_active      AS shop_active
         FROM shop_products sp
         JOIN products p ON p.id = sp.product_id
         JOIN shops    s ON s.id = sp.shop_id
         LEFT JOIN product_families pf ON pf.id = p.product_family_id
         JOIN user_shop_allocations a
           ON a.shop_id = sp.shop_id
          AND a.user_id = $1
        WHERE sp.product_id  = $2
          AND sp.shop_id     = $3
          AND sp.deleted_at IS NULL
          AND s.is_active    = true
          AND s.deleted_at  IS NULL`,
      [userId, productId, shopId]
    )
    return rows[0] || null
  }

  /**
   * Resolve which shop a product should be added from when the caller does
   * not specify shop_id. Returns every active shop_products row across the
   * user's allocations, ordered with the primary allocation first.
   *
   * Used by the cart service to auto-pick a shop when the customer adds a
   * product that exists in exactly one of their allocated shops; ambiguous
   * cases are surfaced back to the caller (CART_SHOP_REQUIRED).
   *
   * @param {string} userId
   * @param {string} productId
   * @returns {Promise<Array<object>>}
   */
  async findShopProductsForProduct(userId, productId) {
    const { rows } = await query(
      `SELECT sp.id            AS shop_product_id,
              sp.shop_id,
              sp.product_id,
              sp.price         AS sp_price,
              sp.sale_price    AS sp_sale_price,
              sp.wholesale_price AS sp_wholesale_price,
              sp.stock_quantity,
              sp.max_order_qty,
              sp.is_available,
              s.name           AS shop_name,
              a.is_primary,
              a.distance_km
         FROM shop_products sp
         JOIN shops s
           ON s.id = sp.shop_id
         JOIN user_shop_allocations a
           ON a.shop_id = sp.shop_id
          AND a.user_id = $1
        WHERE sp.product_id  = $2
          AND sp.deleted_at IS NULL
          AND sp.is_available = true
          AND s.is_active    = true
          AND s.deleted_at  IS NULL
        ORDER BY a.is_primary DESC, a.distance_km ASC NULLS LAST`,
      [userId, productId]
    )
    return rows
  }

  /**
   * Phase 3: resolve a shop_product row by its id (the per-shop SKU id),
   * scoped to the customer's active allocations. Used when the Flutter
   * option popup sends `shopProductId` directly so the cart service can
   * derive (productId, shopId) without ambiguity.
   *
   * Returns the same enriched shape as `findShopProductForUser` so the
   * service can run identical validation regardless of which identity the
   * caller provided. NULL is returned when:
   *   - the shop_product is missing or soft-deleted
   *   - the shop is inactive or soft-deleted
   *   - the shop is not in the customer's allocations
   *
   * @param {string} userId
   * @param {string} shopProductId
   * @returns {Promise<object|null>}
   */
  async findShopProductByIdForUser(userId, shopProductId) {
    const { rows } = await query(
      `SELECT sp.id            AS shop_product_id,
              sp.shop_id,
              sp.product_id,
              sp.price         AS sp_price,
              sp.sale_price    AS sp_sale_price,
              sp.stock_quantity,
              sp.max_order_qty,
              sp.is_available,
              p.name,
              p.slug,
              p.unit,
              p.thumbnail_url,
              p.is_active      AS product_active,
              p.price          AS product_price,
              p.brand          AS product_brand,
              p.sale_price     AS product_sale_price,
              p.category_id,
              p.product_family_id,
              p.option_label,
              p.net_quantity,
              p.food_type,
              p.origin_tag,
              p.custom_badges,
              p.display_delivery_minutes,
              pf.name          AS family_name,
              s.name           AS shop_name,
              s.is_active      AS shop_active
         FROM shop_products sp
         JOIN products p ON p.id = sp.product_id
         JOIN shops    s ON s.id = sp.shop_id
         LEFT JOIN product_families pf ON pf.id = p.product_family_id
         JOIN user_shop_allocations a
           ON a.shop_id = sp.shop_id
          AND a.user_id = $1
        WHERE sp.id          = $2
          AND sp.deleted_at IS NULL
          AND s.is_active    = true
          AND s.deleted_at  IS NULL`,
      [userId, shopProductId]
    )
    return rows[0] || null
  }

  /**
   * Batch-load shop_product rows for a list of (productId, shopId) pairs
   * within the user's allocations. Used for cart enrichment and re-validation
   * at checkout (Requirement 12.3). Returns rows keyed by `${productId}:${shopId}`.
   *
   * Implementation note: PostgreSQL `unnest` is used to expand two parallel
   * arrays into a derived table, avoiding N+1 lookups while keeping the SQL
   * fully parameterized.
   *
   * @param {string} userId
   * @param {Array<{productId: string, shopId: string}>} pairs
   * @returns {Promise<Array<object>>}
   */
  async findShopProductsForCart(userId, pairs) {
    if (!Array.isArray(pairs) || pairs.length === 0) return []
    const productIds = pairs.map((p) => p.productId)
    const shopIds = pairs.map((p) => p.shopId)

    const { rows } = await query(
      `WITH targets AS (
         SELECT * FROM unnest($2::uuid[], $3::uuid[]) AS t(product_id, shop_id)
       )
       SELECT sp.id            AS shop_product_id,
              sp.shop_id,
              sp.product_id,
              sp.price         AS sp_price,
              sp.sale_price    AS sp_sale_price,
              sp.wholesale_price AS sp_wholesale_price,
              sp.stock_quantity,
              sp.max_order_qty,
              sp.is_available,
              p.name,
              p.slug,
              p.unit,
              p.thumbnail_url,
              p.is_active      AS product_active,
              p.price          AS product_price,
              p.brand          AS product_brand,
              p.sale_price     AS product_sale_price,
              p.category_id,
              p.product_family_id,
              p.option_label,
              p.net_quantity,
              p.food_type,
              p.origin_tag,
              p.custom_badges,
              p.display_delivery_minutes,
              pf.name          AS family_name,
              s.name           AS shop_name,
              s.is_active      AS shop_active
         FROM shop_products sp
         JOIN products p ON p.id = sp.product_id
         JOIN shops    s ON s.id = sp.shop_id
         LEFT JOIN product_families pf ON pf.id = p.product_family_id
         JOIN targets  t
           ON t.product_id = sp.product_id
          AND t.shop_id    = sp.shop_id
         JOIN user_shop_allocations a
           ON a.shop_id = sp.shop_id
          AND a.user_id = $1
        WHERE sp.deleted_at IS NULL
          AND s.deleted_at  IS NULL`,
      [userId, productIds, shopIds]
    )
    return rows
  }

  // ────────────────────────────────────────────────────────
  // Cart Extras (Tip & Instructions)
  // ────────────────────────────────────────────────────────

  /**
   * Get tip amount from Redis
   */
  async getTip(userId, priceMode = 'retail') {
    const tip = await redis.get(cartExtraKey(CART_TIP_PREFIX, userId, priceMode))
    return tip ? parseFloat(tip) : 0
  }

  /**
   * Set tip amount in Redis (7-day TTL)
   */
  async setTip(userId, amount, priceMode = 'retail') {
    await redis.set(cartExtraKey(CART_TIP_PREFIX, userId, priceMode), String(amount), 'EX', CART_TTL)
    await redis.zadd(CART_ACTIVITY_ZSET, Date.now(), userId)
  }

  /**
   * Clear tip amount
   */
  async clearTip(userId, priceMode = 'retail') {
    await redis.del(cartExtraKey(CART_TIP_PREFIX, userId, priceMode))
  }

  /**
   * Get delivery instructions from Redis
   */
  async getInstructions(userId, priceMode = 'retail') {
    return await redis.get(cartExtraKey(CART_INSTRUCTIONS_PREFIX, userId, priceMode)) || null
  }

  /**
   * Set delivery instructions in Redis (7-day TTL)
   */
  async setInstructions(userId, text, priceMode = 'retail') {
    if (text && text.trim()) {
      await redis.set(cartExtraKey(CART_INSTRUCTIONS_PREFIX, userId, priceMode), text.trim(), 'EX', CART_TTL)
      await redis.zadd(CART_ACTIVITY_ZSET, Date.now(), userId)
    } else {
      await this.clearInstructions(userId, priceMode)
    }
  }

  /**
   * Clear delivery instructions
   */
  async clearInstructions(userId, priceMode = 'retail') {
    await redis.del(cartExtraKey(CART_INSTRUCTIONS_PREFIX, userId, priceMode))
  }

  /**
   * Backward-compatible alias for existing callers
   */
  async getDeliveryInstructions(userId) {
    return this.getInstructions(userId)
  }

  /**
   * Backward-compatible alias for existing callers
   */
  async setDeliveryInstructions(userId, instructions) {
    await this.setInstructions(userId, instructions)
  }

  /**
   * Clear tip and instructions on order placement
   */
  async clearExtras(userId, priceMode = 'retail') {
    await Promise.all([
      this.clearTip(userId, priceMode),
      this.clearInstructions(userId, priceMode),
    ])
  }
}
