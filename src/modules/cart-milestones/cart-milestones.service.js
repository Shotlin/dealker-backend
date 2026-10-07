import { logger } from '../../config/logger.js'
import { emit as emitAudit } from '../../utils/audit-log.js'
import { CartMilestonesRepository } from './cart-milestones.repository.js'
import { CustomerSegmentsRepository } from '../admin/customer-segments/customer-segments.repository.js'
import { CouponsRepository } from '../coupons/coupons.repository.js'

export class CartMilestonesService {
  constructor(
    repository = new CartMilestonesRepository(),
    segmentsRepo = new CustomerSegmentsRepository(),
    couponsRepo = new CouponsRepository()
  ) {
    this.repo = repository
    this.segmentsRepo = segmentsRepo
    this.couponsRepo = couponsRepo
  }

  async listAll() {
    return this.repo.findAll()
  }

  async getDetail(id) {
    return this.repo.findById(id)
  }

  /** Is this milestone visible/applicable to this user at all (independent of cart value)? */
  async _isEligible(milestone, userId) {
    if (milestone.usageLimitPerUser != null) {
      const usage = await this.repo.getUserUsageCount(milestone.id, userId)
      if (usage >= milestone.usageLimitPerUser) return false
    }
    if (milestone.applicableUserType === 'FIRST_TIME') {
      return !(await this.repo.hasPriorOrder(userId))
    }
    if (milestone.applicableUserType === 'SEGMENT') {
      return milestone.applicableSegmentId
        ? this.segmentsRepo.isMember(milestone.applicableSegmentId, userId)
        : false
    }
    // ALL — optionally minus one excluded segment (106_cart_milestone_
    // excluded_segment.sql) and/or minus first-time customers
    // (107_cart_milestone_exclude_first_time.sql). Both let an admin carve
    // a group that already has its own dedicated reward (a segment-scoped
    // milestone, or the separate First-Time Offer feature) out of a
    // broader "All users" one, so that group doesn't double-dip on both
    // rewards for the same purchase. FIRST_TIME/SEGMENT above never
    // consult either — they already run their own single-audience rule.
    if (milestone.excludeFirstTimeUsers) {
      const isFirstTime = !(await this.repo.hasPriorOrder(userId))
      if (isFirstTime) return false
    }
    if (milestone.excludedSegmentId) {
      const isExcluded = await this.segmentsRepo.isMember(milestone.excludedSegmentId, userId)
      if (isExcluded) return false
    }
    return true
  }

  /**
   * All active milestones this user is eligible for, ordered ascending by
   * tier — the raw ladder, independent of cart value.
   *
   * When `cartTotal` is provided, each returned tier is also annotated with
   * `hasScope`/`scopedSubtotal` (see #_scopedSubtotal) so callers building
   * a cart-value-aware view (getProgress below, and the bill-summary reward
   * ladder) don't need to re-resolve scope matching themselves. Omit
   * `cartTotal` for the plain eligibility-only list — every existing caller
   * that doesn't care about cart value keeps working unchanged.
   *
   * @param {string} userId
   * @param {number|null} [cartTotal]
   * @param {Array<object>|null} [cartItems] - current cart lines; only
   *   needed when an active milestone has a category/product scope (see
   *   #_scopedSubtotal for the exact shape expected).
   */
  async getEligibleTiers(userId, cartTotal = null, cartItems = null) {
    const active = await this.repo.findAllActive()
    const eligible = []
    for (const m of active) {
      if (!(await this._isEligible(m, userId))) continue
      if (cartTotal == null) {
        eligible.push(m)
        continue
      }
      const { hasScope, scopedSubtotal } = await this._scopedSubtotal(m, cartTotal, cartItems)
      eligible.push({ ...m, hasScope, scopedSubtotal })
    }
    return eligible
  }

  /**
   * How much of the cart counts toward a milestone's min_cart_amount — the
   * full cart total for an unscoped milestone, or just the matching slice
   * (via applicable_category_ids/applicable_product_ids, resolved the same
   * way as coupons/first-time-offers) for a scoped one. Mirrors
   * FirstTimeOffersService#_evaluateCandidates's scoping step.
   *
   * @param {object} milestone
   * @param {number} cartTotal
   * @param {Array<{productId:string, lineTotal?:number, effectivePrice?:number, quantity?:number}>|null} cartItems -
   *   omit for an unscoped milestone; a scoped milestone with no cartItems
   *   simply never matches (same fail-safe as coupons/first-time-offers).
   */
  async _scopedSubtotal(milestone, cartTotal, cartItems) {
    const hasScope = (milestone.applicableCategoryIds?.length > 0) || (milestone.applicableProductIds?.length > 0)
    if (!hasScope) {
      return { hasScope: false, scopedSubtotal: cartTotal }
    }
    const items = cartItems || []
    const matchingIds = await this.repo.resolveMatchingProductIds(
      items.map((i) => i.productId),
      { applicableCategoryIds: milestone.applicableCategoryIds, applicableProductIds: milestone.applicableProductIds }
    )
    const scopedSubtotal = parseFloat(
      items
        .filter((i) => matchingIds.has(i.productId))
        .reduce((sum, i) => sum + Number(i.lineTotal ?? i.effectivePrice * i.quantity), 0)
        .toFixed(2)
    )
    return { hasScope: true, scopedSubtotal }
  }

