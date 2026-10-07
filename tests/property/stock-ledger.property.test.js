// Task 6.11 — Stock Ledger Summation Property
// **Property:** For any sequence of stock changes, Σ quantity_delta ==
// final stock_quantity − initial stock_quantity; stock never goes below zero.
//
// This property test exercises the ShopProductsService.updateStock path
// with sequences of delta-based stock changes and verifies:
//   6.11.A — The sum of all successful deltas equals (final - initial) stock.
//   6.11.B — Stock never goes below zero at any point in the sequence.
//   6.11.C — Failed deltas (INSUFFICIENT_STOCK) do not alter the running total.
//
// Approach:
//   We mock the pg client (same pattern as stock-non-negativity tests) and
//   drive arbitrary sequences of positive/negative deltas through the real
//   service. After each operation we record the stock state and verify the
//   summation invariant holds.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'

// ─── Mock external dependencies BEFORE importing service ────
vi.mock('../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
}))

const databaseMock = vi.hoisted(() => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))
vi.mock('../../src/config/database.js', () => databaseMock)

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn().mockResolvedValue(undefined) },
  stockNotificationsQueue: { add: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('../../src/plugins/socketio.plugin.js', () => ({
  getSocketIo: vi.fn().mockReturnValue(null),
}))

import { ShopProductsService } from '../../src/modules/shop-products/shop-products.service.js'
import { ShopProductsRepository } from '../../src/modules/shop-products/shop-products.repository.js'

// ─── Test fixtures ──────────────────────────────────────────
const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const PRODUCT_ID = '22222222-2222-2222-2222-222222222222'
const ACTOR = { id: 'actor-uuid', role: 'ADMIN', shopRole: null }

// ─── Seed for reproducibility ─────────────────────────────────
const SEED = 20240611
const NUM_RUNS = 100

/**
 * Build a fake pg client backed by an in-memory shop_product row.
 */
function makeFakeClient(initialStock) {
  let row = {
    id: 'sp-uuid',
    shop_id: SHOP_ID,
    product_id: PRODUCT_ID,
    stock_quantity: initialStock,
    is_available: initialStock > 0,
    deleted_at: null,
    sold_out_at: null,
  }

  return {
    getStock() {
      return row.stock_quantity
    },
    async query(sql, params) {
      const text = typeof sql === 'string' ? sql : sql?.text || ''

      if (/BEGIN|COMMIT|ROLLBACK/i.test(text)) {
        return { rows: [], rowCount: 0 }
      }

      if (/FOR UPDATE/i.test(text)) {
        if (row.deleted_at) return { rows: [], rowCount: 0 }
        return { rows: [{ ...row }], rowCount: 1 }
      }

      if (/^\s*UPDATE shop_products/i.test(text)) {
        const [newQty] = params
        const prevQty = row.stock_quantity
        const newAvailable =
          newQty === 0
            ? false
            : prevQty === 0 && newQty > 0
              ? true
              : row.is_available
        const newSoldOutAt =
          newQty === 0
            ? new Date()
            : prevQty === 0 && newQty > 0
              ? null
              : row.sold_out_at || null
        row = {
          ...row,
          stock_quantity: newQty,
          is_available: newAvailable,
          sold_out_at: newSoldOutAt,
          updated_at: new Date(),
        }
        return { rows: [{ ...row }], rowCount: 1 }
      }

      return { rows: [], rowCount: 0 }
    },
    release: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════
// Property 6.11.A — Σ successful deltas == final − initial
// ═══════════════════════════════════════════════════════════════
describe('Property 6.11: Stock Ledger Summation', () => {
  it('sum of successful quantity deltas equals final stock minus initial stock', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 500 }), // initial stock
        fc.array(fc.integer({ min: -200, max: 200 }), {
          minLength: 1,
          maxLength: 20,
        }), // sequence of deltas
        async (initialStock, deltas) => {
          const client = makeFakeClient(initialStock)
          databaseMock.getClient.mockResolvedValue(client)

          const service = new ShopProductsService(new ShopProductsRepository())

          let sumSuccessfulDeltas = 0

          for (const delta of deltas) {
            if (delta === 0) continue // skip no-ops

            const res = await service.updateStock(
              SHOP_ID,
              'sp-uuid',
              { delta },
              ACTOR
            )

            if (res.success) {
              sumSuccessfulDeltas += delta
            }
          }

          const finalStock = client.getStock()

          // Core invariant: Σ successful deltas == final - initial
          expect(finalStock - initialStock).toBe(sumSuccessfulDeltas)
        }
      ),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })

  // ═══════════════════════════════════════════════════════════════
  // Property 6.11.B — Stock never goes below zero
  // ═══════════════════════════════════════════════════════════════
  it('stock never goes below zero at any point in the sequence', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 500 }),
        fc.array(fc.integer({ min: -200, max: 200 }), {
          minLength: 1,
          maxLength: 20,
        }),
        async (initialStock, deltas) => {
          const client = makeFakeClient(initialStock)
          databaseMock.getClient.mockResolvedValue(client)

          const service = new ShopProductsService(new ShopProductsRepository())

          for (const delta of deltas) {
            if (delta === 0) continue

            await service.updateStock(SHOP_ID, 'sp-uuid', { delta }, ACTOR)

            // After every operation, stock must be non-negative
            expect(client.getStock()).toBeGreaterThanOrEqual(0)
          }
        }
      ),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })

  // ═══════════════════════════════════════════════════════════════
  // Property 6.11.C — Failed deltas do not alter the running total
  // ═══════════════════════════════════════════════════════════════
  it('failed deltas (INSUFFICIENT_STOCK) leave stock unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 500 }),
        fc.array(fc.integer({ min: -200, max: 200 }), {
          minLength: 1,
          maxLength: 20,
        }),
        async (initialStock, deltas) => {
          const client = makeFakeClient(initialStock)
          databaseMock.getClient.mockResolvedValue(client)

          const service = new ShopProductsService(new ShopProductsRepository())

          for (const delta of deltas) {
            if (delta === 0) continue

            const stockBefore = client.getStock()
            const res = await service.updateStock(
              SHOP_ID,
              'sp-uuid',
              { delta },
              ACTOR
            )

            if (!res.success) {
              // Stock must be unchanged after a failed operation
              expect(client.getStock()).toBe(stockBefore)
            }
          }
        }
      ),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })
})
