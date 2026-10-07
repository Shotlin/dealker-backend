// Task 9.7 — Coupon Distribution Sum-Preserving Rounding Property
// **Property:** For any random multi-shop cart and PLATFORM_COUPON, sum of
// distributed discounts equals the coupon's computed total discount
// (sum-preserving rounding invariant).
//
// The CouponsService._applyPlatformCoupon method uses largest-remainder
// (Hamilton) rounding to distribute a platform-wide discount proportionally
// across shop groups. This property verifies that:
//   9.7.A — Σ shopDiscounts[i].discount === totalDiscount (exact, no rounding loss)
//   9.7.B — Each shop's discount is non-negative and ≤ its group total
//   9.7.C — Distribution is proportional (within ±0.01 of ideal share)
//   9.7.D — Works for both PERCENTAGE and FLAT discount types

import { describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'

// ─── Mock dependencies before importing ───────────────────────
vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
}))

import { CouponsService } from '../../src/modules/coupons/coupons.service.js'

// ─── Seed for reproducibility ─────────────────────────────────
const SEED = 20240907
const NUM_RUNS = 100

// ─── Arbitraries ──────────────────────────────────────────────

// A cart item with price and quantity
const cartItemArb = fc.record({
  productId: fc.uuid(),
  categoryId: fc.uuid(),
  price: fc.integer({ min: 1, max: 5000 }), // price in whole units (₹1–₹5000)
  qty: fc.integer({ min: 1, max: 10 }),
})

// A shop group with items and delivery fee
const shopGroupArb = fc.record({
  shopId: fc.uuid(),
  items: fc.array(cartItemArb, { minLength: 1, maxLength: 8 }),
  deliveryFee: fc.integer({ min: 0, max: 100 }),
})

// A multi-shop cart with 1–6 shop groups
const multiShopCartArb = fc.record({
  shopGroups: fc.array(shopGroupArb, { minLength: 1, maxLength: 6 }),
})

// A PLATFORM_COUPON — either PERCENTAGE or FLAT
const platformCouponArb = fc.oneof(
  // Percentage coupon (1–100%) with optional maxDiscount cap
  fc.record({
    couponType: fc.constant('PLATFORM_COUPON'),
    discountType: fc.constant('PERCENTAGE'),
    discountValue: fc.integer({ min: 1, max: 100 }),
    maxDiscount: fc.option(fc.integer({ min: 1, max: 10000 }), { nil: null }),
  }),
  // Flat coupon (₹1–₹5000)
  fc.record({
    couponType: fc.constant('PLATFORM_COUPON'),
    discountType: fc.constant('FLAT'),
    discountValue: fc.integer({ min: 1, max: 5000 }),
    maxDiscount: fc.constant(null),
  })
)

// ─── Service instance (no repo needed for applyCouponToCart) ──
const service = new CouponsService({})

