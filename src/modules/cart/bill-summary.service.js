import { CartRepository } from './cart.repository.js'
import { CartService } from './cart.service.js'
import { FeeSettingsService } from '../fee-settings/fee-settings.service.js'
import { TotalsEngine } from './totals-engine.service.js'
import { PaymentSettingsService } from '../payment-settings/payment-settings.service.js'
import { CartMilestonesService } from '../cart-milestones/cart-milestones.service.js'
import { haversineKm } from '../../utils/distance.js'
import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'

/**
 * Bill summary service — computes the complete cart bill breakdown for
 * GET /api/v1/cart/summary.
 *
 * Source of truth: the canonical {@link TotalsEngine} + the `fee_settings`
 * config. Delivery fee is dynamic (distance-based) and computed per shop so
 * the summary agrees with what order creation actually charges (orders split
 * per shop). Distance is the haversine between the customer's selected/default
 * delivery address and each shop.
 *
 * Backward compatibility: the response keeps the original keys
 * (itemTotal, deliveryFee{amount,isFree,freeIn}, handlingFee, lateNightFee,
 * toPay, savings, deliveryEstimate, couponDiscount, tipAmount, itemCount) so
 * the current Flutter build keeps working, AND adds the new canonical fields
 * (totals, fees[], distance, freeDelivery, platformFee, smallCartFee, …) for
 * the redesigned bill UI.
 */
export class BillSummaryService {
  constructor({
    cartService = null,
    cartRepository = null,
    feeSettingsService = null,
    totalsEngine = null,
    paymentSettingsService = null,
    cartMilestonesService = null,
  } = {}) {
    this.cartRepository = cartRepository ?? new CartRepository()
    this.cartService = cartService ?? new CartService(this.cartRepository)
    this.feeSettingsService = feeSettingsService ?? new FeeSettingsService()
    this.totalsEngine =
      totalsEngine ?? new TotalsEngine({ feeSettingsService: this.feeSettingsService })
    this.paymentSettingsService = paymentSettingsService ?? new PaymentSettingsService()
    this.cartMilestonesService = cartMilestonesService ?? new CartMilestonesService()
  }

