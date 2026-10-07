import { describe, expect, it } from 'vitest'

import { TotalsEngine } from '../../../src/modules/cart/totals-engine.service.js'

/**
 * Coverage for the forceFreeDelivery override (Phase 2 of the
 * customer-segment marketing system) — a coupon (FREE_DELIVERY
 * discountType) or a first-time-offer (FREE_DELIVERY rewardType) can waive
 * delivery independently of the cart-value threshold in fee_settings.
 * Must not change behaviour for orders that don't have either.
 */

const BASE_CONFIG = Object.freeze({
  delivery_fee_enabled: true,
  min_delivery_fee: 20,
  base_distance_km: 1.5,
  per_km_fee: 8,
  max_delivery_distance_km: 10,
  free_delivery_enabled: true,
  free_delivery_above: 499,
  delivery_fee_label: 'Delivery fee',

  handling_fee_enabled: false,
  handling_fee_type: 'FLAT',
  handling_fee_value: 5,
  platform_fee_enabled: false,
  platform_fee_type: 'FLAT',
  platform_fee_value: 5,
  small_cart_fee_enabled: false,
  small_cart_threshold: 99,
  small_cart_fee: 15,
  surge_fee_enabled: false,
  surge_fee_value: 10,
  packaging_fee_enabled: false,
  packaging_fee_value: 8,
})

function config(overrides = {}) {
  return { ...BASE_CONFIG, ...overrides }
}

describe('TotalsEngine — forceFreeDelivery override (positive)', () => {
  const engine = new TotalsEngine()

  it('waives delivery below the cart-value threshold when forceFreeDelivery is true', () => {
    const breakdown = engine.computeBreakdown({
      config: config(),
      itemsSubtotal: 100, // well below the ₹499 threshold
      distanceKm: 3,
      forceFreeDelivery: true,
    })

    expect(breakdown.deliveryFeeWaived).toBe(true)
    expect(breakdown.freeDelivery.unlocked).toBe(true)
  })

  it('produces a distinct "applied" reason (not the threshold-unlocked reason) when forced', () => {
    const delivery = engine.computeDeliveryFee(config(), 3, 100, true)
    expect(delivery.waived).toBe(true)
    expect(delivery.reason).toBe('Free delivery applied')
  })
})

describe('TotalsEngine — forceFreeDelivery does not affect unrelated orders (negative/regression)', () => {
  const engine = new TotalsEngine()

  it('still charges delivery below threshold when forceFreeDelivery is false/omitted (regression)', () => {
    const breakdown = engine.computeBreakdown({
      config: config(),
      itemsSubtotal: 100,
      distanceKm: 3,
    })

    expect(breakdown.deliveryFeeWaived).toBe(false)
    expect(breakdown.deliveryFee).toBeGreaterThan(0)
  })

  it('still waives delivery when the cart value alone crosses the threshold, with the original reason (regression)', () => {
    const breakdown = engine.computeBreakdown({
      config: config(),
      itemsSubtotal: 600, // above the ₹499 threshold
      distanceKm: 3,
      forceFreeDelivery: false,
    })

    expect(breakdown.deliveryFeeWaived).toBe(true)
    const delivery = engine.computeDeliveryFee(config(), 3, 600, false)
    expect(delivery.reason).toContain('unlocked on orders above')
  })

  it('does not waive delivery when delivery fees are disabled entirely, forceFreeDelivery or not', () => {
    const breakdown = engine.computeBreakdown({
      config: config({ delivery_fee_enabled: false }),
      itemsSubtotal: 100,
      distanceKm: 3,
      forceFreeDelivery: true,
    })

    expect(breakdown.deliveryFeeWaived).toBe(false)
    expect(breakdown.deliveryFee).toBe(0)
  })
})
