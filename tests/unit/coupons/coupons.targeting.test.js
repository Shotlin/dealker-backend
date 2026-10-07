// Coverage for Phase 1 of the customer-segment marketing system: coupon
// targeting (ALL / SEGMENT / INDIVIDUAL / FIRST_TIME). Uses constructor
// injection (CouponsService takes repo + segmentsRepo directly) so no
// database/redis mocking is needed — this isolates the targeting logic in
// validateCouponEligibility() from everything else.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CouponsService } from '../../../src/modules/coupons/coupons.service.js'
import { ERROR_CODES } from '../../../src/constants/errors.js'

const VALID_UUID = '11111111-1111-1111-1111-111111111111'
const OTHER_UUID = '22222222-2222-2222-2222-222222222222'
const SEGMENT_UUID = '33333333-3333-3333-3333-333333333333'

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
    discountType: 'FLAT',
    discountValue: 50,
    ...overrides,
  }
}

function makeRepoMock(overrides = {}) {
  return {
    getUserUsageCount: vi.fn().mockResolvedValue(0),
    getTotalUsageCount: vi.fn().mockResolvedValue(0),
    isTargetUser: vi.fn().mockResolvedValue(false),
    hasPriorOrder: vi.fn().mockResolvedValue(false),
    ...overrides,
  }
}

function makeSegmentsRepoMock(overrides = {}) {
  return {
    isMember: vi.fn().mockResolvedValue(false),
    ...overrides,
  }
}

describe('CouponsService.validateCouponEligibility — targeting (positive)', () => {
  it('ALL-type coupons are unaffected by targeting (existing behaviour preserved)', async () => {
    const service = new CouponsService(makeRepoMock(), makeSegmentsRepoMock())
    const result = await service.validateCouponEligibility(baseCoupon({ targetType: 'ALL' }), OTHER_UUID, 100)
    expect(result.valid).toBe(true)
  })

  it('demo coupons (no targetType at all) are unaffected by targeting', async () => {
    const service = new CouponsService(makeRepoMock(), makeSegmentsRepoMock())
    const demoCoupon = baseCoupon({ id: 'demo-coupon-bakaloo50', targetType: undefined })
    const result = await service.validateCouponEligibility(demoCoupon, OTHER_UUID, 100)
    expect(result.valid).toBe(true)
  })

  it('SEGMENT-type coupon succeeds for a member of the target segment', async () => {
    const segmentsRepo = makeSegmentsRepoMock({ isMember: vi.fn().mockResolvedValue(true) })
    const service = new CouponsService(makeRepoMock(), segmentsRepo)
    const coupon = baseCoupon({ targetType: 'SEGMENT', targetSegmentId: SEGMENT_UUID })
    const result = await service.validateCouponEligibility(coupon, VALID_UUID, 100)
    expect(result.valid).toBe(true)
    expect(segmentsRepo.isMember).toHaveBeenCalledWith(SEGMENT_UUID, VALID_UUID)
  })

  it('INDIVIDUAL-type coupon succeeds for a targeted user', async () => {
    const repo = makeRepoMock({ isTargetUser: vi.fn().mockResolvedValue(true) })
    const service = new CouponsService(repo, makeSegmentsRepoMock())
    const coupon = baseCoupon({ targetType: 'INDIVIDUAL' })
    const result = await service.validateCouponEligibility(coupon, VALID_UUID, 100)
    expect(result.valid).toBe(true)
  })

  it('FIRST_TIME-type coupon succeeds for a user with no prior orders', async () => {
    const repo = makeRepoMock({ hasPriorOrder: vi.fn().mockResolvedValue(false) })
    const service = new CouponsService(repo, makeSegmentsRepoMock())
    const coupon = baseCoupon({ targetType: 'FIRST_TIME' })
    const result = await service.validateCouponEligibility(coupon, VALID_UUID, 100)
    expect(result.valid).toBe(true)
  })
})

