// Feature: multi-vendor-system, Property 19: Bulk Order Stock Round Trip
// **Validates: Requirements 9.5, 9.7**
//
// Property:
//   For any bulk order that is confirmed (SUBMITTED → CONFIRMED) and then
//   cancelled (CONFIRMED → CANCELLED), every shop_product's stock_quantity
//   returns to its pre-confirmation value. Concretely:
//
//     after CONFIRMED:                stock(p) = initial(p) − requested(p)
//     after CANCELLED-from-CONFIRMED: stock(p) = initial(p)
//
//   The service deducts stock in `_confirmAndDeductStock` (Req 9.5) and
//   restores it in `_cancelAndRestoreStock` (Req 9.7), both inside a single
//   transaction using SELECT … FOR UPDATE row locks. This property
//   exercises the full round trip across many randomly-generated item
//   arrays — including duplicate product_ids the handler must aggregate.
//
// Approach:
//   We mock `getClient()` so the service can run its tx pattern, and we
//   mock the bulk-orders repository. The repository's stock helpers
//   (`lockShopProduct`, `applyShopProductStock`) are wired to a stateful
//   in-memory shop_products store keyed by product_id, so confirm/cancel
//   actually mutate the simulated DB. `findById` / `findByIdForUpdate` /
//   `updateStatus` advance the bulk_orders row through the state machine
//   so the second updateStatus call sees the post-confirm CONFIRMED state.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'

// ─── Module mocks (must be hoisted before the imports they replace) ──
vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { getClient } from '../../src/config/database.js'
import { BulkOrdersService } from '../../src/modules/bulk-orders/bulk-orders.service.js'

// ─── Test fixtures ───────────────────────────────────────────────
const SHOP_ID = '11111111-1111-4111-8111-111111111111'
const ORDER_ID = '33333333-3333-4333-8333-333333333333'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const ADMIN_ACTOR = { id: 'admin', role: 'ADMIN' }

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── Test doubles ─────────────────────────────────────────────────

/**
 * Build a stateful shop_products store keyed by product_id.
 * Each record: { id, product_id, stock_quantity, is_available }.
 */
function makeStockStore(initialStockByProduct) {
  const byProduct = new Map()
  const byShopProductId = new Map()
  let counter = 0
  for (const [productId, qty] of initialStockByProduct.entries()) {
    const record = {
      id: `sp-${counter++}-${productId.slice(0, 8)}`,
      product_id: productId,
      stock_quantity: qty,
      is_available: qty > 0,
    }
    byProduct.set(productId, record)
    byShopProductId.set(record.id, record)
  }
  return { byProduct, byShopProductId }
}

/**
 * Aggregate items by product_id, mirroring BulkOrdersService._aggregateByProduct.
 */
function aggregate(items) {
  const map = new Map()
  for (const it of items) {
    const pid = it.product_id
    const q = Number(it.quantity || 0)
    if (!pid || !Number.isFinite(q) || q <= 0) continue
    map.set(pid, (map.get(pid) || 0) + q)
  }
  return map
}

/**
 * Build a repository whose stock helpers operate against the in-memory
 * store, and whose order-row helpers track the status transitions of a
 * single bulk_orders row.
 */
function makeRepoWithStore(store, initialOrderRow) {
  // Mutable proxy so updateStatus can move the order through the state machine.
  const orderRow = { ...initialOrderRow }
  return {
    findById: vi.fn(async () => ({ ...orderRow })),
    findByIdForUpdate: vi.fn(async () => ({ ...orderRow })),
    updateStatus: vi.fn(async (_id, newStatus) => {
      orderRow.status = newStatus
      return { ...orderRow }
    }),
    lockShopProduct: vi.fn(async (_client, shopId, productId) => {
      if (shopId !== SHOP_ID) return null
      const r = store.byProduct.get(productId)
      if (!r) return null
      return {
        id: r.id,
        stock_quantity: r.stock_quantity,
        is_available: r.is_available,
      }
    }),
    applyShopProductStock: vi.fn(async (_client, shopProductId, newQty) => {
      const r = store.byShopProductId.get(shopProductId)
      if (!r) return null
      r.stock_quantity = newQty
      r.is_available = newQty > 0
      return {
        id: r.id,
        stock_quantity: r.stock_quantity,
        is_available: r.is_available,
      }
    }),
    // Unused by this property but present for shape parity with the real repo.
    findStaffRole: vi.fn(),
    isUserAllocatedToShop: vi.fn(),
    create: vi.fn(),
    findShopProductsForValidation: vi.fn(),
    findMany: vi.fn(),
    countByOrderNumberPattern: vi.fn(),
    existsOrderNumber: vi.fn(),
  }
}

/**
 * Fake pg PoolClient — the service only calls BEGIN/COMMIT/ROLLBACK on it
 * directly; the actual data work goes through the repository helpers above.
 */
function makeFakeClient() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  }
}

// ─── Arbitraries ──────────────────────────────────────────────────

