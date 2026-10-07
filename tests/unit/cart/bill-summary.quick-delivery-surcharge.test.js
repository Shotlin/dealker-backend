import { describe, expect, it } from 'vitest'

import { BillSummaryService } from '../../../src/modules/cart/bill-summary.service.js'

/**
 * Coverage for the Quick Delivery surcharge line in BillSummaryService's
 * `_buildFeesArray` (delivery scheduling feature, Phase 1, 2026-07-03).
 * `_buildFeesArray` is a pure reconstruction of the fee display array from
 * already-aggregated numbers (used because bill-summary sums per-shop
 * breakdowns rather than calling TotalsEngine once) — this file exercises
 * that reconstruction directly, complementing the TotalsEngine-level
 * coverage in totals-engine.quick-delivery-surcharge.test.js.
 */

function service() {
  return new BillSummaryService({})
}

function baseArgs(overrides = {}) {
  return {
    config: {
      delivery_fee_enabled: false,
      quick_delivery_surcharge_label: 'Quick delivery fee',
    },
    deliveryFee: 0,
    deliveryFeeOriginal: 0,
    deliveryWaived: false,
    handlingFee: 0,
    platformFee: 0,
    smallCartFee: 0,
    surgeFee: 0,
    packagingFee: 0,
    distanceKm: null,
    storeName: null,
    amountToUnlock: 0,
    ...overrides,
  }
}

describe('BillSummaryService._buildFeesArray — Quick Delivery surcharge line (positive)', () => {
  it('includes the surcharge fee line when a positive amount is passed', () => {
    const fees = service()._buildFeesArray(baseArgs({ quickDeliverySurcharge: 25 }))

    const fee = fees.find((f) => f.code === 'QUICK_DELIVERY_SURCHARGE')
    expect(fee).toMatchObject({ label: 'Quick delivery fee', amount: 25, waived: false })
  })

  it('uses the admin-configured label', () => {
    const fees = service()._buildFeesArray(
      baseArgs({
        quickDeliverySurcharge: 30,
        config: { delivery_fee_enabled: false, quick_delivery_surcharge_label: 'Priority delivery' },
      }),
    )

    const fee = fees.find((f) => f.code === 'QUICK_DELIVERY_SURCHARGE')
    expect(fee.label).toBe('Priority delivery')
  })
})

describe('BillSummaryService._buildFeesArray — Quick Delivery surcharge line (negative)', () => {
  it('omits the surcharge line when the amount is 0 (default, most orders)', () => {
    const fees = service()._buildFeesArray(baseArgs())

    expect(fees.find((f) => f.code === 'QUICK_DELIVERY_SURCHARGE')).toBeUndefined()
  })

  it('omits the surcharge line when quickDeliverySurcharge is omitted entirely (every pre-existing caller)', () => {
    const args = baseArgs()
    delete args.quickDeliverySurcharge

    const fees = service()._buildFeesArray(args)

    expect(fees.find((f) => f.code === 'QUICK_DELIVERY_SURCHARGE')).toBeUndefined()
    expect(fees).toEqual([])
  })
})
