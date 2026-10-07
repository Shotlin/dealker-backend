// Coverage for PurchaseLimitsService — the core anti-abuse arithmetic
// (per-order cap, rolling-window cap, CATEGORY-vs-PRODUCT rule precedence,
// checkout-time advisory locking) behind the "Purchase Limits" feature.
// Constructor-injected repo/cartRepo mocks, no database mocking needed.

import { describe, expect, it, vi } from 'vitest'
import { PurchaseLimitsService } from '../../../src/modules/purchase-limits/purchase-limits.service.js'

const USER_ID = 'user-1'
const CATEGORY_DAIRY = 'cat-dairy'
const CATEGORY_VEG = 'cat-veg'
const PROD_MILK = 'prod-milk'
const PROD_CHEESE = 'prod-cheese'
const PROD_TOMATO = 'prod-tomato'

function makeRepoMock(overrides = {}) {
  return {
    resolveEffectiveRules: vi.fn().mockResolvedValue(new Map()),
    getCategoryMap: vi.fn().mockResolvedValue(new Map()),
    getWindowUsage: vi.fn().mockResolvedValue(0),
    ...overrides,
  }
}

function makeCartRepoMock(overrides = {}) {
  return {
    getCart: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════
// evaluate() — cart.service.js addItem/updateItem/validateCart call this
// ═══════════════════════════════════════════════════════════════════════

describe('PurchaseLimitsService.evaluate — unrestricted products (safe default)', () => {
  it('returns ok:true immediately, with no category/window queries, when the product has no active rule', async () => {
    const repo = makeRepoMock()
    const service = new PurchaseLimitsService(repo)

    const result = await service.evaluate(USER_ID, {
      productId: PROD_TOMATO,
      cartItems: [{ productId: PROD_TOMATO, quantity: 40 }],
    })

    expect(result).toEqual({ ok: true })
    expect(repo.getCategoryMap).not.toHaveBeenCalled()
    expect(repo.getWindowUsage).not.toHaveBeenCalled()
  })
})

describe('PurchaseLimitsService.evaluate — per-order cap (PRODUCT-level rule)', () => {
  const rule = {
    id: 'rule-1', label: 'Milk cap', targetType: 'PRODUCT',
    productId: PROD_MILK, categoryId: null,
    maxQtyPerOrder: 3, windowEnabled: false,
  }

  it('allows exactly at the cap (boundary — positive)', async () => {
    const repo = makeRepoMock({ resolveEffectiveRules: vi.fn().mockResolvedValue(new Map([[PROD_MILK, rule]])) })
    const service = new PurchaseLimitsService(repo)

    const result = await service.evaluate(USER_ID, {
      productId: PROD_MILK,
      cartItems: [{ productId: PROD_MILK, quantity: 3 }],
    })

    expect(result.ok).toBe(true)
  })

  it('rejects one unit over the cap with a customer-facing message naming the rule and the limit', async () => {
    const repo = makeRepoMock({ resolveEffectiveRules: vi.fn().mockResolvedValue(new Map([[PROD_MILK, rule]])) })
    const service = new PurchaseLimitsService(repo)

    const result = await service.evaluate(USER_ID, {
      productId: PROD_MILK,
      cartItems: [{ productId: PROD_MILK, quantity: 4 }],
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('PURCHASE_LIMIT_ORDER_EXCEEDED')
    expect(result.message).toBe('Maximum 3 units of "Milk cap" allowed per order')
  })
})

describe('PurchaseLimitsService.evaluate — CATEGORY-level rule aggregates every matching cart line', () => {
  const rule = {
    id: 'rule-2', label: 'Dairy cap', targetType: 'CATEGORY',
    productId: null, categoryId: CATEGORY_DAIRY,
    maxQtyPerOrder: 5, windowEnabled: false,
  }

  it('sums quantities across every product sharing the restricted category, not just the one being added', async () => {
    const repo = makeRepoMock({
      resolveEffectiveRules: vi.fn().mockResolvedValue(new Map([[PROD_CHEESE, rule]])),
      getCategoryMap: vi.fn().mockResolvedValue(new Map([
        [PROD_MILK, CATEGORY_DAIRY],
        [PROD_CHEESE, CATEGORY_DAIRY],
        [PROD_TOMATO, CATEGORY_VEG],
      ])),
    })
    const service = new PurchaseLimitsService(repo)

    // 3 milk (dairy) + 3 cheese (dairy) = 6 > 5, even though 10 tomato (veg) is also in the cart
    const result = await service.evaluate(USER_ID, {
      productId: PROD_CHEESE,
      cartItems: [
        { productId: PROD_MILK, quantity: 3 },
        { productId: PROD_TOMATO, quantity: 10 },
        { productId: PROD_CHEESE, quantity: 3 },
      ],
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('PURCHASE_LIMIT_ORDER_EXCEEDED')
  })

  it('never restricts a product in an unrestricted category no matter the quantity (mixed-cart isolation)', async () => {
    const repo = makeRepoMock({
      resolveEffectiveRules: vi.fn().mockResolvedValue(new Map()), // tomato has no rule at all
    })
    const service = new PurchaseLimitsService(repo)

    const result = await service.evaluate(USER_ID, {
      productId: PROD_TOMATO,
      cartItems: [{ productId: PROD_TOMATO, quantity: 40 }],
    })

    expect(result.ok).toBe(true)
  })
})

describe('PurchaseLimitsService.evaluate — exemptOrderCapWithOtherItems (solo-order exemption)', () => {
  const rule = {
    id: 'rule-solo', label: 'Dairy cap', targetType: 'CATEGORY',
    productId: null, categoryId: CATEGORY_DAIRY,
    maxQtyPerOrder: 3, windowEnabled: false,
    exemptOrderCapWithOtherItems: true,
  }

  it('still enforces the per-order cap when the order is only the restricted category', async () => {
    const repo = makeRepoMock({
      resolveEffectiveRules: vi.fn().mockResolvedValue(new Map([[PROD_MILK, rule]])),
      getCategoryMap: vi.fn().mockResolvedValue(new Map([[PROD_MILK, CATEGORY_DAIRY]])),
    })
    const service = new PurchaseLimitsService(repo)

    const result = await service.evaluate(USER_ID, {
      productId: PROD_MILK,
      cartItems: [{ productId: PROD_MILK, quantity: 5 }], // over the cap of 3, nothing else in cart
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('PURCHASE_LIMIT_ORDER_EXCEEDED')
  })

  it('lifts the per-order cap once the cart also has a product outside the rule\'s scope', async () => {
    const repo = makeRepoMock({
      resolveEffectiveRules: vi.fn().mockResolvedValue(new Map([[PROD_MILK, rule]])),
      getCategoryMap: vi.fn().mockResolvedValue(new Map([
        [PROD_MILK, CATEGORY_DAIRY],
        [PROD_TOMATO, CATEGORY_VEG],
      ])),
    })
    const service = new PurchaseLimitsService(repo)

    const result = await service.evaluate(USER_ID, {
      productId: PROD_MILK,
      cartItems: [
        { productId: PROD_MILK, quantity: 5 }, // over the cap of 3...
        { productId: PROD_TOMATO, quantity: 1 }, // ...but a vegetable is also in the basket
      ],
    })

    expect(result.ok).toBe(true)
  })

  it('does NOT lift the rolling-window cap even when other products are in the basket', async () => {
    const windowRule = { ...rule, maxQtyPerOrder: null, windowEnabled: true, windowPeriod: 'DAY', windowCount: 1, maxQtyPerWindow: 3 }
    const repo = makeRepoMock({
      resolveEffectiveRules: vi.fn().mockResolvedValue(new Map([[PROD_MILK, windowRule]])),
      getCategoryMap: vi.fn().mockResolvedValue(new Map([
        [PROD_MILK, CATEGORY_DAIRY],
        [PROD_TOMATO, CATEGORY_VEG],
      ])),
      getWindowUsage: vi.fn().mockResolvedValue(2), // already bought 2 today
    })
    const service = new PurchaseLimitsService(repo)

    const result = await service.evaluate(USER_ID, {
      productId: PROD_MILK,
      cartItems: [
        { productId: PROD_MILK, quantity: 5 }, // 2 + 5 = 7 > 3
        { productId: PROD_TOMATO, quantity: 1 },
      ],
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('PURCHASE_LIMIT_WINDOW_EXCEEDED')
  })
})

describe('PurchaseLimitsService.evaluate — rolling window cap', () => {
  const rule = {
    id: 'rule-3', label: 'Dairy weekly cap', targetType: 'CATEGORY',
    productId: null, categoryId: CATEGORY_DAIRY,
    maxQtyPerOrder: null, windowEnabled: true,
    windowPeriod: 'WEEK', windowCount: 1, maxQtyPerWindow: 5,
  }

  it('combines already-purchased window usage with the current cart to detect the breach', async () => {
    const repo = makeRepoMock({
      resolveEffectiveRules: vi.fn().mockResolvedValue(new Map([[PROD_MILK, rule]])),
      getCategoryMap: vi.fn().mockResolvedValue(new Map([[PROD_MILK, CATEGORY_DAIRY]])),
      getWindowUsage: vi.fn().mockResolvedValue(3), // already bought 3 this week
    })
    const service = new PurchaseLimitsService(repo)

    // 3 already bought + 3 more in cart = 6 > 5
    const result = await service.evaluate(USER_ID, {
      productId: PROD_MILK,
      cartItems: [{ productId: PROD_MILK, quantity: 3 }],
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('PURCHASE_LIMIT_WINDOW_EXCEEDED')
    expect(result.message).toContain('2 left') // 5 - 3 already bought = 2 remaining
    // WEEK x 1 -> 7 days, passed through to the repository as-is
    expect(repo.getWindowUsage).toHaveBeenCalledWith(USER_ID, rule, 7, null)
  })

  it('a cancelled/refunded order freeing up quota is entirely the repository/SQL layer\'s concern — the service just trusts the number it gets back', async () => {
    const repo = makeRepoMock({
      resolveEffectiveRules: vi.fn().mockResolvedValue(new Map([[PROD_MILK, rule]])),
      getCategoryMap: vi.fn().mockResolvedValue(new Map([[PROD_MILK, CATEGORY_DAIRY]])),
      getWindowUsage: vi.fn().mockResolvedValue(0), // e.g. the only prior order was cancelled
    })
    const service = new PurchaseLimitsService(repo)

    const result = await service.evaluate(USER_ID, {
      productId: PROD_MILK,
      cartItems: [{ productId: PROD_MILK, quantity: 5 }],
    })

    expect(result.ok).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// evaluateCheckout() — order-splitter.service.js createOrders() calls this
// ═══════════════════════════════════════════════════════════════════════

describe('PurchaseLimitsService.evaluateCheckout — final, checkout-time re-check', () => {
  it('skips locking entirely and returns no failures when nothing in the checkout is restricted', async () => {
    const repo = makeRepoMock()
    const service = new PurchaseLimitsService(repo)
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) }

    const failures = await service.evaluateCheckout(
      USER_ID,
      [{ productId: PROD_TOMATO, shopId: 'shop-1', quantity: 40 }],
      client
    )

    expect(failures).toEqual([])
    expect(client.query).not.toHaveBeenCalled()
  })

  it('acquires one advisory lock per distinct rule, in sorted rule-id order (deadlock-free)', async () => {
    const ruleA = { id: 'rule-a', label: 'A', targetType: 'PRODUCT', productId: 'p-a', categoryId: null, maxQtyPerOrder: 100, windowEnabled: false }
    const ruleB = { id: 'rule-b', label: 'B', targetType: 'PRODUCT', productId: 'p-b', categoryId: null, maxQtyPerOrder: 100, windowEnabled: false }
    const repo = makeRepoMock({
      // Deliberately resolved/inserted out of sorted order to prove the
      // service sorts before locking, not just iterates insertion order.
      resolveEffectiveRules: vi.fn().mockResolvedValue(new Map([['p-b', ruleB], ['p-a', ruleA]])),
    })
    const service = new PurchaseLimitsService(repo)
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) }

    await service.evaluateCheckout(
      USER_ID,
      [
        { productId: 'p-b', shopId: 'shop-1', quantity: 1 },
        { productId: 'p-a', shopId: 'shop-1', quantity: 1 },
      ],
      client
    )

    const lockCalls = client.query.mock.calls.filter(([sql]) => sql.includes('pg_advisory_xact_lock'))
    expect(lockCalls).toHaveLength(2)
    expect(lockCalls[0][1]).toEqual([`${USER_ID}:rule-a`])
    expect(lockCalls[1][1]).toEqual([`${USER_ID}:rule-b`])
  })

  it('produces one failure per offending line, sharing the same reason/code, and leaves unrestricted lines out entirely', async () => {
    const rule = {
      id: 'rule-dairy', label: 'Dairy cap', targetType: 'CATEGORY',
      productId: null, categoryId: CATEGORY_DAIRY, maxQtyPerOrder: 3, windowEnabled: false,
    }
    const repo = makeRepoMock({
      resolveEffectiveRules: vi.fn().mockResolvedValue(new Map([
        [PROD_MILK, rule],
        [PROD_CHEESE, rule],
      ])),
    })
    const service = new PurchaseLimitsService(repo)
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) }

    const failures = await service.evaluateCheckout(
      USER_ID,
      [
        { productId: PROD_MILK, shopId: 'shop-1', quantity: 2 },
        { productId: PROD_CHEESE, shopId: 'shop-1', quantity: 2 }, // 2+2=4 > 3
        { productId: PROD_TOMATO, shopId: 'shop-1', quantity: 50 }, // unrestricted
      ],
      client
    )

    expect(failures).toHaveLength(2)
    expect(failures.every((f) => f.code === 'PURCHASE_LIMIT_ORDER_EXCEEDED')).toBe(true)
    expect(failures.map((f) => f.productId).sort()).toEqual([PROD_CHEESE, PROD_MILK].sort())
    expect(failures.find((f) => f.productId === PROD_TOMATO)).toBeUndefined()
  })

  it('lifts the per-order cap at checkout too, once the same checkout has an unrestricted line', async () => {
    const rule = {
      id: 'rule-solo-checkout', label: 'Dairy cap', targetType: 'CATEGORY',
      productId: null, categoryId: CATEGORY_DAIRY, maxQtyPerOrder: 3, windowEnabled: false,
      exemptOrderCapWithOtherItems: true,
    }
    const repo = makeRepoMock({
      resolveEffectiveRules: vi.fn().mockResolvedValue(new Map([[PROD_MILK, rule]])),
    })
    const service = new PurchaseLimitsService(repo)
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) }

    const failures = await service.evaluateCheckout(
      USER_ID,
      [
        { productId: PROD_MILK, shopId: 'shop-1', quantity: 5 }, // over the cap of 3...
        { productId: PROD_TOMATO, shopId: 'shop-1', quantity: 1 }, // ...but tomato (unrestricted) is also in this checkout
      ],
      client
    )

    expect(failures).toEqual([])
  })

  it('passes when every restricted line stays within its cap', async () => {
    const rule = { id: 'rule-4', label: 'Milk cap', targetType: 'PRODUCT', productId: PROD_MILK, categoryId: null, maxQtyPerOrder: 5, windowEnabled: false }
    const repo = makeRepoMock({ resolveEffectiveRules: vi.fn().mockResolvedValue(new Map([[PROD_MILK, rule]])) })
    const service = new PurchaseLimitsService(repo)
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) }

    const failures = await service.evaluateCheckout(
      USER_ID,
      [{ productId: PROD_MILK, shopId: 'shop-1', quantity: 5 }],
      client
    )

    expect(failures).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// getStatusForUser() — the customer-facing "+"-button status endpoint
// ═══════════════════════════════════════════════════════════════════════

describe('PurchaseLimitsService.getStatusForUser — powers the Flutter "+" button', () => {
  it('omits unrestricted products entirely (absence == unrestricted, the client\'s safe default)', async () => {
    const repo = makeRepoMock()
    const service = new PurchaseLimitsService(repo, { cartRepository: makeCartRepoMock() })

    const items = await service.getStatusForUser(USER_ID, [PROD_TOMATO])

    expect(items).toEqual([])
  })

  it('remainingToAdd is the tighter of the per-order and window caps, net of what is already in the cart', async () => {
    const rule = {
      id: 'rule-5', label: 'Dairy cap', targetType: 'CATEGORY', productId: null, categoryId: CATEGORY_DAIRY,
      maxQtyPerOrder: 5, windowEnabled: true, windowPeriod: 'WEEK', windowCount: 1, maxQtyPerWindow: 4,
    }
    const repo = makeRepoMock({
      resolveEffectiveRules: vi.fn().mockResolvedValue(new Map([[PROD_MILK, rule]])),
      getCategoryMap: vi.fn().mockResolvedValue(new Map([[PROD_MILK, CATEGORY_DAIRY]])),
      getWindowUsage: vi.fn().mockResolvedValue(1), // already bought 1 this week
    })
    const cartRepo = makeCartRepoMock({
      getCart: vi.fn().mockResolvedValue([{ productId: PROD_MILK, quantity: 2 }]), // 2 already in cart
    })
    const service = new PurchaseLimitsService(repo, { cartRepository: cartRepo })

    const [status] = await service.getStatusForUser(USER_ID, [PROD_MILK])

    // remainingThisOrder = 5 - 2(cart)              = 3
    // remainingInWindow  = 4 - 1(used) - 2(cart)     = 1
    // remainingToAdd     = min(3, 1)                 = 1
    expect(status.remainingThisOrder).toBe(3)
    expect(status.remainingInWindow).toBe(1)
    expect(status.remainingToAdd).toBe(1)
    expect(status.isAtLimit).toBe(false)
  })

  it('marks isAtLimit true once remainingToAdd hits zero', async () => {
    const rule = { id: 'rule-6', label: 'Milk cap', targetType: 'PRODUCT', productId: PROD_MILK, categoryId: null, maxQtyPerOrder: 2, windowEnabled: false }
    const repo = makeRepoMock({ resolveEffectiveRules: vi.fn().mockResolvedValue(new Map([[PROD_MILK, rule]])) })
    const cartRepo = makeCartRepoMock({
      getCart: vi.fn().mockResolvedValue([{ productId: PROD_MILK, quantity: 2 }]), // already at the cap
    })
    const service = new PurchaseLimitsService(repo, { cartRepository: cartRepo })

    const [status] = await service.getStatusForUser(USER_ID, [PROD_MILK])

    expect(status.remainingThisOrder).toBe(0)
    expect(status.remainingToAdd).toBe(0)
    expect(status.isAtLimit).toBe(true)
  })

  it('exemptOrderCapWithOtherItems: reports the per-order cap as lifted once another product is in the cart, leaving only the window cap in effect', async () => {
    const rule = {
      id: 'rule-solo-status', label: 'Dairy cap', targetType: 'CATEGORY', productId: null, categoryId: CATEGORY_DAIRY,
      maxQtyPerOrder: 3, windowEnabled: false, exemptOrderCapWithOtherItems: true,
    }
    const repo = makeRepoMock({
      resolveEffectiveRules: vi.fn().mockResolvedValue(new Map([[PROD_MILK, rule]])),
      getCategoryMap: vi.fn().mockResolvedValue(new Map([
        [PROD_MILK, CATEGORY_DAIRY],
        [PROD_TOMATO, CATEGORY_VEG],
      ])),
    })
    const cartRepo = makeCartRepoMock({
      getCart: vi.fn().mockResolvedValue([
        { productId: PROD_MILK, quantity: 5 }, // already over the cap of 3
        { productId: PROD_TOMATO, quantity: 1 },
      ]),
    })
    const service = new PurchaseLimitsService(repo, { cartRepository: cartRepo })

    const [status] = await service.getStatusForUser(USER_ID, [PROD_MILK])

    expect(status.remainingThisOrder).toBeNull()
    expect(status.orderCapLifted).toBe(true)
    expect(status.isAtLimit).toBe(false)
    // remainingThisOrder is null (lifted) AND remainingInWindow is null (no
    // window cap on this rule) — remainingToAdd must still come back as a
    // real, non-null number: the Flutter model's `remainingToAdd` is a
    // non-nullable int, and (json['remainingToAdd'] as num) throws on null.
    expect(status.remainingToAdd).not.toBeNull()
    expect(typeof status.remainingToAdd).toBe('number')
  })

  it('never goes negative when the cart already exceeds the cap (e.g. admin just lowered it)', async () => {
    const rule = { id: 'rule-7', label: 'Milk cap', targetType: 'PRODUCT', productId: PROD_MILK, categoryId: null, maxQtyPerOrder: 2, windowEnabled: false }
    const repo = makeRepoMock({ resolveEffectiveRules: vi.fn().mockResolvedValue(new Map([[PROD_MILK, rule]])) })
    const cartRepo = makeCartRepoMock({
      getCart: vi.fn().mockResolvedValue([{ productId: PROD_MILK, quantity: 9 }]), // cart pre-dates the new, lower cap
    })
    const service = new PurchaseLimitsService(repo, { cartRepository: cartRepo })

    const [status] = await service.getStatusForUser(USER_ID, [PROD_MILK])

    expect(status.remainingThisOrder).toBe(0)
    expect(status.remainingToAdd).toBe(0)
    expect(status.isAtLimit).toBe(true)
  })
})
