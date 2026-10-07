import { FeeSettingsService } from '../fee-settings/fee-settings.service.js'
import { formatDistanceKm } from '../../utils/distance.js'

/**
 * TotalsEngine — the single canonical fee + totals calculator.
 *
 * Every surface that needs a bill (cart summary, checkout, order creation,
 * payment, admin preview) MUST compute totals through this engine so the
 * numbers never diverge. The engine is pure given a resolved config: it does
 * no IO except `resolveForShop` when the caller asks it to fetch config.
 *
 * Delivery fee formula (per design):
 *   chargeableKm           = max(0, distanceKm - baseDistanceKm)
 *   deliveryFeeBeforeWaiver = minDeliveryFee + ceil(chargeableKm) * perKmFee
 *   finalDeliveryFee        = 0  when freeDeliveryEnabled && eligibleSubtotal >= freeDeliveryAbove
 *                           = deliveryFeeBeforeWaiver  otherwise
 *
 * Free-delivery eligibility compares the item subtotal AFTER item (MRP)
 * discounts but BEFORE delivery fee and BEFORE coupon — documented rule so
 * cart, checkout, order and payment all agree.
 *
 * Only the delivery fee is waived above the free-delivery threshold; all other
 * fees remain unless individually disabled.
 */

export const FEE_CODES = Object.freeze({
  DELIVERY: 'DELIVERY_FEE',
  HANDLING: 'HANDLING_FEE',
  PLATFORM: 'PLATFORM_FEE',
  SMALL_CART: 'SMALL_CART_FEE',
  SURGE: 'SURGE_FEE',
  PACKAGING: 'PACKAGING_FEE',
  QUICK_DELIVERY: 'QUICK_DELIVERY_SURCHARGE',
})

export class TotalsEngine {
  /**
   * @param {object} deps
   * @param {FeeSettingsService} [deps.feeSettingsService]
   */
  constructor(deps = {}) {
    this.feeSettings = deps.feeSettingsService || new FeeSettingsService()
  }

  // ── number helpers ───────────────────────────────────────────
  _num(value, fallback = 0) {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }

  _round(value) {
    return Math.round((this._num(value) + Number.EPSILON) * 100) / 100
  }

  /**
   * Compute the dynamic delivery fee for a distance + config.
   *
   * @param {object} config        resolved fee_settings row
   * @param {number|null} distanceKm  null when coordinates unavailable
   * @param {number} eligibleSubtotal item subtotal (post item-discount, pre fees)
   * @returns {{ amount:number, original:number, waived:boolean, reason:string|null,
   *             applicable:boolean, distanceKnown:boolean, outOfRange:boolean }}
   */
  computeDeliveryFee(config, distanceKm, eligibleSubtotal, forceWaive = false) {
    if (!config.delivery_fee_enabled) {
      return {
        amount: 0,
        original: 0,
        waived: false,
        reason: null,
        applicable: false,
        distanceKnown: distanceKm !== null && distanceKm !== undefined,
        outOfRange: false,
      }
    }

    const minFee = this._num(config.min_delivery_fee)
    const baseKm = this._num(config.base_distance_km)
    const perKm = this._num(config.per_km_fee)
    const distanceKnown = distanceKm !== null && distanceKm !== undefined && Number.isFinite(Number(distanceKm))
    const km = distanceKnown ? this._num(distanceKm) : null

    // Fallback when no distance is available: charge the safe minimum fee
    // rather than crashing or guessing a distance.
    let before
    let outOfRange = false
    if (!distanceKnown) {
      before = minFee
    } else {
      // Clamp the chargeable distance to the configured maximum (when set) so
      // a mis-allocated far shop / bad coordinates can never produce an absurd
      // fee. Distance beyond the cap is flagged `outOfRange` for the caller.
      const maxKm =
        config.max_delivery_distance_km != null
          ? this._num(config.max_delivery_distance_km)
          : null
      let effectiveKm = km
      if (maxKm !== null && km > maxKm) {
        outOfRange = true
        effectiveKm = maxKm
      }
      const chargeableKm = Math.max(0, effectiveKm - baseKm)
      before = minFee + Math.ceil(chargeableKm) * perKm
    }
    before = this._round(before)

    const freeEnabled = !!config.free_delivery_enabled
    const threshold =
      config.free_delivery_above === null || config.free_delivery_above === undefined
        ? null
        : this._num(config.free_delivery_above)
    const unlocked =
      freeEnabled && threshold !== null && this._num(eligibleSubtotal) >= threshold

    // A coupon (FREE_DELIVERY discountType) or a first-time-offer
    // (FREE_DELIVERY rewardType) can waive delivery independently of the
    // cart-value threshold above — checked after the threshold so the
    // "unlocked by cart value" messaging still wins when both are true.
    if (unlocked || forceWaive) {
      return {
        amount: 0,
        original: before,
        waived: true,
        reason: unlocked
          ? (threshold !== null ? `Free delivery unlocked on orders above ₹${this._formatMoney(threshold)}` : 'Free delivery unlocked')
          : 'Free delivery applied',
        applicable: true,
        distanceKnown,
        outOfRange,
      }
    }

    return {
      amount: before,
      original: before,
      waived: false,
      reason: null,
      applicable: true,
      distanceKnown,
      outOfRange,
    }
  }

