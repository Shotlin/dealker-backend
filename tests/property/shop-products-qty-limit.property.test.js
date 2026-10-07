// Feature: multi-vendor-system, Property 13: Quantity Limit Enforcement
// **Validates: Requirements 5.4, 12.2, 12.3**
//
// Property:
//   For any product with max_order_qty M, cart/checkout with total qty > M
//   must be rejected. Conversely, any quantity in [1, M] must be accepted.
//
// Coverage at this stage of the spec:
//   At task 4.4, only the producer-side (shop-products) exists; cart-side
//   wiring lands in task 6.2. We therefore validate the layer that the cart
//   will rely on:
//     1. Schema-level (Zod) — createShopProductSchema and
//        updateShopProductSchema reject max_order_qty outside [1, 10000]
//        (Req 12.6) and accept values within range.
//     2. A pure validator helper that the cart will reuse:
//        requestedQty <= max_order_qty → ok; else MAX_QTY_EXCEEDED
//        (Req 5.4, 12.2, 12.3).
//     3. Stock-update interplay — stockUpdateSchema does not surface
//        max_order_qty, and the repository's applyStockUpdate SQL never
//        writes it. max_order_qty constrains ORDER quantities, not stock.

import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'

// ─── Mock infrastructure dependencies BEFORE importing app modules ───
// The schemas are pure Zod, but the repository file imports the database
// client at load time. Mocks let this test run without live infra.
vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  createShopProductSchema,
  updateShopProductSchema,
  stockUpdateSchema,
} from '../../src/modules/shop-products/shop-products.schema.js'
import { ShopProductsRepository } from '../../src/modules/shop-products/shop-products.repository.js'

// ─── Constants — mirror the DB CHECK constraints ─────────
const MAX_ORDER_QTY_MIN = 1
const MAX_ORDER_QTY_MAX = 10000

// ─── Pure validator helper (the contract the cart will rely on) ──
// This is the producer-side guard. The cart-side validation in task 6.2
// will call this exact shape. Keeping it inline keeps the test self
// contained for the current task scope.
function validateRequestedQty({ requestedQty, maxOrderQty }) {
  if (
    !Number.isInteger(requestedQty) ||
    !Number.isInteger(maxOrderQty) ||
    requestedQty < 1 ||
    maxOrderQty < MAX_ORDER_QTY_MIN ||
    maxOrderQty > MAX_ORDER_QTY_MAX
  ) {
    return { ok: false, code: 'INVALID_INPUT' }
  }
  if (requestedQty > maxOrderQty) {
    return {
      ok: false,
      code: 'MAX_QTY_EXCEEDED',
      max: maxOrderQty,
    }
  }
  return { ok: true }
}

// ─── Arbitraries ─────────────────────────────────────────
const validMaxOrderQtyArb = fc.integer({
  min: MAX_ORDER_QTY_MIN,
  max: MAX_ORDER_QTY_MAX,
})

// Out-of-range integers: below 1 (incl. zero and negatives) and above 10000.
const invalidIntegerMaxOrderQtyArb = fc.oneof(
  fc.integer({ min: -1_000_000, max: 0 }),
  fc.integer({ min: MAX_ORDER_QTY_MAX + 1, max: 1_000_000 })
)

// Non-integer / non-numeric variants — Zod must also reject these.
const nonIntegerMaxOrderQtyArb = fc.oneof(
  fc
    .double({ noNaN: true, noDefaultInfinity: true, min: 1.0001, max: 9999.9999 })
    .filter((n) => !Number.isInteger(n)),
  fc.constantFrom('50', null, true, false, [], {})
)

// Wider qty range for the validator helper, intentionally overshooting M.
const requestedQtyArb = fc.integer({ min: 1, max: 100_000 })

// Body fields shared by create-product payloads (kept minimal).
const validCreateBaseArb = fc.record({
  product_id: fc.uuid(),
  stock_quantity: fc.integer({ min: 0, max: 1000 }),
  low_stock_threshold: fc.integer({ min: 0, max: 100 }),
  is_available: fc.boolean(),
})

