import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external collaborators BEFORE importing the SUT ─────────────
// CartService only imports `logger`, but the project convention is to mock
// the standard set of side-effect modules so a misplaced import never reaches
// real Postgres / Redis from a unit suite (mirrors order-splitter.smoke).
vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  cacheDeletePattern: vi.fn(),
}))

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../../src/config/redis.js', () => ({
  redis: {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
  },
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// This suite predates the purchase-limits feature and exercises none of its
// behavior (that's covered separately) — CartService default-constructs a
// real PurchaseLimitsService when no dep is injected, which would otherwise
// issue an extra, unmocked `query()` call on every addItem/updateItem/
// validateCart and break every test's sequential `query.mockResolvedValueOnce`
// setup. Stubbing it to always report "no rule" (`ok: true`) keeps this file
// scoped to what it actually tests.
vi.mock('../../../src/modules/purchase-limits/purchase-limits.service.js', () => ({
  PurchaseLimitsService: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn().mockResolvedValue({ ok: true }),
    evaluateCheckout: vi.fn().mockResolvedValue([]),
  })),
}))

import {
  CartService,
  MAX_CART_ITEMS,
} from '../../../src/modules/cart/cart.service.js'

// ═══════════════════════════════════════════════════════════════════════
// Test fixtures
// ═══════════════════════════════════════════════════════════════════════

const USER_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_A = '22222222-2222-2222-2222-2222222222aa'
const SHOP_B = '33333333-3333-3333-3333-3333333333bb'
const PROD_1 = '44444444-4444-4444-4444-444444444411'
const PROD_2 = '55555555-5555-5555-5555-555555555522'
const SP_A1 = 'aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SP_A2 = 'aaaa2222-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SP_B1 = 'bbbb1111-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

/**
 * Build a CartRepository mock that covers every method called by the
 * service (Redis-backed cart + Postgres lookups).
 */
function makeRepoMock() {
  return {
    // Redis-backed cart
    getCart: vi.fn().mockResolvedValue([]),
    saveCart: vi.fn().mockResolvedValue(undefined),
    clearCart: vi.fn().mockResolvedValue(undefined),
    clearExtras: vi.fn().mockResolvedValue(undefined),
    // Cart extras
    getTip: vi.fn().mockResolvedValue(0),
    getInstructions: vi.fn().mockResolvedValue(null),
    // Postgres lookups
    findShopProductForUser: vi.fn(),
    findShopProductsForProduct: vi.fn().mockResolvedValue([]),
    findShopProductsForCart: vi.fn().mockResolvedValue([]),
    // Phase 3: shop_product_id-based lookup
    findShopProductByIdForUser: vi.fn(),
  }
}

/**
 * Build a shop_product row matching the shape returned by
 * CartRepository.findShopProductForUser / findShopProductsForCart.
 */