  /**
   * Compute the bill summary for a user's cart.
   * @param {string} userId
   * @param {string|null} [addressId] - optional selected address; defaults to the user's default address
   */
  async getBillSummary(userId, addressId = null, { quickDeliverySelected = false, priceMode = 'retail' } = {}) {
    const cart = await this.cartService.getCart(userId, priceMode)
    const paymentConfig = await this.paymentSettingsService.getConfig()
    if (!cart.items || cart.items.length === 0) {
      return this._emptyBill(paymentConfig)
    }

    const itemTotalDiscounted = this._round(cart.subtotal)
    const itemTotalOriginal = this._round(cart.totalMrp || cart.subtotal)
    const mrpDiscount = this._round(Math.max(0, itemTotalOriginal - itemTotalDiscounted))
    const tipAmount = this._toNumber(cart.tipAmount)

    // Resolve delivery coordinates + per-shop distances.
    const address = await this._resolveAddress(userId, addressId)
    const shopGroups = cart.shopGroups || []
    const shopIds = shopGroups.map((g) => g.shopId)
    const shopMeta = await this._getShopMeta(shopIds)

    // Compute a per-shop breakdown via the engine and aggregate. Delivery and
    // each fee are charged per shop (matching order splitting); the aggregate
    // is what the customer pays in total.
    const { config } = await this.feeSettingsService.resolveForShop(
      shopGroups.length === 1 ? shopGroups[0].shopId : null
    )

    // First-time offer — auto-applies for eligible first-time customers on
    // single-shop carts, mirroring OrdersService.placeOrder()'s rule
    // (single discount slot, single-shop only). Resolved here — not just at
    // order placement — so the customer actually SEES the promised discount
    // while shopping, matching the "auto-apply, no claim step" admin setting.
    // Payment method isn't known yet at cart-view time, so `onlinePayment`
    // First-time-offer auto-apply was removed with the grocery marketing
    // module; marketplace discounts come from coupons, milestones, points.
    const firstTimeOfferDiscount = 0
    const firstTimeOfferFreeDelivery = false
    const firstTimeOfferMeta = null
    const firstTimeOfferTeaser = null

    let deliveryFee = 0
    let deliveryFeeOriginal = 0
    let handlingFee = 0
    let platformFee = 0
    let smallCartFee = 0
    let surgeFee = 0
    let packagingFee = 0
    let anyDeliveryWaived = false
    let primaryDistanceKm = null
    let primaryStoreName = null
    let amountToUnlock = 0

    for (const group of shopGroups) {
      const meta = shopMeta.get(group.shopId) || {}
      const distanceKm =
        address && Number.isFinite(meta.lat) && Number.isFinite(meta.lng)
          ? haversineKm(address.lat, address.lng, meta.lat, meta.lng)
          : null

      const shopConfigResolved = await this.feeSettingsService.resolveForShop(group.shopId)
      const breakdown = this.totalsEngine.computeBreakdown({
        config: shopConfigResolved.config,
        itemsSubtotal: group.subtotal,
        distanceKm,
        storeName: meta.name || group.shopName || null,
        forceFreeDelivery: firstTimeOfferFreeDelivery,
      })

      deliveryFee = this._round(deliveryFee + breakdown.deliveryFee)
      deliveryFeeOriginal = this._round(deliveryFeeOriginal + breakdown.deliveryFeeOriginal)
      handlingFee = this._round(handlingFee + breakdown.handlingFee)
      platformFee = this._round(platformFee + breakdown.platformFee)
      smallCartFee = this._round(smallCartFee + breakdown.smallCartFee)
      surgeFee = this._round(surgeFee + breakdown.surgeFee)
      packagingFee = this._round(packagingFee + breakdown.packagingFee)
      if (breakdown.deliveryFeeWaived) anyDeliveryWaived = true
      amountToUnlock = this._round(amountToUnlock + breakdown.freeDelivery.amountToUnlock)

      // Use the primary (first / single) shop for the headline distance label.
      if (primaryDistanceKm === null && breakdown.distance.known) {
        primaryDistanceKm = breakdown.distance.km
        primaryStoreName = meta.name || group.shopName || null
      }
    }

    // Build a single aggregate breakdown for the canonical response. The
    // first-time-offer discount is fed through the engine's `couponDiscount`
    // slot — the same "single discount slot" convention OrdersService.
    // placeOrder() already uses (coupon and first-time-offer share one slot,
    // never stack) — so totalPayable/totalSavings stay consistent.
    const aggregate = this.totalsEngine.computeBreakdown({
      config,
      itemsSubtotal: itemTotalDiscounted,
      itemDiscount: mrpDiscount,
      couponDiscount: firstTimeOfferDiscount,
      distanceKm: primaryDistanceKm,
      tipAmount,
      storeName: primaryStoreName,
      quickDeliverySelected,
      forceFreeDelivery: firstTimeOfferFreeDelivery,
    })

    // Override the aggregate's per-fee numbers with the summed per-shop values
    // so multi-shop carts reflect the real charge.
    aggregate.deliveryFee = deliveryFee
    aggregate.deliveryFeeOriginal = deliveryFeeOriginal
    aggregate.deliveryFeeWaived = anyDeliveryWaived && deliveryFee === 0
    aggregate.handlingFee = handlingFee
    aggregate.platformFee = platformFee
    aggregate.smallCartFee = smallCartFee
    aggregate.surgeFee = surgeFee
    aggregate.packagingFee = packagingFee
    aggregate.freeDelivery.amountToUnlock = aggregate.deliveryFeeWaived ? 0 : amountToUnlock
    aggregate.freeDelivery.unlocked = aggregate.deliveryFeeWaived

    // Quick Delivery surcharge is order-level (not per-shop-distance like
    // delivery fee), so the aggregate breakdown's own value is authoritative
    // — no per-shop summing needed, unlike the fees above.
    const quickDeliverySurcharge = aggregate.quickDeliverySurcharge || 0

    const feesTotal = this._round(
      deliveryFee + handlingFee + platformFee + smallCartFee + surgeFee + packagingFee + quickDeliverySurcharge
    )

    // GST — exclusive, computed on (subtotal + all other fees), matching
    // TotalsEngine.computeBreakdown's formula. Recomputed here (rather than
    // trusting the single-shop `aggregate.tax` from the earlier
    // computeBreakdown call above) because this method overwrites every
    // other fee with the properly-summed multi-shop total — using the
    // stale single-shop tax figure would under/over-charge on any
    // multi-shop cart.
    const preTaxTotal = this._round(
      Math.max(0, itemTotalDiscounted - firstTimeOfferDiscount + feesTotal)
    )
    const gstAmount = config.gst_enabled
      ? this._round((preTaxTotal * this._toNumber(config.gst_rate)) / 100)
      : 0
    aggregate.tax = gstAmount

    const toPayFinal = this._round(
      Math.max(0, itemTotalDiscounted - firstTimeOfferDiscount + feesTotal + gstAmount + tipAmount)
    )
    const toPayOriginal = this._round(
      itemTotalOriginal + deliveryFeeOriginal + handlingFee + platformFee + smallCartFee + surgeFee + packagingFee + quickDeliverySurcharge + gstAmount + tipAmount
    )
    aggregate.totalPayable = toPayFinal
    aggregate.itemsSubtotal = itemTotalDiscounted
    aggregate.itemDiscount = mrpDiscount

    // Rebuild the canonical fees[] array from aggregated values.
    aggregate.fees = this._buildFeesArray({
      config,
      deliveryFee,
      deliveryFeeOriginal,
      deliveryWaived: aggregate.deliveryFeeWaived,
      handlingFee,
      platformFee,
      smallCartFee,
      surgeFee,
      packagingFee,
      quickDeliverySurcharge,
      gstAmount,
      distanceKm: primaryDistanceKm,
      storeName: primaryStoreName,
      amountToUnlock,
    })

    const { normalEtaMinutes, quickEtaMinutes, deliveryEstimateMinutes } =
      this._resolveDeliveryEstimateMinutes(config, quickDeliverySelected)
    const freeThreshold = aggregate.freeDelivery.threshold

    // Cart milestone progress (Phase 3) — powers the mobile Smart Bottom
    // Bar's "Add ₹X more to unlock…" state, plus a full merged ladder (free
    // delivery + every cart-milestone tier this user is eligible for, in
    // one ascending sequence) so the bar can render a single segmented
    // progress track instead of resetting to 0% every time a tier is
    // crossed — each tier fills its own segment as the cart approaches it,
    // and every earlier segment stays fully filled once passed.
    // Best-effort: a milestone lookup failure must never break the cart summary itself.
    let cartMilestone = { unlocked: null, next: null, ladder: [] }
    try {
      const allCartItems = shopGroups.flatMap((g) => g.items || [])
      const [progress, eligibleTiers] = await Promise.all([
        this.cartMilestonesService.getProgress(userId, itemTotalDiscounted, allCartItems),
        this.cartMilestonesService.getEligibleTiers(userId, itemTotalDiscounted, allCartItems),
      ])
      const ladder = this._buildRewardLadder({
        freeDeliveryEnabled: aggregate.freeDelivery.enabled,
        freeDeliveryThreshold: freeThreshold,
        tiers: eligibleTiers,
        cartTotal: itemTotalDiscounted,
      })
      cartMilestone = { ...progress, ladder }
    } catch (err) {
      logger.warn({ userId, err: err.message, action: 'bill_summary_milestone' }, 'Cart milestone progress failed')
    }

    // ── Legacy-compatible shape + new canonical fields ──────────
    return {
      // legacy keys (current Flutter)
      itemTotal: {
        original: itemTotalOriginal,
        discounted: itemTotalDiscounted,
      },
      deliveryFee: {
        amount: deliveryFee,
        isFree: aggregate.deliveryFeeWaived,
        freeIn: aggregate.deliveryFeeWaived ? 0 : amountToUnlock,
        originalAmount: deliveryFeeOriginal,
        waiverReason: aggregate.deliveryFeeWaiverReason,
      },
      handlingFee: {
        amount: handlingFee,
        isFree: handlingFee <= 0,
        savedAmount: 0,
        label: config.handling_fee_label || 'Handling fee',
        description: config.handling_fee_description || 'Covers packing and order handling.',
      },
      lateNightFee: {
        amount: 0,
        isFree: true,
        savedAmount: 0,
        isLateNight: false,
      },
      // Auto-applied first-time-offer discount (backend-known at cart-view
      // time — no customer action needed). A manually-typed coupon code
      // lives entirely in client-side state and is NOT reflected here; the
      // Flutter app overlays that discount on top of / in place of this one
      // (single discount slot — a manual coupon takes priority, matching
      // OrdersService.placeOrder()'s rule).
      couponDiscount: firstTimeOfferDiscount,
      tipAmount,
      toPay: {
        original: toPayOriginal,
        final: toPayFinal,
      },
      savings: {
        total: aggregate.totalSavings,
        breakdown: [
          ...(mrpDiscount > 0
            ? [{ type: 'mrp_discount', label: 'Discount on MRP', amount: mrpDiscount }]
            : []),
          ...(firstTimeOfferDiscount > 0
            ? [{ type: 'first_time_offer', label: firstTimeOfferMeta?.name || 'First order offer', amount: firstTimeOfferDiscount }]
            : []),
        ],
      },
      deliveryEstimate: {
        minutes: deliveryEstimateMinutes,
        label: `Delivering in ${deliveryEstimateMinutes} mins`,
      },
      itemCount: cart.count,

      // new canonical fields (redesigned bill UI)
      totals: aggregate,
      fees: aggregate.fees,
      distance: aggregate.distance,
      freeDelivery: {
        enabled: aggregate.freeDelivery.enabled,
        threshold: freeThreshold,
        unlocked: aggregate.deliveryFeeWaived,
        amountToUnlock: aggregate.deliveryFeeWaived ? 0 : amountToUnlock,
      },
      platformFee: {
        amount: platformFee,
        isFree: platformFee <= 0,
        label: config.platform_fee_label || 'Platform fee',
        description: config.platform_fee_description || 'Supports platform operations and support.',
      },
      smallCartFee: {
        amount: smallCartFee,
        isFree: smallCartFee <= 0,
        label: config.small_cart_fee_label || 'Small cart fee',
        description: config.small_cart_fee_description || 'Applied to small orders.',
      },
      totalPayable: toPayFinal,
      paymentMethods: this._buildPaymentMethods(paymentConfig, toPayFinal),
      cartMilestone,
      firstTimeOffer: firstTimeOfferMeta
        ? {
            id: firstTimeOfferMeta.id,
            name: firstTimeOfferMeta.name,
            rewardType: firstTimeOfferMeta.rewardType,
            discount: firstTimeOfferDiscount,
            freeDelivery: firstTimeOfferFreeDelivery,
          }
        : null,
      // Positive nudge shown instead of firstTimeOffer when nothing
      // currently qualifies but a nearby offer exists — see the resolve
      // block above. Always null whenever firstTimeOffer is non-null.
      firstTimeOfferTeaser,
      // Whether the "Quick Delivery" opt-in is available at all right now —
      // independent of the fees[] line, which only appears once the
      // customer has actually selected it (see quickDeliverySelected param).
      quickDelivery: {
        enabled: !!config.quick_delivery_surcharge_enabled,
        amount: this._toNumber(config.quick_delivery_surcharge_amount) || 0,
        label: config.quick_delivery_surcharge_label || 'Quick delivery fee',
        etaMinutes: quickEtaMinutes,
      },
    }
  }

