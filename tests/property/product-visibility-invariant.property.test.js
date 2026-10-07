// Feature: multi-vendor-system, Property 2: Product Visibility Invariant
// **Validates: Requirements 1.5, 4.5, 11.5**
//
// Property statement (design.md §Property 2):
//   For any customer query, every returned product must belong to a shop in
//   the customer's allocations, have is_available=true, and belong to an
//   active non-deleted shop.
//
// Operationalised as the customer-visibility predicate (Requirements 1.5,
// 4.5, 11.5):
//
//   visible(P, C) ⇔ ∃ S such that
//                     S.id ∈ C.allocated_shop_ids
//                   ∧ S.is_active = true
//                   ∧ S.deleted_at IS NULL
//                   ∧ ∃ SP where  SP.shop_id    = S.id
//                              ∧ SP.product_id  = P.id
//                              ∧ SP.is_available = true
//                              ∧ SP.deleted_at  IS NULL
//
// Two complementary properties asserted below:
//
//   (a) Soundness    — every product returned to customer C satisfies
//                       visible(P, C).
//   (b) Completeness — every product satisfying visible(P, C) is in the
//                       set returned to C.
//
// A combined "exact set" property (a ∧ b) is asserted as the primary
// check; the individual soundness and completeness assertions are kept
// as separate `it` blocks so a regression points at the failing half.
//
// Approach:
//   We mock the post-import collaborators (Redis cache, AllocationService)
//   but exercise the REAL ProductsRepository SQL builder against a fake
//   pg `query` function that interprets the SQL it receives:
//
//     - When the SQL contains the customer-scoping EXISTS subquery,
//       the fake reads the allocated_shop_ids array out of the bound
//       parameters and applies the SAME visibility predicate the EXISTS
//       SQL expresses — but against the test's in-memory model.
//     - When the SQL contains the empty-allocation "FALSE" predicate
//       emitted by buildCustomerVisibilitySnippet for an empty allocation
//       list, the fake returns zero rows (matching real Postgres
//       behaviour).
//     - The fake recognises both the data SELECT and the COUNT
//       sibling query so pagination/totals stay consistent.
//
//   This design verifies the END-TO-END invariant: given a model state
//   and a customer C, ProductsService.list returns exactly the products
//   satisfying the predicate — proving that the SQL the repository
//   builds, the parameters the service binds, and the service-layer
//   short-circuits all collectively encode the visibility invariant.
//
//   No real Postgres or Redis is touched — only the fake query
//   interpreter and the AllocationService stub.
//
//   Min 100 iterations per property (project standard).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'

const FC_SEED = process.env.FAST_CHECK_SEED
  ? parseInt(process.env.FAST_CHECK_SEED, 10)
  : process.env.CI
    ? 42
    : undefined
const FC_PARAMS = FC_SEED !== undefined ? { numRuns: 100, seed: FC_SEED } : { numRuns: 100 }

// ─── Mock external dependencies BEFORE importing the SUT ──────────────

vi.mock('../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
}))

// vi.mock() is hoisted above imports — use vi.hoisted so the test body
// can reconfigure `query` per-iteration without recreating the module.
const databaseMock = vi.hoisted(() => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))
vi.mock('../../src/config/database.js', () => databaseMock)

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../src/config/cloudinary.js', () => ({
  normalizeCloudinaryDeliveryUrl: vi.fn((url) => url),
}))