function makeSpRow(overrides = {}) {
  return {
    shop_product_id: SP_A1,
    shop_id: SHOP_A,
    product_id: PROD_1,
    sp_price: 100,
    sp_sale_price: null,
    stock_quantity: 10,
    max_order_qty: 50,
    is_available: true,
    name: 'Test Product',
    slug: 'test-product',
    unit: '1kg',
    thumbnail_url: 'thumb.png',
    product_active: true,
    product_price: 100,
    product_sale_price: null,
    shop_name: 'Test Shop',
    shop_active: true,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════
// 1.  CartService.addItem — Req 5.1, 5.2, 5.3, 5.4, 5.5
// ═══════════════════════════════════════════════════════════════════════

describe('CartService.addItem — input validation', () => {
  it('rejects non-positive quantity with INVALID_QUANTITY', async () => {
    const repo = makeRepoMock()
    const svc = new CartService(repo)

    const r1 = await svc.addItem(USER_ID, { productId: PROD_1, shopId: SHOP_A, quantity: 0 })
    const r2 = await svc.addItem(USER_ID, { productId: PROD_1, shopId: SHOP_A, quantity: -3 })
    const r3 = await svc.addItem(USER_ID, { productId: PROD_1, shopId: SHOP_A, quantity: 1.5 })

    for (const r of [r1, r2, r3]) {
      expect(r.success).toBe(false)
      expect(r.code).toBe('INVALID_QUANTITY')
    }
    expect(repo.findShopProductForUser).not.toHaveBeenCalled()
    expect(repo.saveCart).not.toHaveBeenCalled()
  })
})

describe('CartService.addItem — shop allocation + activity (Req 5.2, 5.3)', () => {
  it('rejects with SHOP_NOT_AVAILABLE when shop is not in user allocations', async () => {
    const repo = makeRepoMock()
    repo.findShopProductForUser.mockResolvedValueOnce(null)
    const svc = new CartService(repo)

    const result = await svc.addItem(USER_ID, {
      productId: PROD_1,
      shopId: SHOP_A,
      quantity: 1,
    })

    expect(result).toMatchObject({
      success: false,
      code: 'SHOP_NOT_AVAILABLE',
    })
    expect(repo.findShopProductForUser).toHaveBeenCalledWith(USER_ID, PROD_1, SHOP_A)
    expect(repo.saveCart).not.toHaveBeenCalled()
  })

  it('rejects with SHOP_INACTIVE when the shop is_active=false', async () => {
    const repo = makeRepoMock()
    repo.findShopProductForUser.mockResolvedValueOnce(makeSpRow({ shop_active: false }))
    const svc = new CartService(repo)

    const result = await svc.addItem(USER_ID, {
      productId: PROD_1,
      shopId: SHOP_A,
      quantity: 1,
    })

    expect(result).toMatchObject({ success: false, code: 'SHOP_INACTIVE' })
    expect(repo.saveCart).not.toHaveBeenCalled()
  })

  it('rejects with SHOP_PRODUCT_UNAVAILABLE when shop_product is_available=false', async () => {
    const repo = makeRepoMock()
    repo.findShopProductForUser.mockResolvedValueOnce(makeSpRow({ is_available: false }))
    const svc = new CartService(repo)

    const result = await svc.addItem(USER_ID, {
      productId: PROD_1,
      shopId: SHOP_A,
      quantity: 1,
    })

    expect(result).toMatchObject({ success: false, code: 'SHOP_PRODUCT_UNAVAILABLE' })
    expect(repo.saveCart).not.toHaveBeenCalled()
  })

  it('rejects with SHOP_PRODUCT_UNAVAILABLE when product_active=false', async () => {
    const repo = makeRepoMock()
    repo.findShopProductForUser.mockResolvedValueOnce(makeSpRow({ product_active: false }))
    const svc = new CartService(repo)

    const result = await svc.addItem(USER_ID, {
      productId: PROD_1,
      shopId: SHOP_A,
      quantity: 1,
    })

    expect(result).toMatchObject({ success: false, code: 'SHOP_PRODUCT_UNAVAILABLE' })
    expect(repo.saveCart).not.toHaveBeenCalled()
  })
})

describe('CartService.addItem — quantity guards (Req 5.4, 5.5, 12.2)', () => {
  it('rejects with MAX_QTY_EXCEEDED when existing + new exceeds max_order_qty', async () => {
    const repo = makeRepoMock()
    repo.findShopProductForUser.mockResolvedValueOnce(
      makeSpRow({ max_order_qty: 5, stock_quantity: 100 })
    )
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 4 },
    ])
    const svc = new CartService(repo)

    const result = await svc.addItem(USER_ID, {
      productId: PROD_1,
      shopId: SHOP_A,
      quantity: 2, // existing 4 + new 2 = 6 > 5
    })

    expect(result.success).toBe(false)
    expect(result.code).toBe('MAX_QTY_EXCEEDED')
    expect(result.details).toEqual({
      productId: PROD_1,
      shopId: SHOP_A,
      max: 5,
    })
    expect(repo.saveCart).not.toHaveBeenCalled()
  })

  it('rejects with INSUFFICIENT_STOCK when requested qty > stock_quantity', async () => {
    const repo = makeRepoMock()
    repo.findShopProductForUser.mockResolvedValueOnce(
      makeSpRow({ max_order_qty: 50, stock_quantity: 3 })
    )
    repo.getCart.mockResolvedValueOnce([])
    const svc = new CartService(repo)

    const result = await svc.addItem(USER_ID, {
      productId: PROD_1,
      shopId: SHOP_A,
      quantity: 5,
    })

    expect(result.success).toBe(false)
    expect(result.code).toBe('INSUFFICIENT_STOCK')
    expect(result.details).toEqual({
      productId: PROD_1,
      shopId: SHOP_A,
      available: 3,
    })
    expect(repo.saveCart).not.toHaveBeenCalled()
  })

  it('checks max_order_qty before stock (so MAX_QTY wins when both are violated)', async () => {
    // Both constraints are violated by qty=20 (max=5, stock=3); max is checked first.
    const repo = makeRepoMock()
    repo.findShopProductForUser.mockResolvedValueOnce(
      makeSpRow({ max_order_qty: 5, stock_quantity: 3 })
    )
    repo.getCart.mockResolvedValueOnce([])
    const svc = new CartService(repo)

    const result = await svc.addItem(USER_ID, {
      productId: PROD_1,
      shopId: SHOP_A,
      quantity: 20,
    })

    expect(result.success).toBe(false)
    expect(result.code).toBe('MAX_QTY_EXCEEDED')
  })
})

describe('CartService.addItem — cart limit (Req 5.1)', () => {
  it('rejects with CART_LIMIT_EXCEEDED when adding a 51st distinct item', async () => {
    // 50 existing items, all distinct shop+product pairs; new add introduces
    // a brand new (productId, shopId) pair → cap.
    const filler = Array.from({ length: MAX_CART_ITEMS }, (_, i) => ({
      productId: `f-prod-${i}`,
      shopId: SHOP_A,
      quantity: 1,
    }))
    const repo = makeRepoMock()
    repo.findShopProductForUser.mockResolvedValueOnce(
      makeSpRow({ product_id: PROD_2, shop_product_id: SP_A2 })
    )
    repo.getCart.mockResolvedValueOnce(filler)
    const svc = new CartService(repo)

    const result = await svc.addItem(USER_ID, {
      productId: PROD_2,
      shopId: SHOP_A,
      quantity: 1,
    })

    expect(result.success).toBe(false)
    expect(result.code).toBe('CART_LIMIT_EXCEEDED')
    expect(result.details).toEqual({ max: MAX_CART_ITEMS })
    expect(repo.saveCart).not.toHaveBeenCalled()
  })

  it('updates an existing line even when cart is at the 50-item cap', async () => {
    // Bumping qty on an EXISTING line doesn't grow the line count, so the cap
    // must not block it. This is the contract that lets users still adjust
    // quantities on a full cart.
    const filler = Array.from({ length: MAX_CART_ITEMS - 1 }, (_, i) => ({
      productId: `f-prod-${i}`,
      shopId: SHOP_A,
      quantity: 1,
    }))
    filler.push({ productId: PROD_1, shopId: SHOP_A, quantity: 1 })
    expect(filler).toHaveLength(MAX_CART_ITEMS)

    const repo = makeRepoMock()
    repo.findShopProductForUser.mockResolvedValueOnce(
      makeSpRow({ stock_quantity: 100, max_order_qty: 50 })
    )
    repo.getCart.mockResolvedValueOnce(filler)
    repo.findShopProductsForCart.mockResolvedValueOnce([])
    const svc = new CartService(repo)

    const result = await svc.addItem(USER_ID, {
      productId: PROD_1,
      shopId: SHOP_A,
      quantity: 2,
    })

    expect(result.success).toBe(true)
    // saveCart received a 50-item array (no new entry), with the matching
    // line bumped to 3 (1 existing + 2 added).
    expect(repo.saveCart).toHaveBeenCalledTimes(1)
    const saved = repo.saveCart.mock.calls[0][1]
    expect(saved).toHaveLength(MAX_CART_ITEMS)
    const updatedLine = saved.find(
      (i) => i.productId === PROD_1 && i.shopId === SHOP_A
    )
    expect(updatedLine.quantity).toBe(3)
  })
})

