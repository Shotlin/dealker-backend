/**
 * Task 23.9 — Concurrent stock deduction with SELECT FOR UPDATE prevents oversell
 *
 * Scenario: 10 concurrent orders attempt to deduct 1 unit each from a product
 * with stock_quantity = 5. Exactly 5 must succeed and 5 must be rejected with
 * STOCK_NEGATIVE_FORBIDDEN (via the service-level INSUFFICIENT_STOCK guard).
 *
 * The test uses a shared in-memory row protected by an async mutex to simulate
 * PostgreSQL's row-level FOR UPDATE lock. Each "connection" acquires the mutex
 * on BEGIN, reads the current row on SELECT FOR UPDATE, and releases on
 * COMMIT/ROLLBACK — faithfully modelling the serialisation guarantees of the
 * real database without requiring a live PostgreSQL instance.
 *
 * Requirements: R3.8, R11.7, R23.9, R23.14
 * Design:       §8.1 of .kiro/specs/multi-vendor-system/design.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external dependencies BEFORE importing service ────────────────────
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

// ─── Test helpers ───────────────────────────────────────────────────────────

const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const PRODUCT_ID = '22222222-2222-2222-2222-222222222222'
const SHOP_PRODUCT_ID = 'sp-uuid-concurrent-test'
const ACTOR = { id: 'actor-uuid', role: 'ADMIN', shopRole: null }

/**
 * Async FIFO mutex — simulates PostgreSQL row-level FOR UPDATE serialisation.
 * acquire() resolves to a release function once the caller holds the lock.
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

// ═══════════════════════════════════════════════════════════════════════════════
// Task 23.9 — 10 concurrent orders for 5 units → 5 succeed, 5 reject
// ═══════════════════════════════════════════════════════════════════════════════
describe('Task 23.9: Concurrent stock deduction — SELECT FOR UPDATE prevents oversell', () => {
  it('10 concurrent deductions of 1 unit against stock=5 → exactly 5 succeed, 5 fail', async () => {
    const INITIAL_STOCK = 5
    const CONCURRENT_ORDERS = 10
    const DEDUCTION_PER_ORDER = -1

    // Shared mutable state representing the single shop_products row
    const sharedState = {
      row: {
        id: SHOP_PRODUCT_ID,
        shop_id: SHOP_ID,
        product_id: PRODUCT_ID,
        stock_quantity: INITIAL_STOCK,
        is_available: true,
        sold_out_at: null,
        deleted_at: null,
        low_stock_threshold: 2,
        max_order_qty: 10,
        price: 100,
        sale_price: null,
        cost_price: null,
        approval_status: 'APPROVED',
        approved_at: null,
        approved_by: null,
        rejection_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    }

    const mutex = makeMutex()

    // Each getClient() call returns a fresh fake pg client that shares the
    // same backing row via the mutex — models concurrent DB connections.
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
            if (sharedState.row.deleted_at) return { rows: [], rowCount: 0 }
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
            return { rows: [{ ...sharedState.row }], rowCount: 1 }
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

    const service = new ShopProductsService(new ShopProductsRepository())

    // Fire 10 concurrent deductions via Promise.all
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_ORDERS }, () =>
        service.updateStock(SHOP_ID, SHOP_PRODUCT_ID, { delta: DEDUCTION_PER_ORDER }, ACTOR)
      )
    )

    const successes = results.filter((r) => r.success)
    const failures = results.filter((r) => !r.success)

    // Exactly 5 succeed (stock goes from 5 → 4 → 3 → 2 → 1 → 0)
    expect(successes).toHaveLength(5)

    // Exactly 5 fail with INSUFFICIENT_STOCK
    expect(failures).toHaveLength(5)
    for (const f of failures) {
      expect(f.code).toBe('INSUFFICIENT_STOCK')
    }

    // Final stock is exactly 0 (never negative)
    expect(sharedState.row.stock_quantity).toBe(0)

    // Product is marked as unavailable when stock hits 0
    expect(sharedState.row.is_available).toBe(false)
    expect(sharedState.row.sold_out_at).toBeInstanceOf(Date)
  })

  it('10 concurrent deductions of 2 units against stock=5 → at most 2 succeed, at least 8 fail', async () => {
    const INITIAL_STOCK = 5
    const CONCURRENT_ORDERS = 10
    const DEDUCTION_PER_ORDER = -2

    const sharedState = {
      row: {
        id: SHOP_PRODUCT_ID,
        shop_id: SHOP_ID,
        product_id: PRODUCT_ID,
        stock_quantity: INITIAL_STOCK,
        is_available: true,
        sold_out_at: null,
        deleted_at: null,
        low_stock_threshold: 2,
        max_order_qty: 10,
        price: 100,
        sale_price: null,
        cost_price: null,
        approval_status: 'APPROVED',
        approved_at: null,
        approved_by: null,
        rejection_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    }

    const mutex = makeMutex()

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
            if (sharedState.row.deleted_at) return { rows: [], rowCount: 0 }
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
            return { rows: [{ ...sharedState.row }], rowCount: 1 }
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

    const service = new ShopProductsService(new ShopProductsRepository())

    const results = await Promise.all(
      Array.from({ length: CONCURRENT_ORDERS }, () =>
        service.updateStock(SHOP_ID, SHOP_PRODUCT_ID, { delta: DEDUCTION_PER_ORDER }, ACTOR)
      )
    )

    const successes = results.filter((r) => r.success)
    const failures = results.filter((r) => !r.success)

    // At most floor(5/2) = 2 can succeed
    expect(successes.length).toBeLessThanOrEqual(2)

    // At least 8 must fail
    expect(failures.length).toBeGreaterThanOrEqual(8)
    for (const f of failures) {
      expect(f.code).toBe('INSUFFICIENT_STOCK')
    }

    // Final stock is non-negative
    expect(sharedState.row.stock_quantity).toBeGreaterThanOrEqual(0)

    // Final stock = INITIAL_STOCK - (successes * 2)
    expect(sharedState.row.stock_quantity).toBe(INITIAL_STOCK - successes.length * 2)
  })
})