// ═══════════════════════════════════════════════════════════════
// Property 13.A — Schema rejects out-of-range max_order_qty
// ═══════════════════════════════════════════════════════════════
describe('Property 13: Quantity Limit Enforcement — schema range (Req 12.6)', () => {
  it('createShopProductSchema rejects every integer max_order_qty outside [1, 10000]', () => {
    fc.assert(
      fc.property(
        validCreateBaseArb,
        invalidIntegerMaxOrderQtyArb,
        (base, badQty) => {
          const result = createShopProductSchema.safeParse({
            ...base,
            max_order_qty: badQty,
          })
          expect(result.success).toBe(false)
          // The failing path must point at max_order_qty.
          const paths = result.error.issues.map((i) => i.path.join('.'))
          expect(paths).toContain('max_order_qty')
        }
      ),
      { numRuns: 100 }
    )
  })

  it('createShopProductSchema rejects every non-integer max_order_qty', () => {
    fc.assert(
      fc.property(
        validCreateBaseArb,
        nonIntegerMaxOrderQtyArb,
        (base, badQty) => {
          const result = createShopProductSchema.safeParse({
            ...base,
            max_order_qty: badQty,
          })
          expect(result.success).toBe(false)
          const paths = result.error.issues.map((i) => i.path.join('.'))
          expect(paths).toContain('max_order_qty')
        }
      ),
      { numRuns: 100 }
    )
  })

  it('createShopProductSchema accepts every integer max_order_qty in [1, 10000]', () => {
    fc.assert(
      fc.property(validCreateBaseArb, validMaxOrderQtyArb, (base, goodQty) => {
        const result = createShopProductSchema.safeParse({
          ...base,
          max_order_qty: goodQty,
        })
        expect(result.success).toBe(true)
        expect(result.data.max_order_qty).toBe(goodQty)
      }),
      { numRuns: 100 }
    )
  })

  it('updateShopProductSchema rejects every integer max_order_qty outside [1, 10000]', () => {
    fc.assert(
      fc.property(invalidIntegerMaxOrderQtyArb, (badQty) => {
        const result = updateShopProductSchema.safeParse({
          max_order_qty: badQty,
        })
        expect(result.success).toBe(false)
        const paths = result.error.issues.map((i) => i.path.join('.'))
        expect(paths).toContain('max_order_qty')
      }),
      { numRuns: 100 }
    )
  })

  it('updateShopProductSchema accepts every integer max_order_qty in [1, 10000]', () => {
    fc.assert(
      fc.property(validMaxOrderQtyArb, (goodQty) => {
        const result = updateShopProductSchema.safeParse({
          max_order_qty: goodQty,
        })
        expect(result.success).toBe(true)
        expect(result.data.max_order_qty).toBe(goodQty)
      }),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 13.B — Cart-side helper: qty > M is rejected, qty ≤ M is accepted
// ═══════════════════════════════════════════════════════════════
describe('Property 13: Quantity Limit Enforcement — request-time check (Req 5.4, 12.2, 12.3)', () => {
  it('rejects every requestedQty greater than max_order_qty with MAX_QTY_EXCEEDED', () => {
    fc.assert(
      fc.property(
        validMaxOrderQtyArb,
        requestedQtyArb,
        (maxOrderQty, requestedQty) => {
          fc.pre(requestedQty > maxOrderQty)
          const result = validateRequestedQty({ requestedQty, maxOrderQty })
          expect(result.ok).toBe(false)
          expect(result.code).toBe('MAX_QTY_EXCEEDED')
          expect(result.max).toBe(maxOrderQty)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('accepts every requestedQty in [1, max_order_qty]', () => {
    fc.assert(
      fc.property(
        validMaxOrderQtyArb.chain((maxOrderQty) =>
          fc.record({
            maxOrderQty: fc.constant(maxOrderQty),
            requestedQty: fc.integer({ min: 1, max: maxOrderQty }),
          })
        ),
        ({ maxOrderQty, requestedQty }) => {
          const result = validateRequestedQty({ requestedQty, maxOrderQty })
          expect(result.ok).toBe(true)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('boundary: requestedQty === max_order_qty is accepted; requestedQty === max_order_qty + 1 is rejected', () => {
    fc.assert(
      fc.property(validMaxOrderQtyArb, (maxOrderQty) => {
        const atLimit = validateRequestedQty({
          requestedQty: maxOrderQty,
          maxOrderQty,
        })
        expect(atLimit.ok).toBe(true)

        const overLimit = validateRequestedQty({
          requestedQty: maxOrderQty + 1,
          maxOrderQty,
        })
        expect(overLimit.ok).toBe(false)
        expect(overLimit.code).toBe('MAX_QTY_EXCEEDED')
        expect(overLimit.max).toBe(maxOrderQty)
      }),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 13.C — Stock updates never mutate max_order_qty
// ═══════════════════════════════════════════════════════════════
// max_order_qty constrains ORDER quantities, not stock. Therefore stock
// writes must never bypass it by silently overwriting the column.
//
// We assert this on two surfaces:
//   1. The stockUpdateSchema does not surface a max_order_qty field on its
//      parsed output, so it cannot be propagated downstream from a stock
//      write payload.
//   2. The repository SQL for stock writes does not reference
//      max_order_qty in its SET clause.
describe('Property 13: Quantity Limit Enforcement — stock updates preserve max_order_qty', () => {
  it('stockUpdateSchema strips any max_order_qty key from a stock-write payload', () => {
    fc.assert(
      fc.property(
        // Either an absolute set or a delta — both legitimate stock-update modes.
        fc.oneof(
          fc.record({
            stock_quantity: fc.integer({ min: 0, max: 1_000_000 }),
          }),
          fc.record({
            delta: fc.integer({ min: -1000, max: 1000 }),
          })
        ),
        // Any value the caller might attempt to smuggle in.
        fc.oneof(
          fc.integer({ min: 1, max: MAX_ORDER_QTY_MAX }),
          fc.integer({ min: -1000, max: 0 }),
          fc.integer({ min: MAX_ORDER_QTY_MAX + 1, max: 1_000_000 })
        ),
        (basePayload, smuggledMaxQty) => {
          // Zod strips unknown keys silently by default; the meaningful
          // assertion is therefore that the parsed result NEVER carries a
          // max_order_qty field. Anything downstream that consumes
          // result.data has no way to mutate the column from this surface.
          const result = stockUpdateSchema.safeParse({
            ...basePayload,
            max_order_qty: smuggledMaxQty,
          })
          expect(result.success).toBe(true)
          expect(result.data).not.toHaveProperty('max_order_qty')
        }
      ),
      { numRuns: 100 }
    )
  })

  it('repository applyStockUpdate SQL never writes to max_order_qty for any input', async () => {
    // Capture the SQL text issued by applyStockUpdate. Property: regardless
    // of the new stock quantity, the SET clause never references
    // max_order_qty. This is an invariant of the implementation, and it is
    // what the cart-side checks in task 6.2 will rely on.
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // shop_product id
        fc.uuid(), // shop_id
        fc.integer({ min: 0, max: 1_000_000 }), // newStockQuantity
        async (id, shopId, newStock) => {
          let capturedSql = null
          let capturedParams = null
          const fakeClient = {
            query: async (sql, params) => {
              capturedSql = sql
              capturedParams = params
              return {
                rows: [{ id, shop_id: shopId, stock_quantity: newStock }],
              }
            },
          }
          const repo = new ShopProductsRepository()
          await repo.applyStockUpdate(fakeClient, id, shopId, newStock)

          expect(capturedSql).toBeTruthy()

          // The SET clause must not assign max_order_qty.
          const setMatch = capturedSql
            .replace(/\s+/g, ' ')
            .match(/SET\s+(.*?)\s+WHERE/i)
          expect(setMatch).not.toBeNull()
          expect(setMatch[1].toLowerCase()).not.toContain('max_order_qty')

          // Defensive: stock value reaches SQL only via $1; never inlined.
          expect(capturedParams[0]).toBe(newStock)
        }
      ),
      { numRuns: 100 }
    )
  })
})
