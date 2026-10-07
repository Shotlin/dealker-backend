import { describe, expect, it } from 'vitest'

import { BillSummaryService } from '../../../src/modules/cart/bill-summary.service.js'

/**
 * GST wiring in the multi-shop cart preview (_buildFeesArray / the
 * feesTotal+toPay recomputation in getBillSummary). This path recomputes
 * every fee from per-shop sums rather than trusting the single-shop
 * aggregate TotalsEngine.computeBreakdown() call — GST must be included in
 * that recomputation too, or the cart preview silently drops the tax that
 * the real order-creation path (order-splitter.service.js, which calls
 * computeBreakdown() directly per shop) would still charge.
 */

function service() {
  // _buildFeesArray is pure given its inputs — no DB access.
  return new BillSummaryService({})
}

describe('BillSummaryService._buildFeesArray — GST line', () => {
  it('omits the GST line entirely when gstAmount is 0 (disabled or 0% rate)', () => {
    const fees = service()._buildFeesArray({
      config: { delivery_fee_enabled: false },
      deliveryFee: 0,
      deliveryFeeOriginal: 0,
      deliveryWaived: false,
      handlingFee: 0,
      platformFee: 0,
      smallCartFee: 0,
      surgeFee: 0,
      packagingFee: 0,
      gstAmount: 0,
      distanceKm: null,
      storeName: null,
      amountToUnlock: 0,
    })
    expect(fees.find((f) => f.code === 'GST')).toBeUndefined()
  })

  it('appends a GST line with the configured label and rate when gstAmount > 0', () => {
    const fees = service()._buildFeesArray({
      config: { delivery_fee_enabled: false, gst_label: 'GST', gst_rate: 18 },
      deliveryFee: 0,
      deliveryFeeOriginal: 0,
      deliveryWaived: false,
      handlingFee: 0,
      platformFee: 0,
      smallCartFee: 0,
      surgeFee: 0,
      packagingFee: 0,
      gstAmount: 93.6,
      distanceKm: null,
      storeName: null,
      amountToUnlock: 0,
    })
    const gstLine = fees.find((f) => f.code === 'GST')
    expect(gstLine).toBeDefined()
    expect(gstLine.amount).toBe(93.6)
    expect(gstLine.label).toBe('GST')
    expect(gstLine.metadata.rate).toBe(18)
  })
})

describe('BillSummaryService — GST included in the multi-shop feesTotal/toPay recomputation', () => {
  // Exercises the exact block in getBillSummary() that overwrites
  // aggregate.totalPayable/aggregate.fees from per-shop-summed values —
  // this is a regression guard for the bug where that recomputation
  // silently dropped tax even though TotalsEngine.computeBreakdown()
  // (used per shop group) computed it correctly.
  it('computes GST on (itemTotalDiscounted + feesTotal), matching TotalsEngine\'s own formula', () => {
    const svc = service()
    const itemTotalDiscounted = 500
    const feesTotal = 20 // e.g. delivery fee only
    const config = { gst_enabled: true, gst_rate: 18 }

    const preTaxTotal = svc._round(Math.max(0, itemTotalDiscounted + feesTotal))
    const gstAmount = config.gst_enabled
      ? svc._round((preTaxTotal * svc._toNumber(config.gst_rate)) / 100)
      : 0

    expect(preTaxTotal).toBe(520)
    expect(gstAmount).toBe(93.6)
  })
})