describe('CartService.addItem — shop auto-resolution', () => {
  it('auto-resolves to the single matching shop when shopId is omitted', async () => {
    const repo = makeRepoMock()
    repo.findShopProductsForProduct.mockResolvedValueOnce([
      { shop_id: SHOP_A, shop_product_id: SP_A1 },
    ])
    repo.findShopProductForUser.mockResolvedValueOnce(makeSpRow())
    repo.getCart.mockResolvedValueOnce([])
    const svc = new CartService(repo)

    const result = await svc.addItem(USER_ID, { productId: PROD_1, quantity: 2 })

    expect(result.success).toBe(true)
    expect(repo.findShopProductsForProduct).toHaveBeenCalledWith(USER_ID, PROD_1)
    // Service must lookup using the resolved shopId
    expect(repo.findShopProductForUser).toHaveBeenCalledWith(USER_ID, PROD_1, SHOP_A)
    // Saved line has the resolved shopId
    const saved = repo.saveCart.mock.calls[0][1]
    expect(saved).toEqual([
      { productId: PROD_1, shopId: SHOP_A, quantity: 2 },
    ])
  })

  it('rejects with CART_SHOP_REQUIRED when multiple shops carry the product', async () => {
    const repo = makeRepoMock()
    repo.findShopProductsForProduct.mockResolvedValueOnce([
      { shop_id: SHOP_A, shop_product_id: SP_A1 },
      { shop_id: SHOP_B, shop_product_id: SP_B1 },
    ])
    const svc = new CartService(repo)

    const result = await svc.addItem(USER_ID, { productId: PROD_1, quantity: 1 })

    expect(result.success).toBe(false)
    expect(result.code).toBe('CART_SHOP_REQUIRED')
    expect(repo.findShopProductForUser).not.toHaveBeenCalled()
    expect(repo.saveCart).not.toHaveBeenCalled()
  })

  it('rejects with SHOP_NOT_AVAILABLE when no shop carries the product', async () => {
    const repo = makeRepoMock()
    repo.findShopProductsForProduct.mockResolvedValueOnce([])
    const svc = new CartService(repo)

    const result = await svc.addItem(USER_ID, { productId: PROD_1, quantity: 1 })

    expect(result.success).toBe(false)
    expect(result.code).toBe('SHOP_NOT_AVAILABLE')
    expect(repo.findShopProductForUser).not.toHaveBeenCalled()
  })
})

