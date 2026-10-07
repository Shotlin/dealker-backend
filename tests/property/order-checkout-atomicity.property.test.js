// Feature: multi-vendor-system, Property 7: Transaction Atomicity
// **Validates: Requirements 5.9, 7.9, 15.9, 15.10**
//
// Property:
//   For any failed checkout or financial operation, database state must be
//   identical to the pre-operation state. Concretely for OrderSplitterService.
//   createOrders, the platform guarantees atomicity via the outer transaction
//   owned by OrdersService (BEGIN…COMMIT/ROLLBACK around the splitter call).
//   Inside the splitter the contract is:
//
//     1. For each shop group, all rows are SELECT…FOR UPDATE-locked and
//        validated BEFORE any mutation in that group runs. So any per-item
//        failure inside a shop group bails before that group writes anything.
//     2. On any failure the splitter throws an Error whose
//        `code === 'CHECKOUT_PARTIAL_FAIL'` and `failures` is a non-empty
//        array. Because the splitter is run inside the caller's pg
//        transaction client, the caller's ROLLBACK undoes any writes that
//        earlier shop groups may have committed during the same call.
//     3. The happy path issues exactly one ordersRepository.create per
//        distinct shop and exactly one shopProductsRepository.applyStockChange
//        per cart line — no extras, no duplicates.
//
//   The strict "no writes at all" sub-property of Property 7 holds for
//   single-shop carts (the most natural unit of atomicity at the splitter
//   layer). For multi-shop carts where the failing shop is not the first
//   sorted one, atomicity is delegated to the outer transaction's ROLLBACK;
//   we exercise that path by injecting failures into the first sorted shop.
//
// Approach:
//   The splitter takes its db client and its repositories as injected
//   collaborators. We give it a fake pg client (vi.fn() query/release that
//   captures every SQL string) and vi.fn() repository stubs that record their
//   call arguments. No real Postgres is touched. We then assert on the
//   captured calls. This mirrors the structure used in the smoke test and
//   the stock-non-negativity property test.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'

// Mock logger so the service stays hermetic — pino isn't needed for unit
// property tests and avoids transport setup noise.
vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { OrderSplitterService } from '../../src/modules/orders/order-splitter.service.js'

// ─── Test doubles ──────────────────────────────────────────────

/**
 * Build a fake pg PoolClient that records every SQL string passed to query().
 * The splitter does not call client.query() directly today (the repos do),
 * but we still capture writes so the property can assert "no DELETE/INSERT/
 * UPDATE was issued" at the SQL level if the contract ever evolves to call
 * the client directly.
 */