  /** Build the cod/razorpay/wallet availability block from the resolved config + bill total. */
  _buildPaymentMethods(config, totalPayable) {
    const { codEnabled, codMinOrderAmount, codMaxOrderAmount, razorpayEnabled, walletEnabled } = config

    let codReason = null
    let codAvailable = codEnabled
    if (!codEnabled) {
      codReason = 'Cash on Delivery is currently unavailable.'
      codAvailable = false
    } else if (totalPayable < codMinOrderAmount) {
      const shortfall = this._round(codMinOrderAmount - totalPayable)
      codReason = `Add ₹${shortfall} more to use Cash on Delivery — available above ₹${codMinOrderAmount}.`
      codAvailable = false
    } else if (codMaxOrderAmount != null && totalPayable > codMaxOrderAmount) {
      codReason = `Cash on Delivery isn't available above ₹${codMaxOrderAmount} — please pay online.`
      codAvailable = false
    }

    return {
      cod: {
        enabled: codEnabled,
        available: codAvailable,
        minAmount: codMinOrderAmount,
        maxAmount: codMaxOrderAmount,
        reason: codReason,
      },
      razorpay: { enabled: razorpayEnabled },
      wallet: { enabled: walletEnabled },
    }
  }

  /**
   * Resolve which delivery estimate to show: the normal always-shown
   * `delivery_eta_minutes`, or — once the customer has actually opted into
   * (and is paying for) Quick Delivery — the faster `quick_delivery_eta_minutes`.
   * Never switches just because the surcharge is enabled in config; only
   * when the customer explicitly selected it for this request.
   */
  _resolveDeliveryEstimateMinutes(config, quickDeliverySelected) {
    const normalEtaMinutes = this._toNumber(config.delivery_eta_minutes) || 30
    const quickEtaMinutes = this._toNumber(config.quick_delivery_eta_minutes) || normalEtaMinutes
    const quickDeliveryApplied = quickDeliverySelected && !!config.quick_delivery_surcharge_enabled
    return {
      normalEtaMinutes,
      quickEtaMinutes,
      deliveryEstimateMinutes: quickDeliveryApplied ? quickEtaMinutes : normalEtaMinutes,
    }
  }