describe('CartService.addItem — line consolidation', () => {
  it('updates the existing (product+shop) line in-place rather than duplicating', async () => {
    const repo = makeRepoMock()
    repo.findShopProductForUser.mockResolvedValueOnce(
      makeSpRow({ stock_quantity: 100, max_order_qty: 50 })
    )
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 2 },
      { productId: PROD_2, shopId: SHOP_A, quantity: 1 },
    ])
    repo.findShopProductsForCart.mockResolvedValueOnce([])
    const svc = new CartService(repo)

    const result = await svc.addItem(USER_ID, {
      productId: PROD_1,
      shopId: SHOP_A,
      quantity: 3,
    })

    expect(result.success).toBe(true)
    expect(repo.saveCart).toHaveBeenCalledTimes(1)
    const saved = repo.saveCart.mock.calls[0][1]
    expect(saved).toHaveLength(2) // not 3 — line was consolidated
    expect(saved).toEqual(
      expect.arrayContaining([
        { productId: PROD_1, shopId: SHOP_A, quantity: 5 }, // 2 + 3
        { productId: PROD_2, shopId: SHOP_A, quantity: 1 },
      ])
    )
  })

  it('treats the same product from different shops as separate lines', async () => {
    const repo = makeRepoMock()
    repo.findShopProductForUser.mockResolvedValueOnce(
      makeSpRow({ shop_id: SHOP_B, shop_product_id: SP_B1 })
    )
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 2 },
    ])
    repo.findShopProductsForCart.mockResolvedValueOnce([])
    const svc = new CartService(repo)

    const result = await svc.addItem(USER_ID, {
      productId: PROD_1,
      shopId: SHOP_B,
      quantity: 4,
    })

    expect(result.success).toBe(true)
    const saved = repo.saveCart.mock.calls[0][1]
    expect(saved).toHaveLength(2)
    expect(saved).toEqual(
      expect.arrayContaining([
        { productId: PROD_1, shopId: SHOP_A, quantity: 2 },
        { productId: PROD_1, shopId: SHOP_B, quantity: 4 },
      ])
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 2.  CartService.updateItem
// ═══════════════════════════════════════════════════════════════════════

describe('CartService.updateItem — lookup by (productId, shopId)', () => {
  it('returns CART_ITEM_NOT_FOUND when the product is not in cart', async () => {
    const repo = makeRepoMock()
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_2, shopId: SHOP_A, quantity: 1 },
    ])
    const svc = new CartService(repo)

    const result = await svc.updateItem(USER_ID, PROD_1, 2, SHOP_A)

    expect(result.success).toBe(false)
    expect(result.code).toBe('CART_ITEM_NOT_FOUND')
    expect(repo.saveCart).not.toHaveBeenCalled()
  })

  it('returns CART_SHOP_REQUIRED when productId matches multiple lines and no shopId given', async () => {
    const repo = makeRepoMock()
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 1 },
      { productId: PROD_1, shopId: SHOP_B, quantity: 2 },
    ])
    const svc = new CartService(repo)

    const result = await svc.updateItem(USER_ID, PROD_1, 5)

    expect(result.success).toBe(false)
    expect(result.code).toBe('CART_ITEM_AMBIGUOUS')
    expect(repo.saveCart).not.toHaveBeenCalled()
  })

  it('rejects non-positive new quantity with INVALID_QUANTITY', async () => {
    const repo = makeRepoMock()
    const svc = new CartService(repo)

    const result = await svc.updateItem(USER_ID, PROD_1, 0, SHOP_A)

    expect(result.success).toBe(false)
    expect(result.code).toBe('INVALID_QUANTITY')
    expect(repo.getCart).not.toHaveBeenCalled()
  })

  it('updates the absolute quantity on a single matched line', async () => {
    const repo = makeRepoMock()
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 2 },
    ])
    repo.findShopProductForUser.mockResolvedValueOnce(makeSpRow())
    repo.findShopProductsForCart.mockResolvedValueOnce([])
    const svc = new CartService(repo)

    const result = await svc.updateItem(USER_ID, PROD_1, 7, SHOP_A)

    expect(result.success).toBe(true)
    const saved = repo.saveCart.mock.calls[0][1]
    expect(saved).toEqual([{ productId: PROD_1, shopId: SHOP_A, quantity: 7 }])
  })

  it('drops the line and returns SHOP_NOT_AVAILABLE when allocation/lookup is gone', async () => {
    const repo = makeRepoMock()
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 2 },
    ])
    repo.findShopProductForUser.mockResolvedValueOnce(null)
    const svc = new CartService(repo)

    const result = await svc.updateItem(USER_ID, PROD_1, 5, SHOP_A)

    expect(result.success).toBe(false)
    expect(result.code).toBe('SHOP_NOT_AVAILABLE')
    expect(repo.saveCart).toHaveBeenCalledTimes(1)
    expect(repo.saveCart.mock.calls[0][1]).toEqual([])
  })

  it('rejects with MAX_QTY_EXCEEDED when new qty exceeds max_order_qty', async () => {
    const repo = makeRepoMock()
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 2 },
    ])
    repo.findShopProductForUser.mockResolvedValueOnce(
      makeSpRow({ max_order_qty: 5, stock_quantity: 100 })
    )
    const svc = new CartService(repo)

    const result = await svc.updateItem(USER_ID, PROD_1, 10, SHOP_A)

    expect(result.success).toBe(false)
    expect(result.code).toBe('MAX_QTY_EXCEEDED')
    expect(repo.saveCart).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 3.  CartService.removeItem
// ═══════════════════════════════════════════════════════════════════════

describe('CartService.removeItem', () => {
  it('returns CART_ITEM_NOT_FOUND for a missing item', async () => {
    const repo = makeRepoMock()
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_2, shopId: SHOP_A, quantity: 1 },
    ])
    const svc = new CartService(repo)

    const result = await svc.removeItem(USER_ID, PROD_1, SHOP_A)

    expect(result.success).toBe(false)
    expect(result.code).toBe('CART_ITEM_NOT_FOUND')
    expect(repo.saveCart).not.toHaveBeenCalled()
  })

  it('removes only the matching (productId, shopId) line', async () => {
    const repo = makeRepoMock()
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 1 },
      { productId: PROD_1, shopId: SHOP_B, quantity: 3 },
      { productId: PROD_2, shopId: SHOP_A, quantity: 5 },
    ])
    repo.findShopProductsForCart.mockResolvedValueOnce([])
    const svc = new CartService(repo)

    const result = await svc.removeItem(USER_ID, PROD_1, SHOP_A)

    expect(result.success).toBe(true)
    expect(repo.saveCart).toHaveBeenCalledTimes(1)
    const saved = repo.saveCart.mock.calls[0][1]
    expect(saved).toEqual([
      { productId: PROD_1, shopId: SHOP_B, quantity: 3 },
      { productId: PROD_2, shopId: SHOP_A, quantity: 5 },
    ])
  })

  it('with no shopId, removes every line matching productId across shops', async () => {
    const repo = makeRepoMock()
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 1 },
      { productId: PROD_1, shopId: SHOP_B, quantity: 3 },
      { productId: PROD_2, shopId: SHOP_A, quantity: 5 },
    ])
    repo.findShopProductsForCart.mockResolvedValueOnce([])
    const svc = new CartService(repo)

    const result = await svc.removeItem(USER_ID, PROD_1)

    expect(result.success).toBe(true)
    const saved = repo.saveCart.mock.calls[0][1]
    expect(saved).toEqual([{ productId: PROD_2, shopId: SHOP_A, quantity: 5 }])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 4.  CartService.validateCart — Req 5.9
// ═══════════════════════════════════════════════════════════════════════

