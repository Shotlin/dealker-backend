// Task 24.1 — Aggregate Property Test Runner
//
// Executes the four core property tests from tasks 2.8, 6.11, 8.12, 9.7
// with seeded random inputs (default 100 iterations each).
//
// Run ONLY this aggregate runner:
//   npx vitest run tests/property/aggregate-runner.test.js
//
// Run ALL property tests (includes the individual files too):
//   npx vitest run tests/property/
//
// Run with a custom seed (override via environment variable):
//   PROPERTY_SEED=42 npx vitest run tests/property/aggregate-runner.test.js
//
// Each property uses fast-check with a fixed seed for reproducibility.
// The runner imports the pure functions under test and re-asserts the
// core invariant from each task in a single consolidated test suite.
//
// Properties aggregated:
//   2.8  — Permission Set Vocabulary: effective set ⊆ 37-value vocabulary
//   6.11 — Stock Ledger Summation: Σ deltas == final − initial, stock ≥ 0
//   8.12 — Financial Ledger: balance = Σ(CREDIT) − Σ(DEBIT), no UPDATE/DELETE
//   9.7  — Coupon Distribution: Σ shop discounts === totalDiscount (sum-preserving)
//
// Configuration:
//   - Seed: deterministic (PROPERTY_SEED env or 20241201)
//   - Iterations: 100 per property (configurable via PROPERTY_ITERATIONS env)
//   - Timeout: 30s per test (vitest.config.js testTimeout)

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'

// ─── Configuration ────────────────────────────────────────────
const NUM_RUNS = parseInt(process.env.PROPERTY_ITERATIONS || '100', 10)
const SEED = parseInt(process.env.PROPERTY_SEED || '20241201', 10)