  /** Build the canonical fees[] array from aggregated fee values. */
  _buildFeesArray({
    config,
    deliveryFee,
    deliveryFeeOriginal,
    deliveryWaived,
    handlingFee,
    platformFee,
    smallCartFee,
    surgeFee,
    packagingFee,
    quickDeliverySurcharge = 0,
    gstAmount = 0,
    distanceKm,
    storeName,
    amountToUnlock,
  }) {
    const fees = []
    if (config.delivery_fee_enabled) {
      const desc = deliveryWaived
        ? 'Free delivery unlocked'
        : distanceKm !== null && distanceKm !== undefined
          ? `Calculated for ${Number(distanceKm).toFixed(1)} km${storeName ? ` from ${storeName}` : ''}`
          : 'Standard delivery charge'
      fees.push({
        code: 'DELIVERY_FEE',
        label: config.delivery_fee_label || 'Delivery fee',
        amount: deliveryFee,
        originalAmount: deliveryFeeOriginal,
        waived: deliveryWaived,
        description: desc,
        metadata: { distanceKm: distanceKm ?? null, storeName: storeName || null },
      })
    }
    if (handlingFee > 0) {
      fees.push({
        code: 'HANDLING_FEE',
        label: config.handling_fee_label || 'Handling fee',
        amount: handlingFee,
        originalAmount: handlingFee,
        waived: false,
        description: config.handling_fee_description || 'Covers packing and order handling.',
        metadata: {},
      })
    }
    if (platformFee > 0) {
      fees.push({
        code: 'PLATFORM_FEE',
        label: config.platform_fee_label || 'Platform fee',
        amount: platformFee,
        originalAmount: platformFee,
        waived: false,
        description: config.platform_fee_description || 'Supports platform operations and support.',
        metadata: {},
      })
    }
    if (smallCartFee > 0) {
      fees.push({
        code: 'SMALL_CART_FEE',
        label: config.small_cart_fee_label || 'Small cart fee',
        amount: smallCartFee,
        originalAmount: smallCartFee,
        waived: false,
        description: config.small_cart_fee_description || 'Applied to small orders.',
        metadata: {},
      })
    }
    if (surgeFee > 0) {
      fees.push({
        code: 'SURGE_FEE',
        label: config.surge_fee_label || 'Surge fee',
        amount: surgeFee,
        originalAmount: surgeFee,
        waived: false,
        description: config.surge_fee_description || 'Temporary surcharge during high demand.',
        metadata: {},
      })
    }
    if (packagingFee > 0) {
      fees.push({
        code: 'PACKAGING_FEE',
        label: config.packaging_fee_label || 'Packaging fee',
        amount: packagingFee,
        originalAmount: packagingFee,
        waived: false,
        description: config.packaging_fee_description || 'Covers packaging materials.',
        metadata: {},
      })
    }
    if (quickDeliverySurcharge > 0) {
      fees.push({
        code: 'QUICK_DELIVERY_SURCHARGE',
        label: config.quick_delivery_surcharge_label || 'Quick delivery fee',
        amount: quickDeliverySurcharge,
        originalAmount: quickDeliverySurcharge,
        waived: false,
        description: 'Charged for immediate/priority delivery.',
        metadata: {},
      })
    }
    if (gstAmount > 0) {
      fees.push({
        code: 'GST',
        label: config.gst_label || 'GST',
        amount: gstAmount,
        originalAmount: gstAmount,
        waived: false,
        description: `${config.gst_rate}% tax on the order total.`,
        metadata: { rate: this._toNumber(config.gst_rate) },
      })
    }
    return fees
  }