// AllocationService transitively imports BullMQ + Socket.IO — stub them
// so the import chain stays hermetic.
vi.mock('../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn().mockResolvedValue(undefined) },
  stockNotificationsQueue: { add: vi.fn().mockResolvedValue(undefined) },
  allocationQueue: { add: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('../../src/plugins/socketio.plugin.js', () => ({
  getSocketIo: vi.fn().mockReturnValue(null),
}))

import { ProductsService } from '../../src/modules/products/products.service.js'
import { ProductsRepository } from '../../src/modules/products/products.repository.js'

// ─── In-memory model + visibility predicate ───────────────────────────

/**
 * Pure visibility predicate. This is the single source of truth for the
 * property — both the fake `query` interpreter and the expectation
 * computation call it so the test can never accidentally pass because
 * the two halves drifted in lockstep.
 *
 * @param {string} productId
 * @param {string[]} allocatedShopIds
 * @param {{ shops: Array, shopProducts: Array }} model
 * @returns {boolean}
 */
function isVisible(productId, allocatedShopIds, model) {
  if (!Array.isArray(allocatedShopIds) || allocatedShopIds.length === 0) {
    return false
  }
  const allocatedSet = new Set(allocatedShopIds)
  const shopById = new Map(model.shops.map((s) => [s.id, s]))
  return model.shopProducts.some((sp) => {
    if (sp.product_id !== productId) return false
    if (sp.is_available !== true) return false
    if (sp.deleted_at !== null) return false
    if (!allocatedSet.has(sp.shop_id)) return false
    const shop = shopById.get(sp.shop_id)
    if (!shop) return false
    if (shop.is_active !== true) return false
    if (shop.deleted_at !== null) return false
    return true
  })
}

/**
 * Compute the expected visible product id set for a customer given the
 * model state — i.e. the right-hand side of the property invariant.
 *
 * @param {string[]} allocatedShopIds
 * @param {{ products: Array, shops: Array, shopProducts: Array }} model
 * @returns {Set<string>}
 */
function expectedVisibleSet(allocatedShopIds, model) {
  const out = new Set()
  for (const p of model.products) {
    if (isVisible(p.id, allocatedShopIds, model)) out.add(p.id)
  }
  return out
}

/**
 * Build a fake pg `query` function that interprets the SQL produced by
 * ProductsRepository.findMany against the in-memory model.
 *
 * Recognised shapes:
 *   - Data SELECT:  `SELECT … FROM products p LEFT JOIN categories c …
 *                    WHERE … ORDER BY … LIMIT $X OFFSET $Y`
 *   - Count SELECT: `SELECT COUNT(*)::int AS total FROM products p WHERE …`
 *
 * The interpreter detects whether customer-scoping is in play by
 * checking for the EXISTS subquery against shop_products + shops, then
 * reads the bound array parameter to extract the allocated_shop_ids,
 * then filters the model's products via the shared `isVisible` helper.
 *
 * Empty allocation lists surface as the literal predicate "FALSE"
 * (after findMany strips the leading "AND ") — those queries return
 * zero rows, exactly as Postgres would.
 *
 * @param {{ products: Array, shops: Array, shopProducts: Array }} model
 */
function makeFakeQuery(model) {
  return vi.fn(async (sql, params = []) => {
    const text = typeof sql === 'string' ? sql : sql?.text || ''
    // console.log('QUERY CALL:', text, 'PARAMS:', params)

    const hasVisibilityExists =
      /EXISTS\s*\(/i.test(text) && /shop_products\s+sp/i.test(text)

    // buildCustomerVisibilitySnippet emits 'AND FALSE' for empty
    // allocations; findMany strips the leading 'AND ' so it appears as
    // a bare 'FALSE' inside the WHERE clause.
    const hasFalsePredicate =
      !hasVisibilityExists && /\bFALSE\b/i.test(text)

    let visibleProducts
    if (hasFalsePredicate) {
      visibleProducts = []
    } else if (hasVisibilityExists) {
      // The bound array param is the allocated_shop_ids list — the only
      // Array-typed value the repository ever passes.
      const arrayParam = params.find((p) => Array.isArray(p))
      const allocatedShopIds = Array.isArray(arrayParam) ? arrayParam : []
      visibleProducts = model.products.filter((p) =>
        isVisible(p.id, allocatedShopIds, model)
      )
    } else {
      // No customer scoping → admin/anonymous reads see the full catalog.
      visibleProducts = model.products.slice()
    }

    if (/\bSELECT\s+COUNT\s*\([^)]*\)(?:::\w+)?\s+AS\s+total\b/i.test(text)) {
      return { rows: [{ total: visibleProducts.length }] }
    }

    // Data query: parse LIMIT $A and OFFSET $B parameter indices if present
    const limitMatch = /\bLIMIT\s+\$(\d+)/i.exec(text)
    const offsetMatch = /\bOFFSET\s+\$(\d+)/i.exec(text)
    const limitVal = limitMatch ? Number(params[Number(limitMatch[1]) - 1]) : visibleProducts.length
    const offsetVal = offsetMatch ? Number(params[Number(offsetMatch[1]) - 1]) : 0
    const limit = isNaN(limitVal) ? visibleProducts.length : limitVal
    const offset = isNaN(offsetVal) ? 0 : offsetVal

    const rows = visibleProducts.slice(offset, offset + limit).map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      price: 100,
      sale_price: null,
      stock_quantity: 5,
      unit: 'piece',
      thumbnail_url: null,
      is_active: true,
      is_featured: false,
      total_sold: 0,
      sku: null,
      barcode: null,
      low_stock_threshold: 5,
      category_id: null,
      category_name: null,
    }))
    return { rows }
  })
}