describe('CouponsService.validateCouponEligibility — targeting (negative)', () => {
  it('SEGMENT-type coupon rejects a non-member with the exact required copy', async () => {
    const segmentsRepo = makeSegmentsRepoMock({ isMember: vi.fn().mockResolvedValue(false) })
    const service = new CouponsService(makeRepoMock(), segmentsRepo)
    const coupon = baseCoupon({ targetType: 'SEGMENT', targetSegmentId: SEGMENT_UUID })
    const result = await service.validateCouponEligibility(coupon, OTHER_UUID, 100)
    expect(result.valid).toBe(false)
    expect(result.code).toBe(ERROR_CODES.COUPON_SEGMENT_RESTRICTED)
    expect(result.message).toBe('This coupon is only available for selected customers.')
  })

  it('SEGMENT-type coupon with no targetSegmentId set rejects everyone (misconfiguration fails closed)', async () => {
    const segmentsRepo = makeSegmentsRepoMock()
    const service = new CouponsService(makeRepoMock(), segmentsRepo)
    const coupon = baseCoupon({ targetType: 'SEGMENT', targetSegmentId: null })
    const result = await service.validateCouponEligibility(coupon, VALID_UUID, 100)
    expect(result.valid).toBe(false)
    expect(segmentsRepo.isMember).not.toHaveBeenCalled()
  })

  it('INDIVIDUAL-type coupon rejects a non-targeted user with the exact required copy', async () => {
    const repo = makeRepoMock({ isTargetUser: vi.fn().mockResolvedValue(false) })
    const service = new CouponsService(repo, makeSegmentsRepoMock())
    const coupon = baseCoupon({ targetType: 'INDIVIDUAL' })
    const result = await service.validateCouponEligibility(coupon, OTHER_UUID, 100)
    expect(result.valid).toBe(false)
    expect(result.code).toBe(ERROR_CODES.COUPON_NOT_APPLICABLE)
    expect(result.message).toBe('This coupon is not applicable to your account.')
  })

  it('FIRST_TIME-type coupon rejects a repeat customer', async () => {
    const repo = makeRepoMock({ hasPriorOrder: vi.fn().mockResolvedValue(true) })
    const service = new CouponsService(repo, makeSegmentsRepoMock())
    const coupon = baseCoupon({ targetType: 'FIRST_TIME' })
    const result = await service.validateCouponEligibility(coupon, VALID_UUID, 100)
    expect(result.valid).toBe(false)
    expect(result.code).toBe(ERROR_CODES.COUPON_NOT_APPLICABLE)
    expect(result.message).toBe('This coupon is not applicable to your account.')
  })
})

describe('CouponsService.validateCouponEligibility — existing checks still work (regression)', () => {
  let repo, segmentsRepo, service

  beforeEach(() => {
    repo = makeRepoMock()
    segmentsRepo = makeSegmentsRepoMock()
    service = new CouponsService(repo, segmentsRepo)
  })

  it('still rejects an inactive coupon', async () => {
    const result = await service.validateCouponEligibility(baseCoupon({ isActive: false }), VALID_UUID, 100)
    expect(result.valid).toBe(false)
    expect(result.code).toBe(ERROR_CODES.COUPON_INACTIVE)
  })

  it('still rejects an expired coupon', async () => {
    const coupon = baseCoupon({ validUntil: '2020-01-01T00:00:00.000Z' })
    const result = await service.validateCouponEligibility(coupon, VALID_UUID, 100)
    expect(result.valid).toBe(false)
    expect(result.code).toBe(ERROR_CODES.COUPON_EXPIRED)
  })

  it('still rejects when cart total is below min_order_amount (ALL-type coupon, unaffected by targeting)', async () => {
    const coupon = baseCoupon({ minOrderAmount: 500 })
    const result = await service.validateCouponEligibility(coupon, VALID_UUID, 100)
    expect(result.valid).toBe(false)
    expect(result.code).toBe(ERROR_CODES.COUPON_MIN_ORDER_NOT_MET)
  })

  it('still rejects when the user already hit their per-user usage limit', async () => {
    repo.getUserUsageCount = vi.fn().mockResolvedValue(1)
    const coupon = baseCoupon({ perUserLimit: 1 })
    const result = await service.validateCouponEligibility(coupon, VALID_UUID, 100)
    expect(result.valid).toBe(false)
    expect(result.code).toBe(ERROR_CODES.COUPON_USER_LIMIT_REACHED)
  })

  it('still succeeds for a plain valid ALL-type coupon (full positive baseline)', async () => {
    const result = await service.validateCouponEligibility(baseCoupon(), VALID_UUID, 1000)
    expect(result.valid).toBe(true)
  })
})