  /**
   * Build the "next milestone" progress for the Smart Bottom Bar / bill
   * summary: the highest tier already unlocked by the current cart value
   * (if any) and the lowest tier still ahead (if any), both scoped to
   * milestones this user is actually eligible for.
   *
   * @param {string} userId
   * @param {number} cartTotal
   * @param {Array<object>|null} [cartItems] - see #_scopedSubtotal; only
   *   needed when an active milestone has a category/product scope.
   */
  async getProgress(userId, cartTotal, cartItems = null) {
    const eligible = await this.getEligibleTiers(userId, cartTotal, cartItems)

    let unlockedMilestone = null
    let nextMilestone = null
    for (const m of eligible) {
      // A scoped milestone needs at least one matching item actually in the
      // cart — checked independent of minCartAmount, which defaults to 0
      // and would otherwise let "zero matching items" (scopedSubtotal 0)
      // look "satisfied" by `0 >= 0`. Same guard as
      // FirstTimeOffersService#_evaluateCandidates.
      const satisfied = m.hasScope
        ? m.scopedSubtotal > 0 && m.scopedSubtotal >= m.minCartAmount
        : m.scopedSubtotal >= m.minCartAmount
      if (satisfied) {
        // Tiers are ordered ascending, so the last one that's satisfied is
        // the best — this stays correct even when different tiers have
        // different scopes (and so aren't necessarily satisfied in a
        // strictly monotonic order): a later, higher-value tier that IS
        // satisfied always wins over an earlier one that isn't.
        unlockedMilestone = m
      } else if (!nextMilestone) {
        nextMilestone = m
      }
    }

    return {
      unlocked: unlockedMilestone
        ? { ...unlockedMilestone, message: unlockedMilestone.messageAfter || `${unlockedMilestone.name} unlocked` }
        : null,
      next: nextMilestone
        ? {
            ...nextMilestone,
            amountToUnlock: Math.max(0, Math.round((nextMilestone.minCartAmount - nextMilestone.scopedSubtotal) * 100) / 100),
            message: await this._renderNextMessage(nextMilestone),
          }
        : null,
    }
  }

  _renderMessage(milestone, cartTotal) {
    const amountToUnlock = Math.round((milestone.minCartAmount - cartTotal) * 100) / 100
    const template = milestone.messageBefore || `Add ₹{amount} more to unlock {name}`
    return template
      .replace('{amount}', String(amountToUnlock))
      .replace('{name}', milestone.name)
  }

  /**
   * The "next milestone" teaser message — {amount}/{name} template
   * substitution via _renderMessage.
   *
   * Used to also append "— only X, Y count toward this" for a scoped
   * milestone (103_cart_milestone_scope.sql), naming the actual matching
   * category/bundle/products — deliberately dropped per product decision:
   * the admin wants the smart bar to show just the milestone's own message/
   * name, not an auto-generated scope breakdown alongside it. That
   * clarification was originally added because the plain "Add ₹30 more to
   * unlock FREE DELIVERY" text read as a broken promise when unrelated
   * items didn't move the gap — if that confusion resurfaces, the fix is a
   * clearer admin-authored messageBefore for that milestone, not this
   * backend-generated suffix.
   */
  async _renderNextMessage(milestone) {
    return this._renderMessage(milestone, milestone.scopedSubtotal)
  }

  /**
   * Resolve the best-fit (highest unlocked) milestone reward for checkout,
   * or null.
   *
   * @param {string} userId
   * @param {number} cartTotal
   * @param {Array<object>|null} [cartItems] - see #_scopedSubtotal; only
   *   needed when an active milestone has a category/product scope.
   */
  async resolveForCheckout(userId, cartTotal, cartItems = null) {
    const progress = await this.getProgress(userId, cartTotal, cartItems)
    return progress.unlocked
  }