describe('CartService.validateCart', () => {
  it('returns valid=false with empty payload when cart is empty', async () => {
    const repo = makeRepoMock()
    repo.getCart.mockResolvedValueOnce([])
    const svc = new CartService(repo)

    const result = await svc.validateCart(USER_ID)

    expect(result.valid).toBe(false)
    expect(result.items).toEqual([])
    expect(result.failed).toEqual([])
    expect(result.subtotal).toBe(0)
    expect(result.groupedByShop).toBeInstanceOf(Map)
    expect(result.groupedByShop.size).toBe(0)
    // Nothing to validate ⇒ no DB lookup, no save needed
    expect(repo.findShopProductsForCart).not.toHaveBeenCalled()
    expect(repo.saveCart).not.toHaveBeenCalled()
  })

  it('reports each invalid line in `failed` with productId, shopId, reason, code', async () => {
    const repo = makeRepoMock()
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 2 }, // missing row → SHOP_NOT_AVAILABLE
      { productId: PROD_2, shopId: SHOP_A, quantity: 3 }, // shop inactive → SHOP_INACTIVE
      { productId: 'p3', shopId: SHOP_B, quantity: 5 }, // product unavailable
      { productId: 'p4', shopId: SHOP_B, quantity: 100 }, // exceeds max_order_qty
      { productId: 'p5', shopId: SHOP_B, quantity: 50 }, // exceeds stock
    ])
    repo.findShopProductsForCart.mockResolvedValueOnce([
      // No row for PROD_1 / SHOP_A → produces SHOP_NOT_AVAILABLE
      makeSpRow({
        product_id: PROD_2,
        shop_id: SHOP_A,
        shop_active: false,
      }),
      makeSpRow({
        product_id: 'p3',
        shop_id: SHOP_B,
        is_available: false,
      }),
      makeSpRow({
        product_id: 'p4',
        shop_id: SHOP_B,
        max_order_qty: 10,
      }),
      makeSpRow({
        product_id: 'p5',
        shop_id: SHOP_B,
        stock_quantity: 4,
      }),
    ])
    const svc = new CartService(repo)

    const result = await svc.validateCart(USER_ID)

    expect(result.valid).toBe(false)
    expect(result.items).toEqual([])
    expect(result.subtotal).toBe(0)

    expect(result.failed).toHaveLength(5)
    expect(result.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          productId: PROD_1,
          shopId: SHOP_A,
          code: 'SHOP_NOT_AVAILABLE',
          reason: expect.any(String),
        }),
        expect.objectContaining({
          productId: PROD_2,
          shopId: SHOP_A,
          code: 'SHOP_INACTIVE',
        }),
        expect.objectContaining({
          productId: 'p3',
          shopId: SHOP_B,
          code: 'SHOP_PRODUCT_UNAVAILABLE',
        }),
        expect.objectContaining({
          productId: 'p4',
          shopId: SHOP_B,
          code: 'MAX_QTY_EXCEEDED',
          max: 10,
        }),
        expect.objectContaining({
          productId: 'p5',
          shopId: SHOP_B,
          code: 'INSUFFICIENT_STOCK',
          available: 4,
        }),
      ])
    )

    // Failed lines must be dropped from the persisted cart
    expect(repo.saveCart).toHaveBeenCalledTimes(1)
    expect(repo.saveCart.mock.calls[0][1]).toEqual([])
  })

  it('drops invalid lines from the saved cart, keeping the valid ones', async () => {
    const repo = makeRepoMock()
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 2 }, // valid
      { productId: PROD_2, shopId: SHOP_A, quantity: 3 }, // unavailable
    ])
    repo.findShopProductsForCart.mockResolvedValueOnce([
      makeSpRow({
        product_id: PROD_1,
        shop_id: SHOP_A,
        sp_price: 100,
        stock_quantity: 10,
      }),
      makeSpRow({
        product_id: PROD_2,
        shop_id: SHOP_A,
        is_available: false,
      }),
    ])
    const svc = new CartService(repo)

    const result = await svc.validateCart(USER_ID)

    expect(result.valid).toBe(false) // because failed.length > 0
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      productId: PROD_1,
      shopId: SHOP_A,
      quantity: 2,
      lineTotal: 200,
    })
    expect(result.failed).toHaveLength(1)

    // Persisted cart drops the failed line
    expect(repo.saveCart).toHaveBeenCalledTimes(1)
    expect(repo.saveCart.mock.calls[0][1]).toEqual([
      { productId: PROD_1, shopId: SHOP_A, quantity: 2 },
    ])
  })

  it('computes subtotal as sum of lineTotals rounded to 2 decimals', async () => {
    const repo = makeRepoMock()
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 3 }, // 3 × 19.99 = 59.97
      { productId: PROD_2, shopId: SHOP_A, quantity: 2 }, // 2 × 49.50 = 99.00
    ])
    repo.findShopProductsForCart.mockResolvedValueOnce([
      makeSpRow({ product_id: PROD_1, shop_id: SHOP_A, sp_price: 19.99 }),
      makeSpRow({ product_id: PROD_2, shop_id: SHOP_A, sp_price: 49.5 }),
    ])
    const svc = new CartService(repo)

    const result = await svc.validateCart(USER_ID)

    expect(result.valid).toBe(true)
    expect(result.subtotal).toBe(158.97)
    // Verify line-level math too
    const line1 = result.items.find((i) => i.productId === PROD_1)
    const line2 = result.items.find((i) => i.productId === PROD_2)
    expect(line1.lineTotal).toBe(59.97)
    expect(line2.lineTotal).toBe(99)
  })

  it('uses sale_price when set (effective price = sale_price)', async () => {
    const repo = makeRepoMock()
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 4 },
    ])
    repo.findShopProductsForCart.mockResolvedValueOnce([
      makeSpRow({
        product_id: PROD_1,
        shop_id: SHOP_A,
        sp_price: 100,
        sp_sale_price: 75,
      }),
    ])
    const svc = new CartService(repo)

    const result = await svc.validateCart(USER_ID)

    expect(result.valid).toBe(true)
    expect(result.subtotal).toBe(300) // 4 × 75
  })

  it('builds groupedByShop Map keyed by shopId with all valid lines', async () => {
    const repo = makeRepoMock()
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 1 },
      { productId: PROD_2, shopId: SHOP_A, quantity: 2 },
      { productId: PROD_1, shopId: SHOP_B, quantity: 3 },
    ])
    repo.findShopProductsForCart.mockResolvedValueOnce([
      makeSpRow({ product_id: PROD_1, shop_id: SHOP_A, sp_price: 10 }),
      makeSpRow({ product_id: PROD_2, shop_id: SHOP_A, sp_price: 20 }),
      makeSpRow({
        product_id: PROD_1,
        shop_id: SHOP_B,
        shop_product_id: SP_B1,
        sp_price: 30,
      }),
    ])
    const svc = new CartService(repo)

    const result = await svc.validateCart(USER_ID)

    expect(result.valid).toBe(true)
    expect(result.groupedByShop).toBeInstanceOf(Map)
    expect(result.groupedByShop.size).toBe(2)
    expect(result.groupedByShop.get(SHOP_A)).toHaveLength(2)
    expect(result.groupedByShop.get(SHOP_B)).toHaveLength(1)

    // Round trip: union of grouped values equals items array
    const flattened = []
    for (const [, lines] of result.groupedByShop) flattened.push(...lines)
    expect(flattened).toHaveLength(result.items.length)
  })

  // Regression: a shop with no price set for a listing (shop_products.price
  // IS NULL — the schema allows it) previously fell through to the master
  // catalog price in _effectivePrice()/_listPrice() instead of being
  // treated as unavailable, silently charging a price the shop never set.
  it('rejects with SHOP_PRICE_NOT_SET when sp_price is null, never falling back to the master price', async () => {
    const repo = makeRepoMock()
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 1 },
    ])
    repo.findShopProductsForCart.mockResolvedValueOnce([
      makeSpRow({ product_id: PROD_1, shop_id: SHOP_A, sp_price: null, product_price: 999 }),
    ])
    const svc = new CartService(repo)

    const result = await svc.validateCart(USER_ID)

    expect(result.valid).toBe(false)
    expect(result.items).toEqual([])
    expect(result.failed).toEqual([
      expect.objectContaining({
        productId: PROD_1,
        shopId: SHOP_A,
        code: 'SHOP_PRICE_NOT_SET',
      }),
    ])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// CartService.getCart — out-of-stock lines stay visible, but priced at ₹0
