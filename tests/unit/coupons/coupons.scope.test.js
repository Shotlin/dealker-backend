// Coverage for category/product/bundle-scoped coupons (088) — the
// applicable_category_ids/applicable_product_ids columns existed since
// migration 044 but were never actually enforced against a real cart at
// checkout (orders.service.js only ever called validate() with a flat
// cartTotal number). This suite covers the new behavior: minOrderAmount
// and the discount amount are both computed against only the matching
// slice of the cart, not the whole order — the same milk-vs-vegetables
// isolation the purchase-limits feature already guarantees, but for
// coupons.

import { describe, expect, it, vi } from 'vitest'
import { CouponsService } from '../../../src/modules/coupons/coupons.service.js'

const VALID_UUID = '11111111-1111-1111-1111-111111111111'
const PROD_MILK = 'prod-milk'
const PROD_CHEESE = 'prod-cheese'
const PROD_TOMATO = 'prod-tomato'

function makeRepoMock(coupon, { matchingIds, categoryNames, productNames } = {}) {
  return {
    findByCode: vi.fn().mockResolvedValue(coupon),
    getUserUsageCount: vi.fn().mockResolvedValue(0),
    getTotalUsageCount: vi.fn().mockResolvedValue(0),
    isTargetUser: vi.fn().mockResolvedValue(false),
    hasPriorOrder: vi.fn().mockResolvedValue(false),
    resolveMatchingProductIds: vi.fn().mockResolvedValue(matchingIds ?? new Set()),
    getCategoryNames: vi.fn().mockResolvedValue(categoryNames ?? []),
    getProductNames: vi.fn().mockResolvedValue(productNames ?? []),
  }
}

function makeSegmentsRepoMock() {
  return { isMember: vi.fn().mockResolvedValue(false) }
}

function baseCoupon(overrides = {}) {
  return {
    id: VALID_UUID,
    code: 'DAIRY10',
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
    applicableCategoryIds: null,
    applicableProductIds: null,
    ...overrides,
  }
}

const cartItems = [
  { productId: PROD_MILK, quantity: 2, effectivePrice: 30, lineTotal: 60 },
  { productId: PROD_CHEESE, quantity: 1, effectivePrice: 40, lineTotal: 40 },
  { productId: PROD_TOMATO, quantity: 5, effectivePrice: 10, lineTotal: 50 },
]
// cart total = 150; dairy-only (milk+cheese) subtotal = 100; tomato-only = 50