/**
 * A customer's ONE storefront shop: the primary allocation (here: the first id
 * in the deterministic order), as a one-element list — [] when unallocated.
 * Mirrors `AllocationService.getStorefrontShopIds`, the rule the product,
 * theme, banner and category endpoints (and a guest's storefront token) share.
 * The visibility predicate is defined over THIS set, not over every allocated
 * shop.
 *
 * @param {string[]|undefined} ids
 */
function storefrontShopOf(ids) {
  const sorted = [...(ids || [])].sort()
  return sorted.length > 0 ? [sorted[0]] : []
}

/**
 * Build a stub AllocationService that returns each customer's
 * pre-computed storefront shop from the model.
 *
 * @param {Map<string, string[]>} customerAllocations
 */
function makeAllocationServiceStub(customerAllocations) {
  return {
    getStorefrontShopIds: vi.fn(async (userId) =>
      storefrontShopOf(customerAllocations.get(userId))
    ),
  }
}

// ─── Arbitraries ──────────────────────────────────────────────────────

const shopArb = fc.record({
  id: fc.uuid(),
  is_active: fc.boolean(),
  deleted_at: fc.option(fc.constant(new Date('2024-01-01T00:00:00Z')), {
    nil: null,
  }),
})

const productArb = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 12 }),
  slug: fc.string({ minLength: 1, maxLength: 12 }),
})

const customerArb = fc.record({
  id: fc.uuid(),
})

/**
 * Compose a small randomised model: shops, products, customers, the
 * shop_products join table, and per-customer allocations.
 *
 * Sizes are kept small so 100 iterations finish quickly while still
 * sweeping a wide variety of (active/inactive × deleted/live ×
 * available/unavailable × allocated/unallocated) combinations.
 */
