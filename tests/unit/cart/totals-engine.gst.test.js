import { describe, expect, it } from 'vitest'

import { TotalsEngine } from '../../../src/modules/cart/totals-engine.service.js'

/**
 * GST (Todo: "add real per-order tax") — exclusive, computed on
 * (subtotal - coupon + all other fees), off by default so enabling it is
 * always an explicit admin action (Settings -> Fees).
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
  handling_fee_value: 0,

  platform_fee_enabled: false,
  platform_fee_type: 'FLAT',
  platform_fee_value: 0,

  small_cart_fee_enabled: false,
  small_cart_threshold: 99,
  small_cart_fee: 0,

  surge_fee_enabled: false,
  surge_fee_value: 0,

  packaging_fee_enabled: false,
  packaging_fee_value: 0,

  delivery_eta_minutes: 30,

  gst_enabled: false,
  gst_rate: 18,
  gst_label: 'GST',
})

function config(overrides = {}) {
  return { ...BASE_CONFIG, ...overrides }
}

describe('TotalsEngine.computeBreakdown — GST', () => {
  const engine = new TotalsEngine()

  it('is a complete no-op when gst_enabled is false (default) — zero behavior change', () => {
    const breakdown = engine.computeBreakdown({
      config: config({ gst_enabled: false }),
      itemsSubtotal: 500,
    })
    expect(breakdown.tax).toBe(0)
    expect(breakdown.fees.find((f) => f.code === 'GST')).toBeUndefined()
    expect(breakdown.totalPayable).toBe(520) // 500 subtotal + 20 delivery
  })

  it('charges GST exclusively on top of (subtotal + fees), not baked into existing prices', () => {
    // subtotal 500 (no distance -> min delivery fee 20) = 520 pre-tax.
    // 18% of 520 = 93.60
    const breakdown = engine.computeBreakdown({
      config: config({ gst_enabled: true, gst_rate: 18 }),
      itemsSubtotal: 500,
    })
    expect(breakdown.tax).toBe(93.6)
    expect(breakdown.totalPayable).toBe(613.6) // 520 + 93.60
    const gstLine = breakdown.fees.find((f) => f.code === 'GST')
    expect(gstLine).toBeDefined()
    expect(gstLine.amount).toBe(93.6)
    expect(gstLine.label).toBe('GST')
  })

  it('computes GST on the post-coupon-discount base, not the raw subtotal', () => {
    // subtotal 500, coupon -100 => 400, + delivery 20 = 420 pre-tax base.
    // 18% of 420 = 75.60
    const breakdown = engine.computeBreakdown({
      config: config({ gst_enabled: true, gst_rate: 18 }),
      itemsSubtotal: 500,
      couponDiscount: 100,
    })
    expect(breakdown.tax).toBe(75.6)
  })

  it('never taxes the tip (a voluntary gratuity, not part of the order value)', () => {
    const withoutTip = engine.computeBreakdown({
      config: config({ gst_enabled: true, gst_rate: 18 }),
      itemsSubtotal: 500,
      tipAmount: 0,
    })
    const withTip = engine.computeBreakdown({
      config: config({ gst_enabled: true, gst_rate: 18 }),
      itemsSubtotal: 500,
      tipAmount: 50,
    })
    expect(withTip.tax).toBe(withoutTip.tax)
    expect(withTip.totalPayable).toBe(withoutTip.totalPayable + 50)
  })

  it('uses the configurable label and rate from fee_settings', () => {
    const breakdown = engine.computeBreakdown({
      config: config({ gst_enabled: true, gst_rate: 5, gst_label: 'Sales Tax' }),
      itemsSubtotal: 1000,
    })
    const gstLine = breakdown.fees.find((f) => f.code === 'GST')
    expect(gstLine.label).toBe('Sales Tax')
    expect(gstLine.metadata.rate).toBe(5)
  })

  it('respects a 0% rate even when enabled (produces no charge, no fee line)', () => {
    const breakdown = engine.computeBreakdown({
      config: config({ gst_enabled: true, gst_rate: 0 }),
      itemsSubtotal: 500,
    })
    expect(breakdown.tax).toBe(0)
    expect(breakdown.fees.find((f) => f.code === 'GST')).toBeUndefined()
  })
})