describe('CouponsService.validate — category/product scope (088)', () => {
  it('unscoped coupon (no category/product ids): behaves exactly as before, discount against the full cart', async () => {
    const coupon = baseCoupon({ discountType: 'PERCENTAGE', discountValue: 10, minOrderAmount: 100 })
    const repo = makeRepoMock(coupon)
    const service = new CouponsService(repo, makeSegmentsRepoMock())

    const result = await service.validate('user-1', 'DAIRY10', 150, cartItems)

    expect(result.valid).toBe(true)
    expect(result.discount).toBe(15) // 10% of 150
    expect(repo.resolveMatchingProductIds).not.toHaveBeenCalled()
  })

  it('category-scoped coupon: minOrderAmount is checked against the matching subtotal, not the whole cart', async () => {
    // Dairy-only subtotal is 100 — meets a 100 minOrder even though the
    // whole cart (150) would too; the real test is the rejection below.
    const coupon = baseCoupon({
      discountType: 'PERCENTAGE', discountValue: 10, minOrderAmount: 100,
      applicableCategoryIds: ['cat-dairy'],
    })
    const repo = makeRepoMock(coupon, { matchingIds: new Set([PROD_MILK, PROD_CHEESE]) })
    const service = new CouponsService(repo, makeSegmentsRepoMock())

    const result = await service.validate('user-1', 'DAIRY10', 150, cartItems)

    expect(result.valid).toBe(true)
    expect(result.discount).toBe(10) // 10% of the 100 dairy subtotal, NOT 150
    expect(repo.resolveMatchingProductIds).toHaveBeenCalledWith(
      [PROD_MILK, PROD_CHEESE, PROD_TOMATO],
      { applicableCategoryIds: ['cat-dairy'], applicableProductIds: null }
    )
  })

  it('rejects with COUPON_MIN_ORDER_NOT_MET when the matching-scope subtotal alone is under the minimum, even though the whole cart clears it', async () => {
    const coupon = baseCoupon({
      discountType: 'PERCENTAGE', discountValue: 10, minOrderAmount: 120, // whole cart (150) clears this...
      applicableCategoryIds: ['cat-dairy'],
    })
    // ...but dairy alone is only 100
    const repo = makeRepoMock(coupon, { matchingIds: new Set([PROD_MILK, PROD_CHEESE]) })
    const service = new CouponsService(repo, makeSegmentsRepoMock())

    const result = await service.validate('user-1', 'DAIRY10', 150, cartItems)

    expect(result.valid).toBe(false)
    expect(result.code).toBe('COUPON_MIN_ORDER_NOT_MET')
  })

  it('rejects with COUPON_NOT_APPLICABLE when nothing in the cart matches the coupon\'s scope at all (e.g. a Dairy coupon on an all-vegetable cart), naming the actual category in the message', async () => {
    const coupon = baseCoupon({
      discountType: 'PERCENTAGE', discountValue: 10,
      applicableCategoryIds: ['cat-dairy'],
    })
    const repo = makeRepoMock(coupon, { matchingIds: new Set(), categoryNames: ['Dairy'] }) // nothing matches
    const service = new CouponsService(repo, makeSegmentsRepoMock())

    const result = await service.validate('user-1', 'DAIRY10', 150, cartItems)

    expect(result.valid).toBe(false)
    expect(result.code).toBe('COUPON_NOT_APPLICABLE')
    // Previously a flat "specific products or categories" with no way for
    // the customer to act on it — now names what actually qualifies.
    expect(result.message).toContain('Dairy')
  })

  it('rejects a scoped coupon with no cart items provided at all, rather than silently discounting the whole order', async () => {
    const coupon = baseCoupon({ discountType: 'FLAT', discountValue: 20, applicableProductIds: [PROD_MILK] })
    const repo = makeRepoMock(coupon)
    const service = new CouponsService(repo, makeSegmentsRepoMock())

    const result = await service.validate('user-1', 'DAIRY10', 150, null)

    expect(result.valid).toBe(false)
    expect(result.code).toBe('COUPON_NOT_APPLICABLE')
    expect(repo.resolveMatchingProductIds).not.toHaveBeenCalled()
  })

  it('falls back to the generic message when category/product names can\'t be resolved (e.g. a stale/deleted category id)', async () => {
    const coupon = baseCoupon({
      discountType: 'PERCENTAGE', discountValue: 10,
      applicableCategoryIds: ['cat-deleted'],
    })
    const repo = makeRepoMock(coupon, { matchingIds: new Set(), categoryNames: [] })
    const service = new CouponsService(repo, makeSegmentsRepoMock())

    const result = await service.validate('user-1', 'DAIRY10', 150, cartItems)

    expect(result.valid).toBe(false)
    expect(result.message).toContain('specific products or categories')
  })

  it('product-scoped coupon: discount and minOrderAmount both apply against just that product\'s line total', async () => {
    const coupon = baseCoupon({
      discountType: 'FLAT', discountValue: 15, minOrderAmount: 50,
      applicableProductIds: [PROD_TOMATO],
    })
    const repo = makeRepoMock(coupon, { matchingIds: new Set([PROD_TOMATO]) })
    const service = new CouponsService(repo, makeSegmentsRepoMock())

    const result = await service.validate('user-1', 'DAIRY10', 150, cartItems)

    expect(result.valid).toBe(true)
    expect(result.discount).toBe(15)
  })

  it('a bundle-scoped coupon (category id happens to be a BUNDLE) works through the exact same applicableCategoryIds path — the repository, not the service, knows about bundles', async () => {
    const coupon = baseCoupon({
      discountType: 'PERCENTAGE', discountValue: 20,
      applicableCategoryIds: ['bundle-combo-offer'],
    })
    const repo = makeRepoMock(coupon, { matchingIds: new Set([PROD_MILK]) })
    const service = new CouponsService(repo, makeSegmentsRepoMock())

    const result = await service.validate('user-1', 'DAIRY10', 150, cartItems)

    expect(result.valid).toBe(true)
    expect(result.discount).toBe(12) // 20% of milk's 60 line total
  })

  it('caps the discount at maxDiscount against the scoped subtotal, same as the unscoped case', async () => {
    const coupon = baseCoupon({
      discountType: 'PERCENTAGE', discountValue: 50, maxDiscount: 5,
      applicableCategoryIds: ['cat-dairy'],
    })
    const repo = makeRepoMock(coupon, { matchingIds: new Set([PROD_MILK, PROD_CHEESE]) })
    const service = new CouponsService(repo, makeSegmentsRepoMock())

    const result = await service.validate('user-1', 'DAIRY10', 150, cartItems)

    expect(result.discount).toBe(5) // 50% of 100 = 50, capped at maxDiscount 5
  })
})