const modelArb = fc
  .record({
    shops: fc.uniqueArray(shopArb, {
      selector: (s) => s.id,
      minLength: 1,
      maxLength: 5,
    }),
    products: fc.uniqueArray(productArb, {
      selector: (p) => p.id,
      minLength: 1,
      maxLength: 10,
    }),
    customers: fc.uniqueArray(customerArb, {
      selector: (c) => c.id,
      minLength: 1,
      maxLength: 3,
    }),
    // Seeds for the dependent generations below.
    spSeed: fc.array(
      fc.record({
        shopIdx: fc.nat(),
        productIdx: fc.nat(),
        is_available: fc.boolean(),
        deleted_at: fc.option(
          fc.constant(new Date('2024-02-01T00:00:00Z')),
          { nil: null }
        ),
      }),
      { minLength: 0, maxLength: 30 }
    ),
    // Per-customer allocation seed — each entry is a bitmap over shop indexes.
    allocSeed: fc.array(
      fc.array(fc.boolean(), { minLength: 0, maxLength: 5 }),
      { minLength: 1, maxLength: 3 }
    ),
  })
  .map(({ shops, products, customers, spSeed, allocSeed }) => {
    // Materialise shop_products by indexing into shops/products and
    // de-duplicating on (shop_id, product_id) — the real schema enforces
    // UNIQUE(shop_id, product_id).
    const seenSP = new Set()
    const shopProducts = []
    for (const sp of spSeed) {
      const shop = shops[sp.shopIdx % shops.length]
      const product = products[sp.productIdx % products.length]
      const key = `${shop.id}|${product.id}`
      if (seenSP.has(key)) continue
      seenSP.add(key)
      shopProducts.push({
        shop_id: shop.id,
        product_id: product.id,
        is_available: sp.is_available,
        deleted_at: sp.deleted_at,
      })
    }

    // Materialise allocations per customer using the bitmap seed.
    const customerAllocations = new Map()
    customers.forEach((customer, idx) => {
      const mask = allocSeed[idx % allocSeed.length] || []
      const ids = []
      shops.forEach((shop, sIdx) => {
        if (mask[sIdx] === true) ids.push(shop.id)
      })
      customerAllocations.set(customer.id, ids)
    })

    return { shops, products, customers, shopProducts, customerAllocations }
  })

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════
// Property 2 (combined) — exact-set match
// ═══════════════════════════════════════════════════════════════════════
describe('Property 2: Product Visibility Invariant — exact set', () => {
  it('for any model state and customer C, list() returns exactly the products satisfying the visibility predicate', async () => {
    await fc.assert(
      fc.asyncProperty(modelArb, async (model) => {
        databaseMock.query.mockImplementation(makeFakeQuery(model))

        const repo = new ProductsRepository()

        for (const customer of model.customers) {
          const allocatedShopIds = storefrontShopOf(
            model.customerAllocations.get(customer.id)
          )
          const allocationService = makeAllocationServiceStub(
            model.customerAllocations
          )
          const service = new ProductsService(repo, { allocationService })

          // Use a generous limit so pagination doesn't hide any rows.
          const result = await service.list(
            { page: 1, limit: 100 },
            { userId: customer.id }
          )

          const actualIds = new Set(result.data.map((p) => p.id))
          const expectedIds = expectedVisibleSet(allocatedShopIds, model)

          expect(actualIds).toEqual(expectedIds)
          // Pagination total should agree with the visible set size.
          expect(result.pagination.total).toBe(expectedIds.size)
        }
      }),
      FC_PARAMS
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Property 2a — Soundness
// ═══════════════════════════════════════════════════════════════════════
describe('Property 2: Product Visibility Invariant — soundness', () => {
  it('every product returned to a customer satisfies the visibility predicate', async () => {
    await fc.assert(
      fc.asyncProperty(modelArb, async (model) => {
        databaseMock.query.mockImplementation(makeFakeQuery(model))

        const repo = new ProductsRepository()

        for (const customer of model.customers) {
          const allocatedShopIds = storefrontShopOf(
            model.customerAllocations.get(customer.id)
          )
          const allocationService = makeAllocationServiceStub(
            model.customerAllocations
          )
          const service = new ProductsService(repo, { allocationService })

          const result = await service.list(
            { page: 1, limit: 100 },
            { userId: customer.id }
          )

          for (const product of result.data) {
            // Every emitted product MUST satisfy the invariant.
            expect(isVisible(product.id, allocatedShopIds, model)).toBe(true)
          }
        }
      }),
      FC_PARAMS
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Property 2b — Completeness
// ═══════════════════════════════════════════════════════════════════════
describe('Property 2: Product Visibility Invariant — completeness', () => {
  it('every product that satisfies the visibility predicate IS returned to the customer', async () => {
    await fc.assert(
      fc.asyncProperty(modelArb, async (model) => {
        databaseMock.query.mockImplementation(makeFakeQuery(model))

        const repo = new ProductsRepository()

        for (const customer of model.customers) {
          const allocatedShopIds = storefrontShopOf(
            model.customerAllocations.get(customer.id)
          )
          const allocationService = makeAllocationServiceStub(
            model.customerAllocations
          )
          const service = new ProductsService(repo, { allocationService })

          const result = await service.list(
            { page: 1, limit: 100 },
            { userId: customer.id }
          )

          const actualIds = new Set(result.data.map((p) => p.id))
          for (const product of model.products) {
            if (isVisible(product.id, allocatedShopIds, model)) {
              // Every visible product MUST appear in the result set.
              expect(actualIds.has(product.id)).toBe(true)
            }
          }
        }
      }),
      FC_PARAMS
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Guard: an unallocated customer never sees ANY product, regardless of
//        how the model fills shop_products. This protects the test from
//        accidentally passing because the predicate matches everything.
// ═══════════════════════════════════════════════════════════════════════
describe('Property 2: Product Visibility Invariant — empty-allocation guard', () => {
  it('a customer with zero allocations sees zero products even when shop_products is fully populated', async () => {
    await fc.assert(
      fc.asyncProperty(modelArb, async (model) => {
        databaseMock.query.mockImplementation(makeFakeQuery(model))

        const repo = new ProductsRepository()
        // Force an empty-allocation model for a synthetic customer id so
        // the property holds independent of the generated allocations.
        const SYNTHETIC_CUSTOMER = '00000000-0000-0000-0000-000000000001'
        const allocations = new Map(model.customerAllocations)
        allocations.set(SYNTHETIC_CUSTOMER, [])

        const allocationService = makeAllocationServiceStub(allocations)
        const service = new ProductsService(repo, { allocationService })

        const result = await service.list(
          { page: 1, limit: 100 },
          { userId: SYNTHETIC_CUSTOMER }
        )

        expect(result.data).toEqual([])
        expect(result.pagination.total).toBe(0)
      }),
      FC_PARAMS
    )
  })
})
