// Feature: multi-vendor-system, Property 4: Stock Non-Negativity
// **Validates: Requirements 3.5, 3.8, 11.7**
//
// Property:
//   For any Shop_Product with stock S, concurrent deductions totaling > S must
//   result in stock >= 0 with at least one failure. The platform must use
//   SELECT...FOR UPDATE row-level locking so stock_quantity can never become
//   negative, and the service-side guard must surface a friendly error code
//   (INSUFFICIENT_STOCK for delta-based requests, NEGATIVE_STOCK for absolute
//   negative inputs).
//
// Approach:
//   This file uses two complementary properties:
//     A. Pure guard property — for any (prevStock, delta) pair, the service
//        either returns INSUFFICIENT_STOCK (when delta < -prev) or succeeds
//        with newStock = prev + delta. Absolute negatives are rejected with
//        NEGATIVE_STOCK. The post-state always satisfies newStock >= 0.
//     B. Concurrent-deductions simulator — multiple deduction requests are
//        serialized through a fake pg client that simulates SELECT FOR UPDATE
//        by handing out the latest row to one caller at a time. Total deltas
//        sum to > S, so at least one must fail with INSUFFICIENT_STOCK, and
//        the final stock must remain >= 0.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'

// ─── Mock external dependencies BEFORE importing service ────
// The stock-update flow only depends on:
//   - getClient()        → we hand out fake pg clients per test
//   - cacheDeletePattern → no-op (fired post-commit)
//   - logger             → silent
// No real Postgres or Redis is touched.
vi.mock('../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
}))