// ═══════════════════════════════════════════════════════════════════════
//
// Regression: a line could go out of stock (or get manually delisted)
// after being added to the cart — e.g. another customer buying the last
// unit first. getCart() used to have no stock/availability check at all
// (only validateCart(), called at order-placement time, caught it) — so
// the cart screen showed it completely normally, charged its price, and
// the customer only found out at a failed checkout attempt with no idea
// which item was the problem. getCart() must now: keep the line visible
// (so the app can show "out of stock"), but exclude it from subtotal/
// totalMrp/shopGroups (nothing about it is actually payable/deliverable).

describe('CartService.getCart — out-of-stock lines', () => {
  it('keeps an insufficient-stock line in items but excludes its price from subtotal', async () => {
    const repo = makeRepoMock()
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 3 },
    ])
    repo.findShopProductsForCart.mockResolvedValueOnce([
      makeSpRow({ product_id: PROD_1, shop_id: SHOP_A, sp_price: 50, stock_quantity: 1 }),
    ])
    const svc = new CartService(repo)

    const result = await svc.getCart(USER_ID)

    expect(result.items).toHaveLength(1)
    expect(result.items[0].stockQuantity).toBe(1)
    expect(result.subtotal).toBe(0)
    expect(result.totalMrp).toBe(0)
  })

  it('keeps an is_available=false line in items but excludes its price from subtotal', async () => {
    const repo = makeRepoMock()
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 1 },
    ])
    repo.findShopProductsForCart.mockResolvedValueOnce([
      makeSpRow({ product_id: PROD_1, shop_id: SHOP_A, sp_price: 50, is_available: false }),
    ])
    const svc = new CartService(repo)

    const result = await svc.getCart(USER_ID)

    expect(result.items).toHaveLength(1)
    expect(result.items[0].isAvailable).toBe(false)
    expect(result.subtotal).toBe(0)
  })

  it('excludes an out-of-stock line from shopGroups entirely (fee/coupon-scope computation must never see it)', async () => {
    const repo = makeRepoMock()
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 5 },
      { productId: PROD_2, shopId: SHOP_A, quantity: 1 },
    ])
    repo.findShopProductsForCart.mockResolvedValueOnce([
      makeSpRow({ product_id: PROD_1, shop_id: SHOP_A, sp_price: 50, stock_quantity: 0 }),
      makeSpRow({ product_id: PROD_2, shop_id: SHOP_A, sp_price: 20, stock_quantity: 10 }),
    ])
    const svc = new CartService(repo)

    const result = await svc.getCart(USER_ID)

    expect(result.shopGroups).toHaveLength(1)
    expect(result.shopGroups[0].items).toHaveLength(1)
    expect(result.shopGroups[0].items[0].productId).toBe(PROD_2)
    expect(result.shopGroups[0].subtotal).toBe(20)
    // The out-of-stock line is still visible at the top level for display.
    expect(result.items.map((i) => i.productId).sort()).toEqual([PROD_1, PROD_2].sort())
  })

  it('an all-available cart is unaffected (subtotal includes every line, as before)', async () => {
    const repo = makeRepoMock()
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 2 },
    ])
    repo.findShopProductsForCart.mockResolvedValueOnce([
      makeSpRow({ product_id: PROD_1, shop_id: SHOP_A, sp_price: 25, stock_quantity: 10 }),
    ])
    const svc = new CartService(repo)

    const result = await svc.getCart(USER_ID)

    expect(result.subtotal).toBe(50)
    expect(result.shopGroups[0].subtotal).toBe(50)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: shopProductId identity (option popup payload)
