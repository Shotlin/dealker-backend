import { describe, expect, it } from 'vitest'

import { TotalsEngine, FEE_CODES } from '../../../src/modules/cart/totals-engine.service.js'

/**
 * Regression coverage for the "fee toggles don't take effect" bug report
 * (2026-07-02): the admin turns delivery / platform / small-cart / rain
 * (surge) / packaging fees on and off in Settings → Fees and the change
 * doesn't show up for the customer.
 *
 * Root cause was architectural (a dead duplicate settings surface never
 * read by order calculation — see migration 065) rather than a bug in
 * TotalsEngine itself, but these tests pin down the actual gating logic so
 * a future regression here is caught immediately: every fee type must be
 * ON when enabled=true and completely absent from the bill when
 * enabled=false, for every fee independently of the others.
 */

const BASE_CONFIG = Object.freeze({
  delivery_fee_enabled: true,
  min_delivery_fee: 20,
  base_distance_km: 1.5,
  per_km_fee: 8,
  max_delivery_distance_km: 10,
  free_delivery_enabled: false,
  free_delivery_above: null,
  delivery_fee_label: 'Delivery fee',

  handling_fee_enabled: false,
  handling_fee_type: 'FLAT',
  handling_fee_value: 5,
  handling_fee_label: 'Handling fee',
  handling_fee_description: null,

  platform_fee_enabled: false,
  platform_fee_type: 'FLAT',
  platform_fee_value: 5,
  platform_fee_label: 'Platform fee',
  platform_fee_description: null,

  small_cart_fee_enabled: false,
  small_cart_threshold: 99,
  small_cart_fee: 15,
  small_cart_fee_label: 'Small cart fee',
  small_cart_fee_description: null,

  surge_fee_enabled: false,
  surge_fee_value: 10,
  surge_fee_label: 'Rain fee',
  surge_fee_description: null,

  packaging_fee_enabled: false,
  packaging_fee_value: 8,
  packaging_fee_label: 'Packaging fee',
  packaging_fee_description: null,

  delivery_eta_minutes: 30,
})

function config(overrides = {}) {
  return { ...BASE_CONFIG, ...overrides }
}

function feeCodesIn(breakdown) {
  return breakdown.fees.map((f) => f.code)
}