  /**
   * Mirrors FirstTimeOffersService.computeReward — same shape convention,
   * including using the milestone's own scopedSubtotal (attached by
   * getProgress/getEligibleTiers) in place of the raw cart total whenever
   * the milestone has a category/product scope — a Dairy-only milestone
   * must never pay out on the full cart just because the total happens to
   * clear min_cart_amount.
   *
   * grantsFreeDelivery is independent of rewardType (100_cart_milestone_
   * free_delivery_toggle.sql) — same pattern as coupons.grants_free_delivery
   * and first_time_offers.grants_free_delivery: a CASHBACK or FLAT_DISCOUNT
   * milestone can ALSO waive delivery instead of being forced to invent a
   * fake reward value just to get a free-delivery effect.
   */
  computeReward(milestone, cartTotal) {
    const amount = milestone.scopedSubtotal ?? cartTotal
    const freeDelivery = !!milestone.grantsFreeDelivery
    switch (milestone.rewardType) {
      case 'FLAT_DISCOUNT': {
        // "Instant Discount" in the dashboard — same rewardPercent/
        // maxDiscount convention as CASHBACK below: when rewardPercent is
        // set it wins over the flat rewardValue, capped by maxDiscount, so
        // an admin can configure "20% off, up to ₹50" instead of only a
        // flat ₹X. Always clamped to the (scoped) cart amount either way —
        // a discount can never exceed what's actually being bought.
        let discount = milestone.rewardPercent
          ? amount * (milestone.rewardPercent / 100)
          : (milestone.rewardValue || 0)
        if (milestone.maxDiscount) discount = Math.min(discount, milestone.maxDiscount)
        discount = Math.min(discount, amount)
        discount = Math.round(discount * 100) / 100
        return { discount, freeDelivery }
      }
      case 'CASHBACK': {
        // rewardPercent (when set) wins over the flat rewardValue — same
        // convention as payment_offers.cashback_percent — so an admin can
        // configure "80% cashback, up to ₹50" instead of only a flat ₹X.
        let cashbackAmount = milestone.rewardValue || 0
        if (milestone.rewardPercent) {
          cashbackAmount = amount * (milestone.rewardPercent / 100)
        }
        if (milestone.maxDiscount) cashbackAmount = Math.min(cashbackAmount, milestone.maxDiscount)
        cashbackAmount = Math.round(cashbackAmount * 100) / 100
        return { cashbackAmount, freeDelivery }
      }
      case 'COUPON_UNLOCK':
        return { unlockCouponId: milestone.unlockCouponId, freeDelivery }
      default:
        return { freeDelivery }
    }
  }

  /**
   * A COUPON_UNLOCK reward grants access by inserting the user into
   * coupon_target_users once they cross the milestone (see
   * orders.service.js) — but coupons.service.js#_isTargetEligible only
   * ever consults coupon_target_users for a coupon whose targetType is
   * 'INDIVIDUAL'. Linking any other targetType makes the "unlock" a silent
   * no-op: the coupon was either already open to everyone (ALL/SEGMENT) or
   * permanently unreachable through this milestone (FIRST_TIME, etc — that
   * targeting rule runs instead and ignores coupon_target_users entirely).
   * Catch this at save time instead of letting an admin discover it only
   * when a customer's checkout silently fails to apply the reward.
   */
  async _validateCouponUnlock(data) {
    if (data.rewardType !== 'COUPON_UNLOCK') return null
    if (!data.unlockCouponId) {
      return 'unlockCouponId is required when rewardType is COUPON_UNLOCK'
    }
    const coupon = await this.couponsRepo.findById(data.unlockCouponId)
    if (!coupon) return 'Selected coupon was not found'
    if (coupon.targetType !== 'INDIVIDUAL') {
      return `"${coupon.code}" must have its Target Audience set to "Individual" to work as a milestone reward — it's currently "${coupon.targetType}", so reaching this milestone would have no effect on who can use it.`
    }
    if (!coupon.isActive) {
      return `"${coupon.code}" is inactive — activate it before linking it as a milestone reward.`
    }
    return null
  }

  async create(data, actor) {
    if (!data.name || !data.rewardType || data.minCartAmount == null) {
      return { success: false, message: 'name, rewardType and minCartAmount are required' }
    }
    const couponError = await this._validateCouponUnlock(data)
    if (couponError) return { success: false, message: couponError }
    const milestone = await this.repo.create({ ...data, createdBy: actor.userId })
    emitAudit('cart_milestone_created', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'cart_milestone',
      target_id: milestone.id,
      before: null,
      after: milestone,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    logger.info({ milestoneId: milestone.id, actor: actor.userId }, 'Cart milestone created')
    return { success: true, milestone }
  }

  async update(id, data, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Milestone not found' }
    const merged = { ...existing, ...data }
    const couponError = await this._validateCouponUnlock(merged)
    if (couponError) return { success: false, message: couponError }
    const milestone = await this.repo.update(id, data)
    emitAudit('cart_milestone_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'cart_milestone',
      target_id: id,
      before: existing,
      after: milestone,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, milestone }
  }

  async delete(id, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Milestone not found' }
    await this.repo.delete(id)
    emitAudit('cart_milestone_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'cart_milestone',
      target_id: id,
      before: existing,
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true }
  }

  /** Record that a user has redeemed a milestone's reward for a specific order. */
  async recordUsage(milestoneId, userId, orderId) {
    return this.repo.recordUsage(milestoneId, userId, orderId)
  }
}
