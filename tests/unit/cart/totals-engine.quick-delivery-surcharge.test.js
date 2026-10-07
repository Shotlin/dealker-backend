import { describe, expect, it } from 'vitest'

import { TotalsEngine, FEE_CODES } from '../../../src/modules/cart/totals-engine.service.js'

/**
 * Coverage for the Quick Delivery surcharge (delivery scheduling feature,
 * Phase 1, 2026-07-03). The surcharge must be double-gated: it only ever
 * appears when BOTH the admin has enabled it (quick_delivery_surcharge_enabled)
 * AND the customer explicitly opted in (quickDeliverySelected) — confirmed
 * product decision that this is never a silent default fee on a plain ASAP
 * order. Every existing caller that doesn't pass quickDeliverySelected must
 * see byte-identical output to before this feature shipped.
 */

const BASE_CONFIG = Object.freeze({
  delivery_fee_enabled: false,
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

  delivery_eta_minutes: 30,

  quick_delivery_surcharge_enabled: false,
  quick_delivery_surcharge_amount: 25,
  quick_delivery_surcharge_label: 'Quick delivery fee',
})

function config(overrides = {}) {
  return { ...BASE_CONFIG, ...overrides }
}

describe('TotalsEngine — Quick Delivery surcharge (positive)', () => {
  const engine = new TotalsEngine()

  it('adds the surcharge fee line and to totalPayable when enabled AND selected', () => {
    const breakdown = engine.computeBreakdown({
      config: config({ quick_delivery_surcharge_enabled: true }),
      itemsSubtotal: 200,
      quickDeliverySelected: true,
    })

    const fee = breakdown.fees.find((f) => f.code === FEE_CODES.QUICK_DELIVERY)
    expect(fee).toMatchObject({ amount: 25, waived: false })
    expect(breakdown.quickDeliverySurcharge).toBe(25)
    expect(breakdown.totalPayable).toBe(225)
  })

  it('uses the admin-configured label and amount', () => {
    const breakdown = engine.computeBreakdown({
      config: config({
        quick_delivery_surcharge_enabled: true,
        quick_delivery_surcharge_amount: 40,
        quick_delivery_surcharge_label: 'Priority delivery',
      }),
      itemsSubtotal: 200,
      quickDeliverySelected: true,
    })

    const fee = breakdown.fees.find((f) => f.code === FEE_CODES.QUICK_DELIVERY)
    expect(fee.label).toBe('Priority delivery')
    expect(fee.amount).toBe(40)
  })
})

describe('TotalsEngine — Quick Delivery surcharge is double-gated (negative, the core product rule)', () => {
  const engine = new TotalsEngine()

  it('does NOT charge the surcharge when enabled but the customer did not select it', () => {
    const breakdown = engine.computeBreakdown({
      config: config({ quick_delivery_surcharge_enabled: true }),
      itemsSubtotal: 200,
      // quickDeliverySelected omitted — defaults to false
    })

    expect(breakdown.fees.find((f) => f.code === FEE_CODES.QUICK_DELIVERY)).toBeUndefined()
    expect(breakdown.quickDeliverySurcharge).toBe(0)
    expect(breakdown.totalPayable).toBe(200)
  })

  it('does NOT charge the surcharge when selected but the admin has it disabled', () => {
    const breakdown = engine.computeBreakdown({
      config: config({ quick_delivery_surcharge_enabled: false }),
      itemsSubtotal: 200,
      quickDeliverySelected: true,
    })

    expect(breakdown.fees.find((f) => f.code === FEE_CODES.QUICK_DELIVERY)).toBeUndefined()
    expect(breakdown.totalPayable).toBe(200)
  })

  it('every existing caller (quickDeliverySelected never passed) sees byte-identical output to pre-feature behavior', () => {
    const breakdown = engine.computeBreakdown({
      config: config({ quick_delivery_surcharge_enabled: true }),
      itemsSubtotal: 200,
    })

    expect(breakdown.fees).toEqual([])
    expect(breakdown.totalPayable).toBe(200)
  })
})