  _formatMoney(value) {
    const n = this._num(value)
    return Number.isInteger(n) ? String(n) : n.toFixed(2)
  }

  /** Compute a FLAT/PERCENT fee against a base. */
  _flatOrPercent(type, value, base) {
    if (type === 'PERCENT') {
      return this._round((this._num(base) * this._num(value)) / 100)
    }
    return this._round(value)
  }

  /**
   * Compute the full canonical breakdown.
   *
   * @param {object} args
   * @param {object} args.config            resolved fee_settings row
   * @param {number} args.itemsSubtotal     item subtotal after item discounts (pre fees)
   * @param {number} [args.itemDiscount=0]  MRP/item-level discount (for display)
   * @param {number} [args.couponDiscount=0] coupon discount on subtotal
   * @param {number|null} [args.distanceKm] delivery distance, null when unknown
   * @param {number} [args.tax=0]
   * @param {number} [args.tipAmount=0]
   * @param {string|null} [args.storeName]
   * @returns {object} canonical totals object
   */
  computeBreakdown({
    config,
    itemsSubtotal,
    itemDiscount = 0,
    couponDiscount = 0,
    distanceKm = null,
    tax = 0,
    tipAmount = 0,
    storeName = null,
    forceFreeDelivery = false,
    quickDeliverySelected = false,
  }) {
    const subtotal = this._round(itemsSubtotal)
    const eligibleSubtotal = subtotal // post item-discount, pre fees, pre coupon
    const fees = []

    // ── Delivery fee ──────────────────────────────────────────
    const delivery = this.computeDeliveryFee(config, distanceKm, eligibleSubtotal, forceFreeDelivery)
    const distanceLabel = formatDistanceKm(distanceKm)
    if (delivery.applicable) {
      const desc = delivery.waived
        ? delivery.reason
        : delivery.distanceKnown
          ? `Calculated for ${distanceLabel}${storeName ? ` from ${storeName}` : ''}`
          : 'Standard delivery charge'
      fees.push({
        code: FEE_CODES.DELIVERY,
        label: config.delivery_fee_label || 'Delivery fee',
        amount: delivery.amount,
        originalAmount: delivery.original,
        waived: delivery.waived,
        description: desc,
        metadata: {
          distanceKm: delivery.distanceKnown ? this._round(distanceKm) : null,
          storeName: storeName || null,
          outOfRange: delivery.outOfRange,
        },
      })
    }

    // ── Handling fee ──────────────────────────────────────────
    let handlingFee = 0
    if (config.handling_fee_enabled) {
      handlingFee = this._flatOrPercent(config.handling_fee_type, config.handling_fee_value, subtotal)
      if (handlingFee > 0) {
        fees.push({
          code: FEE_CODES.HANDLING,
          label: config.handling_fee_label || 'Handling fee',
          amount: handlingFee,
          originalAmount: handlingFee,
          waived: false,
          description: config.handling_fee_description || 'Covers packing and order handling.',
          metadata: {},
        })
      }
    }

    // ── Platform fee ──────────────────────────────────────────
    let platformFee = 0
    if (config.platform_fee_enabled) {
      platformFee = this._flatOrPercent(config.platform_fee_type, config.platform_fee_value, subtotal)
      if (platformFee > 0) {
        fees.push({
          code: FEE_CODES.PLATFORM,
          label: config.platform_fee_label || 'Platform fee',
          amount: platformFee,
          originalAmount: platformFee,
          waived: false,
          description: config.platform_fee_description || 'Supports platform operations and support.',
          metadata: {},
        })
      }
    }

    // ── Small cart fee ────────────────────────────────────────
    let smallCartFee = 0
    if (config.small_cart_fee_enabled && subtotal < this._num(config.small_cart_threshold)) {
      smallCartFee = this._round(config.small_cart_fee)
      if (smallCartFee > 0) {
        fees.push({
          code: FEE_CODES.SMALL_CART,
          label: config.small_cart_fee_label || 'Small cart fee',
          amount: smallCartFee,
          originalAmount: smallCartFee,
          waived: false,
          description:
            config.small_cart_fee_description ||
            `Applied to orders below ₹${this._formatMoney(config.small_cart_threshold)}.`,
          metadata: { threshold: this._num(config.small_cart_threshold) },
        })
      }
    }

    // ── Surge fee ─────────────────────────────────────────────
    let surgeFee = 0
    if (config.surge_fee_enabled) {
      surgeFee = this._round(config.surge_fee_value)
      if (surgeFee > 0) {
        fees.push({
          code: FEE_CODES.SURGE,
          label: config.surge_fee_label || 'Surge fee',
          amount: surgeFee,
          originalAmount: surgeFee,
          waived: false,
          description: config.surge_fee_description || 'Temporary surcharge during high demand.',
          metadata: {},
        })
      }
    }

    // ── Packaging fee ─────────────────────────────────────────
    let packagingFee = 0
    if (config.packaging_fee_enabled) {
      packagingFee = this._round(config.packaging_fee_value)
      if (packagingFee > 0) {
        fees.push({
          code: FEE_CODES.PACKAGING,
          label: config.packaging_fee_label || 'Packaging fee',
          amount: packagingFee,
          originalAmount: packagingFee,
          waived: false,
          description: config.packaging_fee_description || 'Covers packaging materials.',
          metadata: {},
        })
      }
    }

    // ── Quick Delivery surcharge ──────────────────────────────
    // Double-gated: only applies when the admin has enabled it AND the
    // customer explicitly opted into Quick Delivery — never a silent
    // default fee on a plain ASAP order (confirmed product decision).
    let quickDeliverySurcharge = 0
    if (config.quick_delivery_surcharge_enabled && quickDeliverySelected) {
      quickDeliverySurcharge = this._round(config.quick_delivery_surcharge_amount)
      if (quickDeliverySurcharge > 0) {
        fees.push({
          code: FEE_CODES.QUICK_DELIVERY,
          label: config.quick_delivery_surcharge_label || 'Quick delivery fee',
          amount: quickDeliverySurcharge,
          originalAmount: quickDeliverySurcharge,
          waived: false,
          description: 'Charged for immediate/priority delivery.',
          metadata: {},
        })
      }
    }

    const couponDisc = this._round(Math.max(0, this._num(couponDiscount)))
    const tip = this._round(Math.max(0, this._num(tipAmount)))

    const feesTotal = this._round(
      delivery.amount + handlingFee + platformFee + smallCartFee + surgeFee + packagingFee + quickDeliverySurcharge
    )

    // ── GST ───────────────────────────────────────────────────
    // Exclusive tax: computed on (subtotal - coupon + all other fees), i.e.
    // "delivery and everything" per the confirmed product decision — not
    // just the item subtotal. Excludes the tip (a voluntary gratuity, not
    // consideration for goods/services). Off by default (gst_enabled=false)
    // so this is a no-op until an admin explicitly turns it on; the `tax`
    // param is a legacy override slot no real caller currently sets a
    // nonzero value for, kept only for backward compatibility.
    const preTaxTotal = this._round(Math.max(0, subtotal - couponDisc + feesTotal))
    const gstAmount = config.gst_enabled
      ? this._round((preTaxTotal * this._num(config.gst_rate)) / 100)
      : 0
    const taxAmount = this._round(gstAmount + this._num(tax))

    if (gstAmount > 0) {
      fees.push({
        code: 'GST',
        label: config.gst_label || 'GST',
        amount: gstAmount,
        originalAmount: gstAmount,
        waived: false,
        description: `${this._formatMoney(config.gst_rate)}% tax on the order total.`,
        metadata: { rate: this._num(config.gst_rate) },
      })
    }

    let totalPayable = this._round(
      subtotal - couponDisc + feesTotal + taxAmount + tip
    )
    if (totalPayable < 0) totalPayable = 0

    // Savings: item discount + coupon + delivery waiver
    const deliverySaving = delivery.waived ? this._round(delivery.original) : 0
    const totalSavings = this._round(
      this._num(itemDiscount) + couponDisc + deliverySaving
    )

    const threshold =
      config.free_delivery_above === null || config.free_delivery_above === undefined
        ? null
        : this._num(config.free_delivery_above)
    const freeDeliveryUnlocked = delivery.waived
    const amountToUnlock =
      config.free_delivery_enabled && threshold !== null && !freeDeliveryUnlocked
        ? this._round(Math.max(0, threshold - eligibleSubtotal))
        : 0

    return {
      itemsSubtotal: subtotal,
      itemDiscount: this._round(itemDiscount),
      couponDiscount: couponDisc,
      deliveryFee: delivery.amount,
      deliveryFeeOriginal: delivery.original,
      deliveryFeeWaived: delivery.waived,
      deliveryFeeWaiverReason: delivery.reason,
      handlingFee,
      platformFee,
      smallCartFee,
      surgeFee,
      packagingFee,
      quickDeliverySurcharge,
      tax: taxAmount,
      tipAmount: tip,
      totalSavings,
      totalPayable,
      distance: {
        km: delivery.distanceKnown ? this._round(distanceKm) : null,
        label: distanceLabel,
        known: delivery.distanceKnown,
      },
      freeDelivery: {
        enabled: !!config.free_delivery_enabled,
        threshold,
        unlocked: freeDeliveryUnlocked,
        amountToUnlock,
      },
      deliveryEtaMinutes: this._num(config.delivery_eta_minutes, 30),
      fees,
    }
  }

  /**
   * Admin preview — resolve config for an optional shop and compute a
   * breakdown for the given subtotal + distance.
   */
  async preview({ subtotal, distanceKm, shopId }) {
    const { config, source } = await this.feeSettings.resolveForShop(shopId || null)
    const breakdown = this.computeBreakdown({
      config,
      itemsSubtotal: subtotal,
      distanceKm: distanceKm === undefined ? null : distanceKm,
    })
    return { ...breakdown, configSource: source }
  }
}
