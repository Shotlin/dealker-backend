import { query } from '../../config/database.js'

/**
 * Coupons repository — all SQL queries for coupons.
 *
 * Multi-vendor extensions (migration 044, design §3.2.6, R26.1):
 *   coupon_type, absorber, shop_id, applicable_shop_ids,
 *   applicable_category_ids, applicable_product_ids, usage_limit_total,
 *   usage_limit_per_user, created_by
 *
 * The legacy single-vendor columns (`usage_limit`, `used_count`,
 * `per_user_limit`) are intentionally retained so the existing
 * single-vendor checkout flow keeps working until the service layer is
 * migrated to the multi-vendor application algorithm in task 9.2.
 */
const COUPON_COLUMNS = `
  id, code, description, terms,
  discount_type, discount_value,
  min_order_amount, max_discount,
  usage_limit, used_count, per_user_limit,
  valid_from, valid_until,
  is_active,
  coupon_type, absorber, shop_id,
  applicable_shop_ids, applicable_category_ids, applicable_product_ids,
  usage_limit_total, usage_limit_per_user,
  target_type, target_segment_id,
  cashback_credit_trigger,
  grants_free_delivery,
  created_by,
  created_at, updated_at
`

export class CouponsRepository {
  /**
   * Find active coupon by code (case-insensitive)
   */
  async findByCode(code) {
    const { rows } = await query(
      `SELECT ${COUPON_COLUMNS}
       FROM coupons
       WHERE UPPER(code) = UPPER($1)`,
      [code]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Find coupon by ID
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT ${COUPON_COLUMNS}
       FROM coupons WHERE id = $1`,
      [id]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Get user's usage count for a coupon
   */
  async getUserUsageCount(couponId, userId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count FROM coupon_usages
       WHERE coupon_id = $1 AND user_id = $2`,
      [couponId, userId]
    )
    return rows[0].count
  }

