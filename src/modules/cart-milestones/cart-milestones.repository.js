import { query } from '../../config/database.js'

const COLUMNS = `
  id, name, min_cart_amount, reward_type, reward_value, reward_percent, max_discount,
  unlock_coupon_id, message_before, message_after, icon_url, is_active,
  applicable_user_type, applicable_segment_id, excluded_segment_id, exclude_first_time_users,
  stackable_with_coupon,
  priority, cashback_credit_trigger, usage_limit_per_user, grants_free_delivery,
  applicable_category_ids, applicable_product_ids,
  created_by, created_at, updated_at
`

export class CartMilestonesRepository {
  async findAll() {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM cart_milestones ORDER BY min_cart_amount ASC`
    )
    return rows.map(this._format)
  }

  async findById(id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM cart_milestones WHERE id = $1`, [id])
    return rows[0] ? this._format(rows[0]) : null
  }

  /** All active milestones ordered by tier — used to build the full progress ladder. */
  async findAllActive() {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM cart_milestones WHERE is_active = true ORDER BY min_cart_amount ASC`
    )
    return rows.map(this._format)
  }

  /**
   * True once userId has placed a real order (any status except
   * CANCELLED — including PENDING, since a reward is consumed the moment
   * an order is placed, not once delivered) — same check used by
   * FIRST_TIME coupon targeting (coupons.repository.js) and
   * first-time-offers.repository.js. See those for the full rationale,
   * including why PENDING doesn't reopen the old stuck-payment problem
   * (payment-expiry.worker.js auto-cancels an abandoned online payment
   * within 15 minutes) and the delivered_at-based regression this
   * replaced (it let a customer place several orders before the first one
   * ever reached DELIVERED, each still counting as "first-time").
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

  async create(data) {
    const { rows } = await query(
      `INSERT INTO cart_milestones (
         name, min_cart_amount, reward_type, reward_value, reward_percent, max_discount,
         unlock_coupon_id, message_before, message_after, icon_url,
         applicable_user_type, applicable_segment_id, excluded_segment_id, exclude_first_time_users,
         stackable_with_coupon,
         priority, cashback_credit_trigger, usage_limit_per_user, grants_free_delivery,
         applicable_category_ids, applicable_product_ids,
         created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
       RETURNING ${COLUMNS}`,
      [
        data.name,
        data.minCartAmount,
        data.rewardType,
        data.rewardValue ?? null,
        data.rewardPercent ?? null,
        data.maxDiscount ?? null,
        data.unlockCouponId ?? null,
        data.messageBefore ?? null,
        data.messageAfter ?? null,
        data.iconUrl ?? null,
        data.applicableUserType ?? 'ALL',
        data.applicableSegmentId ?? null,
        data.excludedSegmentId ?? null,
        !!data.excludeFirstTimeUsers,
        data.stackableWithCoupon ?? true,
        data.priority ?? 0,
        data.cashbackCreditTrigger ?? 'ORDER_DELIVERED',
        data.usageLimitPerUser ?? null,
        !!data.grantsFreeDelivery,
        data.applicableCategoryIds?.length ? data.applicableCategoryIds : null,
        data.applicableProductIds?.length ? data.applicableProductIds : null,
        data.createdBy ?? null,
      ]
    )
    return this._format(rows[0])
  }

  async update(id, data) {
    const fields = []
    const params = []
    let idx = 1
    const fieldMap = {
      name: 'name',
      minCartAmount: 'min_cart_amount',
      rewardType: 'reward_type',
      rewardValue: 'reward_value',
      rewardPercent: 'reward_percent',
      maxDiscount: 'max_discount',
      unlockCouponId: 'unlock_coupon_id',
      messageBefore: 'message_before',
      messageAfter: 'message_after',
      iconUrl: 'icon_url',
      isActive: 'is_active',
      applicableUserType: 'applicable_user_type',
      applicableSegmentId: 'applicable_segment_id',
      excludedSegmentId: 'excluded_segment_id',
      excludeFirstTimeUsers: 'exclude_first_time_users',
      stackableWithCoupon: 'stackable_with_coupon',
      priority: 'priority',
      cashbackCreditTrigger: 'cashback_credit_trigger',
      usageLimitPerUser: 'usage_limit_per_user',
      grantsFreeDelivery: 'grants_free_delivery',
      applicableCategoryIds: 'applicable_category_ids',
      applicableProductIds: 'applicable_product_ids',
    }
    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        const isArrayScopeField = jsKey === 'applicableCategoryIds' || jsKey === 'applicableProductIds'
        fields.push(`${dbKey} = $${idx++}`)
        params.push(isArrayScopeField && !data[jsKey]?.length ? null : data[jsKey])
      }
    }
    if (fields.length === 0) return this.findById(id)
    fields.push(`updated_at = NOW()`)
    params.push(id)
    const { rows } = await query(
      `UPDATE cart_milestones SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${COLUMNS}`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async delete(id) {
    const result = await query(`DELETE FROM cart_milestones WHERE id = $1`, [id])
    return result.rowCount > 0
  }

  /**
   * How many times this user has already redeemed this milestone's reward.
   *
   * recordUsage() below fires the moment an order is CREATED — same
   * "consumed at placement, not delivery" timing as hasPriorOrder()
   * (deliberate; see that method's own doc comment) — so a usage row can
   * exist for an order that never actually completed: a Razorpay payment
   * the customer cancelled, or one the payment-expiry worker later
   * auto-cancelled. Unlike hasPriorOrder(), this was a bare COUNT(*) with
   * no idea what became of the order it belongs to, so a single cancelled
   * attempt permanently burned a usageLimitPerUser slot — e.g. a
   * FIRST_TIME milestone with usageLimitPerUser=1 (the natural setting for
   * a first-order reward) would lock a customer out forever after one
   * cancelled first attempt, even though _isEligible()'s own FIRST_TIME/
   * hasPriorOrder() check right below this one would have correctly said
   * they're still eligible. Reported: "first order failed [payment
   * cancelled]... first-time [milestone] offer show[s] gone."
   *
   * LEFT JOIN (not INNER) — order_id is nullable on cart_milestone_usages,
   * so a usage row with no linked order at all still counts, same as
   * before this fix; only a usage whose order is confirmed CANCELLED is
   * excluded.
   */
  async getUserUsageCount(milestoneId, userId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count FROM cart_milestone_usages cmu
       LEFT JOIN orders o ON o.id = cmu.order_id
       WHERE cmu.cart_milestone_id = $1 AND cmu.user_id = $2
         AND (o.id IS NULL OR o.status != 'CANCELLED')`,
      [milestoneId, userId]
    )
    return rows[0].count
  }

  /** Record a redemption — called once per order right after the reward is applied. */
  async recordUsage(milestoneId, userId, orderId) {
    await query(
      `INSERT INTO cart_milestone_usages (cart_milestone_id, user_id, order_id)
       VALUES ($1, $2, $3)`,
      [milestoneId, userId, orderId]
    )
  }

  /**
   * Of `cartProductIds`, which ones fall inside a milestone's
   * applicable_category_ids/applicable_product_ids scope. Identical logic
   * to CouponsRepository#resolveMatchingProductIds and
   * FirstTimeOffersRepository#resolveMatchingProductIds — a category id can
   * be an ordinary/sub-category (products.category_id) or a BUNDLE (matched
   * via category_products). No scope at all means "matches everything", the
   * safe default that keeps existing unscoped milestones unchanged.
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
   * Human-readable names for a set of category ids — lets an "add X to
   * unlock this milestone" teaser name the actual category/bundle instead
   * of a generic "specific products". Identical to CouponsRepository's and
   * FirstTimeOffersRepository's version.
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
   * getCategoryNames(), for milestones scoped to specific products.
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

  _format(row) {
    return {
      id: row.id,
      name: row.name,
      minCartAmount: parseFloat(row.min_cart_amount),
      rewardType: row.reward_type,
      rewardValue: row.reward_value != null ? parseFloat(row.reward_value) : null,
      rewardPercent: row.reward_percent != null ? parseFloat(row.reward_percent) : null,
      maxDiscount: row.max_discount != null ? parseFloat(row.max_discount) : null,
      unlockCouponId: row.unlock_coupon_id,
      messageBefore: row.message_before,
      messageAfter: row.message_after,
      iconUrl: row.icon_url,
      isActive: row.is_active,
      applicableUserType: row.applicable_user_type,
      applicableSegmentId: row.applicable_segment_id,
      excludedSegmentId: row.excluded_segment_id,
      excludeFirstTimeUsers: row.exclude_first_time_users,
      stackableWithCoupon: row.stackable_with_coupon,
      priority: row.priority,
      cashbackCreditTrigger: row.cashback_credit_trigger,
      usageLimitPerUser: row.usage_limit_per_user,
      grantsFreeDelivery: row.grants_free_delivery,
      applicableCategoryIds: row.applicable_category_ids,
      applicableProductIds: row.applicable_product_ids,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