// ═══════════════════════════════════════════════════════════════
// Property 9.7.A — Sum preservation: Σ shop discounts === totalDiscount
// ═══════════════════════════════════════════════════════════════
describe('Property 9.7: Coupon Distribution — sum-preserving rounding', () => {
  it('sum of distributed shop discounts equals totalDiscount exactly', () => {
    fc.assert(
      fc.property(multiShopCartArb, platformCouponArb, (cart, coupon) => {
        const result = service.applyCouponToCart(cart, coupon)

        // Sum of per-shop discounts
        const sumShopDiscounts = result.shopDiscounts.reduce(
          (sum, sd) => sum + sd.discount,
          0
        )

        // Must equal totalDiscount exactly (largest-remainder preserves sum)
        // Use toFixed(2) comparison to handle floating point representation
        expect(parseFloat(sumShopDiscounts.toFixed(2))).toBe(
          parseFloat(result.totalDiscount.toFixed(2))
        )
      }),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })

  // ═══════════════════════════════════════════════════════════════
  // Property 9.7.B — Each shop discount is non-negative and bounded
  // ═══════════════════════════════════════════════════════════════
  it('each shop discount is non-negative and does not exceed its group item total', () => {
    fc.assert(
      fc.property(multiShopCartArb, platformCouponArb, (cart, coupon) => {
        const result = service.applyCouponToCart(cart, coupon)

        for (let i = 0; i < result.shopDiscounts.length; i++) {
          const sd = result.shopDiscounts[i]
          const group = cart.shopGroups[i]
          const groupTotal = (group.items || []).reduce(
            (sum, item) => sum + item.price * item.qty,
            0
          )

          // Non-negative
          expect(sd.discount).toBeGreaterThanOrEqual(0)

          // Cannot exceed the group's item total
          expect(sd.discount).toBeLessThanOrEqual(groupTotal + 0.01) // +0.01 for float tolerance
        }
      }),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })

  // ═══════════════════════════════════════════════════════════════
  // Property 9.7.C — Distribution is proportional (within ±0.01)
  // ═══════════════════════════════════════════════════════════════
  it('each shop discount is within ±0.01 of its ideal proportional share', () => {
    fc.assert(
      fc.property(multiShopCartArb, platformCouponArb, (cart, coupon) => {
        const result = service.applyCouponToCart(cart, coupon)

        if (result.totalDiscount === 0) return // skip zero-discount cases

        const groupTotals = cart.shopGroups.map((g) =>
          (g.items || []).reduce((sum, item) => sum + item.price * item.qty, 0)
        )
        const cartTotal = groupTotals.reduce((sum, t) => sum + t, 0)

        if (cartTotal === 0) return // skip empty carts

        for (let i = 0; i < result.shopDiscounts.length; i++) {
          const sd = result.shopDiscounts[i]
          const idealShare = (groupTotals[i] / cartTotal) * result.totalDiscount

          // Largest-remainder can differ from ideal by at most 0.01 (1 cent)
          expect(Math.abs(sd.discount - idealShare)).toBeLessThanOrEqual(0.01)
        }
      }),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })

  // ═══════════════════════════════════════════════════════════════
  // Property 9.7.D — totalDiscount is correctly computed and capped
  // ═══════════════════════════════════════════════════════════════
  it('totalDiscount does not exceed cart total and respects maxDiscount cap', () => {
    fc.assert(
      fc.property(multiShopCartArb, platformCouponArb, (cart, coupon) => {
        const result = service.applyCouponToCart(cart, coupon)

        const cartTotal = cart.shopGroups.reduce(
          (sum, g) =>
            sum +
            (g.items || []).reduce(
              (s, item) => s + item.price * item.qty,
              0
            ),
          0
        )

        // totalDiscount cannot exceed cart total
        expect(result.totalDiscount).toBeLessThanOrEqual(cartTotal + 0.01)

        // totalDiscount is non-negative
        expect(result.totalDiscount).toBeGreaterThanOrEqual(0)

        // If percentage with maxDiscount cap, totalDiscount ≤ maxDiscount
        if (coupon.discountType === 'PERCENTAGE' && coupon.maxDiscount != null) {
          expect(result.totalDiscount).toBeLessThanOrEqual(coupon.maxDiscount + 0.01)
        }

        // If flat, totalDiscount ≤ discountValue (capped by cart total)
        if (coupon.discountType === 'FLAT') {
          expect(result.totalDiscount).toBeLessThanOrEqual(coupon.discountValue + 0.01)
        }
      }),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })

  // ═══════════════════════════════════════════════════════════════
  // Property 9.7.E — shopDiscounts array length matches shopGroups
  // ═══════════════════════════════════════════════════════════════
  it('shopDiscounts array has one entry per shop group', () => {
    fc.assert(
      fc.property(multiShopCartArb, platformCouponArb, (cart, coupon) => {
        const result = service.applyCouponToCart(cart, coupon)
        expect(result.shopDiscounts.length).toBe(cart.shopGroups.length)
      }),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })
})