// A small pool (1..6 distinct uuids) so duplicate product_ids actually
// surface in the items array — the handler must aggregate them and the
// round trip must still net to zero per product.
const itemsArb = fc
  .uniqueArray(fc.uuid(), { minLength: 1, maxLength: 6 })
  .chain((productPool) =>
    fc
      .array(
        fc.record({
          product_id: fc.constantFrom(...productPool),
          quantity: fc.integer({ min: 1, max: 50 }),
        }),
        { minLength: 1, maxLength: 10 }
      )
      .map((items) => ({ items, productPool }))
  )

// ═══════════════════════════════════════════════════════════════
// Property 19 — Bulk Order Stock Round Trip
// ═══════════════════════════════════════════════════════════════
describe('Property 19: Bulk Order Stock Round Trip (Req 9.5, 9.7)', () => {
  it('CONFIRMED then CANCELLED restores all shop_product stock to pre-confirmation values', async () => {
    await fc.assert(
      fc.asyncProperty(itemsArb, async ({ items }) => {
        const aggregated = aggregate(items)
        // Aggregated.size === 0 only happens if all entries had qty<=0;
        // our generator constrains qty >= 1 so this should always pass.
        fc.pre(aggregated.size > 0)

        // Pick initial stock per product such that stock(p) >= aggregated(p).
        // A healthy buffer keeps the property non-trivial (post-confirm
        // values are strictly positive, then must climb back to the buffer).
        const initialStock = new Map()
        for (const [pid, qty] of aggregated.entries()) {
          initialStock.set(pid, qty + 100)
        }
        // Snapshot for the post-cancel identity check.
        const snapshot = new Map(initialStock)

        const store = makeStockStore(initialStock)
        const submittedRow = {
          id: ORDER_ID,
          user_id: USER_ID,
          shop_id: SHOP_ID,
          status: 'SUBMITTED',
          items,
        }
        const repo = makeRepoWithStore(store, submittedRow)

        // Each updateStatus call grabs a fresh client; return a new fake
        // each time getClient() is invoked so release() book-keeping is
        // correct across the two transitions.
        getClient.mockImplementation(async () => makeFakeClient())

        const service = new BulkOrdersService(repo)

        // ─── Step 1: SUBMITTED → CONFIRMED ───────────────────────
        const confirmResult = await service.updateStatus(
          ADMIN_ACTOR,
          ORDER_ID,
          'CONFIRMED'
        )
        expect(confirmResult.success).toBe(true)

        // Sub-property: after CONFIRMED, stock decreased by exactly the
        // (aggregated) requested quantity per product, and never goes
        // negative.
        for (const [pid, qty] of aggregated.entries()) {
          const r = store.byProduct.get(pid)
          expect(r.stock_quantity).toBe(snapshot.get(pid) - qty)
          expect(r.stock_quantity).toBeGreaterThanOrEqual(0)
        }

        // ─── Step 2: CONFIRMED → CANCELLED ───────────────────────
        const cancelResult = await service.updateStatus(
          ADMIN_ACTOR,
          ORDER_ID,
          'CANCELLED'
        )
        expect(cancelResult.success).toBe(true)

        // Main property: round trip is the identity on stock_quantity
        // for every product touched by the order.
        for (const [pid, expectedQty] of snapshot.entries()) {
          const r = store.byProduct.get(pid)
          expect(r.stock_quantity).toBe(expectedQty)
        }
      }),
      { numRuns: 100 }
    )
  })

  it('round trip leaves products NOT touched by the order unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        itemsArb,
        // An additional product id that is in the store but not in the order.
        fc.uuid(),
        // Initial stock for the untouched product
        fc.integer({ min: 0, max: 1000 }),
        async ({ items, productPool }, untouchedPid, untouchedStock) => {
          fc.pre(!productPool.includes(untouchedPid))
          const aggregated = aggregate(items)
          fc.pre(aggregated.size > 0)

          const initialStock = new Map()
          for (const [pid, qty] of aggregated.entries()) {
            initialStock.set(pid, qty + 50)
          }
          initialStock.set(untouchedPid, untouchedStock)
          const snapshot = new Map(initialStock)

          const store = makeStockStore(initialStock)
          const submittedRow = {
            id: ORDER_ID,
            user_id: USER_ID,
            shop_id: SHOP_ID,
            status: 'SUBMITTED',
            items,
          }
          const repo = makeRepoWithStore(store, submittedRow)
          getClient.mockImplementation(async () => makeFakeClient())

          const service = new BulkOrdersService(repo)
          const c = await service.updateStatus(ADMIN_ACTOR, ORDER_ID, 'CONFIRMED')
          expect(c.success).toBe(true)
          const x = await service.updateStatus(ADMIN_ACTOR, ORDER_ID, 'CANCELLED')
          expect(x.success).toBe(true)

          // The untouched product's stock must equal its initial value
          // throughout the round trip.
          expect(store.byProduct.get(untouchedPid).stock_quantity).toBe(
            snapshot.get(untouchedPid)
          )
        }
      ),
      { numRuns: 50 }
    )
  })
})
