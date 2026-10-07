// Coverage for FirstTimeOffersService — best-fit graduated offer
// resolution, category/product scoping (090_first_time_offer_scope_and_
// free_delivery.sql, mirroring coupons' scope feature), the "add X to
// unlock" upcoming-offer preview, and reward computation. Constructor-
// injected repo, no database mocking needed.

import { describe, expect, it, vi } from 'vitest'
import { FirstTimeOffersService } from '../../../src/modules/first-time-offers/first-time-offers.service.js'

const USER_ID = 'user-1'
const PROD_MILK = 'prod-milk'
const PROD_TOMATO = 'prod-tomato'

const cartItems = [
  { productId: PROD_MILK, quantity: 2, effectivePrice: 30, lineTotal: 60 },
  { productId: PROD_TOMATO, quantity: 5, effectivePrice: 10, lineTotal: 50 },
]
// cart total = 110; dairy-only (milk) subtotal = 60

function makeRepoMock(overrides = {}) {
  return {
    hasPriorOrder: vi.fn().mockResolvedValue(false),
    findAllActiveCandidates: vi.fn().mockResolvedValue([]),
    resolveMatchingProductIds: vi.fn().mockResolvedValue(new Set()),
    getCategoryNames: vi.fn().mockResolvedValue([]),
    getProductNames: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

describe('FirstTimeOffersService.resolveForCheckout (positive/negative)', () => {
  it('returns null for a repeat customer regardless of cart total (negative — anti-abuse)', async () => {
    const repo = makeRepoMock({ hasPriorOrder: vi.fn().mockResolvedValue(true) })
    const service = new FirstTimeOffersService(repo)

    const offer = await service.resolveForCheckout(USER_ID, 999)

    expect(offer).toBeNull()
    expect(repo.findAllActiveCandidates).not.toHaveBeenCalled()
  })

  it('returns the best-fit offer for a real first-time customer (positive)', async () => {
    const repo = makeRepoMock({
      findAllActiveCandidates: vi.fn().mockResolvedValue([
        { id: 'offer-999', minOrderAmount: 999, rewardType: 'WALLET_CASHBACK', rewardValue: 100 },
      ]),
    })
    const service = new FirstTimeOffersService(repo)

    const offer = await service.resolveForCheckout(USER_ID, 1200)

    expect(offer.id).toBe('offer-999')
    expect(repo.findAllActiveCandidates).toHaveBeenCalledWith({ onlinePayment: undefined })
  })

  it('passes the onlinePayment flag through so COD checkouts exclude ONLINE_ONLY offers', async () => {
    const repo = makeRepoMock()
    const service = new FirstTimeOffersService(repo)

    await service.resolveForCheckout(USER_ID, 500, { onlinePayment: false })

    expect(repo.findAllActiveCandidates).toHaveBeenCalledWith({ onlinePayment: false })
  })
})

describe('FirstTimeOffersService graduated-ladder scenario (positive — matches the 3 examples from the spec)', () => {
  it('a ₹1200 cart resolves to the ₹999 tier (highest satisfied threshold), not the ₹299 or ₹499 tier', async () => {
    // Selection now happens entirely in the service (candidates come back
    // unsorted-by-relevance from the repo) — this exercises the real
    // "highest min_order_amount the cart still satisfies" tie-break.
    const repo = makeRepoMock({
      findAllActiveCandidates: vi.fn().mockResolvedValue([
        { id: 'offer-299', minOrderAmount: 299, rewardType: 'FREE_DELIVERY' },
        { id: 'offer-499', minOrderAmount: 499, rewardType: 'WALLET_CASHBACK', rewardValue: 20 },
        { id: 'offer-999', minOrderAmount: 999, rewardType: 'WALLET_CASHBACK', rewardValue: 100 },
      ]),
    })
    const service = new FirstTimeOffersService(repo)

    const offer = await service.resolveForCheckout(USER_ID, 1200)

    expect(offer.id).toBe('offer-999')
    expect(service.computeReward(offer, 1200)).toEqual({ cashbackAmount: 100, freeDelivery: false })
  })
})

describe('FirstTimeOffersService — category/product scope (090)', () => {
  it('an unscoped offer behaves exactly as before, evaluated against the full cart total', async () => {
    const repo = makeRepoMock({
      findAllActiveCandidates: vi.fn().mockResolvedValue([
        { id: 'offer-100', minOrderAmount: 100, rewardType: 'FREE_DELIVERY' },
      ]),
    })
    const service = new FirstTimeOffersService(repo)

    const offer = await service.resolveForCheckout(USER_ID, 110, { cartItems })

    expect(offer.id).toBe('offer-100')
    expect(repo.resolveMatchingProductIds).not.toHaveBeenCalled()
  })

  it('a scoped offer only counts the matching slice of the cart toward its minOrderAmount', async () => {
    // Dairy-only subtotal is 60 — a 100 min order fails even though the
    // whole cart (110) would clear it.
    const repo = makeRepoMock({
      findAllActiveCandidates: vi.fn().mockResolvedValue([
        { id: 'offer-dairy', minOrderAmount: 100, rewardType: 'FLAT_DISCOUNT', rewardValue: 20, applicableCategoryIds: ['cat-dairy'] },
      ]),
      resolveMatchingProductIds: vi.fn().mockResolvedValue(new Set([PROD_MILK])),
    })
    const service = new FirstTimeOffersService(repo)

    const offer = await service.resolveForCheckout(USER_ID, 110, { cartItems })

    expect(offer).toBeNull()
    expect(repo.resolveMatchingProductIds).toHaveBeenCalledWith(
      [PROD_MILK, PROD_TOMATO],
      { applicableCategoryIds: ['cat-dairy'], applicableProductIds: undefined }
    )
  })

  it('a scoped offer resolves and its reward is computed against the scoped subtotal, not the full cart total', async () => {
    const repo = makeRepoMock({
      findAllActiveCandidates: vi.fn().mockResolvedValue([
        { id: 'offer-dairy', minOrderAmount: 50, rewardType: 'PERCENTAGE_DISCOUNT', rewardValue: 10, applicableCategoryIds: ['cat-dairy'] },
      ]),
      resolveMatchingProductIds: vi.fn().mockResolvedValue(new Set([PROD_MILK])),
    })
    const service = new FirstTimeOffersService(repo)

    const offer = await service.resolveForCheckout(USER_ID, 110, { cartItems })

    expect(offer.scopedSubtotal).toBe(60)
    expect(service.computeReward(offer, 110)).toEqual({ discount: 6, freeDelivery: false }) // 10% of 60, not 110
  })

  it("rejects a scoped offer with minOrderAmount 0 when nothing in the cart matches (0 >= 0 must not count as satisfied) — the exact reported bug: a Vegetables-scoped offer stayed 'applied' after the customer removed the vegetable, leaving only a restricted dairy item", async () => {
    const repo = makeRepoMock({
      findAllActiveCandidates: vi.fn().mockResolvedValue([
        { id: 'offer-veg', minOrderAmount: 0, rewardType: 'FREE_DELIVERY', applicableCategoryIds: ['cat-veg'] },
      ]),
      resolveMatchingProductIds: vi.fn().mockResolvedValue(new Set()), // only dairy left in cart, no vegetables
    })
    const service = new FirstTimeOffersService(repo)

    const offer = await service.resolveForCheckout(USER_ID, 110, { cartItems })

    expect(offer).toBeNull()
  })
})

describe('FirstTimeOffersService.previewUpcoming — the positive "add X to unlock" nudge', () => {
  it('returns null for a repeat customer', async () => {
    const repo = makeRepoMock({ hasPriorOrder: vi.fn().mockResolvedValue(true) })
    const service = new FirstTimeOffersService(repo)

    expect(await service.previewUpcoming(USER_ID, 110, { cartItems })).toBeNull()
  })

  it('returns null once an offer is already satisfied — no "you got X" and "add Y" double message', async () => {
    const repo = makeRepoMock({
      findAllActiveCandidates: vi.fn().mockResolvedValue([
        { id: 'offer-50', minOrderAmount: 50, rewardType: 'FREE_DELIVERY' },
      ]),
    })
    const service = new FirstTimeOffersService(repo)

    expect(await service.previewUpcoming(USER_ID, 110, { cartItems })).toBeNull()
  })

  it("names the exact reported scenario: an all-dairy cart doesn't qualify for a Fresh-Vegetables-scoped offer, so it's teased with the gap", async () => {
    const repo = makeRepoMock({
      findAllActiveCandidates: vi.fn().mockResolvedValue([
        { id: 'offer-veg', name: 'Veg Starter', minOrderAmount: 200, rewardType: 'FREE_DELIVERY', applicableCategoryIds: ['cat-veg'] },
      ]),
      resolveMatchingProductIds: vi.fn().mockResolvedValue(new Set()), // nothing in the cart is a vegetable
    })
    const service = new FirstTimeOffersService(repo)

    const upcoming = await service.previewUpcoming(USER_ID, 110, { cartItems })

    expect(upcoming.id).toBe('offer-veg')
    expect(upcoming.amountToUnlock).toBe(200) // scopedSubtotal is 0, so the full min order is still needed
  })

  it('picks the closest-to-unlock offer when several are still out of reach', async () => {
    const repo = makeRepoMock({
      findAllActiveCandidates: vi.fn().mockResolvedValue([
        { id: 'offer-far', minOrderAmount: 500, rewardType: 'FREE_DELIVERY' },
        { id: 'offer-near', minOrderAmount: 150, rewardType: 'FREE_DELIVERY' },
      ]),
    })
    const service = new FirstTimeOffersService(repo)

    const upcoming = await service.previewUpcoming(USER_ID, 110, { cartItems })

    expect(upcoming.id).toBe('offer-near')
    expect(upcoming.amountToUnlock).toBe(40) // 150 - 110
  })

  it('tees up a zero-minimum scoped offer as the teaser (not as "already applied") when nothing matches yet', async () => {
    const repo = makeRepoMock({
      findAllActiveCandidates: vi.fn().mockResolvedValue([
        { id: 'offer-veg', minOrderAmount: 0, rewardType: 'FREE_DELIVERY', applicableCategoryIds: ['cat-veg'] },
      ]),
      resolveMatchingProductIds: vi.fn().mockResolvedValue(new Set()),
    })
    const service = new FirstTimeOffersService(repo)

    const upcoming = await service.previewUpcoming(USER_ID, 110, { cartItems })

    expect(upcoming.id).toBe('offer-veg')
    expect(upcoming.amountToUnlock).toBe(0)
  })
})

describe('FirstTimeOffersService.describeUpcoming — teaser copy', () => {
  it('names the actual category for a scoped offer', async () => {
    const repo = makeRepoMock({ getCategoryNames: vi.fn().mockResolvedValue(['Fresh Vegetables']) })
    const service = new FirstTimeOffersService(repo)

    const message = await service.describeUpcoming({
      rewardType: 'FREE_DELIVERY',
      applicableCategoryIds: ['cat-veg'],
      hasScope: true,
      amountToUnlock: 200,
    })

    expect(message).toBe('Add ₹200 of Fresh Vegetables to unlock Free Delivery!')
  })

  it('phrases a zero-minimum scoped offer qualitatively instead of "Add ₹0 of X"', async () => {
    const repo = makeRepoMock({ getCategoryNames: vi.fn().mockResolvedValue(['Fresh Vegetables']) })
    const service = new FirstTimeOffersService(repo)

    const message = await service.describeUpcoming({
      rewardType: 'FREE_DELIVERY',
      applicableCategoryIds: ['cat-veg'],
      hasScope: true,
      amountToUnlock: 0,
    })

    expect(message).toBe('Add Fresh Vegetables to unlock Free Delivery!')
  })

  it('falls back to generic copy when the scoped category/product can\'t be resolved', async () => {
    const service = new FirstTimeOffersService(makeRepoMock())

    const message = await service.describeUpcoming({
      rewardType: 'WALLET_CASHBACK',
      rewardValue: 50,
      applicableCategoryIds: ['cat-deleted'],
      hasScope: true,
      amountToUnlock: 75,
    })

    expect(message).toBe('Add ₹75 more of the right products to unlock ₹50 cashback!')
  })

  it('uses the plain rupee shortfall for an unscoped offer', async () => {
    const service = new FirstTimeOffersService(makeRepoMock())

    const message = await service.describeUpcoming({
      rewardType: 'PERCENTAGE_DISCOUNT',
      rewardValue: 15,
      hasScope: false,
      amountToUnlock: 40,
    })

    expect(message).toBe('Add ₹40 more to unlock 15% off!')
  })
})

describe('FirstTimeOffersService.computeReward — each reward type (positive)', () => {
  const service = new FirstTimeOffersService(makeRepoMock())

  it('FREE_DELIVERY yields a plain flag, no amount', () => {
    const reward = service.computeReward({ rewardType: 'FREE_DELIVERY' }, 350)
    expect(reward).toEqual({ freeDelivery: true })
  })

  it('FLAT_DISCOUNT is capped at the cart total', () => {
    const reward = service.computeReward({ rewardType: 'FLAT_DISCOUNT', rewardValue: 5000 }, 100)
    expect(reward.discount).toBe(100)
  })

  it('PERCENTAGE_DISCOUNT applies maxDiscount cap', () => {
    const reward = service.computeReward(
      { rewardType: 'PERCENTAGE_DISCOUNT', rewardValue: 50, maxDiscount: 30 },
      1000
    )
    expect(reward.discount).toBe(30)
  })

  it('WALLET_CASHBACK returns the flat reward value as cashbackAmount', () => {
    const reward = service.computeReward({ rewardType: 'WALLET_CASHBACK', rewardValue: 100 }, 999)
    expect(reward).toEqual({ cashbackAmount: 100, freeDelivery: false })
  })

  it('COUPON_UNLOCK returns the coupon id to unlock', () => {
    const reward = service.computeReward({ rewardType: 'COUPON_UNLOCK', unlockCouponId: 'coupon-42' }, 500)
    expect(reward).toEqual({ unlockCouponId: 'coupon-42', freeDelivery: false })
  })

  it('grantsFreeDelivery independently waives delivery on top of a non-FREE_DELIVERY reward', () => {
    const reward = service.computeReward(
      { rewardType: 'WALLET_CASHBACK', rewardValue: 100, grantsFreeDelivery: true },
      999
    )
    expect(reward).toEqual({ cashbackAmount: 100, freeDelivery: true })
  })
})
