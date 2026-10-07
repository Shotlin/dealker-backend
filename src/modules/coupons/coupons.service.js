import { logger } from '../../config/logger.js'
import { ERROR_CODES } from '../../constants/errors.js'
import { HQ_ROLES } from '../../utils/permissions.js'
import { emit as emitAudit } from '../../utils/audit-log.js'
import { CustomerSegmentsRepository } from '../admin/customer-segments/customer-segments.repository.js'

/** Returns true only for properly formatted UUIDs. */
function _isValidUUID(value) {
  if (typeof value !== 'string') return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

/**
 * Coupons service — business logic for discount codes.
 *
 * Tasks 9.2–9.6:
 *   9.2 — Scope enforcement on create
 *   9.3 — applyCouponToCart with per-shop-order-group evaluation
 *   9.4 — Validation (min_order_amount, expires_at, starts_at, usage limits)
 *   9.5 — coupon_usages + COUPON_DISCOUNT shop_transactions in same tx
 *   9.6 — Audit events (coupon_created, coupon_updated, coupon_deleted)
 */
export class CouponsService {
  constructor(repository, segmentsRepo = new CustomerSegmentsRepository()) {
    this.repo = repository
    this.segmentsRepo = segmentsRepo
  }

  // ═══════════════════════════════════════════════════════════════════
  // TASK 9.2 — Scope enforcement
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Enforce coupon scope rules:
   *   - HQ_User → can create PLATFORM_COUPON
   *   - SHOP_ADMIN/SHOP_MANAGER with `shop_coupons.create` → SHOP_COUPON for their shop
   *   - Otherwise → 403 COUPON_SCOPE_FORBIDDEN
   *
   * @param {object} data - coupon creation payload
   * @param {object} actor - actor context from controller
   * @returns {{ allowed: boolean, code?: string, message?: string }}
   */
  _enforceCouponScope(data, actor) {
    const couponType = data.couponType || 'PLATFORM_COUPON'
    const isHQ = actor.platformRole && HQ_ROLES.includes(actor.platformRole)

    if (couponType === 'PLATFORM_COUPON') {
      if (!isHQ) {
        return {
          allowed: false,
          code: ERROR_CODES.COUPON_SCOPE_FORBIDDEN,
          message: 'Only HQ users can create platform-wide coupons',
        }
      }
      return { allowed: true }
    }

    if (couponType === 'SHOP_COUPON') {
      // HQ users can also create shop coupons
      if (isHQ) {
        return { allowed: true }
      }

      // Shop staff need shop_coupons.create permission
      const shopRole = actor.shopRole
      const hasPermission = Array.isArray(actor.permissions) &&
        actor.permissions.includes('shop_coupons.create')

      if (!hasPermission) {
        return {
          allowed: false,
          code: ERROR_CODES.COUPON_SCOPE_FORBIDDEN,
          message: 'Requires shop_coupons.create permission to create shop coupons',
        }
      }

      // Shop staff can only create coupons for their own shop
      if (data.shopId && data.shopId !== actor.shopId) {
        return {
          allowed: false,
          code: ERROR_CODES.COUPON_SCOPE_FORBIDDEN,
          message: 'Cannot create coupon for a different shop',
        }
      }

      return { allowed: true }
    }

    // CATEGORY_COUPON, PRODUCT_COUPON, DELIVERY_COUPON — same rules as SHOP_COUPON
    // if they have a shopId, or HQ can create them platform-wide
    if (isHQ) {
      return { allowed: true }
    }

    const hasPermission = Array.isArray(actor.permissions) &&
      actor.permissions.includes('shop_coupons.create')
    if (!hasPermission) {
      return {
        allowed: false,
        code: ERROR_CODES.COUPON_SCOPE_FORBIDDEN,
        message: 'Requires shop_coupons.create permission',
      }
    }

    return { allowed: true }
  }

  // ═══════════════════════════════════════════════════════════════════
  // TASK 9.3 — Apply coupon to cart (per-shop-order-group evaluation)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Apply a coupon to a multi-vendor cart. Evaluates per-shop-order-group.
   *
   * Cart shape expected:
   *   { shopGroups: [{ shopId, items: [{ productId, categoryId, price, qty }], deliveryFee }] }
   *
   * Returns:
   *   { totalDiscount, shopDiscounts: [{ shopId, discount, deliveryDiscount }] }
   *
   * Distribution logic:
   *   - PLATFORM_COUPON: proportional across all shop groups (largest-remainder rounding)
   *   - SHOP_COUPON: only matching shop
   *   - CATEGORY_COUPON / PRODUCT_COUPON: only matching items
   *   - DELIVERY_COUPON: reduces only delivery_fee
   *
   * @param {object} cart - multi-vendor cart
   * @param {object} coupon - formatted coupon object
   * @returns {object} discount breakdown
   */
  applyCouponToCart(cart, coupon) {
    const shopGroups = cart.shopGroups || []
    if (shopGroups.length === 0) {
      return { totalDiscount: 0, shopDiscounts: [] }
    }

    const couponType = coupon.couponType || 'PLATFORM_COUPON'

    switch (couponType) {
      case 'PLATFORM_COUPON':
        return this._applyPlatformCoupon(shopGroups, coupon)
      case 'SHOP_COUPON':
        return this._applyShopCoupon(shopGroups, coupon)
      case 'CATEGORY_COUPON':
        return this._applyCategoryCoupon(shopGroups, coupon)
      case 'PRODUCT_COUPON':
        return this._applyProductCoupon(shopGroups, coupon)
      case 'DELIVERY_COUPON':
        return this._applyDeliveryCoupon(shopGroups, coupon)
      default:
        return { totalDiscount: 0, shopDiscounts: [] }
    }
  }

  /**
   * PLATFORM_COUPON: proportional distribution across all shop groups
   * with largest-remainder rounding so sum is preserved exactly.
   */
  _applyPlatformCoupon(shopGroups, coupon) {
    const groupTotals = shopGroups.map((g) => this._groupItemTotal(g))
    const cartTotal = groupTotals.reduce((sum, t) => sum + t, 0)

    if (cartTotal <= 0) {
      return { totalDiscount: 0, shopDiscounts: [] }
    }

    const rawDiscount = this._computeRawDiscount(cartTotal, coupon)
    const totalDiscount = Math.min(rawDiscount, cartTotal)

    // Proportional split with largest-remainder rounding
    const shopDiscounts = this._distributeProportional(shopGroups, groupTotals, cartTotal, totalDiscount)

    return {
      totalDiscount: parseFloat(totalDiscount.toFixed(2)),
      shopDiscounts,
    }
  }

  /**
   * SHOP_COUPON: only matching shop(s)
   */
  _applyShopCoupon(shopGroups, coupon) {
    const applicableShopIds = coupon.applicableShopIds || (coupon.shopId ? [coupon.shopId] : [])
    const shopDiscounts = []
    let totalDiscount = 0

    for (const group of shopGroups) {
      if (!applicableShopIds.includes(group.shopId)) {
        shopDiscounts.push({ shopId: group.shopId, discount: 0, deliveryDiscount: 0 })
        continue
      }

      const groupTotal = this._groupItemTotal(group)
      const discount = Math.min(this._computeRawDiscount(groupTotal, coupon), groupTotal)
      totalDiscount += discount
      shopDiscounts.push({
        shopId: group.shopId,
        discount: parseFloat(discount.toFixed(2)),
        deliveryDiscount: 0,
      })
    }

    return {
      totalDiscount: parseFloat(totalDiscount.toFixed(2)),
      shopDiscounts,
    }
  }

  /**
   * CATEGORY_COUPON: only items matching applicable_category_ids
   */
  _applyCategoryCoupon(shopGroups, coupon) {
    const categoryIds = coupon.applicableCategoryIds || []
    const shopDiscounts = []
    let totalDiscount = 0

    for (const group of shopGroups) {
      const matchingTotal = (group.items || [])
        .filter((item) => categoryIds.includes(item.categoryId))
        .reduce((sum, item) => sum + item.price * item.qty, 0)

      if (matchingTotal <= 0) {
        shopDiscounts.push({ shopId: group.shopId, discount: 0, deliveryDiscount: 0 })
        continue
      }

      const discount = Math.min(this._computeRawDiscount(matchingTotal, coupon), matchingTotal)
      totalDiscount += discount
      shopDiscounts.push({
        shopId: group.shopId,
        discount: parseFloat(discount.toFixed(2)),
        deliveryDiscount: 0,
      })
    }

    return {
      totalDiscount: parseFloat(totalDiscount.toFixed(2)),
      shopDiscounts,
    }
  }

  /**
   * PRODUCT_COUPON: only items matching applicable_product_ids
   */
  _applyProductCoupon(shopGroups, coupon) {
    const productIds = coupon.applicableProductIds || []
    const shopDiscounts = []
    let totalDiscount = 0

    for (const group of shopGroups) {
      const matchingTotal = (group.items || [])
        .filter((item) => productIds.includes(item.productId))
        .reduce((sum, item) => sum + item.price * item.qty, 0)

      if (matchingTotal <= 0) {
        shopDiscounts.push({ shopId: group.shopId, discount: 0, deliveryDiscount: 0 })
        continue
      }

      const discount = Math.min(this._computeRawDiscount(matchingTotal, coupon), matchingTotal)
      totalDiscount += discount
      shopDiscounts.push({
        shopId: group.shopId,
        discount: parseFloat(discount.toFixed(2)),
        deliveryDiscount: 0,
      })
    }

    return {
      totalDiscount: parseFloat(totalDiscount.toFixed(2)),
      shopDiscounts,
    }
  }

  /**
   * DELIVERY_COUPON: reduces only delivery_fee, not item prices
   */
  _applyDeliveryCoupon(shopGroups, coupon) {
    const applicableShopIds = coupon.applicableShopIds || (coupon.shopId ? [coupon.shopId] : null)
    const shopDiscounts = []
    let totalDiscount = 0

    for (const group of shopGroups) {
      // If shop-scoped, only apply to matching shops
      if (applicableShopIds && !applicableShopIds.includes(group.shopId)) {
        shopDiscounts.push({ shopId: group.shopId, discount: 0, deliveryDiscount: 0 })
        continue
      }

      const deliveryFee = group.deliveryFee || 0
      if (deliveryFee <= 0) {
        shopDiscounts.push({ shopId: group.shopId, discount: 0, deliveryDiscount: 0 })
        continue
      }

      const discount = Math.min(this._computeRawDiscount(deliveryFee, coupon), deliveryFee)
      totalDiscount += discount
      shopDiscounts.push({
        shopId: group.shopId,
        discount: 0,
        deliveryDiscount: parseFloat(discount.toFixed(2)),
      })
    }

    return {
      totalDiscount: parseFloat(totalDiscount.toFixed(2)),
      shopDiscounts,
    }
  }

  /**
   * Proportional distribution with largest-remainder (Hamilton) method.
   * Ensures sum of distributed amounts === totalDiscount exactly.
   */
  _distributeProportional(shopGroups, groupTotals, cartTotal, totalDiscount) {
    // Compute ideal (fractional) shares
    const idealShares = groupTotals.map((t) => (t / cartTotal) * totalDiscount)

    // Floor each share (in cents to avoid floating point issues)
    const totalCents = Math.round(totalDiscount * 100)
    const flooredCents = idealShares.map((s) => Math.floor(s * 100))
    const remainders = idealShares.map((s, i) => (s * 100) - flooredCents[i])

    // Distribute residue to groups with largest remainders
    let distributed = flooredCents.reduce((sum, c) => sum + c, 0)
    const residue = totalCents - distributed

    // Get indices sorted by remainder descending
    const indices = remainders
      .map((r, i) => ({ r, i }))
      .sort((a, b) => b.r - a.r)
      .map((x) => x.i)

    for (let k = 0; k < residue; k++) {
      flooredCents[indices[k]] += 1
    }

    return shopGroups.map((group, i) => ({
      shopId: group.shopId,
      discount: parseFloat((flooredCents[i] / 100).toFixed(2)),
      deliveryDiscount: 0,
    }))
  }

  /** Sum of item prices * qty for a shop group */
  _groupItemTotal(group) {
    return (group.items || []).reduce((sum, item) => sum + item.price * item.qty, 0)
  }

  /** Compute raw discount amount before capping */
  _computeRawDiscount(base, coupon) {
    if (coupon.discountType === 'PERCENTAGE') {
      let discount = (base * coupon.discountValue) / 100
      if (coupon.maxDiscount && discount > coupon.maxDiscount) {
        discount = coupon.maxDiscount
      }
      return discount
    }
    // FLAT
    return coupon.discountValue
  }

  // ═══════════════════════════════════════════════════════════════════
  // TASK 9.4 — Validation (min_order_amount, dates, usage limits)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Validate coupon eligibility with proper error codes from R26.8.
   *
   * @param {object} coupon - formatted coupon
   * @param {string} userId - user attempting to use the coupon
   * @param {number} cartTotal - total cart amount
   * @param {Array<{productId:string, quantity:number, effectivePrice?:number, lineTotal?:number}>} [cartItems] -
   *   current cart lines (single shop's worth — orders.service.js already
   *   restricts coupons to a single-shop cart). Only needed when the coupon
   *   has a category/product scope; omit it for an unscoped coupon and the
   *   min-order check falls back to `cartTotal` exactly as before.
   * @returns {Promise<{ valid: boolean, code?: string, message?: string, scopedSubtotal?: number }>}
   */
  async validateCouponEligibility(coupon, userId, cartTotal, cartItems = null) {
    if (!coupon) {
      return { valid: false, code: ERROR_CODES.COUPON_NOT_FOUND, message: 'Coupon not found' }
    }

    if (!coupon.isActive) {
      return { valid: false, code: ERROR_CODES.COUPON_INACTIVE, message: 'Coupon is inactive' }
    }

    const now = new Date()

    // starts_at check
    if (coupon.validFrom && new Date(coupon.validFrom) > now) {
      return { valid: false, code: ERROR_CODES.COUPON_NOT_STARTED, message: 'Coupon is not yet active' }
    }

    // expires_at check
    if (coupon.validUntil && new Date(coupon.validUntil) < now) {
      return { valid: false, code: ERROR_CODES.COUPON_EXPIRED, message: 'Coupon has expired' }
    }

    // Targeting — SEGMENT/INDIVIDUAL/FIRST_TIME (ALL, and demo coupons which
    // have no targetType at all, skip this block entirely via _isTargetEligible).
    if (!(await this._isTargetEligible(coupon, userId))) {
      return coupon.targetType === 'SEGMENT'
        ? {
            valid: false,
            code: ERROR_CODES.COUPON_SEGMENT_RESTRICTED,
            message: 'This coupon is only available for selected customers.',
          }
        : {
            valid: false,
            code: ERROR_CODES.COUPON_NOT_APPLICABLE,
            message: 'This coupon is not applicable to your account.',
          }
    }

    // usage_limit_total (new multi-vendor field)
    // Skip DB lookup for demo coupons — they have non-UUID IDs
    if (coupon.usageLimitTotal != null && _isValidUUID(coupon.id)) {
      const totalUsage = await this.repo.getTotalUsageCount(coupon.id)
      if (totalUsage >= coupon.usageLimitTotal) {
        return { valid: false, code: ERROR_CODES.COUPON_LIMIT_REACHED, message: 'Coupon usage limit reached' }
      }
    }

    // Legacy usage_limit fallback
    if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
      return { valid: false, code: ERROR_CODES.COUPON_LIMIT_REACHED, message: 'Coupon usage limit reached' }
    }

    // per_user_limit is what the admin dashboard's "Per User Limit" field
    // actually writes (updateCouponSchema never exposes usageLimitPerUser,
    // and createCouponSchema defaults it to 1 whenever the client omits it
    // — which the dashboard always does). Preferring usageLimitPerUser here
    // meant every coupon was silently capped at 1 use/user no matter what
    // an admin set in the UI. per_user_limit must win until usage_limit_per_user
    // is actually wired up end-to-end (task 9.2, see coupons.repository.js).
    const perUserLimit = coupon.perUserLimit ?? coupon.usageLimitPerUser ?? 1
    const userUsage = _isValidUUID(coupon.id)
      ? await this.repo.getUserUsageCount(coupon.id, userId)
      : 0
    if (userUsage >= perUserLimit) {
      return { valid: false, code: ERROR_CODES.COUPON_USER_LIMIT_REACHED, message: 'You have already used this coupon the maximum number of times' }
    }

    // Category/product scope — a coupon with either array set only ever
    // discounts the matching slice of the cart, not the whole order (see
    // resolveMatchingProductIds). "Category is the optional rule": most
    // coupons leave both arrays empty/null, which resolveMatchingProductIds
    // treats as "matches everything", so scopedSubtotal collapses to
    // cartTotal below with no special-casing needed here.
    const hasScope = (coupon.applicableCategoryIds?.length > 0) || (coupon.applicableProductIds?.length > 0)
    let scopedSubtotal = cartTotal
    if (hasScope) {
      if (!cartItems || cartItems.length === 0) {
        return {
          valid: false,
          code: ERROR_CODES.COUPON_NOT_APPLICABLE,
          message: await this._buildScopeMismatchMessage(coupon),
        }
      }
      const matchingIds = await this.repo.resolveMatchingProductIds(
        cartItems.map((i) => i.productId),
        { applicableCategoryIds: coupon.applicableCategoryIds, applicableProductIds: coupon.applicableProductIds }
      )
      scopedSubtotal = parseFloat(
        cartItems
          .filter((i) => matchingIds.has(i.productId))
          .reduce((sum, i) => sum + Number(i.lineTotal ?? i.effectivePrice * i.quantity), 0)
          .toFixed(2)
      )
      if (scopedSubtotal <= 0) {
        return {
          valid: false,
          code: ERROR_CODES.COUPON_NOT_APPLICABLE,
          message: await this._buildScopeMismatchMessage(coupon),
        }
      }
    }

    // min_order_amount — checked against scopedSubtotal, which equals
    // cartTotal for an unscoped coupon, so this is the exact same check as
    // before for every coupon that has no category/product scope.
    if (coupon.minOrderAmount && scopedSubtotal < coupon.minOrderAmount) {
      return {
        valid: false,
        code: ERROR_CODES.COUPON_MIN_ORDER_NOT_MET,
        message: `Minimum order amount is ₹${coupon.minOrderAmount}`,
      }
    }

    return { valid: true, scopedSubtotal }
  }

  /**
   * "This coupon only works on X" message naming the coupon's actual
   * category/product scope, instead of a generic "specific products or
   * categories" — the customer has no way to act on the generic version
   * (which categories? which products?), just this one specific-sounding
   * sentence that never actually says which ones.
   */
  async _buildScopeMismatchMessage(coupon) {
    const [categoryNames, productNames] = await Promise.all([
      this.repo.getCategoryNames(coupon.applicableCategoryIds || []),
      this.repo.getProductNames(coupon.applicableProductIds || []),
    ])
    const names = [...categoryNames, ...productNames]
    if (names.length === 0) {
      return 'This coupon only applies to specific products or categories that aren’t in your cart.'
    }
    const shown = names.slice(0, 3).join(', ')
    const label = names.length > 3 ? `${shown} & more` : shown
    return `This coupon only works on ${label} — none of your cart items qualify yet.`
  }

  // ═══════════════════════════════════════════════════════════════════
  // TASK 9.5 — Record coupon usage + COUPON_DISCOUNT transaction
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Insert coupon_usages rows + COUPON_DISCOUNT shop_transactions rows
   * inside the caller's transaction (same tx as order creation).
   *
   * One coupon_usages row per affected per-shop order group.
   * One COUPON_DISCOUNT shop_transactions row per affected shop.
   *
   * @param {import('pg').PoolClient} client - transactional client
   * @param {object} params
   * @param {string} params.couponId
   * @param {string} params.userId
   * @param {string} params.orderId - parent order ID
   * @param {Array<{ shopId: string, shopOrderId: string, discount: number, deliveryDiscount: number }>} params.shopDiscounts
   * @param {object} params.coupon - full coupon object for metadata
   */
  async recordUsageInTx(client, { couponId, userId, orderId, shopDiscounts, coupon }) {
    for (const sd of shopDiscounts) {
      const totalDiscount = sd.discount + (sd.deliveryDiscount || 0)
      if (totalDiscount <= 0) continue

      // Insert coupon_usages row per affected shop order group
      await client.query(
        `INSERT INTO coupon_usages (coupon_id, user_id, order_id, shop_id, discount_amount)
         VALUES ($1, $2, $3, $4, $5)`,
        [couponId, userId, sd.shopOrderId || orderId, sd.shopId, totalDiscount]
      )

      // Insert COUPON_DISCOUNT shop_transactions row
      // Read current balance for the shop
      const { rows: balRows } = await client.query(
        `SELECT balance_after FROM shop_transactions
         WHERE shop_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 1
         FOR UPDATE`,
        [sd.shopId]
      )
      const prevBalance = balRows[0] ? parseFloat(balRows[0].balance_after) : 0
      const absorber = coupon.absorber || 'PLATFORM'

      // COUPON_DISCOUNT is a DEBIT from the shop perspective when
      // absorber is SHOP (shop bears the cost), otherwise it's informational
      // with direction CREDIT (platform absorbs, shop still gets full revenue)
      const direction = absorber === 'SHOP' ? 'DEBIT' : 'CREDIT'
      const balanceAfter = direction === 'DEBIT'
        ? (prevBalance - totalDiscount).toFixed(2)
        : prevBalance.toFixed(2)

      await client.query(
        `INSERT INTO shop_transactions (
           shop_id, type, amount, balance_after,
           reference_type, reference_id, description,
           direction, status, metadata, order_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
        [
          sd.shopId,
          'COUPON_DISCOUNT',
          totalDiscount.toFixed(2),
          balanceAfter,
          'coupon',
          couponId,
          `Coupon ${coupon.code} discount applied`,
          direction,
          'POSTED',
          JSON.stringify({
            coupon_code: coupon.code,
            coupon_type: coupon.couponType,
            absorber,
            order_id: orderId,
          }),
          orderId,
        ]
      )
    }

    // Increment legacy used_count
    await client.query(
      `UPDATE coupons SET used_count = used_count + 1, updated_at = NOW() WHERE id = $1`,
      [couponId]
    )
  }

  // ═══════════════════════════════════════════════════════════════════
  // EXISTING — Validate (customer-facing, updated with R26.8 codes)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Validate a coupon code against a cart total (customer-facing).
   *
   * @param {string} userId
   * @param {string} code
   * @param {number} cartTotal
   * @param {Array<object>} [cartItems] - see validateCouponEligibility's jsdoc; only needed for a scoped coupon.
   */
  async validate(userId, code, cartTotal, cartItems = null) {
    const coupon = await this.repo.findByCode(code)

    const eligibility = await this.validateCouponEligibility(coupon, userId, cartTotal, cartItems)
    if (!eligibility.valid) {
      return { valid: false, message: eligibility.message, code: eligibility.code }
    }
    const scopedSubtotal = eligibility.scopedSubtotal ?? cartTotal

    // grantsFreeDelivery is an independent flag any discount type can carry
    // (088_coupon_free_delivery_toggle.sql) — ORed with the legacy
    // discountType==='FREE_DELIVERY' path so existing coupons of that type
    // keep behaving exactly as before, while a PERCENTAGE/FLAT/CASHBACK
    // coupon can now ALSO waive delivery instead of being forced to choose
    // one or the other. Whichever is true, it's the caller's
    // (orders.service.js) job to actually force-waive the fee — that
    // plumbing already exists and doesn't change here.
    const freeDelivery = coupon.discountType === 'FREE_DELIVERY' || !!coupon.grantsFreeDelivery

    // CASHBACK and (legacy) FREE_DELIVERY don't reduce the order total at
    // all — they produce a separate effect (a pending wallet credit / a
    // delivery-fee waiver) that the caller (orders.service.js) applies
    // elsewhere, so `discount` stays 0 for both.
    if (coupon.discountType === 'CASHBACK') {
      const cashbackAmount = parseFloat(Math.min(coupon.discountValue, scopedSubtotal).toFixed(2))
      return {
        valid: true,
        discount: 0,
        freeDelivery,
        cashbackAmount,
        cashbackCreditTrigger: coupon.cashbackCreditTrigger || 'ORDER_DELIVERED',
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        description: coupon.description ?? null,
        terms: coupon.terms ?? null,
        minOrderAmount: coupon.minOrderAmount || 0,
        maxDiscount: coupon.maxDiscount || null,
        // Scope (null/empty on both = applies to the whole cart). Surfaced
        // so the client can locally re-check "is this coupon still
        // applicable?" whenever the cart changes (an item the coupon was
        // scoped to gets removed) without another round trip — see
        // checkout_provider.dart#_syncCart. Already loaded on `coupon`,
        // costs nothing extra to include here.
        applicableCategoryIds: coupon.applicableCategoryIds || null,
        applicableProductIds: coupon.applicableProductIds || null,
        code: coupon.code,
        couponId: _isValidUUID(coupon.id) ? coupon.id : null,
        isDemo: !!coupon.isDemo,
      }
    }
    if (coupon.discountType === 'FREE_DELIVERY') {
      return {
        valid: true,
        discount: 0,
        freeDelivery: true,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        description: coupon.description ?? null,
        terms: coupon.terms ?? null,
        minOrderAmount: coupon.minOrderAmount || 0,
        maxDiscount: coupon.maxDiscount || null,
        applicableCategoryIds: coupon.applicableCategoryIds || null,
        applicableProductIds: coupon.applicableProductIds || null,
        code: coupon.code,
        couponId: _isValidUUID(coupon.id) ? coupon.id : null,
        isDemo: !!coupon.isDemo,
      }
    }

    // Calculate discount — against scopedSubtotal, which equals cartTotal
    // for an unscoped coupon (see validateCouponEligibility), so this is
    // identical to the previous behavior whenever there's no category/
    // product scope.
    let discount = 0
    if (coupon.discountType === 'PERCENTAGE') {
      discount = (scopedSubtotal * coupon.discountValue) / 100
      if (coupon.maxDiscount && discount > coupon.maxDiscount) {
        discount = coupon.maxDiscount
      }
    } else {
      discount = coupon.discountValue
    }

    discount = parseFloat(Math.min(discount, scopedSubtotal).toFixed(2))

    return {
      valid: true,
      discount,
      freeDelivery,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      description: coupon.description ?? null,
      terms: coupon.terms ?? null,
      minOrderAmount: coupon.minOrderAmount || 0,
      maxDiscount: coupon.maxDiscount || null,
      applicableCategoryIds: coupon.applicableCategoryIds || null,
      applicableProductIds: coupon.applicableProductIds || null,
      code: coupon.code,
      // Only return couponId if it looks like a real UUID — demo coupons
      // have string IDs like 'demo-coupon-bakaloo50' that would crash
      // the coupon_usages INSERT (UUID type column).
      couponId: _isValidUUID(coupon.id) ? coupon.id : null,
      isDemo: !!coupon.isDemo,
    }
  }

  /**
   * Get available coupons for a user (filter out maxed-out and
   * not-eligible-for-this-user ones — segment/individual/first-time-only
   * coupons stay hidden from customers who can't use them rather than
   * teasing a code they'll only see rejected at apply time).
   */
  async getAvailable(userId) {
    const coupons = await this.repo.findAvailable()
    const available = []

    for (const coupon of coupons) {
      const usage = coupon.isDemo
        ? 0
        : await this.repo.getUserUsageCount(coupon.id, userId)
      // See validateCouponEligibility() above — per_user_limit is the
      // column the admin dashboard actually controls, so it must win.
      const perUserLimit = coupon.perUserLimit ?? coupon.usageLimitPerUser ?? 1
      if (usage >= perUserLimit) continue

      if (!(await this._isTargetEligible(coupon, userId))) continue

      available.push(this._toPublicCoupon(coupon))
    }

    return available
  }

  /** Targeting-only eligibility check (no cartTotal/usage-limit — used by getAvailable). */
  async _isTargetEligible(coupon, userId) {
    if (coupon.targetType === 'SEGMENT') {
      return coupon.targetSegmentId
        ? this.segmentsRepo.isMember(coupon.targetSegmentId, userId)
        : false
    }
    if (coupon.targetType === 'INDIVIDUAL') {
      return _isValidUUID(coupon.id) ? this.repo.isTargetUser(coupon.id, userId) : false
    }
    if (coupon.targetType === 'FIRST_TIME') {
      return !(await this.repo.hasPriorOrder(userId))
    }
    return true
  }

  /**
   * Record that a coupon was used in an order (legacy single-vendor path).
   * `shopId`/`discountAmount` are optional — when the caller has them
   * (orders.service.js does), they're persisted on the coupon_usages row
   * instead of being left NULL (see coupons.repository.js#recordUsage).
   */
  async recordUsage(couponCode, userId, orderId, { shopId, discountAmount } = {}) {
    const coupon = await this.repo.findByCode(couponCode)
    // Only record usage for real DB coupons with valid UUID ids.
    // Demo coupons have string IDs (e.g. 'demo-coupon-bakaloo50') that
    // would cause a PostgreSQL UUID cast error on the coupon_usages INSERT.
    if (coupon && _isValidUUID(coupon.id)) {
      try {
        await this.repo.recordUsage(coupon.id, userId, orderId, { shopId, discountAmount })
        logger.info({ couponId: coupon.id, userId, orderId }, 'Coupon usage recorded')
      } catch (err) {
        // coupon_usages has a UNIQUE(coupon_id, user_id, order_id) index —
        // a retry of the same confirmation event (payment webhook firing
        // twice, a client re-calling payFromWallet) must not double-count
        // against the customer's usage limit or double-increment
        // coupons.used_count.
        if (err.code === '23505') {
          logger.info({ couponId: coupon.id, userId, orderId }, 'Coupon usage already recorded for this order — skipping')
          return
        }
        throw err
      }
    }
  }

  /**
   * Record coupon usage for an order that has just been confirmed
   * (payment succeeded) — reads the coupon code/discount straight off the
   * order row rather than requiring the caller to have those in scope.
   * This is what ONLINE/WALLET payment confirmation calls; recordUsage()
   * above is still called directly and immediately for COD, which has no
   * separate confirmation step (see orders.service.js).
   *
   * Previously, coupon usage was recorded unconditionally the moment an
   * order row was created — before an ONLINE/WALLET payment had actually
   * been confirmed. A payment that then failed or was never completed
   * still burned the customer's usage against their per-coupon limit,
   * with no way to recover it (reported bug: first order's wallet payment
   * never confirmed, but the coupon immediately showed "maximum uses").
   */
  async recordUsageForOrder(orderId) {
    const { OrdersRepository } = await import('../orders/orders.repository.js')
    const order = await new OrdersRepository().findById(orderId)
    if (!order || !order.couponCode) return
    await this.recordUsage(order.couponCode, order.userId, orderId, {
      shopId: order.shopId,
      discountAmount: order.discountAmount,
    })
  }

  // ═══════════════════════════════════════════════════════════════════
  // ADMIN methods (with scope enforcement + audit)
  // ═══════════════════════════════════════════════════════════════════

  async listAll(filters) {
    return this.repo.findAll(filters)
  }

  /** Individually-targeted customers for a coupon (dashboard edit-dialog prefill). */
  async getTargetUsers(couponId) {
    return this.repo.getTargetUsers(couponId)
  }

  /**
   * Usage analytics for the dashboard's coupon detail drawer. conversionRate
   * has no dedicated tracking (no "coupon impression" event exists) — it's
   * defined as redemptions against the coupon's own usage_limit_total when
   * one is set (how much of the allotted budget has been used), and 0 when
   * the coupon has no cap to measure against.
   */
  async getAnalytics(couponId) {
    const coupon = await this.repo.findById(couponId)
    if (!coupon) {
      return null
    }

    const analytics = await this.repo.getAnalytics(couponId)
    const usageLimit = coupon.usageLimitTotal ?? coupon.usageLimit
    const conversionRate = usageLimit
      ? Math.round((analytics.totalRedemptions / usageLimit) * 1000) / 10
      : 0

    return { ...analytics, conversionRate }
  }

  /**
   * Create coupon with scope enforcement (task 9.2) and audit (task 9.6).
   */
  async create(data, actor) {
    // Task 9.2: Enforce scope
    const scopeCheck = this._enforceCouponScope(data, actor)
    if (!scopeCheck.allowed) {
      return { success: false, message: scopeCheck.message, code: scopeCheck.code }
    }

    const existing = await this.repo.findByCode(data.code)
    if (existing) {
      return { success: false, message: 'Coupon code already exists', code: 'DUPLICATE' }
    }

    // For shop staff creating SHOP_COUPON, auto-set shopId to their shop
    if ((data.couponType === 'SHOP_COUPON') && !data.shopId && actor.shopId) {
      data.shopId = actor.shopId
    }

    // Set createdBy
    data.createdBy = actor.userId

    const coupon = await this.repo.create(data)

    // Task 9.6: Emit coupon_created audit (fire-and-forget)
    emitAudit('coupon_created', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.shopRole || actor.role,
      actor_shop_id: actor.shopId,
      target_type: 'coupon',
      target_id: coupon.id,
      before: null,
      after: coupon,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })

    logger.info({ couponId: coupon.id, code: coupon.code, actor: actor.userId }, 'Coupon created')
    return { success: true, coupon }
  }

  /**
   * Update coupon with audit (task 9.6).
   */
  async update(id, data, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) {
      return { success: false, message: 'Coupon not found' }
    }

    if (data.code && data.code.toUpperCase() !== existing.code) {
      const dup = await this.repo.findByCode(data.code)
      if (dup) {
        return { success: false, message: 'Coupon code already exists' }
      }
    }

    const coupon = await this.repo.update(id, data)

    // Task 9.6: Emit coupon_updated audit (fire-and-forget)
    emitAudit('coupon_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.shopRole || actor.role,
      actor_shop_id: actor.shopId,
      target_type: 'coupon',
      target_id: id,
      before: existing,
      after: coupon,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })

    logger.info({ couponId: id, actor: actor.userId }, 'Coupon updated')
    return { success: true, coupon }
  }

  /**
   * Delete coupon with audit (task 9.6).
   */
  async delete(id, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) {
      return { success: false, message: 'Coupon not found' }
    }

    try {
      await this.repo.delete(id)
    } catch (err) {
      // coupon_usages.coupon_id (and first_time_offers/cart_milestones'
      // unlock_coupon_id) have no ON DELETE cascade — once a customer has
      // redeemed the coupon, or another reward references it as an unlock,
      // a hard delete violates that FK and Postgres throws 23503.
      // Previously this reached the global error handler as an opaque 500;
      // surface a clear 409 instead and point the admin at deactivating
      // (already a supported toggle) so redemption history isn't lost.
      if (err && err.code === '23503') {
        const conflict = new Error(
          'This coupon has already been used by customers (or is linked to another offer) and cannot be deleted. Deactivate it instead to hide it from customers while keeping their redemption history intact.'
        )
        conflict.statusCode = 409
        conflict.code = 'COUPON_IN_USE'
        throw conflict
      }
      throw err
    }

    // Task 9.6: Emit coupon_deleted audit (fire-and-forget)
    emitAudit('coupon_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.shopRole || actor.role,
      actor_shop_id: actor.shopId,
      target_type: 'coupon',
      target_id: id,
      before: existing,
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })

    logger.info({ couponId: id, actor: actor.userId }, 'Coupon deleted')
    return { success: true }
  }

  _toPublicCoupon(coupon) {
    return {
      ...coupon,
      discountAmount: this._bestDisplayDiscount(coupon),
      terms: coupon.terms ?? null,
    }
  }

  _bestDisplayDiscount(coupon) {
    if (coupon.discountType === 'PERCENTAGE') {
      return coupon.maxDiscount || coupon.discountValue || 0
    }
    return coupon.discountValue || 0
  }
}
