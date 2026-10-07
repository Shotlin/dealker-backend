import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: vi.fn().mockResolvedValue({ rows: [] }),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

import { BillSummaryService } from '../../../src/modules/cart/bill-summary.service.js'

/**
 * Regression coverage for the bug where an admin-configured, auto-apply
 * First-Time Offer ("Get Rs 51 Veg @ Rs.1") never showed up in the cart —
 * the discount-computation code (FirstTimeOffersService) was fully built
 * and correct, but GET /api/v1/cart/summary (what the Flutter cart screen
 * actually renders) never called it at all; the offer only ever applied
 * deep inside OrdersService.placeOrder(), after the customer had already
 * looked at an undiscounted cart. This suite exercises the real
 * getBillSummary() end-to-end (fee config zeroed out so the math reduces to
 * itemsSubtotal - firstTimeOfferDiscount) to prove the discount now reaches
 * the response the app reads.
 */

const flatConfig = {
  delivery_fee_enabled: false,
  handling_fee_enabled: false,
  platform_fee_enabled: false,
  small_cart_fee_enabled: false,
  surge_fee_enabled: false,
  packaging_fee_enabled: false,
  quick_delivery_surcharge_enabled: false,
  gst_enabled: false,
  free_delivery_enabled: false,
}

function cart({ shopGroups, subtotal = 52 } = {}) {
  return {
    items: [{ productId: 'p-1', quantity: 1 }],
    subtotal,
    totalMrp: subtotal,
    tipAmount: 0,
    count: 1,
    shopGroups: shopGroups ?? [{ shopId: 'shop-1', subtotal, shopName: 'Test Shop' }],
  }
}

function buildService({ cartData, firstTimeOffersService }) {
  return new BillSummaryService({
    cartService: { getCart: vi.fn().mockResolvedValue(cartData) },
    feeSettingsService: {
      resolveForShop: vi.fn().mockResolvedValue({ config: flatConfig, source: 'default' }),
    },
    paymentSettingsService: {
      getConfig: vi.fn().mockResolvedValue({
        codEnabled: true,
        codMinOrderAmount: 0,
        codMaxOrderAmount: null,
        razorpayEnabled: true,
        walletEnabled: true,
      }),
    },
    cartMilestonesService: {
      getProgress: vi.fn().mockResolvedValue({ unlocked: null, next: null }),
      getEligibleTiers: vi.fn().mockResolvedValue([]),
    },
    firstTimeOffersService,
  })
}

describe('BillSummaryService — first-time offer auto-applies in the cart preview (positive)', () => {
  it('a ₹52 single-shop cart for a first-time customer shows the ₹51 flat discount and nets it into totalPayable', async () => {
    const firstTimeOffersService = {
      resolveForCheckout: vi.fn().mockResolvedValue({
        id: 'offer-1',
        name: 'Get Rs 51 Veg @ Rs.1',
        rewardType: 'FLAT_DISCOUNT',
        rewardValue: 51,
        autoApply: true,
      }),
      computeReward: vi.fn().mockReturnValue({ discount: 51 }),
    }
    const svc = buildService({ cartData: cart({ subtotal: 52 }), firstTimeOffersService })

    const result = await svc.getBillSummary('user-1')

    expect(firstTimeOffersService.resolveForCheckout).toHaveBeenCalledWith('user-1', 52, { cartItems: undefined })
    expect(result.firstTimeOffer).toMatchObject({
      id: 'offer-1',
      name: 'Get Rs 51 Veg @ Rs.1',
      rewardType: 'FLAT_DISCOUNT',
      discount: 51,
      freeDelivery: false,
    })
    expect(result.couponDiscount).toBe(51)
    expect(result.totalPayable).toBe(1)
    expect(result.toPay.final).toBe(1)
    expect(result.savings.breakdown).toContainEqual({
      type: 'first_time_offer',
      label: 'Get Rs 51 Veg @ Rs.1',
      amount: 51,
    })
  })

  it('a FREE_DELIVERY-type offer waives the delivery fee via forceFreeDelivery', async () => {
    const firstTimeOffersService = {
      resolveForCheckout: vi.fn().mockResolvedValue({
        id: 'offer-2',
        name: 'Free delivery on your first order',
        rewardType: 'FREE_DELIVERY',
        autoApply: true,
      }),
      computeReward: vi.fn().mockReturnValue({ freeDelivery: true }),
    }
    const svc = buildService({
      cartData: cart({ subtotal: 200 }),
      firstTimeOffersService,
    })
    // Enable a real delivery fee this time so the waiver is observable.
    svc.feeSettingsService.resolveForShop = vi.fn().mockResolvedValue({
      config: { ...flatConfig, delivery_fee_enabled: true, min_delivery_fee: 30, base_distance_km: 0, per_km_fee: 0 },
      source: 'default',
    })

    const result = await svc.getBillSummary('user-1')

    expect(result.firstTimeOffer.freeDelivery).toBe(true)
    expect(result.deliveryFee.isFree).toBe(true)
    expect(result.deliveryFee.amount).toBe(0)
    expect(result.totalPayable).toBe(200)
  })
})

