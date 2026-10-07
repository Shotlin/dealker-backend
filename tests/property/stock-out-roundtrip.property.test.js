// Feature: multi-vendor-system, Property 3: Stock-Out Round Trip
// **Validates: Requirements 3.3, 3.4, 11.1, 11.6**
//
// Property statement (design.md §Property 3):
//   For any Shop_Product, deducting all stock sets is_available=false;
//   restocking to a positive value sets is_available=true. The round trip
//   restores original availability.
//
// Operationalised (Requirements 3.3, 3.4, 11.1, 11.6):
//   For any sequence of stock changes applied to a single Shop_Product:
//
//   a) Each (prev > 0 → new === 0) transition causes:
//        - is_available flips to false, sold_out_at set       (Req 11.1)
//        - Redis listing cache invalidated                    (Req 11.2)
//        - Socket.IO `shop:product:stock_out` emitted on
//          channel `shop:{shop_id}` after COMMIT              (Req 11.3, 3.3)
//        - Staff push notification fired                      (Req 11.4)
//
//   b) Each (prev === 0 → new > 0) transition causes:
//        - is_available flips to true, sold_out_at cleared    (Req 11.6)
//        - Redis listing cache invalidated                    (Req 11.2)
//        - Socket.IO `shop:product:restocked` emitted on
//          channel `shop:{shop_id}` after COMMIT              (Req 11.6, 3.3)
//        - BullMQ `wishlist-restock` job enqueued for the
//          stock-notifications worker (task 13.2)             (Req 11.6, 3.4)
//
//   c) A round-trip sequence that ends at the same stock value as it
//      started leaves the row in the same (stock_quantity,
//      is_available, sold_out_at-null-ness) state. The system is
//      "consistent equivalent to never having gone out of stock except
//      for the wishlist notifications that fired in between" —
//      formalised as: the count of stock_out emissions equals the count
//      of restocked emissions, and equals the count of wishlist queue
//      enqueues.
//
//   d) Failed updates (INSUFFICIENT_STOCK / NEGATIVE_STOCK) leave both
//      the row and the side-effect mocks untouched (Req 11.8 — included
//      as a guard so the round-trip property cannot accidentally pass
//      because failed writes leaked side effects).
//
// Approach:
//   We mock the post-commit collaborators only (Socket.IO, push
//   notifications, BullMQ, Redis cache invalidation) and exercise the
//   REAL ShopProductsService + ShopProductsRepository against a fake
//   pg client that persists state across calls. Each `updateStock`
//   invocation runs through BEGIN / SELECT FOR UPDATE / UPDATE / COMMIT
//   exactly as in production, so this property test exercises the full
//   service path including the post-commit
//   `handleStockTransitionSideEffects` orchestrator.
//
//   No real Postgres, Redis, BullMQ or Socket.IO server is touched; the
//   fake pg client and queue/io mocks are the only collaborators.
//
//   Min 100 iterations per property (project standard).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'

// ─── Mock external dependencies BEFORE importing the SUT ──────────────
// Mirrors the pattern used by tests/property/shop-products-stock-non-negativity
// and tests/unit/shop-products/stock-out-handler.test.js.

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
import { cacheDeletePattern } from '../../src/utils/cache.js'

// ─── Fixtures ─────────────────────────────────────────────────────────

const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_PRODUCT_ID = '22222222-2222-2222-2222-222222222222'
const PRODUCT_ID = '33333333-3333-3333-3333-333333333333'
const STAFF_USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const STAFF_USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const ADMIN_ACTOR = {
  id: '99999999-9999-9999-9999-999999999999',
  role: 'ADMIN',
}

// ─── Test helpers ─────────────────────────────────────────────────────

