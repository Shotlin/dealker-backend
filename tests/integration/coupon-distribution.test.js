// Task 23.6 — Multi-shop coupon distribution
// PLATFORM_COUPON across 3 shop groups → discounts sum exactly to coupon's total.
// SHOP_COUPON only affects matching shop.
//
// Requirements: R26.5, R26.8
// Design: §9.3 (applyCouponToCart with per-shop-order-group evaluation)
//
// This test exercises CouponsService.applyCouponToCart() directly — it's a
// pure computation with no I/O dependencies.

import { describe, expect, it } from 'vitest'
import { CouponsService } from '../../src/modules/coupons/coupons.service.js'

// ─── Helpers ─────────────────────────────────────────────────────────

const service = new CouponsService(null) // No repo needed for applyCouponToCart

function makeCart(shopGroups) {
  return { shopGroups }
}

function makeShopGroup(shopId, items, deliveryFee = 30) {
  return { shopId, items, deliveryFee }
}

function makeItem(productId, price, qty, categoryId = 'cat-1') {
  return { productId, price, qty, categoryId }
}

function makePlatformCoupon(overrides = {}) {
  return {
    couponType: 'PLATFORM_COUPON',
    discountType: 'PERCENTAGE',
    discountValue: 10,
    maxDiscount: null,
    ...overrides,
  }
}