// ═══════════════════════════════════════════════════════════════
// SETUP: Mock shared dependencies (needed by all property modules)
// ═══════════════════════════════════════════════════════════════
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
  allocationQueue: { add: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('../../src/plugins/socketio.plugin.js', () => ({
  getSocketIo: vi.fn().mockReturnValue(null),
}))

// ─── Import SUTs ──────────────────────────────────────────────
import {
  computeEffectivePermissions,
  partitionShopPermissions,
} from '../../src/middlewares/permission-check.js'
import {
  PERMISSIONS,
  HQ_ROLES,
  HQ_ROLE_PERMISSIONS,
} from '../../src/utils/permissions.js'
import { ShopProductsService } from '../../src/modules/shop-products/shop-products.service.js'
import { ShopProductsRepository } from '../../src/modules/shop-products/shop-products.repository.js'
import {
  LedgerWriteService,
  __internals,
} from '../../src/modules/shop-transactions/shop-transactions.service.js'
import {
  CREDIT_TYPES,
  DEBIT_TYPES,
  TRANSACTION_TYPES,
} from '../../src/modules/shop-transactions/shop-transactions.schema.js'
import { CouponsService } from '../../src/modules/coupons/coupons.service.js'

const { toCents, fromCents } = __internals

// ─── Shared fixtures ──────────────────────────────────────────
const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const ORDER_ID = '22222222-2222-2222-2222-222222222222'
const ACTOR = { id: 'actor-uuid', role: 'ADMIN', shopRole: null }

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════
// 2.8 — Permission Set Vocabulary
// ═══════════════════════════════════════════════════════════════
describe('[2.8] Permission Set Vocabulary — effective set ⊆ 37-value vocabulary', () => {
  const VOCAB_ARRAY = Array.from(PERMISSIONS)
  const validPermArb = fc.constantFrom(...VOCAB_ARRAY)
  const invalidPermArb = fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !PERMISSIONS.has(s))
  const garbageArb = fc.oneof(fc.integer(), fc.constant(null), fc.constant(undefined), fc.boolean())
  const mixedPermissionsArb = fc.array(
    fc.oneof(validPermArb, invalidPermArb, garbageArb),
    { minLength: 0, maxLength: 50 }
  )
  const hqRoleArb = fc.constantFrom(...HQ_ROLES)

  it('HQ users: every effective permission is in the canonical vocabulary', () => {
    fc.assert(
      fc.property(hqRoleArb, (role) => {
        const effective = computeEffectivePermissions({ platform_role: role })
        for (const perm of effective) {
          expect(PERMISSIONS.has(perm)).toBe(true)
        }
      }),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })

  it('shop staff with arbitrary JWT permissions: effective set ⊆ vocabulary', () => {
    fc.assert(
      fc.property(mixedPermissionsArb, (permissions) => {
        const effective = computeEffectivePermissions({ permissions })
        for (const perm of effective) {
          expect(typeof perm).toBe('string')
          expect(PERMISSIONS.has(perm)).toBe(true)
        }
      }),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// 6.11 — Stock Ledger Summation
// ═══════════════════════════════════════════════════════════════
describe('[6.11] Stock Ledger Summation — Σ deltas == final − initial; stock ≥ 0', () => {
  function makeFakeStockClient(initialStock) {
    let row = {
      id: 'sp-uuid',
      shop_id: SHOP_ID,
      product_id: '22222222-2222-2222-2222-222222222222',
      stock_quantity: initialStock,
      is_available: initialStock > 0,
      deleted_at: null,
      sold_out_at: null,
    }
    return {
      getStock() { return row.stock_quantity },
      async query(sql, params) {
        const text = typeof sql === 'string' ? sql : sql?.text || ''
        if (/BEGIN|COMMIT|ROLLBACK/i.test(text)) return { rows: [], rowCount: 0 }
        if (/FOR UPDATE/i.test(text)) {
          if (row.deleted_at) return { rows: [], rowCount: 0 }
          return { rows: [{ ...row }], rowCount: 1 }
        }
        if (/^\s*UPDATE shop_products/i.test(text)) {
          const [newQty] = params
          row = { ...row, stock_quantity: newQty, is_available: newQty > 0, updated_at: new Date() }
          return { rows: [{ ...row }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
      release: vi.fn(),
    }
  }

  it('Σ successful deltas == final stock − initial stock; stock never negative', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 500 }),
        fc.array(fc.integer({ min: -200, max: 200 }), { minLength: 1, maxLength: 20 }),
        async (initialStock, deltas) => {
          const client = makeFakeStockClient(initialStock)
          databaseMock.getClient.mockResolvedValue(client)
          const service = new ShopProductsService(new ShopProductsRepository())

          let sumSuccessful = 0
          for (const delta of deltas) {
            if (delta === 0) continue
            const res = await service.updateStock(SHOP_ID, 'sp-uuid', { delta }, ACTOR)
            if (res.success) sumSuccessful += delta
            // Stock never negative
            expect(client.getStock()).toBeGreaterThanOrEqual(0)
          }
          // Summation invariant
          expect(client.getStock() - initialStock).toBe(sumSuccessful)
        }
      ),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// 8.12 — Financial Ledger Balance + Immutability
// ═══════════════════════════════════════════════════════════════
describe('[8.12] Financial Ledger — balance = Σ(CREDIT) − Σ(DEBIT); no UPDATE/DELETE', () => {
  const transactionTypeArb = fc.constantFrom(...TRANSACTION_TYPES)
  const amountCentsArb = fc.integer({ min: 1, max: 100_000 })
  const sequenceArb = fc.array(
    fc.record({ type: transactionTypeArb, amountCents: amountCentsArb }),
    { minLength: 1, maxLength: 20 }
  )

  function referenceTypeFor(type) {
    if (type === 'PAYOUT_CREDIT') return 'PAYOUT'
    if (type === 'ADJUSTMENT') return 'ADJUSTMENT'
    if (type === 'EXPENSE') return 'EXPENSE'
    return 'ORDER'
  }

  function makeRepoMock() {
    const rows = []
    let prev = null
    return {
      rows,
      lockLatestForShop: vi.fn(async () => prev),
      insertEntry: vi.fn(async (_client, row) => {
        const inserted = { id: `tx-${rows.length}`, ...row }
        rows.push(JSON.stringify(inserted))
        prev = { balance_after: row.balance_after }
        return inserted
      }),
      findById: vi.fn(),
      findManyByShop: vi.fn(),
      findCurrentBalance: vi.fn(),
    }
  }

  it('balance after N inserts = Σ(CREDIT) − Σ(DEBIT); rows never modified', async () => {
    await fc.assert(
      fc.asyncProperty(sequenceArb, async (steps) => {
        const repo = makeRepoMock()
        const writer = new LedgerWriteService(repo)
        const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }

        let lastInserted = null
        for (const { type, amountCents } of steps) {
          lastInserted = await writer.append(client, {
            shopId: SHOP_ID,
            type,
            amount: Number(fromCents(amountCents)),
            referenceType: referenceTypeFor(type),
            referenceId: ORDER_ID,
          })
        }

        // Balance invariant
        let expectedCents = 0
        for (const { type, amountCents } of steps) {
          if (CREDIT_TYPES.has(type)) expectedCents += amountCents
          else if (DEBIT_TYPES.has(type)) expectedCents -= amountCents
        }
        expect(toCents(lastInserted.balance_after)).toBe(expectedCents)

        // Immutability: row count == steps, no row modified
        expect(repo.rows.length).toBe(steps.length)
      }),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// 9.7 — Coupon Distribution Sum-Preserving Rounding
// ═══════════════════════════════════════════════════════════════
describe('[9.7] Coupon Distribution — Σ shop discounts === totalDiscount', () => {
  const cartItemArb = fc.record({
    productId: fc.uuid(),
    categoryId: fc.uuid(),
    price: fc.integer({ min: 1, max: 5000 }),
    qty: fc.integer({ min: 1, max: 10 }),
  })
  const shopGroupArb = fc.record({
    shopId: fc.uuid(),
    items: fc.array(cartItemArb, { minLength: 1, maxLength: 8 }),
    deliveryFee: fc.integer({ min: 0, max: 100 }),
  })
  const multiShopCartArb = fc.record({
    shopGroups: fc.array(shopGroupArb, { minLength: 1, maxLength: 6 }),
  })
  const platformCouponArb = fc.oneof(
    fc.record({
      couponType: fc.constant('PLATFORM_COUPON'),
      discountType: fc.constant('PERCENTAGE'),
      discountValue: fc.integer({ min: 1, max: 100 }),
      maxDiscount: fc.option(fc.integer({ min: 1, max: 10000 }), { nil: null }),
    }),
    fc.record({
      couponType: fc.constant('PLATFORM_COUPON'),
      discountType: fc.constant('FLAT'),
      discountValue: fc.integer({ min: 1, max: 5000 }),
      maxDiscount: fc.constant(null),
    })
  )

  const couponService = new CouponsService({})

  it('sum of distributed shop discounts equals totalDiscount (sum-preserving rounding)', () => {
    fc.assert(
      fc.property(multiShopCartArb, platformCouponArb, (cart, coupon) => {
        const result = couponService.applyCouponToCart(cart, coupon)
        const sumShop = result.shopDiscounts.reduce((s, sd) => s + sd.discount, 0)
        expect(parseFloat(sumShop.toFixed(2))).toBe(parseFloat(result.totalDiscount.toFixed(2)))
        // Each discount non-negative
        for (const sd of result.shopDiscounts) {
          expect(sd.discount).toBeGreaterThanOrEqual(0)
        }
      }),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })
})