describe('BillSummaryService — first-time offer gating (negative)', () => {
  it('does not apply when the user is not first-time (resolveForCheckout returns null)', async () => {
    const firstTimeOffersService = {
      resolveForCheckout: vi.fn().mockResolvedValue(null),
      computeReward: vi.fn(),
    }
    const svc = buildService({ cartData: cart({ subtotal: 52 }), firstTimeOffersService })

    const result = await svc.getBillSummary('user-1')

    expect(result.firstTimeOffer).toBeNull()
    expect(result.couponDiscount).toBe(0)
    expect(result.totalPayable).toBe(52)
    expect(firstTimeOffersService.computeReward).not.toHaveBeenCalled()
  })

  it('does not apply when the offer is not auto-apply', async () => {
    const firstTimeOffersService = {
      resolveForCheckout: vi.fn().mockResolvedValue({
        id: 'offer-3',
        name: 'Manual claim offer',
        rewardType: 'FLAT_DISCOUNT',
        rewardValue: 51,
        autoApply: false,
      }),
      computeReward: vi.fn().mockReturnValue({ discount: 51 }),
    }
    const svc = buildService({ cartData: cart({ subtotal: 52 }), firstTimeOffersService })

    const result = await svc.getBillSummary('user-1')

    expect(result.firstTimeOffer).toBeNull()
    expect(result.totalPayable).toBe(52)
  })

  it('does not apply to a multi-shop cart, and never even resolves the offer (single discount slot, single-shop only — matches OrdersService.placeOrder)', async () => {
    const firstTimeOffersService = {
      resolveForCheckout: vi.fn().mockResolvedValue({
        id: 'offer-1',
        name: 'Get Rs 51 Veg @ Rs.1',
        rewardType: 'FLAT_DISCOUNT',
        rewardValue: 51,
        autoApply: true,
      }),
      computeReward: vi.fn().mockReturnValue({ discount: 51 }),
    }
    const svc = buildService({
      cartData: cart({
        subtotal: 52,
        shopGroups: [
          { shopId: 'shop-1', subtotal: 30, shopName: 'Shop A' },
          { shopId: 'shop-2', subtotal: 22, shopName: 'Shop B' },
        ],
      }),
      firstTimeOffersService,
    })

    const result = await svc.getBillSummary('user-1')

    expect(firstTimeOffersService.resolveForCheckout).not.toHaveBeenCalled()
    expect(result.firstTimeOffer).toBeNull()
    expect(result.totalPayable).toBe(52)
  })

  it('a discount larger than the cart total never pushes totalPayable negative', async () => {
    const firstTimeOffersService = {
      resolveForCheckout: vi.fn().mockResolvedValue({
        id: 'offer-4',
        name: 'Huge discount',
        rewardType: 'FLAT_DISCOUNT',
        rewardValue: 500,
        autoApply: true,
      }),
      // Mirrors the real computeReward's Math.min(rewardValue, cartTotal) cap.
      computeReward: vi.fn().mockReturnValue({ discount: 15 }),
    }
    const svc = buildService({ cartData: cart({ subtotal: 15 }), firstTimeOffersService })

    const result = await svc.getBillSummary('user-1')

    expect(result.totalPayable).toBe(0)
  })
})