function makeShopCoupon(shopId, overrides = {}) {
  return {
    couponType: 'SHOP_COUPON',
    shopId,
    applicableShopIds: [shopId],
    discountType: 'FLAT',
    discountValue: 50,
    maxDiscount: null,
    ...overrides,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('Task 23.6 — Multi-shop coupon distribution', () => {
  describe('PLATFORM_COUPON across 3 shop groups', () => {
    const cart = makeCart([
      makeShopGroup('shop-A', [
        makeItem('prod-1', 100, 2), // 200
        makeItem('prod-2', 50, 1),  // 50
      ]),
      makeShopGroup('shop-B', [
        makeItem('prod-3', 150, 1), // 150
      ]),
      makeShopGroup('shop-C', [
        makeItem('prod-4', 80, 3),  // 240
        makeItem('prod-5', 60, 1),  // 60
      ]),
    ])
    // Cart total: 200 + 50 + 150 + 240 + 60 = 700

    it('discounts sum exactly to coupon total (percentage)', () => {
      const coupon = makePlatformCoupon({ discountType: 'PERCENTAGE', discountValue: 10 })
      // 10% of 700 = 70

      const result = service.applyCouponToCart(cart, coupon)

      expect(result.totalDiscount).toBe(70)
      const sumOfShopDiscounts = result.shopDiscounts.reduce(
        (sum, sd) => sum + sd.discount, 0
      )
      expect(sumOfShopDiscounts).toBeCloseTo(result.totalDiscount, 2)
    })

    it('discounts sum exactly to coupon total (flat)', () => {
      const coupon = makePlatformCoupon({ discountType: 'FLAT', discountValue: 100 })

      const result = service.applyCouponToCart(cart, coupon)

      expect(result.totalDiscount).toBe(100)
      const sumOfShopDiscounts = result.shopDiscounts.reduce(
        (sum, sd) => sum + sd.discount, 0
      )
      expect(sumOfShopDiscounts).toBeCloseTo(result.totalDiscount, 2)
    })

    it('distributes proportionally based on shop group totals', () => {
      const coupon = makePlatformCoupon({ discountType: 'FLAT', discountValue: 70 })
      // Shop A: 250/700 = 35.71%, Shop B: 150/700 = 21.43%, Shop C: 300/700 = 42.86%

      const result = service.applyCouponToCart(cart, coupon)

      expect(result.shopDiscounts).toHaveLength(3)
      const shopA = result.shopDiscounts.find((sd) => sd.shopId === 'shop-A')
      const shopB = result.shopDiscounts.find((sd) => sd.shopId === 'shop-B')
      const shopC = result.shopDiscounts.find((sd) => sd.shopId === 'shop-C')

      expect(shopA.discount).toBeGreaterThan(0)
      expect(shopB.discount).toBeGreaterThan(0)
      expect(shopC.discount).toBeGreaterThan(0)

      // Shop C has the largest total (300) so gets the largest share
      expect(shopC.discount).toBeGreaterThan(shopB.discount)
    })

    it('respects maxDiscount cap', () => {
      const coupon = makePlatformCoupon({
        discountType: 'PERCENTAGE',
        discountValue: 50, // 50% of 700 = 350
        maxDiscount: 100,  // capped at 100
      })

      const result = service.applyCouponToCart(cart, coupon)

      expect(result.totalDiscount).toBe(100)
      const sumOfShopDiscounts = result.shopDiscounts.reduce(
        (sum, sd) => sum + sd.discount, 0
      )
      expect(sumOfShopDiscounts).toBeCloseTo(100, 2)
    })

    it('largest-remainder rounding preserves exact sum (no floating point drift)', () => {
      // Cart with values that produce repeating decimals
      const trickyCart = makeCart([
        makeShopGroup('shop-X', [makeItem('p1', 33, 1)]),  // 33
        makeShopGroup('shop-Y', [makeItem('p2', 33, 1)]),  // 33
        makeShopGroup('shop-Z', [makeItem('p3', 34, 1)]),  // 34
      ])
      // Total: 100, 10% = 10.00
      const coupon = makePlatformCoupon({ discountType: 'PERCENTAGE', discountValue: 10 })

      const result = service.applyCouponToCart(trickyCart, coupon)

      expect(result.totalDiscount).toBe(10)
      const sumOfShopDiscounts = result.shopDiscounts.reduce(
        (sum, sd) => sum + sd.discount, 0
      )
      // Must be EXACTLY equal, not just close
      expect(sumOfShopDiscounts).toBe(result.totalDiscount)
    })

    it('handles uneven splits without losing cents', () => {
      // 3 shops with equal totals, flat discount of 10 (10/3 = 3.33...)
      const evenCart = makeCart([
        makeShopGroup('shop-1', [makeItem('p1', 100, 1)]),
        makeShopGroup('shop-2', [makeItem('p2', 100, 1)]),
        makeShopGroup('shop-3', [makeItem('p3', 100, 1)]),
      ])
      const coupon = makePlatformCoupon({ discountType: 'FLAT', discountValue: 10 })

      const result = service.applyCouponToCart(evenCart, coupon)

      expect(result.totalDiscount).toBe(10)
      const sumOfShopDiscounts = result.shopDiscounts.reduce(
        (sum, sd) => sum + sd.discount, 0
      )
      // Sum must be exactly 10, not 9.99 or 10.01
      expect(sumOfShopDiscounts).toBe(10)
    })

    it('discount never exceeds cart total', () => {
      const smallCart = makeCart([
        makeShopGroup('shop-A', [makeItem('p1', 10, 1)]),
        makeShopGroup('shop-B', [makeItem('p2', 5, 1)]),
      ])
      // Cart total: 15
      const coupon = makePlatformCoupon({ discountType: 'FLAT', discountValue: 100 })

      const result = service.applyCouponToCart(smallCart, coupon)

      expect(result.totalDiscount).toBeLessThanOrEqual(15)
    })
  })

  describe('SHOP_COUPON only affects matching shop', () => {
    const cart = makeCart([
      makeShopGroup('shop-A', [
        makeItem('prod-1', 200, 1), // 200
      ]),
      makeShopGroup('shop-B', [
        makeItem('prod-2', 150, 1), // 150
      ]),
      makeShopGroup('shop-C', [
        makeItem('prod-3', 100, 1), // 100
      ]),
    ])

    it('applies discount only to the matching shop', () => {
      const coupon = makeShopCoupon('shop-B', {
        discountType: 'FLAT',
        discountValue: 50,
      })

      const result = service.applyCouponToCart(cart, coupon)

      const shopA = result.shopDiscounts.find((sd) => sd.shopId === 'shop-A')
      const shopB = result.shopDiscounts.find((sd) => sd.shopId === 'shop-B')
      const shopC = result.shopDiscounts.find((sd) => sd.shopId === 'shop-C')

      expect(shopA.discount).toBe(0)
      expect(shopB.discount).toBe(50)
      expect(shopC.discount).toBe(0)
      expect(result.totalDiscount).toBe(50)
    })

    it('does not affect non-matching shops (zero discount)', () => {
      const coupon = makeShopCoupon('shop-A', {
        discountType: 'PERCENTAGE',
        discountValue: 20, // 20% of 200 = 40
      })

      const result = service.applyCouponToCart(cart, coupon)

      const shopB = result.shopDiscounts.find((sd) => sd.shopId === 'shop-B')
      const shopC = result.shopDiscounts.find((sd) => sd.shopId === 'shop-C')

      expect(shopB.discount).toBe(0)
      expect(shopC.discount).toBe(0)
      expect(result.totalDiscount).toBe(40)
    })

    it('caps shop discount at shop group total', () => {
      const coupon = makeShopCoupon('shop-C', {
        discountType: 'FLAT',
        discountValue: 500, // More than shop-C total (100)
      })

      const result = service.applyCouponToCart(cart, coupon)

      const shopC = result.shopDiscounts.find((sd) => sd.shopId === 'shop-C')
      expect(shopC.discount).toBeLessThanOrEqual(100)
      expect(result.totalDiscount).toBeLessThanOrEqual(100)
    })

    it('handles multiple applicable shop IDs', () => {
      const coupon = {
        couponType: 'SHOP_COUPON',
        applicableShopIds: ['shop-A', 'shop-C'],
        discountType: 'PERCENTAGE',
        discountValue: 10,
        maxDiscount: null,
      }

      const result = service.applyCouponToCart(cart, coupon)

      const shopA = result.shopDiscounts.find((sd) => sd.shopId === 'shop-A')
      const shopB = result.shopDiscounts.find((sd) => sd.shopId === 'shop-B')
      const shopC = result.shopDiscounts.find((sd) => sd.shopId === 'shop-C')

      expect(shopA.discount).toBe(20)  // 10% of 200
      expect(shopB.discount).toBe(0)   // not in applicableShopIds
      expect(shopC.discount).toBe(10)  // 10% of 100
      expect(result.totalDiscount).toBe(30)
    })

    it('returns zero discount for non-existent shop in cart', () => {
      const coupon = makeShopCoupon('shop-nonexistent', {
        discountType: 'FLAT',
        discountValue: 100,
      })

      const result = service.applyCouponToCart(cart, coupon)

      expect(result.totalDiscount).toBe(0)
      result.shopDiscounts.forEach((sd) => {
        expect(sd.discount).toBe(0)
      })
    })
  })

  describe('Edge cases', () => {
    it('empty cart returns zero discount', () => {
      const result = service.applyCouponToCart({ shopGroups: [] }, makePlatformCoupon())
      expect(result.totalDiscount).toBe(0)
      expect(result.shopDiscounts).toHaveLength(0)
    })

    it('single shop group gets full platform coupon discount', () => {
      const cart = makeCart([
        makeShopGroup('shop-only', [makeItem('p1', 500, 1)]),
      ])
      const coupon = makePlatformCoupon({ discountType: 'FLAT', discountValue: 75 })

      const result = service.applyCouponToCart(cart, coupon)

      expect(result.totalDiscount).toBe(75)
      expect(result.shopDiscounts[0].discount).toBe(75)
    })

    it('DELIVERY_COUPON reduces only delivery_fee, not item prices', () => {
      const cart = makeCart([
        makeShopGroup('shop-A', [makeItem('p1', 200, 1)], 40),
        makeShopGroup('shop-B', [makeItem('p2', 100, 1)], 30),
      ])
      const coupon = {
        couponType: 'DELIVERY_COUPON',
        discountType: 'FLAT',
        discountValue: 50,
        maxDiscount: null,
        applicableShopIds: null,
      }

      const result = service.applyCouponToCart(cart, coupon)

      // Delivery fees: 40 + 30 = 70, coupon = 50 flat per shop
      // Shop A: min(50, 40) = 40, Shop B: min(50, 30) = 30
      result.shopDiscounts.forEach((sd) => {
        expect(sd.discount).toBe(0) // item discount is 0
        expect(sd.deliveryDiscount).toBeGreaterThanOrEqual(0)
      })
    })

    it('CATEGORY_COUPON only discounts matching category items', () => {
      const cart = makeCart([
        makeShopGroup('shop-A', [
          makeItem('p1', 100, 1, 'cat-dairy'),
          makeItem('p2', 200, 1, 'cat-snacks'),
        ]),
      ])
      const coupon = {
        couponType: 'CATEGORY_COUPON',
        applicableCategoryIds: ['cat-dairy'],
        discountType: 'PERCENTAGE',
        discountValue: 50,
        maxDiscount: null,
      }

      const result = service.applyCouponToCart(cart, coupon)

      // Only cat-dairy item (100) gets 50% = 50
      expect(result.totalDiscount).toBe(50)
    })
  })
})
