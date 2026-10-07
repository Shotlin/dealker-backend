// Feature: multi-vendor-system, Property 6: Order Splitting
// **Validates: Requirements 5.6, 5.7**
//
// Property:
//   For any cart with items from N shops, checkout produces exactly N orders,
//   each with items from one shop only, fees computed per-order (delivery
//   fee threshold applied to each shop's subtotal independently).
//
// Sub-properties asserted below (each as its own property test):
//   1. Group count = distinct shop count   (Req 5.6)
//   2. Each group contains only its shop   (Req 5.6)
//   3. No items lost (modulo skipped items lacking shopId)
//   4. Per-shop fee independence            (Req 5.7)
//   5. totalAmount formula                  (Req 5.7)

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'

// ─── Mock external deps BEFORE importing the service ─────────
// The service imports a logger at load time. Mock it so tests stay hermetic
// and don't require a running pino/transport.
vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { OrderSplitterService } from '../../src/modules/orders/order-splitter.service.js'

// ─── Service factory (no real IO) ─────────────────────────────

function makeService(fees = {}) {
  return new OrderSplitterService({
    ordersRepository: {
      create: vi.fn(),
      generateOrderNumber: vi.fn(),
    },
    shopProductsRepository: {
      findByIdForUpdate: vi.fn(),
      applyStockUpdate: vi.fn(),
    },
    fees,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── Arbitraries ──────────────────────────────────────────────

// Small fixed pool of shop ids — picking from a finite set ensures the
// property covers carts with 1..N distinct shops, which is the variable that
// matters for splitting (rather than uuid uniqueness, which is trivially
// true). Pool size matches the spec hint: "small set (1..5) of fc.uuid()s".
const SHOP_POOL_SIZE = 5
const shopPoolArb = fc.uniqueArray(fc.uuid(), {
  minLength: 1,
  maxLength: SHOP_POOL_SIZE,
})

// A line total in [0, 5000] — bounded around the free-delivery threshold so
// tests exercise both the "charge delivery" and "free delivery" branches.
const lineTotalArb = fc.double({
  min: 0,
  max: 5000,
  noNaN: true,
  noDefaultInfinity: true,
})

// quantity in [1, 50] — matches default max_order_qty in the design.
const quantityArb = fc.integer({ min: 1, max: 50 })

// Cart item arbitrary. shopId is chosen from a passed-in pool so the
// distinct-shop count is bounded by the pool.
function cartItemArb(shopPool) {
  return fc.record({
    productId: fc.uuid(),
    shopId: fc.constantFrom(...shopPool),
    quantity: quantityArb,
    lineTotal: lineTotalArb,
  })
}

// Cart arbitrary: 0..50 items drawn from a 1..5-shop pool.
const cartArb = shopPoolArb.chain((pool) =>
  fc
    .array(cartItemArb(pool), { minLength: 0, maxLength: 50 })
    .map((items) => ({ items, pool }))
)

// ═══════════════════════════════════════════════════════════════
// Property 6.1 — Group count equals distinct shop count (Req 5.6)
// ═══════════════════════════════════════════════════════════════
describe('Property 6: Order Splitting — group count = distinct shop count', () => {
  it('splitCart(items).size === |{shopId : item.shopId in items}|', () => {
    const service = makeService()
    fc.assert(
      fc.property(cartArb, ({ items }) => {
        const groups = service.splitCart(items)
        const distinctShops = new Set(
          items.filter((i) => i && i.shopId).map((i) => i.shopId)
        )
        expect(groups.size).toBe(distinctShops.size)
      }),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 6.2 — Each group contains only its shop's items (Req 5.6)
// ═══════════════════════════════════════════════════════════════
describe('Property 6: Order Splitting — group purity', () => {
  it('for each [shopId, items] pair, every item.shopId === shopId', () => {
    const service = makeService()
    fc.assert(
      fc.property(cartArb, ({ items }) => {
        const groups = service.splitCart(items)
        for (const [shopId, groupItems] of groups) {
          for (const item of groupItems) {
            expect(item.shopId).toBe(shopId)
          }
        }
      }),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 6.3 — No items lost (modulo items missing shopId)
// ═══════════════════════════════════════════════════════════════
describe('Property 6: Order Splitting — items conserved', () => {
  it('sum of items across groups equals count of input items with a shopId', () => {
    const service = makeService()
    fc.assert(
      fc.property(cartArb, ({ items }) => {
        const groups = service.splitCart(items)
        let total = 0
        for (const [, groupItems] of groups) total += groupItems.length
        const expectedTotal = items.filter((i) => i && i.shopId).length
        expect(total).toBe(expectedTotal)
      }),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 6.4 — Per-shop fee independence (Req 5.7)
// ═══════════════════════════════════════════════════════════════
describe('Property 6: Order Splitting — per-shop fee independence', () => {
  it('delivery fee = 0 if subtotal >= threshold, else flat fee — applied per shop independently', () => {
    const service = makeService() // defaults: deliveryFee=25, threshold=499
    const threshold = service.freeDeliveryThreshold
    const flat = service.deliveryFee

    fc.assert(
      fc.property(cartArb, ({ items }) => {
        const groups = service.splitCart(items)
        for (const [, groupItems] of groups) {
          const fees = service.computeFees(groupItems)
          if (fees.subtotal >= threshold) {
            expect(fees.deliveryFee).toBe(0)
          } else {
            expect(fees.deliveryFee).toBe(flat)
          }
        }
      }),
      { numRuns: 100 }
    )
  })

  it('explicit two-shop scenario: shop A 200 charges fee, shop B 600 free', () => {
    const service = makeService()
    const SHOP_A = '11111111-1111-1111-1111-111111111111'
    const SHOP_B = '22222222-2222-2222-2222-222222222222'
    const groups = service.splitCart([
      { productId: 'p1', shopId: SHOP_A, quantity: 2, lineTotal: 200 },
      { productId: 'p2', shopId: SHOP_B, quantity: 1, lineTotal: 600 },
    ])
    const feesA = service.computeFees(groups.get(SHOP_A))
    const feesB = service.computeFees(groups.get(SHOP_B))
    expect(feesA.deliveryFee).toBe(25)
    expect(feesB.deliveryFee).toBe(0)
    // Combined subtotals exceed the threshold, but the per-shop logic keeps
    // shop A's fee at the flat rate — that's the independence guarantee.
    expect(feesA.subtotal + feesB.subtotal).toBeGreaterThanOrEqual(
      service.freeDeliveryThreshold
    )
    expect(feesA.deliveryFee).toBe(25)
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 6.5 — totalAmount formula (Req 5.7)
// ═══════════════════════════════════════════════════════════════
describe('Property 6: Order Splitting — totalAmount formula', () => {
  it('totalAmount === round2(subtotal + deliveryFee + platformFee) for any group', () => {
    const service = makeService()
    fc.assert(
      fc.property(cartArb, ({ items }) => {
        const groups = service.splitCart(items)
        for (const [, groupItems] of groups) {
          const fees = service.computeFees(groupItems)
          const expected = Number(
            (fees.subtotal + fees.deliveryFee + fees.platformFee).toFixed(2)
          )
          expect(fees.totalAmount).toBe(expected)
          // platformFee is constant per the splitter contract
          expect(fees.platformFee).toBe(service.platformFee)
        }
      }),
      { numRuns: 100 }
    )
  })

  it('formula holds with custom fee configuration', () => {
    const service = makeService({
      deliveryFee: 40,
      platformFee: 10,
      freeDeliveryThreshold: 1000,
    })
    fc.assert(
      fc.property(cartArb, ({ items }) => {
        const groups = service.splitCart(items)
        for (const [, groupItems] of groups) {
          const fees = service.computeFees(groupItems)
          const expectedDelivery = fees.subtotal >= 1000 ? 0 : 40
          expect(fees.deliveryFee).toBe(expectedDelivery)
          expect(fees.platformFee).toBe(10)
          expect(fees.totalAmount).toBe(
            Number((fees.subtotal + fees.deliveryFee + 10).toFixed(2))
          )
        }
      }),
      { numRuns: 100 }
    )
  })
})
