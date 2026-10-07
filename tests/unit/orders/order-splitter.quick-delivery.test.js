import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  cacheDeletePattern: vi.fn(),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// This suite predates the purchase-limits feature and exercises none of its
// behavior (that's covered separately) — OrderSplitterService
// default-constructs a real PurchaseLimitsService when no dep is injected,
// which would otherwise issue extra, unmocked `client.query()` calls at the
// start of every createOrders(). Stubbing it to always report "no
// failures" keeps this file scoped to what it actually tests.
vi.mock('../../../src/modules/purchase-limits/purchase-limits.service.js', () => ({
  PurchaseLimitsService: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn().mockResolvedValue({ ok: true }),
    evaluateCheckout: vi.fn().mockResolvedValue([]),
  })),
}))

import { OrderSplitterService } from '../../../src/modules/orders/order-splitter.service.js'
import { TotalsEngine } from '../../../src/modules/cart/totals-engine.service.js'

/**
 * Coverage for OrderSplitterService.computeShopFees — Quick Delivery
 * surcharge assignment (delivery scheduling feature, Phase 1, 2026-07-03).
 * Follows the exact same single-shop assignment convention already proven
 * for tip/coupon/free-delivery in this file: the surcharge is a whole-order
 * concern, assigned to exactly one shop via feeContext.quickDeliveryShopId,
 * mirroring feeContext.tipShopId.
 */

const SHOP_A = '11111111-1111-1111-1111-111111111111'
const SHOP_B = '22222222-2222-2222-2222-222222222222'

const CONFIG = {
  delivery_fee_enabled: false,
  handling_fee_enabled: false,
  platform_fee_enabled: false,
  small_cart_fee_enabled: false,
  surge_fee_enabled: false,
  packaging_fee_enabled: false,
  free_delivery_enabled: false,
  quick_delivery_surcharge_enabled: true,
  quick_delivery_surcharge_amount: 30,
  quick_delivery_surcharge_label: 'Quick delivery fee',
  delivery_eta_minutes: 30,
}

function makeSvc() {
  const totalsEngine = new TotalsEngine()
  const feeSettingsService = { resolveForShop: vi.fn().mockResolvedValue({ config: CONFIG, source: 'GLOBAL' }) }
  return new OrderSplitterService({
    ordersRepository: { create: vi.fn(), generateOrderNumber: vi.fn() },
    shopProductsRepository: { findByIdForUpdate: vi.fn(), applyStockUpdate: vi.fn() },
    totalsEngine,
    feeSettingsService,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('OrderSplitterService.computeShopFees — Quick Delivery surcharge assignment (positive)', () => {
  it('charges the surcharge only on the designated quickDeliveryShopId', async () => {
    const svc = makeSvc()
    const items = [{ lineTotal: 100 }]

    const feesForA = await svc.computeShopFees({
      shopId: SHOP_A,
      items,
      feeContext: { quickDeliverySelected: true, quickDeliveryShopId: SHOP_A, configByShop: new Map([[SHOP_A, CONFIG]]) },
    })
    const feesForB = await svc.computeShopFees({
      shopId: SHOP_B,
      items,
      feeContext: { quickDeliverySelected: true, quickDeliveryShopId: SHOP_A, configByShop: new Map([[SHOP_B, CONFIG]]) },
    })

    expect(feesForA.quickDeliverySelected).toBe(true)
    expect(feesForA.quickDeliverySurchargeAmount).toBe(30)
    expect(feesForA.totalAmount).toBe(130)

    expect(feesForB.quickDeliverySelected).toBe(false)
    expect(feesForB.quickDeliverySurchargeAmount).toBe(0)
    expect(feesForB.totalAmount).toBe(100)
  })
})

describe('OrderSplitterService.computeShopFees — Quick Delivery surcharge (negative)', () => {
  it('does not charge the surcharge when quickDeliverySelected is false, even for the designated shop', async () => {
    const svc = makeSvc()
    const fees = await svc.computeShopFees({
      shopId: SHOP_A,
      items: [{ lineTotal: 100 }],
      feeContext: { quickDeliverySelected: false, quickDeliveryShopId: SHOP_A, configByShop: new Map([[SHOP_A, CONFIG]]) },
    })

    expect(fees.quickDeliverySelected).toBe(false)
    expect(fees.totalAmount).toBe(100)
  })

  it('the legacy fallback path (no totalsEngine wired) never charges a surcharge', async () => {
    const svc = new OrderSplitterService({
      ordersRepository: { create: vi.fn(), generateOrderNumber: vi.fn() },
      shopProductsRepository: { findByIdForUpdate: vi.fn(), applyStockUpdate: vi.fn() },
      // totalsEngine intentionally omitted
    })

    const fees = await svc.computeShopFees({
      shopId: SHOP_A,
      items: [{ lineTotal: 100 }],
      feeContext: { quickDeliverySelected: true, quickDeliveryShopId: SHOP_A },
    })

    expect(fees.quickDeliverySelected).toBe(false)
    expect(fees.quickDeliverySurchargeAmount).toBe(0)
  })
})