  /**
   * Get total usage count for a coupon (across all users).
   * Used by task 9.4 validation for usage_limit_total.
   */
  async getTotalUsageCount(couponId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count FROM coupon_usages
       WHERE coupon_id = $1`,
      [couponId]
    )
    return rows[0].count
  }

  /**
   * Record coupon usage. `shopId`/`discountAmount` are optional so callers
   * that don't have them yet keep working; when provided, they also
   * populate the migration-044 columns (`shop_id`, `discount_amount`,
   * `customer_id`) that the live checkout path previously left NULL.
   */
  async recordUsage(couponId, userId, orderId, { shopId, discountAmount } = {}) {
    await query(
      `INSERT INTO coupon_usages (coupon_id, user_id, order_id, shop_id, discount_amount, customer_id)
       VALUES ($1, $2, $3, $4, $5, $2)`,
      [couponId, userId, orderId, shopId ?? null, discountAmount ?? null]
    )
    await query(
      `UPDATE coupons SET used_count = used_count + 1, updated_at = NOW() WHERE id = $1`,
      [couponId]
    )
  }

  /**
   * True once userId has placed a real order — used by FIRST_TIME coupon
   * targeting. Real-time (not cached) so it can't go stale; re-checked
   * inside the order-creation transaction as the final source of truth
   * (never trust the cart-preview-time check alone).
   *
   * A coupon is consumed the moment the order is PLACED (recordUsage runs
   * at order creation/payment confirmation, never waits for delivery), so
   * this counts EVERY status except CANCELLED, including PENDING. Placing
   * a second order while the first is still sitting PENDING must not look
   * "first-time" again just because nothing has been confirmed yet.
   *
   * This does not reopen the old stuck-payment problem: an abandoned
   * ONLINE payment doesn't stay PENDING forever — payment-expiry.worker.js
   * auto-cancels it (and restores stock) within its 15-minute payment
   * window, at which point it's CANCELLED and correctly stops counting.
   * COD orders skip PENDING entirely (order-splitter.service.js creates
   * them straight into CONFIRMED), so there's no equivalent window there.
   *
   * Regression history: this checked `delivered_at IS NOT NULL` for a
   * while, which avoided the stuck-payment problem but reopened a worse
   * one — a customer could place several orders back-to-back (or over
   * several days) before the first one ever reached DELIVERED, each one
   * still looking "first-time" and getting the discount again. Reported:
   * the same first-time discount applied on three separate real orders
   * for one customer.
   */
  async hasPriorOrder(userId) {
    const { rows } = await query(
      `SELECT EXISTS(
         SELECT 1 FROM orders WHERE user_id = $1 AND status != 'CANCELLED'
       ) AS has_prior`,
      [userId]
    )
    return rows[0].has_prior
  }

  /** True if userId is in a coupon's individual-target list. */
  async isTargetUser(couponId, userId) {
    const { rows } = await query(
      `SELECT 1 FROM coupon_target_users WHERE coupon_id = $1 AND user_id = $2 LIMIT 1`,
      [couponId, userId]
    )
    return rows.length > 0
  }

  /** Replace a coupon's individual-target user list wholesale. */
  async setTargetUsers(couponId, userIds) {
    await query(`DELETE FROM coupon_target_users WHERE coupon_id = $1`, [couponId])
    if (userIds?.length) {
      await query(
        `INSERT INTO coupon_target_users (coupon_id, user_id)
         SELECT $1, uid FROM UNNEST($2::uuid[]) AS uid
         ON CONFLICT (coupon_id, user_id) DO NOTHING`,
        [couponId, userIds]
      )
    }
  }

  /**
   * Add a single user to a coupon's individual-target list without
   * touching existing entries — used by the COUPON_UNLOCK first-time-offer
   * reward, which must not wipe other already-unlocked/admin-added users
   * the way setTargetUsers()'s wholesale replace would.
   */
  async addTargetUser(couponId, userId) {
    await query(
      `INSERT INTO coupon_target_users (coupon_id, user_id) VALUES ($1, $2)
       ON CONFLICT (coupon_id, user_id) DO NOTHING`,
      [couponId, userId]
    )
  }

  /** List a coupon's individually-targeted customers, enriched for admin display. */
  async getTargetUsers(couponId) {
    const { rows } = await query(
      `SELECT u.id, u.name, u.phone, u.email
       FROM coupon_target_users ctu
       INNER JOIN users u ON u.id = ctu.user_id
       WHERE ctu.coupon_id = $1
       ORDER BY u.name`,
      [couponId]
    )
    return rows
  }

  /**
   * Get all active/valid coupons
   */
  async findAvailable() {
    const { rows } = await query(
      `SELECT ${COUPON_COLUMNS}
       FROM coupons
       WHERE is_active = true
         AND (valid_from IS NULL OR valid_from <= NOW())
         AND (valid_until IS NULL OR valid_until >= NOW())
         AND (usage_limit IS NULL OR used_count < usage_limit)
       ORDER BY created_at DESC`
    )
    return rows.map(this._format)
  }

  /**
   * List all coupons — admin (paginated)
   */
  async findAll({ limit, offset }) {
    const { rows } = await query(
      `SELECT ${COUPON_COLUMNS}
       FROM coupons
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    )
    const { rows: countRows } = await query(`SELECT COUNT(*)::int AS total FROM coupons`)
    return { data: rows.map(this._format), total: countRows[0].total }
  }

  /**
   * Create a coupon.
   *
   * Defaults:
   *   - couponType  → 'PLATFORM_COUPON'
   *   - absorber    → 'PLATFORM' for PLATFORM_COUPON, 'SHOP' for
   *                   SHOP_COUPON, 'PLATFORM' otherwise.
   *
   * Cross-field consistency (e.g. SHOP_COUPON → shop_id required, or
   * PLATFORM_COUPON → absorber must be 'PLATFORM') is enforced by both
   * the DB CHECK constraints (chk_coupons_shop_required,
   * chk_coupons_platform_absorber from migration 044) and the service
   * layer in task 9.2.
   */
  async create(data) {
    const couponType = data.couponType || 'PLATFORM_COUPON'
    const absorber =
      data.absorber || (couponType === 'SHOP_COUPON' ? 'SHOP' : 'PLATFORM')

    const { rows } = await query(
      `INSERT INTO coupons (
         code, description, terms,
         discount_type, discount_value,
         min_order_amount, max_discount,
         usage_limit, per_user_limit,
         valid_from, valid_until,
         coupon_type, absorber, shop_id,
         applicable_shop_ids, applicable_category_ids, applicable_product_ids,
         usage_limit_total, usage_limit_per_user,
         target_type, target_segment_id,
         cashback_credit_trigger,
         grants_free_delivery,
         created_by
       )
       VALUES (
         UPPER($1), $2, $3,
         $4, $5,
         $6, $7,
         $8, $9,
         $10, $11,
         $12, $13, $14,
         $15, $16, $17,
         $18, $19,
         $20, $21,
         $22,
         $23,
         $24
       )
       RETURNING ${COUPON_COLUMNS}`,
      [
        data.code,
        data.description ?? null,
        data.terms ?? null,
        data.discountType,
        data.discountValue,
        data.minOrderAmount ?? 0,
        data.maxDiscount ?? null,
        data.usageLimit ?? null,
        data.perUserLimit ?? 1,
        data.validFrom ?? null,
        data.validUntil ?? null,
        couponType,
        absorber,
        data.shopId ?? null,
        data.applicableShopIds ?? null,
        data.applicableCategoryIds ?? null,
        data.applicableProductIds ?? null,
        data.usageLimitTotal ?? null,
        data.usageLimitPerUser ?? 1,
        data.targetType ?? 'ALL',
        data.targetSegmentId ?? null,
        data.cashbackCreditTrigger ?? 'ORDER_DELIVERED',
        !!data.grantsFreeDelivery,
        data.createdBy ?? null,
      ]
    )
    const coupon = this._format(rows[0])
    if (data.targetType === 'INDIVIDUAL' && data.targetUserIds?.length) {
      await this.setTargetUsers(coupon.id, data.targetUserIds)
    }
    return coupon
  }

  /**
   * Update a coupon
   */
  async update(id, data) {
    const fields = []
    const params = []
    let idx = 1

    const fieldMap = {
      code:                  'code',
      description:           'description',
      terms:                 'terms',
      discountType:          'discount_type',
      discountValue:         'discount_value',
      minOrderAmount:        'min_order_amount',
      maxDiscount:           'max_discount',
      usageLimit:            'usage_limit',
      perUserLimit:          'per_user_limit',
      validFrom:             'valid_from',
      validUntil:            'valid_until',
      isActive:              'is_active',
      couponType:            'coupon_type',
      absorber:              'absorber',
      shopId:                'shop_id',
      applicableShopIds:     'applicable_shop_ids',
      applicableCategoryIds: 'applicable_category_ids',
      applicableProductIds:  'applicable_product_ids',
      usageLimitTotal:       'usage_limit_total',
      usageLimitPerUser:     'usage_limit_per_user',
      targetType:            'target_type',
      targetSegmentId:       'target_segment_id',
      cashbackCreditTrigger: 'cashback_credit_trigger',
      grantsFreeDelivery:    'grants_free_delivery',
      createdBy:             'created_by',
    }

    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        const val = jsKey === 'code' ? String(data[jsKey]).toUpperCase() : data[jsKey]
        fields.push(`${dbKey} = $${idx++}`)
        params.push(val)
      }
    }

    if (data.targetUserIds !== undefined) {
      await this.setTargetUsers(id, data.targetUserIds)
    }

    if (fields.length === 0) return this.findById(id)

    fields.push(`updated_at = NOW()`)
    params.push(id)

    const { rows } = await query(
      `UPDATE coupons SET ${fields.join(', ')} WHERE id = $${idx}
       RETURNING ${COUPON_COLUMNS}`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Of `cartProductIds`, which ones fall inside a coupon's
   * applicable_category_ids/applicable_product_ids scope. A category id in
   * `applicableCategoryIds` can be either an ordinary/sub- category
   * (matched via products.category_id directly) or a BUNDLE-type category
   * (066_category_bundles_and_ranking.sql — bundle membership lives in
   * category_products, not products.category_id), so both are checked with
   * one OR — the caller never needs to know or care which kind of id it
   * passed. No `applicableCategoryIds`/`applicableProductIds` at all means
   * the coupon is unscoped: every cart product matches (the safe default
   * that keeps existing PLATFORM_COUPON behavior unchanged).
   *
   * @param {string[]} cartProductIds
   * @param {{applicableCategoryIds?: string[]|null, applicableProductIds?: string[]|null}} scope
   * @returns {Promise<Set<string>>} matching product ids
   */
  async resolveMatchingProductIds(cartProductIds, { applicableCategoryIds, applicableProductIds } = {}) {
    const hasProductScope = Array.isArray(applicableProductIds) && applicableProductIds.length > 0
    const hasCategoryScope = Array.isArray(applicableCategoryIds) && applicableCategoryIds.length > 0

    if (!hasProductScope && !hasCategoryScope) {
      return new Set(cartProductIds)
    }
    if (cartProductIds.length === 0) {
      return new Set()
    }

    const { rows } = await query(
      `SELECT DISTINCT p.id AS product_id
         FROM products p
        WHERE p.id = ANY($1::uuid[])
          AND (
               ($2::uuid[] IS NOT NULL AND p.id = ANY($2::uuid[]))
            OR ($3::uuid[] IS NOT NULL AND (
                     p.category_id = ANY($3::uuid[])
                  OR EXISTS (
                       SELECT 1 FROM category_products cp
                       WHERE cp.product_id = p.id AND cp.category_id = ANY($3::uuid[])
                     )
                ))
              )`,
      [
        cartProductIds,
        hasProductScope ? applicableProductIds : null,
        hasCategoryScope ? applicableCategoryIds : null,
      ]
    )
    return new Set(rows.map((r) => r.product_id))
  }

  /**
   * Human-readable names for a set of category ids — lets the "this coupon
   * doesn't match your cart" message name the actual category (e.g. "Fresh
   * Vegetables") instead of a generic "specific products or categories".
   *
   * @param {string[]} categoryIds
   * @returns {Promise<string[]>}
   */
  async getCategoryNames(categoryIds) {
    if (!Array.isArray(categoryIds) || categoryIds.length === 0) return []
    const { rows } = await query(
      `SELECT name FROM categories WHERE id = ANY($1::uuid[]) ORDER BY name ASC`,
      [categoryIds]
    )
    return rows.map((r) => r.name)
  }

  /**
   * Human-readable names for a set of product ids — same purpose as
   * getCategoryNames(), for coupons scoped to specific products instead of
   * (or in addition to) categories.
   *
   * @param {string[]} productIds
   * @returns {Promise<string[]>}
   */
  async getProductNames(productIds) {
    if (!Array.isArray(productIds) || productIds.length === 0) return []
    const { rows } = await query(
      `SELECT name FROM products WHERE id = ANY($1::uuid[]) ORDER BY name ASC`,
      [productIds]
    )
    return rows.map((r) => r.name)
  }

  /**
   * Delete a coupon
   */
  async delete(id) {
    const result = await query(`DELETE FROM coupons WHERE id = $1`, [id])
    return result.rowCount > 0
  }

  _format(row) {
    return {
      id:                    row.id,
      code:                  row.code,
      description:           row.description,
      terms:                 row.terms,
      discountType:          row.discount_type,
      discountValue:         parseFloat(row.discount_value),
      minOrderAmount:        parseFloat(row.min_order_amount),
      maxDiscount:           row.max_discount != null ? parseFloat(row.max_discount) : null,
      usageLimit:            row.usage_limit,
      usedCount:             row.used_count,
      perUserLimit:          row.per_user_limit,
      validFrom:             row.valid_from,
      validUntil:            row.valid_until,
      isActive:              row.is_active,
      couponType:            row.coupon_type,
      absorber:              row.absorber,
      shopId:                row.shop_id,
      applicableShopIds:     row.applicable_shop_ids,
      applicableCategoryIds: row.applicable_category_ids,
      applicableProductIds:  row.applicable_product_ids,
      usageLimitTotal:       row.usage_limit_total,
      usageLimitPerUser:     row.usage_limit_per_user,
      targetType:            row.target_type,
      targetSegmentId:       row.target_segment_id,
      cashbackCreditTrigger: row.cashback_credit_trigger,
      grantsFreeDelivery:    row.grants_free_delivery,
      createdBy:             row.created_by,
      createdAt:             row.created_at,
      updatedAt:             row.updated_at,
    }
  }

  /**
   * Usage analytics for one coupon — redemption count/revenue/avg order
   * value plus a daily breakdown and top-users leaderboard. Everything is
   * derived from coupon_usages joined to orders (for the amount actually
   * paid) and users (for a display name) — no separate analytics table.
   */
  async getAnalytics(couponId) {
    const { rows: overviewRows } = await query(
      `SELECT
         COUNT(cu.id)::int                        AS total_redemptions,
         COALESCE(SUM(o.total_payable), 0)          AS revenue_generated,
         COALESCE(AVG(o.total_payable), 0)          AS avg_order_value,
         COALESCE(AVG(cu.discount_amount), 0)      AS avg_discount
       FROM coupon_usages cu
       LEFT JOIN orders o ON o.id = cu.order_id
       WHERE cu.coupon_id = $1`,
      [couponId]
    )
    const overview = overviewRows[0]

    const { rows: dailyRows } = await query(
      `SELECT
         TO_CHAR(cu.used_at, 'YYYY-MM-DD') AS date,
         COUNT(cu.id)::int                 AS count,
         COALESCE(SUM(o.total_payable), 0)  AS revenue
       FROM coupon_usages cu
       LEFT JOIN orders o ON o.id = cu.order_id
       WHERE cu.coupon_id = $1
       GROUP BY 1
       ORDER BY 1 ASC`,
      [couponId]
    )

    const { rows: topUserRows } = await query(
      `SELECT
         COALESCE(u.name, u.phone, 'Unknown') AS name,
         COUNT(cu.id)::int                    AS uses,
         COALESCE(SUM(o.total_payable), 0)     AS total_spent
       FROM coupon_usages cu
       LEFT JOIN orders o ON o.id = cu.order_id
       LEFT JOIN users u ON u.id = cu.user_id
       WHERE cu.coupon_id = $1
       GROUP BY u.id, u.name, u.phone
       ORDER BY uses DESC, total_spent DESC
       LIMIT 10`,
      [couponId]
    )

    return {
      totalRedemptions: overview.total_redemptions,
      revenueGenerated: parseFloat(overview.revenue_generated),
      avgOrderValue: parseFloat(overview.avg_order_value),
      avgDiscount: parseFloat(overview.avg_discount),
      dailyRedemptions: dailyRows.map((r) => ({
        date: r.date,
        count: r.count,
        revenue: parseFloat(r.revenue),
      })),
      topUsers: topUserRows.map((r) => ({
        name: r.name,
        uses: r.uses,
        totalSpent: parseFloat(r.total_spent),
      })),
    }
  }
}