function makeFakeClient() {
  const calls = []
  return {
    calls,
    query: vi.fn(async (sql) => {
      const text = typeof sql === 'string' ? sql : sql?.text || ''
      calls.push(text)
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
}

function makeOrdersRepo() {
  return {
    create: vi.fn(async (_client, data) => ({
      id: `order-${data.shopId}`,
      orderNumber: data.orderNumber,
      shopId: data.shopId,
      status: data.status,
      totalAmount: data.totalAmount,
    })),
    generateOrderNumber: vi.fn(async () => 'GRO-TEST-001'),
  }
}

/**
 * Build a shop-products repo whose findByIdForUpdate returns the row map
 * that we hand it (keyed by shopProductId). Returning `undefined` from the
 * map simulates a vanished row (returns null). applyStockChange succeeds
 * with the updated qty echoed back.
 */
function makeShopProductsRepo(rowsByShopProductId) {
  return {
    findByIdForUpdate: vi.fn(async (_client, shopProductId, shopId) => {
      const row = rowsByShopProductId.get(shopProductId)
      if (!row) return null
      // Defensive: respect shop scoping
      if (row.shop_id !== shopId) return null
      return row
    }),
    applyStockChange: vi.fn(async (_client, { shopProductId, delta }) => {
      const row = rowsByShopProductId.get(shopProductId)
      const prevQty = row ? Number(row.stock_quantity) : 0
      const newQty = prevQty + delta
      return {
        stockProduct: {
          id: shopProductId,
          stock_quantity: newQty,
          low_stock_threshold: row?.low_stock_threshold ?? 5,
        },
        movement: {
          quantity_before: prevQty,
          quantity_after: newQty,
        },
      }
    }),
  }
}

const USER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── Arbitraries ──────────────────────────────────────────────

const productIdArb = fc.uuid()
const shopProductIdArb = fc.uuid()
const priceArb = fc.double({
  min: 1,
  max: 500,
  noNaN: true,
  noDefaultInfinity: true,
})

/**
 * Build a "valid" cart line for a given shop_product row. The quantity is
 * guaranteed to satisfy stock and max_order_qty so the line passes
 * splitter validation as-is.
 */
function validItemArb(shopId, shopProductRow) {
  const cap = Math.max(
    1,
    Math.min(shopProductRow.stock_quantity, shopProductRow.max_order_qty)
  )
  return fc
    .tuple(fc.integer({ min: 1, max: cap }), priceArb)
    .map(([qty, price]) => ({
      productId: shopProductRow.product_id,
      shopId,
      shopProductId: shopProductRow.id,
      quantity: qty,
      salePrice: price,
      price,
      lineTotal: Number((qty * price).toFixed(2)),
      name: 'P',
    }))
}

/**
 * Single-shop cart arbitrary. Every cart line belongs to one shop and is
 * fully valid by construction. Used to anchor failure-injection scenarios
 * where atomicity is asserted at the splitter level (no writes at all).
 *
 * Shape: { cartItems, rowsByShopProductId, shopId }
 */
const singleShopCartArb = fc.uuid().chain((shopId) =>
  fc
    .array(
      fc
        .record({
          shopProductId: shopProductIdArb,
          productId: productIdArb,
          stock: fc.integer({ min: 1, max: 50 }),
          maxOrderQty: fc.integer({ min: 1, max: 50 }),
        })
        .chain(({ shopProductId, productId, stock, maxOrderQty }) => {
          const row = {
            id: shopProductId,
            shop_id: shopId,
            product_id: productId,
            stock_quantity: stock,
            max_order_qty: maxOrderQty,
            is_available: true,
          }
          return validItemArb(shopId, row).map((item) => ({ item, row }))
        }),
      { minLength: 1, maxLength: 6 }
    )
    .map((entries) => {
      const seen = new Map()
      for (const { item, row } of entries) {
        if (!seen.has(row.id)) seen.set(row.id, { item, row })
      }
      const cartItems = Array.from(seen.values()).map((e) => e.item)
      const rowsByShopProductId = new Map()
      for (const { row } of seen.values())
        rowsByShopProductId.set(row.id, row)
      return { cartItems, rowsByShopProductId, shopId }
    })
)

/**
 * Multi-shop cart arbitrary used for the happy-path property: 1..4 distinct
 * shops, every line valid. Returns the same shape plus distinctShopIds.
 */
const multiShopValidCartArb = fc
  .uniqueArray(fc.uuid(), { minLength: 1, maxLength: 4 })
  .chain((shopPool) =>
    fc
      .array(
        fc
          .record({
            shopIdx: fc.nat(shopPool.length - 1),
            shopProductId: shopProductIdArb,
            productId: productIdArb,
            stock: fc.integer({ min: 1, max: 50 }),
            maxOrderQty: fc.integer({ min: 1, max: 50 }),
          })
          .chain(
            ({ shopIdx, shopProductId, productId, stock, maxOrderQty }) => {
              const shopId = shopPool[shopIdx]
              const row = {
                id: shopProductId,
                shop_id: shopId,
                product_id: productId,
                stock_quantity: stock,
                max_order_qty: maxOrderQty,
                is_available: true,
              }
              return validItemArb(shopId, row).map((item) => ({ item, row }))
            }
          ),
        { minLength: 1, maxLength: 8 }
      )
      .map((entries) => {
        const seen = new Map()
        for (const { item, row } of entries) {
          if (!seen.has(row.id)) seen.set(row.id, { item, row })
        }
        const cartItems = Array.from(seen.values()).map((e) => e.item)
        const rowsByShopProductId = new Map()
        for (const { row } of seen.values())
          rowsByShopProductId.set(row.id, row)
        const distinctShopIds = new Set(cartItems.map((i) => i.shopId))
        return { cartItems, rowsByShopProductId, distinctShopIds }
      })
  )

// ═══════════════════════════════════════════════════════════════
// Property 7.A — Insufficient stock anywhere → no writes (single shop)
// ═══════════════════════════════════════════════════════════════
describe('Property 7: Transaction Atomicity — INSUFFICIENT_STOCK aborts before any write', () => {
  it('any item with quantity > stock causes zero ordersRepo.create and zero applyStockChange calls', async () => {
    await fc.assert(
      fc.asyncProperty(
        singleShopCartArb,
        // Index of the line we'll mutate to break stock
        fc.nat(),
        // Amount by which to exceed the stock
        fc.integer({ min: 1, max: 100 }),
        async ({ cartItems, rowsByShopProductId }, rawIdx, overdraw) => {
          fc.pre(cartItems.length > 0)
          const idx = rawIdx % cartItems.length
          const target = cartItems[idx]
          const row = rowsByShopProductId.get(target.shopProductId)

          // Mutate the request to exceed available stock while staying
          // within max_order_qty so the failure path is INSUFFICIENT_STOCK,
          // not MAX_QTY_EXCEEDED.
          const requested = row.stock_quantity + overdraw
          fc.pre(requested <= row.max_order_qty)
          target.quantity = requested

          const ordersRepo = makeOrdersRepo()
          const shopProductsRepo = makeShopProductsRepo(rowsByShopProductId)
          const client = makeFakeClient()

          const svc = new OrderSplitterService({
            ordersRepository: ordersRepo,
            shopProductsRepository: shopProductsRepo,
          })
          const groups = svc.splitCart(cartItems)

          let thrown = null
          try {
            await svc.createOrders({
              client,
              userId: USER_ID,
              groups,
              deliveryAddress: {},
              payment: { method: 'COD', status: 'PENDING' },
            })
          } catch (e) {
            thrown = e
          }

          // (a) Threw with the documented contract
          expect(thrown).not.toBeNull()
          expect(thrown.code).toBe('CHECKOUT_PARTIAL_FAIL')
          expect(Array.isArray(thrown.failures)).toBe(true)
          expect(thrown.failures.length).toBeGreaterThanOrEqual(1)
          // The mutated item must be in the failures list with the right code
          expect(
            thrown.failures.some(
              (f) =>
                f.productId === target.productId &&
                f.shopId === target.shopId &&
                f.code === 'INSUFFICIENT_STOCK'
            )
          ).toBe(true)

          // (b) No order INSERT
          expect(ordersRepo.create).not.toHaveBeenCalled()
          expect(ordersRepo.generateOrderNumber).not.toHaveBeenCalled()
          // (c) No stock UPDATE
          expect(shopProductsRepo.applyStockChange).not.toHaveBeenCalled()
          // (d) No DML executed via the raw client either
          for (const sql of client.calls) {
            expect(/INSERT|UPDATE|DELETE/i.test(sql)).toBe(false)
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 7.B — max_order_qty exceeded → no writes (single shop)
// ═══════════════════════════════════════════════════════════════
describe('Property 7: Transaction Atomicity — MAX_QTY_EXCEEDED aborts before any write', () => {
  it('any item with quantity > max_order_qty causes zero writes', async () => {
    await fc.assert(
      fc.asyncProperty(
        singleShopCartArb,
        fc.nat(),
        fc.integer({ min: 1, max: 50 }),
        async ({ cartItems, rowsByShopProductId }, rawIdx, over) => {
          fc.pre(cartItems.length > 0)
          const idx = rawIdx % cartItems.length
          const target = cartItems[idx]
          const row = rowsByShopProductId.get(target.shopProductId)

          // Force MAX_QTY_EXCEEDED. Bump stock so INSUFFICIENT_STOCK is not
          // also tripped — we want this property to confirm the max-qty
          // branch independently aborts the checkout.
          const requested = row.max_order_qty + over
          row.stock_quantity = requested + 1000
          target.quantity = requested

          const ordersRepo = makeOrdersRepo()
          const shopProductsRepo = makeShopProductsRepo(rowsByShopProductId)
          const client = makeFakeClient()

          const svc = new OrderSplitterService({
            ordersRepository: ordersRepo,
            shopProductsRepository: shopProductsRepo,
          })
          const groups = svc.splitCart(cartItems)

          let thrown = null
          try {
            await svc.createOrders({
              client,
              userId: USER_ID,
              groups,
              deliveryAddress: {},
              payment: { method: 'COD', status: 'PENDING' },
            })
          } catch (e) {
            thrown = e
          }

          expect(thrown).not.toBeNull()
          expect(thrown.code).toBe('CHECKOUT_PARTIAL_FAIL')
          expect(
            thrown.failures.some(
              (f) =>
                f.productId === target.productId &&
                f.shopId === target.shopId &&
                f.code === 'MAX_QTY_EXCEEDED' &&
                f.max === row.max_order_qty
            )
          ).toBe(true)

          expect(ordersRepo.create).not.toHaveBeenCalled()
          expect(shopProductsRepo.applyStockChange).not.toHaveBeenCalled()
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 7.C — Missing/unavailable shop_product → no writes (single shop)
// ═══════════════════════════════════════════════════════════════
describe('Property 7: Transaction Atomicity — SHOP_PRODUCT_UNAVAILABLE aborts before any write', () => {
  it('removing one shop_product row causes zero writes', async () => {
    await fc.assert(
      fc.asyncProperty(
        singleShopCartArb,
        fc.nat(),
        async ({ cartItems, rowsByShopProductId }, rawIdx) => {
          fc.pre(cartItems.length > 0)
          const idx = rawIdx % cartItems.length
          const target = cartItems[idx]

          // Simulate the row being deleted between cart load and checkout
          rowsByShopProductId.delete(target.shopProductId)

          const ordersRepo = makeOrdersRepo()
          const shopProductsRepo = makeShopProductsRepo(rowsByShopProductId)

          const svc = new OrderSplitterService({
            ordersRepository: ordersRepo,
            shopProductsRepository: shopProductsRepo,
          })
          const groups = svc.splitCart(cartItems)

          let thrown = null
          try {
            await svc.createOrders({
              client: makeFakeClient(),
              userId: USER_ID,
              groups,
              deliveryAddress: {},
              payment: { method: 'COD', status: 'PENDING' },
            })
          } catch (e) {
            thrown = e
          }

          expect(thrown).not.toBeNull()
          expect(thrown.code).toBe('CHECKOUT_PARTIAL_FAIL')
          expect(
            thrown.failures.some(
              (f) =>
                f.productId === target.productId &&
                f.shopId === target.shopId &&
                f.code === 'SHOP_PRODUCT_UNAVAILABLE'
            )
          ).toBe(true)

          expect(ordersRepo.create).not.toHaveBeenCalled()
          expect(shopProductsRepo.applyStockChange).not.toHaveBeenCalled()
        }
      ),
      { numRuns: 100 }
    )
  })

  it('row present but is_available=false also aborts with SHOP_PRODUCT_UNAVAILABLE', async () => {
    await fc.assert(
      fc.asyncProperty(
        singleShopCartArb,
        fc.nat(),
        async ({ cartItems, rowsByShopProductId }, rawIdx) => {
          fc.pre(cartItems.length > 0)
          const idx = rawIdx % cartItems.length
          const target = cartItems[idx]
          const row = rowsByShopProductId.get(target.shopProductId)
          row.is_available = false

          const ordersRepo = makeOrdersRepo()
          const shopProductsRepo = makeShopProductsRepo(rowsByShopProductId)

          const svc = new OrderSplitterService({
            ordersRepository: ordersRepo,
            shopProductsRepository: shopProductsRepo,
          })
          const groups = svc.splitCart(cartItems)

          let thrown = null
          try {
            await svc.createOrders({
              client: makeFakeClient(),
              userId: USER_ID,
              groups,
              deliveryAddress: {},
              payment: { method: 'COD', status: 'PENDING' },
            })
          } catch (e) {
            thrown = e
          }

          expect(thrown).not.toBeNull()
          expect(thrown.code).toBe('CHECKOUT_PARTIAL_FAIL')
          expect(ordersRepo.create).not.toHaveBeenCalled()
          expect(shopProductsRepo.applyStockChange).not.toHaveBeenCalled()
        }
      ),
      { numRuns: 50 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 7.D — All valid → all writes happen exactly once (multi-shop)
// ═══════════════════════════════════════════════════════════════
describe('Property 7: Transaction Atomicity — happy path commits exactly the expected writes', () => {
  it('valid cart of N shops produces N orders and M stock updates with no extras', async () => {
    await fc.assert(
      fc.asyncProperty(
        multiShopValidCartArb,
        async ({ cartItems, rowsByShopProductId, distinctShopIds }) => {
          fc.pre(cartItems.length > 0)

          const ordersRepo = makeOrdersRepo()
          const shopProductsRepo = makeShopProductsRepo(rowsByShopProductId)

          const svc = new OrderSplitterService({
            ordersRepository: ordersRepo,
            shopProductsRepository: shopProductsRepo,
          })
          const groups = svc.splitCart(cartItems)

          const orders = await svc.createOrders({
            client: makeFakeClient(),
            userId: USER_ID,
            groups,
            deliveryAddress: {},
            payment: { method: 'COD', status: 'PENDING' },
          })

          // Exactly N orders, one per distinct shop
          expect(orders).toHaveLength(distinctShopIds.size)
          expect(ordersRepo.create).toHaveBeenCalledTimes(distinctShopIds.size)
          expect(ordersRepo.generateOrderNumber).toHaveBeenCalledTimes(
            distinctShopIds.size
          )

          // Exactly one applyStockChange per cart line
          expect(shopProductsRepo.applyStockChange).toHaveBeenCalledTimes(
            cartItems.length
          )

          // Each stock update decremented by exactly the requested quantity
          for (const call of shopProductsRepo.applyStockChange.mock.calls) {
            const [, { shopProductId, delta }] = call
            const row = rowsByShopProductId.get(shopProductId)
            const cartLine = cartItems.find(
              (i) => i.shopProductId === shopProductId
            )
            expect(delta).toBe(-cartLine.quantity)
            expect(row.stock_quantity + delta).toBeGreaterThanOrEqual(0)
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 7.E — Failures aggregate within a shop group
// ═══════════════════════════════════════════════════════════════
describe('Property 7: Transaction Atomicity — multiple failures in one shop group are aggregated', () => {
  it('all bad items in the failing shop group appear in the failures array', async () => {
    await fc.assert(
      fc.asyncProperty(
        // 2..6 items all from a single shop
        fc.integer({ min: 2, max: 6 }),
        // Bitmask deciding which items are broken (>=1 must be broken)
        fc.array(fc.boolean(), { minLength: 2, maxLength: 6 }),
        async (n, brokenMaskRaw) => {
          // Align mask length with n; ensure at least one is broken
          const brokenMask = []
          for (let i = 0; i < n; i++) {
            brokenMask.push(
              brokenMaskRaw[i] === undefined ? false : brokenMaskRaw[i]
            )
          }
          if (!brokenMask.some(Boolean)) brokenMask[0] = true

          const SHOP = '11111111-1111-1111-1111-111111111111'
          const cartItems = []
          const rowsByShopProductId = new Map()
          const expectedBroken = []

          for (let i = 0; i < n; i++) {
            const shopProductId = `sp-${i}`
            const productId = `p-${i}`
            const isBroken = brokenMask[i]
            const row = {
              id: shopProductId,
              shop_id: SHOP,
              product_id: productId,
              stock_quantity: 100,
              max_order_qty: 100,
              is_available: true,
            }
            rowsByShopProductId.set(shopProductId, row)
            // Broken items request 200 → INSUFFICIENT_STOCK
            const qty = isBroken ? 200 : 5
            cartItems.push({
              productId,
              shopId: SHOP,
              shopProductId,
              quantity: qty,
              salePrice: 10,
              price: 10,
              lineTotal: qty * 10,
              name: `P${i}`,
            })
            if (isBroken) expectedBroken.push({ productId, shopId: SHOP })
          }

          const ordersRepo = makeOrdersRepo()
          const shopProductsRepo = makeShopProductsRepo(rowsByShopProductId)

          const svc = new OrderSplitterService({
            ordersRepository: ordersRepo,
            shopProductsRepository: shopProductsRepo,
          })
          const groups = svc.splitCart(cartItems)

          let thrown = null
          try {
            await svc.createOrders({
              client: makeFakeClient(),
              userId: USER_ID,
              groups,
              deliveryAddress: {},
              payment: { method: 'COD', status: 'PENDING' },
            })
          } catch (e) {
            thrown = e
          }

          expect(thrown).not.toBeNull()
          expect(thrown.code).toBe('CHECKOUT_PARTIAL_FAIL')
          // Every broken item is reported (current implementation aggregates
          // all failures inside the same shop group before throwing).
          for (const broken of expectedBroken) {
            expect(
              thrown.failures.some(
                (f) =>
                  f.productId === broken.productId &&
                  f.shopId === broken.shopId
              )
            ).toBe(true)
          }
          expect(thrown.failures.length).toBe(expectedBroken.length)

          // No writes occurred (single-shop cart so the splitter's contract
          // holds strictly: Req 5.9, 15.9, 15.10).
          expect(ordersRepo.create).not.toHaveBeenCalled()
          expect(shopProductsRepo.applyStockChange).not.toHaveBeenCalled()
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 7.F — Failing shop never has writes when it sorts first
// ═══════════════════════════════════════════════════════════════
describe('Property 7: Transaction Atomicity — failing shop is never written when it is processed first', () => {
  it('the failing shop has zero applyStockChange calls and zero ordersRepo.create calls', async () => {
    await fc.assert(
      fc.asyncProperty(
        // 2..4 distinct shops
        fc.uniqueArray(fc.uuid(), { minLength: 2, maxLength: 4 }),
        async (shopPool) => {
          // The splitter processes shops in sorted order. Place the failing
          // shop first so we exercise the strict no-writes path: nothing
          // else has run yet when the failure surfaces.
          const sortedShops = [...shopPool].sort()
          const FAIL_SHOP = sortedShops[0]

          const cartItems = []
          const rowsByShopProductId = new Map()

          // Failing shop: 1 broken item (qty > stock)
          const failedSpId = 'fail-sp'
          const failedRow = {
            id: failedSpId,
            shop_id: FAIL_SHOP,
            product_id: 'fail-pid',
            stock_quantity: 1,
            max_order_qty: 100,
            is_available: true,
          }
          rowsByShopProductId.set(failedSpId, failedRow)
          cartItems.push({
            productId: 'fail-pid',
            shopId: FAIL_SHOP,
            shopProductId: failedSpId,
            quantity: 100, // > stock
            salePrice: 10,
            price: 10,
            lineTotal: 1000,
            name: 'X',
          })

          // Other shops: one valid line each
          for (let i = 1; i < sortedShops.length; i++) {
            const sid = sortedShops[i]
            const spId = `ok-sp-${i}`
            const pid = `ok-pid-${i}`
            const row = {
              id: spId,
              shop_id: sid,
              product_id: pid,
              stock_quantity: 50,
              max_order_qty: 50,
              is_available: true,
            }
            rowsByShopProductId.set(spId, row)
            cartItems.push({
              productId: pid,
              shopId: sid,
              shopProductId: spId,
              quantity: 1,
              salePrice: 5,
              price: 5,
              lineTotal: 5,
              name: 'OK',
            })
          }

          const ordersRepo = makeOrdersRepo()
          const shopProductsRepo = makeShopProductsRepo(rowsByShopProductId)

          const svc = new OrderSplitterService({
            ordersRepository: ordersRepo,
            shopProductsRepository: shopProductsRepo,
          })
          const groups = svc.splitCart(cartItems)

          let thrown = null
          try {
            await svc.createOrders({
              client: makeFakeClient(),
              userId: USER_ID,
              groups,
              deliveryAddress: {},
              payment: { method: 'COD', status: 'PENDING' },
            })
          } catch (e) {
            thrown = e
          }

          // Splitter throws CHECKOUT_PARTIAL_FAIL once it hits the failing
          // shop in sorted order. Since it sorts first, no other shop has
          // been processed yet — strict no-writes holds.
          expect(thrown).not.toBeNull()
          expect(thrown.code).toBe('CHECKOUT_PARTIAL_FAIL')
          expect(
            thrown.failures.every((f) => f.shopId === FAIL_SHOP)
          ).toBe(true)

          // No order INSERTs at all (failing shop sorts first)
          expect(ordersRepo.create).not.toHaveBeenCalled()
          // No stock UPDATEs at all
          expect(shopProductsRepo.applyStockChange).not.toHaveBeenCalled()
          // The failing shop's stock_quantity is unchanged in the source map
          expect(rowsByShopProductId.get(failedSpId).stock_quantity).toBe(1)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 7.G — Empty cart sentinel
// ═══════════════════════════════════════════════════════════════
describe('Property 7: Transaction Atomicity — empty groups also leave state untouched', () => {
  it('createOrders with an empty group map throws EMPTY_CART and writes nothing', async () => {
    const ordersRepo = makeOrdersRepo()
    const shopProductsRepo = makeShopProductsRepo(new Map())

    const svc = new OrderSplitterService({
      ordersRepository: ordersRepo,
      shopProductsRepository: shopProductsRepo,
    })

    let thrown = null
    try {
      await svc.createOrders({
        client: makeFakeClient(),
        userId: USER_ID,
        groups: new Map(),
        deliveryAddress: {},
        payment: { method: 'COD', status: 'PENDING' },
      })
    } catch (e) {
      thrown = e
    }

    expect(thrown).not.toBeNull()
    expect(thrown.code).toBe('EMPTY_CART')
    expect(Array.isArray(thrown.failures)).toBe(true)
    expect(ordersRepo.create).not.toHaveBeenCalled()
    expect(shopProductsRepo.applyStockChange).not.toHaveBeenCalled()
    expect(shopProductsRepo.findByIdForUpdate).not.toHaveBeenCalled()
  })
})