describe('TotalsEngine — fee enable/disable toggles', () => {
  const engine = new TotalsEngine()
  // Subtotal chosen above the small-cart threshold so that fee is naturally
  // off unless its own test explicitly wants it triggered.
  const ITEMS_SUBTOTAL = 500

  it('includes every fee type in the breakdown when all are enabled (positive)', () => {
    const breakdown = engine.computeBreakdown({
      config: config({
        delivery_fee_enabled: true,
        handling_fee_enabled: true,
        platform_fee_enabled: true,
        small_cart_fee_enabled: true,
        small_cart_threshold: 1000, // force it to apply at subtotal 500
        surge_fee_enabled: true,
        packaging_fee_enabled: true,
      }),
      itemsSubtotal: ITEMS_SUBTOTAL,
      distanceKm: 3,
    })

    const codes = feeCodesIn(breakdown)
    expect(codes).toEqual(
      expect.arrayContaining([
        FEE_CODES.DELIVERY,
        FEE_CODES.HANDLING,
        FEE_CODES.PLATFORM,
        FEE_CODES.SMALL_CART,
        FEE_CODES.SURGE,
        FEE_CODES.PACKAGING,
      ])
    )
    const feesTotal = breakdown.fees.reduce((sum, f) => sum + f.amount, 0)
    expect(feesTotal).toBeGreaterThan(0)
  })

  it('omits every fee type from the breakdown when all are disabled (negative)', () => {
    const breakdown = engine.computeBreakdown({
      config: config({
        delivery_fee_enabled: false,
        handling_fee_enabled: false,
        platform_fee_enabled: false,
        small_cart_fee_enabled: false,
        surge_fee_enabled: false,
        packaging_fee_enabled: false,
      }),
      itemsSubtotal: ITEMS_SUBTOTAL,
      distanceKm: 3,
    })

    expect(breakdown.fees).toEqual([])
    expect(breakdown.totalPayable).toBe(ITEMS_SUBTOTAL)
  })

  it.each([
    ['delivery_fee_enabled', FEE_CODES.DELIVERY],
    ['handling_fee_enabled', FEE_CODES.HANDLING],
    ['platform_fee_enabled', FEE_CODES.PLATFORM],
    ['surge_fee_enabled', FEE_CODES.SURGE],
    ['packaging_fee_enabled', FEE_CODES.PACKAGING],
  ])('toggling %s off removes only %s from the bill, others untouched', (flagKey, code) => {
    const enabledBreakdown = engine.computeBreakdown({
      config: config({
        delivery_fee_enabled: true,
        handling_fee_enabled: true,
        platform_fee_enabled: true,
        surge_fee_enabled: true,
        packaging_fee_enabled: true,
      }),
      itemsSubtotal: ITEMS_SUBTOTAL,
      distanceKm: 3,
    })
    expect(feeCodesIn(enabledBreakdown)).toContain(code)

    const disabledBreakdown = engine.computeBreakdown({
      config: config({
        delivery_fee_enabled: true,
        handling_fee_enabled: true,
        platform_fee_enabled: true,
        surge_fee_enabled: true,
        packaging_fee_enabled: true,
        [flagKey]: false,
      }),
      itemsSubtotal: ITEMS_SUBTOTAL,
      distanceKm: 3,
    })

    expect(feeCodesIn(disabledBreakdown)).not.toContain(code)
    // Every other previously-enabled fee must still be present — a toggle
    // must not have side effects on unrelated fee types.
    const remaining = feeCodesIn(enabledBreakdown).filter((c) => c !== code)
    expect(feeCodesIn(disabledBreakdown)).toEqual(expect.arrayContaining(remaining))
  })

  it('small cart fee applies only below threshold and disappears when disabled (positive + negative)', () => {
    const belowThreshold = engine.computeBreakdown({
      config: config({ small_cart_fee_enabled: true, small_cart_threshold: 99, small_cart_fee: 15 }),
      itemsSubtotal: 50,
    })
    expect(feeCodesIn(belowThreshold)).toContain(FEE_CODES.SMALL_CART)

    const aboveThreshold = engine.computeBreakdown({
      config: config({ small_cart_fee_enabled: true, small_cart_threshold: 99, small_cart_fee: 15 }),
      itemsSubtotal: 150,
    })
    expect(feeCodesIn(aboveThreshold)).not.toContain(FEE_CODES.SMALL_CART)

    const disabledButBelowThreshold = engine.computeBreakdown({
      config: config({ small_cart_fee_enabled: false, small_cart_threshold: 99, small_cart_fee: 15 }),
      itemsSubtotal: 50,
    })
    expect(feeCodesIn(disabledButBelowThreshold)).not.toContain(FEE_CODES.SMALL_CART)
  })

  it('rain (surge) fee reflects live config value, not a stale amount, across repeated calls', () => {
    const first = engine.computeBreakdown({
      config: config({ surge_fee_enabled: true, surge_fee_value: 10 }),
      itemsSubtotal: ITEMS_SUBTOTAL,
    })
    const rainFee1 = first.fees.find((f) => f.code === FEE_CODES.SURGE)
    expect(rainFee1.amount).toBe(10)

    // Admin raises the rain fee — engine is stateless/pure, so a fresh call
    // with the new config must reflect it immediately (no caching layer).
    const second = engine.computeBreakdown({
      config: config({ surge_fee_enabled: true, surge_fee_value: 25 }),
      itemsSubtotal: ITEMS_SUBTOTAL,
    })
    const rainFee2 = second.fees.find((f) => f.code === FEE_CODES.SURGE)
    expect(rainFee2.amount).toBe(25)

    // Admin turns it back off — must vanish, not just zero out.
    const third = engine.computeBreakdown({
      config: config({ surge_fee_enabled: false, surge_fee_value: 25 }),
      itemsSubtotal: ITEMS_SUBTOTAL,
    })
    expect(feeCodesIn(third)).not.toContain(FEE_CODES.SURGE)
  })

  it('packaging fee of zero value does not render even when enabled (no phantom fee lines)', () => {
    const breakdown = engine.computeBreakdown({
      config: config({ packaging_fee_enabled: true, packaging_fee_value: 0 }),
      itemsSubtotal: ITEMS_SUBTOTAL,
    })
    expect(feeCodesIn(breakdown)).not.toContain(FEE_CODES.PACKAGING)
  })

  it('percentage-type platform fee scales with subtotal and disables cleanly', () => {
    const enabled = engine.computeBreakdown({
      config: config({ platform_fee_enabled: true, platform_fee_type: 'PERCENT', platform_fee_value: 2 }),
      itemsSubtotal: 1000,
    })
    const platformFee = enabled.fees.find((f) => f.code === FEE_CODES.PLATFORM)
    expect(platformFee.amount).toBe(20) // 2% of 1000

    const disabled = engine.computeBreakdown({
      config: config({ platform_fee_enabled: false, platform_fee_type: 'PERCENT', platform_fee_value: 2 }),
      itemsSubtotal: 1000,
    })
    expect(feeCodesIn(disabled)).not.toContain(FEE_CODES.PLATFORM)
  })
})