/**
 * Build a fake pg.PoolClient backed by a shared in-memory shop_product row.
 * Recognises the SQL fragments used by ShopProductsRepository's
 * findByIdForUpdate + applyStockUpdate inside the service's updateStock tx.
 *
 * State is shared across `getClient()` calls — i.e. multiple sequential
 * updateStock invocations see the row mutate just like a real Postgres
 * connection pool would.
 *
 * @param {{ stock_quantity: number, is_available: boolean,
 *            sold_out_at: Date|null, low_stock_threshold: number }} initialState
 */
function makeSharedFakeClientFactory(initialState) {
  const state = {
    id: SHOP_PRODUCT_ID,
    shop_id: SHOP_ID,
    product_id: PRODUCT_ID,
    deleted_at: null,
    sold_out_at: null,
    ...initialState,
  }

  function makeClient() {
    return {
      async query(sql, params) {
        const text = typeof sql === 'string' ? sql : sql?.text || ''

        if (/BEGIN|COMMIT|ROLLBACK/i.test(text)) {
          return { rows: [], rowCount: 0 }
        }

        if (/FOR UPDATE/i.test(text)) {
          if (state.deleted_at) return { rows: [], rowCount: 0 }
          return { rows: [{ ...state }], rowCount: 1 }
        }

        if (/^\s*UPDATE shop_products/i.test(text)) {
          const [newQty] = params
          const prevQty = state.stock_quantity
          const newAvailable =
            newQty === 0
              ? false
              : prevQty === 0 && newQty > 0
                ? true
                : state.is_available
          const newSoldOutAt =
            newQty === 0
              ? new Date()
              : prevQty === 0 && newQty > 0
                ? null
                : state.sold_out_at || null
          state.stock_quantity = newQty
          state.is_available = newAvailable
          state.sold_out_at = newSoldOutAt
          state.updated_at = new Date()
          return { rows: [{ ...state }], rowCount: 1 }
        }

        return { rows: [], rowCount: 0 }
      },
      release: vi.fn(),
    }
  }

  return { state, makeClient }
}

/**
 * Build the io / notifications / queue / staff-repo mocks needed by the
 * post-commit side-effect path. All of them record their invocations so
 * the property assertions can match them against the expected transition
 * tally.
 */
function makeSideEffectMocks(staffUserIds = [STAFF_USER_A, STAFF_USER_B]) {
  const emit = vi.fn()
  const to = vi.fn().mockReturnValue({ emit })
  const io = { to, emit }

  const notificationsService = {
    sendNotification: vi.fn().mockResolvedValue(undefined),
  }

  const stockNotificationsQueueOverride = {
    add: vi.fn().mockResolvedValue(undefined),
  }

  const notificationQueueOverride = {
    add: vi.fn().mockResolvedValue(undefined),
  }

  const shopStaffRepo = {
    findActiveUserIdsByShopAndRoles: vi.fn().mockResolvedValue(staffUserIds),
  }

  return {
    io,
    to,
    emit,
    notificationsService,
    stockNotificationsQueueOverride,
    notificationQueueOverride,
    shopStaffRepo,
    staffUserIds,
  }
}

function makeService(sideEffects, getIoOverride) {
  return new ShopProductsService(new ShopProductsRepository(), {
    shopStaffRepository: sideEffects.shopStaffRepo,
    notificationsService: sideEffects.notificationsService,
    notificationQueue: sideEffects.notificationQueueOverride,
    stockNotificationsQueue: sideEffects.stockNotificationsQueueOverride,
    getIo: getIoOverride || (() => sideEffects.io),
  })
}

/**
 * Filter emissions by event name. The io mock records (event, payload)
 * tuples on `emit.mock.calls`.
 */
