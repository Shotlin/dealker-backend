// Coverage for the new CASHBACK / FREE_DELIVERY coupon discountTypes
// (Phase 2 of the customer-segment marketing system) — neither should
// reduce the order total the way PERCENTAGE/FLAT do; they produce a
// separate effect the caller (orders.service.js) applies elsewhere.

import { describe, expect, it, vi } from 'vitest'
import { CouponsService } from '../../../src/modules/coupons/coupons.service.js'

const VALID_UUID = '11111111-1111-1111-1111-111111111111'

function makeRepoMock(coupon) {
  return {
    findByCode: vi.fn().mockResolvedValue(coupon),
    getUserUsageCount: vi.fn().mockResolvedValue(0),
    getTotalUsageCount: vi.fn().mockResolvedValue(0),
    isTargetUser: vi.fn().mockResolvedValue(false),
    hasPriorOrder: vi.fn().mockResolvedValue(false),
  }
}

function makeSegmentsRepoMock() {
  return { isMember: vi.fn().mockResolvedValue(false) }
}

function baseCoupon(overrides = {}) {
  return {
    id: VALID_UUID,
    code: 'TESTCODE',
    isActive: true,
    validFrom: null,
    validUntil: null,
    minOrderAmount: 0,
    usageLimit: null,
    usedCount: 0,
    usageLimitTotal: null,
    usageLimitPerUser: null,
    perUserLimit: 1,
    targetType: 'ALL',
    targetSegmentId: null,
    discountValue: 0,
    ...overrides,
  }
}

describe('CouponsService.validate — CASHBACK discountType (positive/negative)', () => {
  it('discount stays 0 and cashbackAmount is returned instead (positive)', async () => {
    const coupon = baseCoupon({ discountType: 'CASHBACK', discountValue: 50, cashbackCreditTrigger: 'ORDER_DELIVERED' })
    const service = new CouponsService(makeRepoMock(coupon), makeSegmentsRepoMock())

    const result = await service.validate('user-1', 'TESTCODE', 500)

    expect(result.valid).toBe(true)
    expect(result.discount).toBe(0)
    expect(result.cashbackAmount).toBe(50)
    expect(result.cashbackCreditTrigger).toBe('ORDER_DELIVERED')
  })

  it('cashbackAmount is capped at the cart total (negative — cannot exceed order value)', async () => {
    const coupon = baseCoupon({ discountType: 'CASHBACK', discountValue: 500 })
    const service = new CouponsService(makeRepoMock(coupon), makeSegmentsRepoMock())

    const result = await service.validate('user-1', 'TESTCODE', 100)

    expect(result.cashbackAmount).toBe(100)
  })

  it('defaults cashbackCreditTrigger to ORDER_DELIVERED when not configured', async () => {
    const coupon = baseCoupon({ discountType: 'CASHBACK', discountValue: 20, cashbackCreditTrigger: undefined })
    const service = new CouponsService(makeRepoMock(coupon), makeSegmentsRepoMock())

    const result = await service.validate('user-1', 'TESTCODE', 500)

    expect(result.cashbackCreditTrigger).toBe('ORDER_DELIVERED')
  })
})

describe('CouponsService.validate — FREE_DELIVERY discountType (positive)', () => {
  it('discount stays 0 and freeDelivery flag is set', async () => {
    const coupon = baseCoupon({ discountType: 'FREE_DELIVERY', discountValue: 0 })
    const service = new CouponsService(makeRepoMock(coupon), makeSegmentsRepoMock())

    const result = await service.validate('user-1', 'TESTCODE', 200)

    expect(result.valid).toBe(true)
    expect(result.discount).toBe(0)
    expect(result.freeDelivery).toBe(true)
  })
})

describe('CouponsService.validate — grantsFreeDelivery (088): free delivery independent of discountType', () => {
  it('a PERCENTAGE coupon with grantsFreeDelivery still discounts AND sets freeDelivery — both effects, not one or the other', async () => {
    const coupon = baseCoupon({ discountType: 'PERCENTAGE', discountValue: 10, grantsFreeDelivery: true })
    const service = new CouponsService(makeRepoMock(coupon), makeSegmentsRepoMock())

    const result = await service.validate('user-1', 'TESTCODE', 500)

    expect(result.valid).toBe(true)
    expect(result.discount).toBe(50) // 10% of 500
    expect(result.freeDelivery).toBe(true)
  })

  it('a FLAT coupon without grantsFreeDelivery does not set freeDelivery', async () => {
    const coupon = baseCoupon({ discountType: 'FLAT', discountValue: 20, grantsFreeDelivery: false })
    const service = new CouponsService(makeRepoMock(coupon), makeSegmentsRepoMock())

    const result = await service.validate('user-1', 'TESTCODE', 500)

    expect(result.freeDelivery).toBe(false)
  })

  it('a CASHBACK coupon can also grantFreeDelivery alongside the cashback', async () => {
    const coupon = baseCoupon({ discountType: 'CASHBACK', discountValue: 30, grantsFreeDelivery: true })
    const service = new CouponsService(makeRepoMock(coupon), makeSegmentsRepoMock())

    const result = await service.validate('user-1', 'TESTCODE', 500)

    expect(result.cashbackAmount).toBe(30)
    expect(result.freeDelivery).toBe(true)
  })
})

describe('CouponsService.validate — PERCENTAGE/FLAT still unaffected (regression)', () => {
  it('a plain FLAT coupon still reduces the order total as before', async () => {
    const coupon = baseCoupon({ discountType: 'FLAT', discountValue: 50 })
    const service = new CouponsService(makeRepoMock(coupon), makeSegmentsRepoMock())

    const result = await service.validate('user-1', 'TESTCODE', 500)

    expect(result.discount).toBe(50)
    expect(result.cashbackAmount).toBeUndefined()
    // Explicitly false, not undefined — grantsFreeDelivery (088) means
    // every coupon now carries a real freeDelivery verdict, not just the
    // FREE_DELIVERY discountType. Both are falsy to any `if (freeDelivery)`
    // caller, but `false` is the correct value for the Flutter side's
    // non-nullable `bool freeDelivery` field.
    expect(result.freeDelivery).toBe(false)
  })
})