// ═══════════════════════════════════════════════════════════════════════

describe('CartService.addItem — shopProductId identity (Phase 3)', () => {
  it('resolves productId/shopId from shopProductId and adds an item', async () => {
    const repo = makeRepoMock()
    const sp = makeSpRow({ shop_product_id: SP_A1 })
    repo.findShopProductByIdForUser.mockResolvedValue(sp)
    repo.findShopProductsForCart.mockResolvedValue([sp])

    const service = new CartService(repo)
    const result = await service.addItem(USER_ID, {
      shopProductId: SP_A1,
      quantity: 2,
    })

    expect(result.success).toBe(true)
    expect(repo.findShopProductByIdForUser).toHaveBeenCalledWith(USER_ID, SP_A1)
    // Legacy product/shop lookups should NOT be hit when shopProductId is provided
    expect(repo.findShopProductsForProduct).not.toHaveBeenCalled()
    expect(repo.findShopProductForUser).not.toHaveBeenCalled()

    const saved = repo.saveCart.mock.calls[0][1]
    expect(saved).toEqual([{ productId: PROD_1, shopId: SHOP_A, quantity: 2 }])
  })

  it('rejects mismatched productId vs shopProductId with CART_ITEM_IDENTITY_CONFLICT', async () => {
    const repo = makeRepoMock()
    repo.findShopProductByIdForUser.mockResolvedValue(
      makeSpRow({ shop_product_id: SP_A1 })
    )

    const service = new CartService(repo)
    const result = await service.addItem(USER_ID, {
      shopProductId: SP_A1,
      productId: PROD_2, // does not match the resolved product_id (PROD_1)
      quantity: 1,
    })

    expect(result.success).toBe(false)
    expect(result.code).toBe('CART_ITEM_IDENTITY_CONFLICT')
    expect(repo.saveCart).not.toHaveBeenCalled()
  })

  it('rejects mismatched shopId vs shopProductId with CART_ITEM_IDENTITY_CONFLICT', async () => {
    const repo = makeRepoMock()
    repo.findShopProductByIdForUser.mockResolvedValue(makeSpRow())

    const service = new CartService(repo)
    const result = await service.addItem(USER_ID, {
      shopProductId: SP_A1,
      shopId: SHOP_B, // does not match the resolved shop_id (SHOP_A)
      quantity: 1,
    })

    expect(result.success).toBe(false)
    expect(result.code).toBe('CART_ITEM_IDENTITY_CONFLICT')
    expect(repo.saveCart).not.toHaveBeenCalled()
  })

  it('returns SHOP_NOT_AVAILABLE when shopProductId is unknown to user', async () => {
    const repo = makeRepoMock()
    repo.findShopProductByIdForUser.mockResolvedValue(null)

    const service = new CartService(repo)
    const result = await service.addItem(USER_ID, {
      shopProductId: SP_A1,
      quantity: 1,
    })

    expect(result.success).toBe(false)
    expect(result.code).toBe('SHOP_NOT_AVAILABLE')
  })
})

describe('CartService — multi-option same family stays as separate cart lines (Phase 3)', () => {
  it('adding two different products in the same family keeps two cart lines', async () => {
    const repo = makeRepoMock()
    // Tomato 500g and Tomato 1kg — same family, different products
    const tomato500g = makeSpRow({
      shop_product_id: SP_A1,
      product_id: PROD_1,
      product_family_id: 'fam-tomato',
      option_label: '500g',
      family_name: 'Tomato',
      name: 'Tomato 500g',
    })
    const tomato1kg = makeSpRow({
      shop_product_id: SP_A2,
      product_id: PROD_2,
      product_family_id: 'fam-tomato',
      option_label: '1kg',
      family_name: 'Tomato',
      name: 'Tomato 1kg',
    })

    // First add: 500g (auto-resolve via single-shop allocation)
    repo.findShopProductsForProduct.mockResolvedValueOnce([tomato500g])
    repo.findShopProductForUser.mockResolvedValueOnce(tomato500g)
    repo.findShopProductsForCart.mockResolvedValue([tomato500g])

    const service = new CartService(repo)
    await service.addItem(USER_ID, { productId: PROD_1, quantity: 1 })

    // Second add: 1kg — saved cart has the 500g already
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 1 },
    ])
    repo.findShopProductsForProduct.mockResolvedValueOnce([tomato1kg])
    repo.findShopProductForUser.mockResolvedValueOnce(tomato1kg)
    repo.findShopProductsForCart.mockResolvedValue([tomato500g, tomato1kg])

    await service.addItem(USER_ID, { productId: PROD_2, quantity: 1 })

    // saveCart was called twice; the second call must contain BOTH lines.
    const lastSave = repo.saveCart.mock.calls.at(-1)[1]
    expect(lastSave).toHaveLength(2)
    expect(lastSave).toEqual(
      expect.arrayContaining([
        { productId: PROD_1, shopId: SHOP_A, quantity: 1 },
        { productId: PROD_2, shopId: SHOP_A, quantity: 1 },
      ])
    )
  })

  it('adding the same option twice increments the same cart line', async () => {
    const repo = makeRepoMock()
    const tomato500g = makeSpRow({ shop_product_id: SP_A1 })
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 2 },
    ])
    repo.findShopProductsForProduct.mockResolvedValue([tomato500g])
    repo.findShopProductForUser.mockResolvedValue(tomato500g)
    repo.findShopProductsForCart.mockResolvedValue([tomato500g])

    const service = new CartService(repo)
    const result = await service.addItem(USER_ID, {
      productId: PROD_1,
      quantity: 3,
    })

    expect(result.success).toBe(true)
    const saved = repo.saveCart.mock.calls[0][1]
    expect(saved).toEqual([
      { productId: PROD_1, shopId: SHOP_A, quantity: 5 },
    ])
  })
})