  /**
   * Merge the free-delivery threshold and every eligible cart-milestone
   * tier into a single ascending sequence of "checkpoints", each with a
   * self-contained 0–1 `segmentProgress` — how far the cart has filled
   * *that* checkpoint's own span (from the previous checkpoint's amount up
   * to this one), not the overall cart-vs-final-tier fraction. This is
   * what lets the mobile Smart Bottom Bar render one continuous segmented
   * progress track (each tier its own segment, with a gap marker at every
   * boundary) instead of a single bar that resets to 0% each time a tier
   * is crossed.
   */
  _buildRewardLadder({ freeDeliveryEnabled, freeDeliveryThreshold, tiers, cartTotal }) {
    const checkpoints = []
    if (freeDeliveryEnabled && freeDeliveryThreshold != null && freeDeliveryThreshold > 0) {
      checkpoints.push({
        id: 'free-delivery',
        label: 'Free delivery',
        minAmount: this._round(freeDeliveryThreshold),
      })
    }
    for (const tier of tiers) {
      checkpoints.push({
        id: tier.id,
        label: tier.name,
        minAmount: this._round(tier.minCartAmount),
      })
    }
    checkpoints.sort((a, b) => a.minAmount - b.minAmount)

    let previousAmount = 0
    return checkpoints.map((checkpoint) => {
      const span = checkpoint.minAmount - previousAmount
      const achieved = cartTotal >= checkpoint.minAmount
      const segmentProgress = achieved
        ? 1
        : span > 0
          ? Math.max(0, Math.min(1, (cartTotal - previousAmount) / span))
          : 0
      previousAmount = checkpoint.minAmount
      return { ...checkpoint, achieved, segmentProgress: this._round(segmentProgress) }
    })
  }