// vi.mock() is hoisted above imports — use vi.hoisted to share the mock
// instance with the test body so we can reconfigure getClient per scenario.
const databaseMock = vi.hoisted(() => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))
vi.mock('../../src/config/database.js', () => databaseMock)

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// Stub BullMQ + Socket.IO so importing the service doesn't open Redis
// connections or fail on missing env vars (task 13.1 wires post-commit
// fan-out through these modules; the property under test here is the
// in-tx stock guard, so we mute the side-effect path entirely).
vi.mock('../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn().mockResolvedValue(undefined) },
  stockNotificationsQueue: { add: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('../../src/plugins/socketio.plugin.js', () => ({
  getSocketIo: vi.fn().mockReturnValue(null),
}))

import { ShopProductsService } from '../../src/modules/shop-products/shop-products.service.js'
import { ShopProductsRepository } from '../../src/modules/shop-products/shop-products.repository.js'

// ─── Test helpers ──────────────────────────────────────────

const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const PRODUCT_ID = '22222222-2222-2222-2222-222222222222'
const ACTOR = { id: 'actor-uuid', role: 'ADMIN', shopRole: null }

/**
 * Build a fake pg.PoolClient backed by an in-memory shop_product row.
 * Recognises the SQL fragments used by the repository:
 *   BEGIN / COMMIT / ROLLBACK
 *   SELECT … FOR UPDATE          → returns the current row snapshot
 *   UPDATE shop_products SET …   → applies the new stock_quantity & flags
 *
 * For single-actor tests the row is private to one client. For the
 * concurrent-deduction simulator we share state via the per-call factory
 * inside the test itself.
 *
 * @param {{ id: string, stock_quantity: number, is_available: boolean }} initialRow
 */
function makeFakeClient(initialRow) {
  let row = { ...initialRow, deleted_at: null, sold_out_at: null }

  return {
    snapshot() {
      return { ...row }
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

/**
 * Tiny FIFO async mutex. acquire() resolves to a release function once the
 * caller has the lock. Used to simulate row-level FOR UPDATE serialisation
 * across multiple "connections" in the concurrent simulator.
 */
function makeMutex() {
  const queue = []
  let locked = false
  return {
    async acquire() {
      if (!locked) {
        locked = true
        return function release() {
          if (queue.length === 0) {
            locked = false
            return
          }
          const next = queue.shift()
          next()
        }
      }
      return new Promise((resolve) => {
        queue.push(() => {
          resolve(function release() {
            if (queue.length === 0) {
              locked = false
              return
            }
            const next = queue.shift()
            next()
          })
        })
      })
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════
// Property 4A — Pure guard property on a single deduction
// ═══════════════════════════════════════════════════════════════
describe('Property 4: Stock Non-Negativity — single update guard', () => {
  it('delta < -prev is rejected with INSUFFICIENT_STOCK and stock is unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1000 }), // prev stock
        fc.integer({ min: 1, max: 5000 }), // overdraw amount
        async (prev, overdraw) => {
          const delta = -(prev + overdraw) // strictly more than prev
          const initialRow = {
            id: 'sp-uuid',
            shop_id: SHOP_ID,
            product_id: PRODUCT_ID,
            stock_quantity: prev,
            is_available: prev > 0,
          }
          const client = makeFakeClient(initialRow)
          databaseMock.getClient.mockResolvedValue(client)

          const service = new ShopProductsService(new ShopProductsRepository())
          const res = await service.updateStock(
            SHOP_ID,
            'sp-uuid',
            { delta },
            ACTOR
          )

          expect(res.success).toBe(false)
          expect(res.code).toBe('INSUFFICIENT_STOCK')
          // Row unchanged (transaction rolled back).
          expect(client.snapshot().stock_quantity).toBe(prev)
          // Final stock is non-negative.
          expect(client.snapshot().stock_quantity).toBeGreaterThanOrEqual(0)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('valid delta within range succeeds and stock = prev + delta', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        async (prev, delta) => {
          fc.pre(prev + delta >= 0) // precondition: result is non-negative

          const initialRow = {
            id: 'sp-uuid',
            shop_id: SHOP_ID,
            product_id: PRODUCT_ID,
            stock_quantity: prev,
            is_available: prev > 0,
          }
          const client = makeFakeClient(initialRow)
          databaseMock.getClient.mockResolvedValue(client)

          const service = new ShopProductsService(new ShopProductsRepository())
          const res = await service.updateStock(
            SHOP_ID,
            'sp-uuid',
            { delta },
            ACTOR
          )

          expect(res.success).toBe(true)
          expect(res.data.stock_quantity).toBe(prev + delta)
          expect(res.data.stock_quantity).toBeGreaterThanOrEqual(0)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('absolute negative stock_quantity is rejected with NEGATIVE_STOCK', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1000 }), // prev
        fc.integer({ min: -10000, max: -1 }), // negative absolute set
        async (prev, negVal) => {
          const initialRow = {
            id: 'sp-uuid',
            shop_id: SHOP_ID,
            product_id: PRODUCT_ID,
            stock_quantity: prev,
            is_available: prev > 0,
          }
          const client = makeFakeClient(initialRow)
          databaseMock.getClient.mockResolvedValue(client)

          const service = new ShopProductsService(new ShopProductsRepository())
          const res = await service.updateStock(
            SHOP_ID,
            'sp-uuid',
            { stock_quantity: negVal },
            ACTOR
          )

          expect(res.success).toBe(false)
          expect(res.code).toBe('NEGATIVE_STOCK')
          // Row unchanged.
          expect(client.snapshot().stock_quantity).toBe(prev)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('absolute non-negative stock_quantity succeeds and result equals input', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1000 }), // prev
        fc.integer({ min: 0, max: 5000 }), // absolute set value
        async (prev, newVal) => {
          const initialRow = {
            id: 'sp-uuid',
            shop_id: SHOP_ID,
            product_id: PRODUCT_ID,
            stock_quantity: prev,
            is_available: prev > 0,
          }
          const client = makeFakeClient(initialRow)
          databaseMock.getClient.mockResolvedValue(client)

          const service = new ShopProductsService(new ShopProductsRepository())
          const res = await service.updateStock(
            SHOP_ID,
            'sp-uuid',
            { stock_quantity: newVal },
            ACTOR
          )

          expect(res.success).toBe(true)
          expect(res.data.stock_quantity).toBe(newVal)
          expect(res.data.stock_quantity).toBeGreaterThanOrEqual(0)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 4B — Concurrent deductions simulator
// ═══════════════════════════════════════════════════════════════
describe('Property 4: Stock Non-Negativity — concurrent deductions simulator', () => {
  it('with deltas summing to > S, at least one fails and final stock >= 0', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1000 }), // S — starting stock
        fc.array(fc.integer({ min: 1, max: 200 }), {
          minLength: 2,
          maxLength: 12,
        }),
        async (S, rawMagnitudes) => {
          // Ensure total deduction strictly exceeds S so at least one MUST
          // fail. If random sum is too small, pad the last element.
          const magnitudes = [...rawMagnitudes]
          const totalSoFar = magnitudes.reduce((a, b) => a + b, 0)
          if (totalSoFar <= S) {
            magnitudes[magnitudes.length - 1] += S - totalSoFar + 1
          }

          // Single source of truth for the row, shared across all "clients".
          const sharedState = {
            row: {
              id: 'sp-uuid',
              shop_id: SHOP_ID,
              product_id: PRODUCT_ID,
              stock_quantity: S,
              is_available: S > 0,
              sold_out_at: null,
              deleted_at: null,
            },
          }
          const mutex = makeMutex()

          // Each call to getClient() returns a fresh wrapper that shares the
          // same backing state via the mutex. This simulates many DB
          // connections all pointing at the same row, with FOR UPDATE
          // serialising writers.
          databaseMock.getClient.mockImplementation(async () => {
            let myRelease = null
            return {
              async query(sql, params) {
                const text = typeof sql === 'string' ? sql : sql?.text || ''

                if (/BEGIN/i.test(text)) {
                  myRelease = await mutex.acquire()
                  return { rows: [], rowCount: 0 }
                }
                if (/COMMIT|ROLLBACK/i.test(text)) {
                  if (myRelease) {
                    const r = myRelease
                    myRelease = null
                    r()
                  }
                  return { rows: [], rowCount: 0 }
                }
                if (/FOR UPDATE/i.test(text)) {
                  if (sharedState.row.deleted_at)
                    return { rows: [], rowCount: 0 }
                  return { rows: [{ ...sharedState.row }], rowCount: 1 }
                }
                if (/^\s*UPDATE shop_products/i.test(text)) {
                  const [newQty] = params
                  const prevQty = sharedState.row.stock_quantity
                  const newAvailable =
                    newQty === 0
                      ? false
                      : prevQty === 0 && newQty > 0
                        ? true
                        : sharedState.row.is_available
                  const newSoldOutAt =
                    newQty === 0
                      ? new Date()
                      : prevQty === 0 && newQty > 0
                        ? null
                        : sharedState.row.sold_out_at || null
                  sharedState.row = {
                    ...sharedState.row,
                    stock_quantity: newQty,
                    is_available: newAvailable,
                    sold_out_at: newSoldOutAt,
                    updated_at: new Date(),
                  }
                  return {
                    rows: [{ ...sharedState.row }],
                    rowCount: 1,
                  }
                }
                return { rows: [], rowCount: 0 }
              },
              release: () => {
                if (myRelease) {
                  const r = myRelease
                  myRelease = null
                  r()
                }
              },
            }
          })

          const service = new ShopProductsService(
            new ShopProductsRepository()
          )

          // Fire all deductions "concurrently" — Promise.all + the mutex
          // models real overlapping connections.
          const results = await Promise.all(
            magnitudes.map((mag) =>
              service.updateStock(
                SHOP_ID,
                'sp-uuid',
                { delta: -mag },
                ACTOR
              )
            )
          )

          const failures = results.filter((r) => !r.success)
          const successIndices = results
            .map((r, i) => (r.success ? i : -1))
            .filter((i) => i >= 0)
          const successfulDeducted = successIndices.reduce(
            (sum, i) => sum + magnitudes[i],
            0
          )

          // 1. At least one deduction failed (total > S).
          expect(failures.length).toBeGreaterThanOrEqual(1)
          // 2. Every failure must be INSUFFICIENT_STOCK (delta-driven path).
          for (const f of failures) {
            expect(f.code).toBe('INSUFFICIENT_STOCK')
          }
          // 3. Final stock is non-negative.
          expect(sharedState.row.stock_quantity).toBeGreaterThanOrEqual(0)
          // 4. Final stock equals S - (sum of successful deduction magnitudes).
          expect(sharedState.row.stock_quantity).toBe(S - successfulDeducted)
          // 5. Successful deductions never exceeded S.
          expect(successfulDeducted).toBeLessThanOrEqual(S)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('a single deduction equal to S succeeds and drives stock to 0 (is_available=false)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1000 }), async (S) => {
        const initialRow = {
          id: 'sp-uuid',
          shop_id: SHOP_ID,
          product_id: PRODUCT_ID,
          stock_quantity: S,
          is_available: true,
        }
        const client = makeFakeClient(initialRow)
        databaseMock.getClient.mockResolvedValue(client)

        const service = new ShopProductsService(new ShopProductsRepository())
        const res = await service.updateStock(
          SHOP_ID,
          'sp-uuid',
          { delta: -S },
          ACTOR
        )

        expect(res.success).toBe(true)
        expect(res.data.stock_quantity).toBe(0)
        expect(res.data.is_available).toBe(false)
        expect(res.data.sold_out_at).toBeInstanceOf(Date)
      }),
      { numRuns: 50 }
    )
  })
})