describe('CartService.updateItem / removeItem — exact option identity (Phase 3)', () => {
  it('updateItem with shopProductId targets only the matching line', async () => {
    const repo = makeRepoMock()
    const tomato500g = makeSpRow({
      shop_product_id: SP_A1,
      product_id: PROD_1,
      name: 'Tomato 500g',
    })
    const tomato1kg = makeSpRow({
      shop_product_id: SP_A2,
      product_id: PROD_2,
      name: 'Tomato 1kg',
    })

    // Cart already has both options
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 2 },
      { productId: PROD_2, shopId: SHOP_A, quantity: 1 },
    ])
    // shopProductId resolves to PROD_1 / SHOP_A (the 500g)
    repo.findShopProductByIdForUser.mockResolvedValue(tomato500g)
    repo.findShopProductForUser.mockResolvedValue(tomato500g)
    repo.findShopProductsForCart.mockResolvedValue([tomato500g, tomato1kg])

    const service = new CartService(repo)
    const result = await service.updateItem(USER_ID, PROD_1, 5, null, SP_A1)

    expect(result.success).toBe(true)
    const saved = repo.saveCart.mock.calls[0][1]
    // 500g updated to 5; 1kg untouched at 1
    expect(saved).toEqual([
      { productId: PROD_1, shopId: SHOP_A, quantity: 5 },
      { productId: PROD_2, shopId: SHOP_A, quantity: 1 },
    ])
  })

  it('removeItem with shopProductId removes only the matching line', async () => {
    const repo = makeRepoMock()
    const tomato500g = makeSpRow({
      shop_product_id: SP_A1,
      product_id: PROD_1,
    })
    const tomato1kg = makeSpRow({
      shop_product_id: SP_A2,
      product_id: PROD_2,
    })

    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 2 },
      { productId: PROD_2, shopId: SHOP_A, quantity: 1 },
    ])
    repo.findShopProductByIdForUser.mockResolvedValue(tomato1kg)
    repo.findShopProductsForCart.mockResolvedValue([tomato500g])

    const service = new CartService(repo)
    const result = await service.removeItem(USER_ID, PROD_2, null, SP_A2)

    expect(result.success).toBe(true)
    const saved = repo.saveCart.mock.calls[0][1]
    // Only 500g remains
    expect(saved).toEqual([
      { productId: PROD_1, shopId: SHOP_A, quantity: 2 },
    ])
  })

  it('updateItem with productId-only and ambiguous match returns CART_ITEM_AMBIGUOUS', async () => {
    const repo = makeRepoMock()
    // Two cart lines with the SAME productId but different shops
    // (shouldn't normally happen but defends against bad data).
    repo.getCart.mockResolvedValueOnce([
      { productId: PROD_1, shopId: SHOP_A, quantity: 1 },
      { productId: PROD_1, shopId: SHOP_B, quantity: 1 },
    ])

    const service = new CartService(repo)
    const result = await service.updateItem(USER_ID, PROD_1, 5)

    expect(result.success).toBe(false)
    expect(result.code).toBe('CART_ITEM_AMBIGUOUS')
    expect(repo.saveCart).not.toHaveBeenCalled()
  })
})

describe('CartService._formatLine — option metadata enrichment (Phase 3)', () => {
  it('exposes optionLabel, familyName, foodType, originTag, customBadges, displayDeliveryMinutes', () => {
    const repo = makeRepoMock()
    const service = new CartService(repo)

    const sp = makeSpRow({
      product_family_id: 'fam-tomato',
      family_name: 'Tomato',
      option_label: '500g',
      net_quantity: '500g',
      food_type: 'VEG',
      origin_tag: 'LOCAL',
      custom_badges: ['Bestseller', 'Organic'],
      display_delivery_minutes: 10,
      sp_sale_price: 80,
      sp_price: 100,
    })

    const line = service._formatLine(
      sp,
      { productId: PROD_1, shopId: SHOP_A, quantity: 2 },
      80,
      160
    )

    expect(line.productFamilyId).toBe('fam-tomato')
    expect(line.familyName).toBe('Tomato')
    expect(line.optionLabel).toBe('500g')
    expect(line.netQuantity).toBe('500g')
    expect(line.foodType).toBe('VEG')
    expect(line.originTag).toBe('LOCAL')
    expect(line.customBadges).toEqual(['Bestseller', 'Organic'])
    expect(line.displayDeliveryMinutes).toBe(10)
    expect(line.shopProductId).toBe(SP_A1)
    expect(line.effectivePrice).toBe(80)
    // (100 - 80) / 100 = 20%
    expect(line.discountPercent).toBe(20)
    expect(line.discountAmount).toBe(20)
    expect(line.isAvailable).toBe(true)
  })

  it('falls back to safe defaults when option/family fields are missing', () => {
    const repo = makeRepoMock()
    const service = new CartService(repo)
    // Legacy product without family/option fields
    const sp = makeSpRow()

    const line = service._formatLine(
      sp,
      { productId: PROD_1, shopId: SHOP_A, quantity: 1 },
      100,
      100
    )

    expect(line.productFamilyId).toBeNull()
    expect(line.familyName).toBeNull()
    expect(line.optionLabel).toBeNull()
    expect(line.foodType).toBe('NONE')
    expect(line.originTag).toBe('NONE')
    expect(line.customBadges).toEqual([])
    expect(line.displayDeliveryMinutes).toBeNull()
    expect(line.discountAmount).toBe(0)
    expect(line.discountPercent).toBe(0)
  })
})