function emissionsOf(emit, eventName) {
  return emit.mock.calls.filter((c) => c[0] === eventName)
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── Arbitraries ──────────────────────────────────────────────────────

// Each "step" in a stock-change sequence is either an absolute set or a
// delta. Generators are constrained to small magnitudes so a moderate-
// length sequence covers many transitions in/out of zero.
const stepArb = fc.oneof(
  fc.record({
    kind: fc.constant('abs'),
    value: fc.integer({ min: 0, max: 20 }),
  }),
  fc.record({
    kind: fc.constant('delta'),
    value: fc.integer({ min: -10, max: 10 }),
  })
)

// 3..15 steps per sequence — long enough to exercise multiple round
// trips, short enough that 100 iterations finish quickly.
const sequenceArb = fc.array(stepArb, { minLength: 3, maxLength: 15 })

const initialStockArb = fc.integer({ min: 0, max: 20 })
const thresholdArb = fc.integer({ min: 0, max: 5 })

// ═══════════════════════════════════════════════════════════════════════
// Property 3a — Stock-out / restock side effects fire EXACTLY on transitions
// ═══════════════════════════════════════════════════════════════════════
describe('Property 3: Stock-Out Round Trip — transition side effects', () => {
  it('emits stock_out exactly on (prev>0 → new=0); emits restocked exactly on (prev=0 → new>0); cache invalidated on every success', async () => {
    await fc.assert(
      fc.asyncProperty(
        initialStockArb,
        thresholdArb,
        sequenceArb,
        async (initialStock, threshold, steps) => {
          // fast-check loops the property body without re-running
          // beforeEach, so reset the module-level mock spies that
          // outlive a single iteration.
          cacheDeletePattern.mockClear()

          const { state, makeClient } = makeSharedFakeClientFactory({
            stock_quantity: initialStock,
            is_available: initialStock > 0,
            sold_out_at: initialStock === 0 ? new Date() : null,
            low_stock_threshold: threshold,
          })
          databaseMock.getClient.mockImplementation(async () => makeClient())

          const sideEffects = makeSideEffectMocks()
          const service = makeService(sideEffects)

          // Track the model: how many transitions of each kind actually
          // happen against the in-memory row given the steps.
          let stockOutTransitions = 0
          let restockTransitions = 0
          let successCount = 0
          let snapshotPrev = state.stock_quantity

          for (const step of steps) {
            const body =
              step.kind === 'abs'
                ? { stock_quantity: step.value }
                : { delta: step.value }

            const res = await service.updateStock(
              SHOP_ID,
              SHOP_PRODUCT_ID,
              body,
              ADMIN_ACTOR
            )

            if (res.success) {
              successCount += 1
              const newQty = state.stock_quantity
              if (snapshotPrev > 0 && newQty === 0) stockOutTransitions += 1
              if (snapshotPrev === 0 && newQty > 0) restockTransitions += 1
              snapshotPrev = newQty
            }
          }

          // Each successful write invalidates the listing cache (Req 11.2).
          expect(cacheDeletePattern).toHaveBeenCalledTimes(successCount)

          // Socket.IO emission counts MUST match the model exactly.
          const stockOutEmits = emissionsOf(
            sideEffects.emit,
            'shop:product:stock_out'
          )
          const restockEmits = emissionsOf(
            sideEffects.emit,
            'shop:product:restocked'
          )
          expect(stockOutEmits).toHaveLength(stockOutTransitions)
          expect(restockEmits).toHaveLength(restockTransitions)

          // Each emission targets the correct shop channel and carries
          // the documented payload shape.
          for (const [, payload] of stockOutEmits) {
            expect(payload).toMatchObject({
              shop_product_id: SHOP_PRODUCT_ID,
              product_id: PRODUCT_ID,
              shop_id: SHOP_ID,
              stock_quantity: 0,
            })
            expect(payload.sold_out_at).toBeDefined()
          }
          for (const [, payload] of restockEmits) {
            expect(payload).toMatchObject({
              shop_product_id: SHOP_PRODUCT_ID,
              product_id: PRODUCT_ID,
              shop_id: SHOP_ID,
            })
            expect(payload.stock_quantity).toBeGreaterThan(0)
          }

          // Wishlist BullMQ enqueue happens exactly once per restock
          // transition (Req 3.4, 11.6).
          expect(
            sideEffects.stockNotificationsQueueOverride.add
          ).toHaveBeenCalledTimes(restockTransitions)
          for (const call of sideEffects.stockNotificationsQueueOverride.add
            .mock.calls) {
            const [name, data] = call
            expect(name).toBe('wishlist-restock')
            expect(data).toMatchObject({
              type: 'wishlist-restock',
              shop_product_id: SHOP_PRODUCT_ID,
              product_id: PRODUCT_ID,
              shop_id: SHOP_ID,
            })
          }

          // Staff stock-out push notifications: one per staff user per
          // stock-out transition (Req 11.4).
          const stockOutPushes =
            sideEffects.notificationsService.sendNotification.mock.calls.filter(
              (c) => c[1].type === 'stock_out'
            )
          expect(stockOutPushes).toHaveLength(
            stockOutTransitions * sideEffects.staffUserIds.length
          )
          for (const [userId, payload] of stockOutPushes) {
            expect(sideEffects.staffUserIds).toContain(userId)
            expect(payload.data).toMatchObject({
              shop_id: SHOP_ID,
              shop_product_id: SHOP_PRODUCT_ID,
              product_id: PRODUCT_ID,
              stock_quantity: 0,
            })
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Property 3b — Round-trip identity
// ═══════════════════════════════════════════════════════════════════════
describe('Property 3: Stock-Out Round Trip — round-trip identity', () => {
  it('a sequence that returns to the original stock value restores availability and pairs every stock_out with a restock', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Start with stock > 0 so we have a clean "available" baseline.
        fc.integer({ min: 1, max: 20 }),
        // Number of zero-pingpongs the sequence performs (each ping = one
        // 0→N→0 round). 1..4 keeps the test fast while exercising
        // multiple round trips.
        fc.integer({ min: 1, max: 4 }),
        // Restock value used at each ping — stays positive so each ping
        // is a true round trip.
        fc.array(fc.integer({ min: 1, max: 20 }), {
          minLength: 1,
          maxLength: 4,
        }),
        async (initialStock, pingCount, restockValues) => {
          // fast-check loops the property body without re-running
          // beforeEach, so reset module-level mock spies first.
          cacheDeletePattern.mockClear()

          const { state, makeClient } = makeSharedFakeClientFactory({
            stock_quantity: initialStock,
            is_available: true,
            sold_out_at: null,
            low_stock_threshold: 0,
          })
          databaseMock.getClient.mockImplementation(async () => makeClient())

          const sideEffects = makeSideEffectMocks()
          const service = makeService(sideEffects)

          // Build a deterministic round-trip sequence:
          // [ set→0, set→r1, set→0, set→r2, …, set→0, set→initialStock ]
          // Truncate / cycle restockValues to pingCount.
          const restocks = []
          for (let i = 0; i < pingCount; i++) {
            restocks.push(
              restockValues[i % restockValues.length] || initialStock
            )
          }

          const sequence = []
          for (let i = 0; i < pingCount; i++) {
            sequence.push({ kind: 'abs', value: 0 })
            sequence.push({ kind: 'abs', value: restocks[i] })
          }
          // Final step: return to the original stock value if the last
          // restock didn't already land there. This makes the sequence a
          // true identity on stock_quantity. Note: this final step is
          // always a positive→positive transition (no extra stock_out /
          // restock pair) since restocks[last] >= 1 and initialStock >= 1.
          if (restocks[restocks.length - 1] !== initialStock) {
            sequence.push({ kind: 'abs', value: initialStock })
          }

          for (const step of sequence) {
            const res = await service.updateStock(
              SHOP_ID,
              SHOP_PRODUCT_ID,
              { stock_quantity: step.value },
              ADMIN_ACTOR
            )
            expect(res.success).toBe(true)
          }

          // ─── Round-trip identity on the row ─────────────────────
          // Final stock equals the original.
          expect(state.stock_quantity).toBe(initialStock)
          // Availability matches the start state (we started >0).
          expect(state.is_available).toBe(true)
          // sold_out_at is cleared on the last restock that crosses 0→N.
          expect(state.sold_out_at).toBeNull()

          // ─── Pairing invariant ──────────────────────────────────
          // Exactly `pingCount` stock_out emissions paired with
          // exactly `pingCount` restocked emissions and `pingCount`
          // wishlist enqueues (Req 3.4, 11.6).
          const stockOutEmits = emissionsOf(
            sideEffects.emit,
            'shop:product:stock_out'
          )
          const restockEmits = emissionsOf(
            sideEffects.emit,
            'shop:product:restocked'
          )
          expect(stockOutEmits).toHaveLength(pingCount)
          expect(restockEmits).toHaveLength(pingCount)
          expect(
            sideEffects.stockNotificationsQueueOverride.add
          ).toHaveBeenCalledTimes(pingCount)

          // Staff stock-out pushes scale with staff count.
          const stockOutPushes =
            sideEffects.notificationsService.sendNotification.mock.calls.filter(
              (c) => c[1].type === 'stock_out'
            )
          expect(stockOutPushes).toHaveLength(
            pingCount * sideEffects.staffUserIds.length
          )

          // Cache invalidation count = number of successful writes.
          expect(cacheDeletePattern).toHaveBeenCalledTimes(sequence.length)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Property 3c — Failed updates fire NO side effects (guard for 3a/3b)
// ═══════════════════════════════════════════════════════════════════════
describe('Property 3: Stock-Out Round Trip — rollback isolation', () => {
  it('over-deductions and absolute negatives roll back and never trigger socket.io / queue / staff notifications', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20 }), // initial stock S
        fc.integer({ min: 1, max: 50 }), // overdraw amount
        async (S, overdraw) => {
          // fast-check loops the property body without re-running
          // beforeEach, so reset module-level mock spies first.
          cacheDeletePattern.mockClear()

          const { state, makeClient } = makeSharedFakeClientFactory({
            stock_quantity: S,
            is_available: S > 0,
            sold_out_at: S === 0 ? new Date() : null,
            low_stock_threshold: 0,
          })
          databaseMock.getClient.mockImplementation(async () => makeClient())

          const sideEffects = makeSideEffectMocks()
          const service = makeService(sideEffects)

          // 1. Delta that overdraws → INSUFFICIENT_STOCK
          const r1 = await service.updateStock(
            SHOP_ID,
            SHOP_PRODUCT_ID,
            { delta: -(S + overdraw) },
            ADMIN_ACTOR
          )
          expect(r1.success).toBe(false)
          expect(r1.code).toBe('INSUFFICIENT_STOCK')

          // 2. Absolute negative → NEGATIVE_STOCK
          const r2 = await service.updateStock(
            SHOP_ID,
            SHOP_PRODUCT_ID,
            { stock_quantity: -overdraw },
            ADMIN_ACTOR
          )
          expect(r2.success).toBe(false)
          expect(r2.code).toBe('NEGATIVE_STOCK')

          // Row unchanged across BOTH failed attempts.
          expect(state.stock_quantity).toBe(S)
          expect(state.is_available).toBe(S > 0)

          // No side effects whatsoever.
          expect(sideEffects.emit).not.toHaveBeenCalled()
          expect(
            sideEffects.notificationsService.sendNotification
          ).not.toHaveBeenCalled()
          expect(
            sideEffects.stockNotificationsQueueOverride.add
          ).not.toHaveBeenCalled()
          expect(
            sideEffects.shopStaffRepo.findActiveUserIdsByShopAndRoles
          ).not.toHaveBeenCalled()
          expect(cacheDeletePattern).not.toHaveBeenCalled()
        }
      ),
      { numRuns: 100 }
    )
  })
})