  /** Resolve the delivery address (selected or default) with coordinates. */
  async _resolveAddress(userId, addressId) {
    try {
      if (addressId) {
        const { rows } = await query(
          `SELECT lat, lng FROM addresses WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL LIMIT 1`,
          [addressId, userId]
        )
        if (rows[0] && rows[0].lat != null && rows[0].lng != null) {
          return { lat: Number(rows[0].lat), lng: Number(rows[0].lng) }
        }
      }
      const { rows } = await query(
        `SELECT lat, lng FROM addresses
          WHERE user_id = $1 AND lat IS NOT NULL AND lng IS NOT NULL AND deleted_at IS NULL
          ORDER BY is_default DESC, created_at DESC
          LIMIT 1`,
        [userId]
      )
      if (rows[0]) return { lat: Number(rows[0].lat), lng: Number(rows[0].lng) }
    } catch (err) {
      logger.warn({ userId, err: err.message, action: 'bill_summary_address' }, 'Address resolve failed')
    }
    return null
  }

  /** Fetch lat/lng/name for a set of shops. */
  async _getShopMeta(shopIds) {
    const map = new Map()
    if (!shopIds || shopIds.length === 0) return map
    try {
      const { rows } = await query(
        `SELECT id, name, lat, lng FROM shops WHERE id = ANY($1)`,
        [shopIds]
      )
      for (const r of rows) {
        map.set(r.id, {
          name: r.name,
          lat: r.lat != null ? Number(r.lat) : NaN,
          lng: r.lng != null ? Number(r.lng) : NaN,
        })
      }
    } catch (err) {
      logger.warn({ err: err.message, action: 'bill_summary_shop_meta' }, 'Shop meta fetch failed')
    }
    return map
  }

  _emptyBill(paymentConfig = null) {
    return {
      itemTotal: { original: 0, discounted: 0 },
      deliveryFee: { amount: 0, isFree: false, freeIn: 0, originalAmount: 0, waiverReason: null },
      handlingFee: { amount: 0, isFree: true, savedAmount: 0 },
      lateNightFee: { amount: 0, isFree: true, savedAmount: 0, isLateNight: false },
      couponDiscount: 0,
      tipAmount: 0,
      toPay: { original: 0, final: 0 },
      savings: { total: 0, breakdown: [] },
      deliveryEstimate: { minutes: 30, label: 'Delivering in 30 mins' },
      itemCount: 0,
      totals: null,
      fees: [],
      distance: { km: null, label: '', known: false },
      freeDelivery: { enabled: true, threshold: null, unlocked: false, amountToUnlock: 0 },
      platformFee: { amount: 0, isFree: true },
      smallCartFee: { amount: 0, isFree: true },
      totalPayable: 0,
      paymentMethods: paymentConfig ? this._buildPaymentMethods(paymentConfig, 0) : null,
      cartMilestone: { unlocked: null, next: null, ladder: [] },
      quickDelivery: { enabled: false, amount: 0, label: 'Quick delivery fee', etaMinutes: 0 },
      firstTimeOffer: null,
      firstTimeOfferTeaser: null,
    }
  }

  _toNumber(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  _round(value) {
    return Math.round((this._toNumber(value) + Number.EPSILON) * 100) / 100
  }
}
