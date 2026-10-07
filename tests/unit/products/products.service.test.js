import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external collaborators BEFORE importing the SUT ─────────────
vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  cacheDeletePattern: vi.fn(),
}))

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../../src/config/cloudinary.js', () => ({
  normalizeCloudinaryDeliveryUrl: vi.fn((url) => url),
}))

// Stub BullMQ + Socket.IO — pulled in transitively through AllocationService.
vi.mock('../../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn().mockResolvedValue(undefined) },
  stockNotificationsQueue: { add: vi.fn().mockResolvedValue(undefined) },
  allocationQueue: { add: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('../../../src/plugins/socketio.plugin.js', () => ({
  getSocketIo: vi.fn().mockReturnValue(null),
}))

import { ProductsService } from '../../../src/modules/products/products.service.js'
import { ProductsRepository } from '../../../src/modules/products/products.repository.js'
import { cacheGet, cacheSet } from '../../../src/utils/cache.js'

// ═══════════════════════════════════════════════════════════════════════
// Test fixtures
// ═══════════════════════════════════════════════════════════════════════

const CUSTOMER_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SHOP_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const PRODUCT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

function makeRepoMock() {
  return {
    findMany: vi.fn(),
    fullTextSearch: vi.fn(),
    fuzzySuggest: vi.fn(),
    findFeatured: vi.fn(),
    findById: vi.fn(),
    findBySlug: vi.fn(),
    findRelated: vi.fn(),
    findPairWith: vi.fn(),
    getSuggestionTargetCategoryIds: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateStock: vi.fn(),
    delete: vi.fn(),
    getPriceDrops: vi.fn(),
    getLastMinute: vi.fn(),
  }
}

function makeAllocationServiceMock(shopIds) {
  return {
    getStorefrontShopIds: vi.fn().mockResolvedValue(shopIds),
  }
}

function customerProduct(overrides = {}) {
  return {
    id: PRODUCT_ID,
    name: 'Demo product',
    slug: 'demo-product',
    price: 100,
    sale_price: 80,
    stock_quantity: 5,
    unit: 'piece',
    thumbnail_url: null,
    is_active: true,
    is_featured: false,
    total_sold: 0,
    sku: 'SKU',
    barcode: null,
    low_stock_threshold: 5,
    category_id: 'cat-1',
    category_name: 'Cat',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  cacheGet.mockResolvedValue(null)
  cacheSet.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════
// list() — customer scoping
// ═══════════════════════════════════════════════════════════════════════

describe('ProductsService.list — customer scoping (Req 1.5, 4.5, 11.5)', () => {
  it('forwards allocated_shop_ids to the repository when a customer is authenticated', async () => {
    const repo = makeRepoMock()
    repo.findMany.mockResolvedValueOnce({
      data: [customerProduct()],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    })
    const allocation = makeAllocationServiceMock([SHOP_A, SHOP_B])

    const svc = new ProductsService(repo, { allocationService: allocation })
    const result = await svc.list({ page: 1, limit: 20 }, { userId: CUSTOMER_ID })

    expect(allocation.getStorefrontShopIds).toHaveBeenCalledWith(CUSTOMER_ID)
    expect(repo.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        limit: 20,
        allocatedShopIds: [SHOP_A, SHOP_B],
      })
    )
    expect(result.data).toHaveLength(1)
  })

  it('returns an empty paginated result without hitting the repo when the customer has zero allocations', async () => {
    const repo = makeRepoMock()
    const allocation = makeAllocationServiceMock([])

    const svc = new ProductsService(repo, { allocationService: allocation })
    const result = await svc.list({ page: 1, limit: 20 }, { userId: CUSTOMER_ID })

    expect(repo.findMany).not.toHaveBeenCalled()
    expect(result).toEqual({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    })
  })

  it('passes allocatedShopIds=null for anonymous callers (legacy unscoped behaviour)', async () => {
    const repo = makeRepoMock()
    repo.findMany.mockResolvedValueOnce({
      data: [customerProduct()],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    })
    const allocation = makeAllocationServiceMock([SHOP_A])

    const svc = new ProductsService(repo, { allocationService: allocation })
    await svc.list({ page: 1, limit: 20 }, null)

    expect(allocation.getStorefrontShopIds).not.toHaveBeenCalled()
    expect(repo.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ allocatedShopIds: null })
    )
  })

  it('uses different cache keys for two customers with different allocations (Req 14.7)', async () => {
    const repo = makeRepoMock()
    repo.findMany.mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    })
    const allocationA = makeAllocationServiceMock([SHOP_A])
    const allocationB = makeAllocationServiceMock([SHOP_B])

    const svcA = new ProductsService(repo, { allocationService: allocationA })
    const svcB = new ProductsService(repo, { allocationService: allocationB })

    await svcA.list({ page: 1, limit: 20 }, { userId: CUSTOMER_ID })
    await svcB.list({ page: 1, limit: 20 }, { userId: CUSTOMER_ID })

    const keys = cacheSet.mock.calls.map((args) => args[0])
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toEqual(keys[1])
    // Both should be customer-scoped (start with `c:`)
    expect(keys.every((k) => k.includes(':c:'))).toBe(true)
  })

  it('uses the same cache key for two customers with identical allocations (cache reuse)', async () => {
    const repo = makeRepoMock()
    repo.findMany.mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    })
    const allocation = makeAllocationServiceMock([SHOP_A, SHOP_B])

    const svc = new ProductsService(repo, { allocationService: allocation })
    await svc.list({ page: 1, limit: 20 }, { userId: 'user-1' })
    await svc.list({ page: 1, limit: 20 }, { userId: 'user-2' })

    const keys = cacheSet.mock.calls.map((args) => args[0])
    expect(keys[0]).toEqual(keys[1])
  })

  it('uses a stable cache key irrespective of allocation order (sort invariance)', async () => {
    const repo = makeRepoMock()
    repo.findMany.mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    })

    const svcA = new ProductsService(repo, {
      allocationService: makeAllocationServiceMock([SHOP_A, SHOP_B]),
    })
    const svcB = new ProductsService(repo, {
      allocationService: makeAllocationServiceMock([SHOP_B, SHOP_A]),
    })

    await svcA.list({ page: 1, limit: 20 }, { userId: 'u1' })
    await svcB.list({ page: 1, limit: 20 }, { userId: 'u2' })

    const keys = cacheSet.mock.calls.map((args) => args[0])
    expect(keys[0]).toEqual(keys[1])
  })

  it('falls back to empty visibility when allocation lookup throws (fail-closed)', async () => {
    const repo = makeRepoMock()
    const allocation = {
      getStorefrontShopIds: vi.fn().mockRejectedValue(new Error('redis down')),
    }

    const svc = new ProductsService(repo, { allocationService: allocation })
    const result = await svc.list({ page: 1, limit: 20 }, { userId: CUSTOMER_ID })

    expect(repo.findMany).not.toHaveBeenCalled()
    expect(result.data).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// search() — customer scoping
// ═══════════════════════════════════════════════════════════════════════

describe('ProductsService.search — customer scoping', () => {
  it('forwards allocated_shop_ids to fullTextSearch for authenticated customers', async () => {
    const repo = makeRepoMock()
    repo.fullTextSearch.mockResolvedValueOnce({
      data: [],
      suggestions: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    })
    const allocation = makeAllocationServiceMock([SHOP_A])

    const svc = new ProductsService(repo, { allocationService: allocation })
    await svc.search('milk', { page: 1, limit: 20 }, { userId: CUSTOMER_ID })

    expect(repo.fullTextSearch).toHaveBeenCalledWith(
      'milk',
      expect.objectContaining({ allocatedShopIds: [SHOP_A] })
    )
  })

  it('returns an empty result for customers with zero allocations', async () => {
    const repo = makeRepoMock()
    const allocation = makeAllocationServiceMock([])

    const svc = new ProductsService(repo, { allocationService: allocation })
    const result = await svc.search('milk', { page: 1, limit: 20 }, { userId: CUSTOMER_ID })

    expect(repo.fullTextSearch).not.toHaveBeenCalled()
    expect(result.data).toEqual([])
    expect(result.suggestions).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// getById / getBySlug — customer scoping
// ═══════════════════════════════════════════════════════════════════════

describe('ProductsService.getById/getBySlug — customer scoping', () => {
  it('forwards allocated_shop_ids to findById for authenticated customers', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce(customerProduct())
    const allocation = makeAllocationServiceMock([SHOP_A])

    const svc = new ProductsService(repo, { allocationService: allocation })
    const result = await svc.getById(PRODUCT_ID, { userId: CUSTOMER_ID })

    expect(repo.findById).toHaveBeenCalledWith(PRODUCT_ID, [SHOP_A])
    expect(result.id).toBe(PRODUCT_ID)
  })

  it('returns null when a customer has zero allocations even for valid product ids', async () => {
    const repo = makeRepoMock()
    const allocation = makeAllocationServiceMock([])

    const svc = new ProductsService(repo, { allocationService: allocation })
    const result = await svc.getById(PRODUCT_ID, { userId: CUSTOMER_ID })

    expect(repo.findById).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })

  it('passes allocatedShopIds=null for anonymous callers', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce(customerProduct())
    const allocation = makeAllocationServiceMock([SHOP_A])

    const svc = new ProductsService(repo, { allocationService: allocation })
    await svc.getById(PRODUCT_ID, null)

    expect(repo.findById).toHaveBeenCalledWith(PRODUCT_ID, null)
  })

  it('returns null from getBySlug when product not found in allocated shops', async () => {
    const repo = makeRepoMock()
    repo.findBySlug.mockResolvedValueOnce(null)
    const allocation = makeAllocationServiceMock([SHOP_A])

    const svc = new ProductsService(repo, { allocationService: allocation })
    const result = await svc.getBySlug('demo-product', { userId: CUSTOMER_ID })

    expect(repo.findBySlug).toHaveBeenCalledWith('demo-product', [SHOP_A])
    expect(result).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// getFeatured / getRelated / getPriceDrops / getLastMinute / getPairWith
// ═══════════════════════════════════════════════════════════════════════

describe('ProductsService — other read paths inherit customer scoping', () => {
  it('forwards allocated_shop_ids to findFeatured', async () => {
    const repo = makeRepoMock()
    repo.findFeatured.mockResolvedValueOnce([customerProduct()])
    const allocation = makeAllocationServiceMock([SHOP_A])

    const svc = new ProductsService(repo, { allocationService: allocation })
    await svc.getFeatured({ userId: CUSTOMER_ID })

    expect(repo.findFeatured).toHaveBeenCalledWith(20, [SHOP_A])
  })

  it('forwards allocated_shop_ids to getPriceDrops', async () => {
    const repo = makeRepoMock()
    repo.getPriceDrops.mockResolvedValueOnce([])
    const allocation = makeAllocationServiceMock([SHOP_A])

    const svc = new ProductsService(repo, { allocationService: allocation })
    await svc.getPriceDrops(10, { userId: CUSTOMER_ID })

    expect(repo.getPriceDrops).toHaveBeenCalledWith(10, [SHOP_A])
  })

  it('forwards allocated_shop_ids to getLastMinute', async () => {
    const repo = makeRepoMock()
    repo.getLastMinute.mockResolvedValueOnce([])
    const allocation = makeAllocationServiceMock([SHOP_A])

    const svc = new ProductsService(repo, { allocationService: allocation })
    await svc.getLastMinute(10, { userId: CUSTOMER_ID })

    expect(repo.getLastMinute).toHaveBeenCalledWith(10, [SHOP_A])
  })

  it('forwards allocated_shop_ids to findRelated using the catalog row category', async () => {
    const repo = makeRepoMock()
    repo.findById
      // first call: master-catalog lookup for the category_id
      .mockResolvedValueOnce({ id: PRODUCT_ID, category_id: 'cat-1' })
    repo.findRelated.mockResolvedValueOnce([customerProduct()])
    const allocation = makeAllocationServiceMock([SHOP_A])

    const svc = new ProductsService(repo, { allocationService: allocation })
    await svc.getRelated(PRODUCT_ID, { userId: CUSTOMER_ID })

    expect(repo.findRelated).toHaveBeenCalledWith(PRODUCT_ID, 'cat-1', 10, [SHOP_A])
  })

  it('forwards allocated_shop_ids to findPairWith', async () => {
    const repo = makeRepoMock()
    cacheGet.mockResolvedValueOnce([]) // no configured suggestion rule for 'cat-1'
    repo.findPairWith.mockResolvedValueOnce([])
    const allocation = makeAllocationServiceMock([SHOP_A])

    const svc = new ProductsService(repo, { allocationService: allocation })
    await svc.getPairWith(PRODUCT_ID, 'cat-1', 5, { userId: CUSTOMER_ID })

    expect(repo.findPairWith).toHaveBeenCalledWith(PRODUCT_ID, 'cat-1', 5, [SHOP_A], [])
  })

  it('getPairWith falls back to the DB and caches the result on a cache miss (no rule configured yet)', async () => {
    const repo = makeRepoMock()
    cacheGet.mockResolvedValueOnce(null)
    repo.getSuggestionTargetCategoryIds.mockResolvedValueOnce([])
    repo.findPairWith.mockResolvedValueOnce([])
    const allocation = makeAllocationServiceMock([SHOP_A])

    const svc = new ProductsService(repo, { allocationService: allocation })
    await svc.getPairWith(PRODUCT_ID, 'cat-1', 5, { userId: CUSTOMER_ID })

    expect(repo.getSuggestionTargetCategoryIds).toHaveBeenCalledWith('cat-1')
    expect(cacheSet).toHaveBeenCalledWith('products:pairwith-categories:v1:cat-1', [], 3600)
    expect(repo.findPairWith).toHaveBeenCalledWith(PRODUCT_ID, 'cat-1', 5, [SHOP_A], [])
  })

  it('getPairWith passes an admin-configured target-category list through to findPairWith', async () => {
    const repo = makeRepoMock()
    cacheGet.mockResolvedValueOnce(['cat-dairy', 'cat-bakery'])
    repo.findPairWith.mockResolvedValueOnce([])
    const allocation = makeAllocationServiceMock([SHOP_A])

    const svc = new ProductsService(repo, { allocationService: allocation })
    await svc.getPairWith(PRODUCT_ID, 'cat-1', 5, { userId: CUSTOMER_ID })

    expect(repo.getSuggestionTargetCategoryIds).not.toHaveBeenCalled()
    expect(repo.findPairWith).toHaveBeenCalledWith(PRODUCT_ID, 'cat-1', 5, [SHOP_A], ['cat-dairy', 'cat-bakery'])
  })

  it('returns [] across all collections when the customer has zero allocations', async () => {
    const repo = makeRepoMock()
    const allocation = makeAllocationServiceMock([])

    const svc = new ProductsService(repo, { allocationService: allocation })

    expect(await svc.getFeatured({ userId: CUSTOMER_ID })).toEqual([])
    expect(await svc.getPriceDrops(10, { userId: CUSTOMER_ID })).toEqual([])
    expect(await svc.getLastMinute(10, { userId: CUSTOMER_ID })).toEqual([])
    expect(await svc.getPairWith(PRODUCT_ID, 'cat-1', 5, { userId: CUSTOMER_ID })).toEqual([])

    expect(repo.findFeatured).not.toHaveBeenCalled()
    expect(repo.getPriceDrops).not.toHaveBeenCalled()
    expect(repo.getLastMinute).not.toHaveBeenCalled()
    expect(repo.findPairWith).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Repository SQL safety — defence in depth
// ═══════════════════════════════════════════════════════════════════════

describe('ProductsRepository — customer scoping SQL', () => {
  it('builds an EXISTS subquery against shop_products + shops when allocatedShopIds is set', async () => {
    const { query } = await import('../../../src/config/database.js')
    query.mockImplementation((sql) => {
      if (/COUNT\(/i.test(sql)) return Promise.resolve({ rows: [{ total: 0 }] })
      return Promise.resolve({ rows: [] })
    })

    const repo = new ProductsRepository()
    await repo.findMany({ page: 1, limit: 20, allocatedShopIds: [SHOP_A] })

    const sqlExecuted = query.mock.calls.map((c) => c[0]).join('\n')
    expect(sqlExecuted).toMatch(/EXISTS\s*\(/)
    expect(sqlExecuted).toMatch(/shop_products sp/)
    expect(sqlExecuted).toMatch(/shops s/)
    expect(sqlExecuted).toMatch(/sp\.is_available\s*=\s*true/)
    expect(sqlExecuted).toMatch(/sp\.deleted_at\s+IS\s+NULL/i)
    expect(sqlExecuted).toMatch(/s\.is_active\s*=\s*true/)
    expect(sqlExecuted).toMatch(/s\.deleted_at\s+IS\s+NULL/i)
    expect(sqlExecuted).toMatch(/\$\d+::uuid\[\]/)
  })

  it('emits an unconditionally-false predicate when allocatedShopIds is empty', async () => {
    const { query } = await import('../../../src/config/database.js')
    query.mockImplementation((sql) => {
      if (/COUNT\(/i.test(sql)) return Promise.resolve({ rows: [{ total: 0 }] })
      return Promise.resolve({ rows: [] })
    })

    const repo = new ProductsRepository()
    await repo.findMany({ page: 1, limit: 20, allocatedShopIds: [] })

    const sqlExecuted = query.mock.calls.map((c) => c[0]).join('\n')
    // findMany strips the leading "AND " when no other conditions are
    // present, so the predicate appears as "WHERE FALSE". When other
    // conditions are present it appears as "AND FALSE". Match both.
    expect(sqlExecuted).toMatch(/(WHERE|AND)\s+FALSE/i)
  })

  it('omits the customer-scoping predicate when allocatedShopIds is null', async () => {
    const { query } = await import('../../../src/config/database.js')
    query.mockImplementation((sql) => {
      if (/COUNT\(/i.test(sql)) return Promise.resolve({ rows: [{ total: 0 }] })
      return Promise.resolve({ rows: [] })
    })

    const repo = new ProductsRepository()
    await repo.findMany({ page: 1, limit: 20, allocatedShopIds: null })

    const sqlExecuted = query.mock.calls.map((c) => c[0]).join('\n')
    expect(sqlExecuted).not.toMatch(/EXISTS\s*\(\s*SELECT 1\s+FROM shop_products/i)
  })

  it('uses parameterized placeholders for the shop_ids array (no string interpolation of values)', async () => {
    const { query } = await import('../../../src/config/database.js')
    query.mockImplementation((sql) => {
      if (/COUNT\(/i.test(sql)) return Promise.resolve({ rows: [{ total: 0 }] })
      return Promise.resolve({ rows: [] })
    })

    const repo = new ProductsRepository()
    await repo.findMany({ page: 1, limit: 20, allocatedShopIds: [SHOP_A, SHOP_B] })

    const dataCall = query.mock.calls.find((c) => /SELECT[\s\S]+FROM products p/i.test(c[0]))
    expect(dataCall).toBeDefined()
    const [, params] = dataCall
    // params should contain the array as a single bound value, never inlined into SQL
    const arrayParam = params.find((p) => Array.isArray(p) && p.includes(SHOP_A))
    expect(arrayParam).toEqual([SHOP_A, SHOP_B])
    // SQL must not contain the literal UUIDs
    expect(dataCall[0]).not.toContain(SHOP_A)
    expect(dataCall[0]).not.toContain(SHOP_B)
  })
})

describe('ProductsRepository — findRelated / findPairWith stock filter + category rules', () => {
  it('findRelated excludes zero-stock products', async () => {
    const { query } = await import('../../../src/config/database.js')
    query.mockResolvedValueOnce({ rows: [] })

    const repo = new ProductsRepository()
    await repo.findRelated(PRODUCT_ID, 'cat-1', 10, null)

    const [sql] = query.mock.calls[0]
    expect(sql).toMatch(/p\.stock_quantity\s*>\s*0/)
  })

  it('findPairWith excludes zero-stock products', async () => {
    const { query } = await import('../../../src/config/database.js')
    query.mockResolvedValueOnce({ rows: [] })

    const repo = new ProductsRepository()
    await repo.findPairWith(PRODUCT_ID, 'cat-1', 10, null)

    const [sql] = query.mock.calls[0]
    expect(sql).toMatch(/p\.stock_quantity\s*>\s*0/)
  })

  it('findPairWith falls back to any-other-category when no target categories are configured', async () => {
    const { query } = await import('../../../src/config/database.js')
    query.mockResolvedValueOnce({ rows: [] })

    const repo = new ProductsRepository()
    await repo.findPairWith(PRODUCT_ID, 'cat-1', 10, null, [])

    const [sql, params] = query.mock.calls[0]
    expect(sql).toMatch(/p\.category_id\s*!=\s*\$1/)
    expect(sql).not.toMatch(/ANY/)
    expect(params).toEqual(['cat-1', PRODUCT_ID, 10])
  })

  it('findPairWith restricts to the admin-configured target categories when present', async () => {
    const { query } = await import('../../../src/config/database.js')
    query.mockResolvedValueOnce({ rows: [] })

    const repo = new ProductsRepository()
    await repo.findPairWith(PRODUCT_ID, 'cat-dairy', 10, null, ['cat-dairy', 'cat-bakery'])

    const [sql, params] = query.mock.calls[0]
    expect(sql).toMatch(/p\.category_id\s*=\s*ANY\(\$3::uuid\[\]\)/)
    expect(sql).not.toMatch(/category_id\s*!=/)
    expect(params).toEqual(['cat-dairy', PRODUCT_ID, ['cat-dairy', 'cat-bakery'], 10])
  })

  it('getSuggestionTargetCategoryIds queries active rules for the source category, ordered', async () => {
    const { query } = await import('../../../src/config/database.js')
    query.mockResolvedValueOnce({ rows: [{ target_category_id: 'cat-bakery' }, { target_category_id: 'cat-dairy' }] })

    const repo = new ProductsRepository()
    const result = await repo.getSuggestionTargetCategoryIds('cat-1')

    const [sql, params] = query.mock.calls[0]
    expect(sql).toMatch(/FROM category_suggestion_rules/)
    expect(sql).toMatch(/source_category_id\s*=\s*\$1/)
    expect(sql).toMatch(/is_active\s*=\s*true/)
    expect(params).toEqual(['cat-1'])
    expect(result).toEqual(['cat-bakery', 'cat-dairy'])
  })
})

describe('ProductsRepository — fullTextSearch / fuzzySuggest field coverage (migration 081)', () => {
  it('fullTextSearch ranks the FTS branch with ts_rank_cd (weighted search_vector)', async () => {
    const { query } = await import('../../../src/config/database.js')
    query.mockResolvedValue({ rows: [] })

    const repo = new ProductsRepository()
    await repo.fullTextSearch('milk', { page: 1, limit: 20 })

    const [sql] = query.mock.calls[0]
    expect(sql).toMatch(/ts_rank_cd\(p\.search_vector/)
  })

  it('fullTextSearch\'s ILIKE fallback also matches brand, category name, and tags', async () => {
    const { query } = await import('../../../src/config/database.js')
    query.mockResolvedValue({ rows: [] })

    const repo = new ProductsRepository()
    await repo.fullTextSearch('amul', { page: 1, limit: 20 })

    const [mainSql] = query.mock.calls[0]
    expect(mainSql).toMatch(/p\.brand ILIKE \$2/)
    expect(mainSql).toMatch(/c\.name ILIKE \$2/)
    expect(mainSql).toMatch(/unnest\(p\.tags\)/)

    const [countSql] = query.mock.calls[1]
    expect(countSql).toMatch(/p\.brand ILIKE \$2/)
    expect(countSql).toMatch(/c\.name ILIKE \$2/)
    expect(countSql).toMatch(/unnest\(p\.tags\)/)
  })

  it('fuzzySuggest matches on brand and category name similarity, not just product name', async () => {
    const { query } = await import('../../../src/config/database.js')
    query.mockResolvedValue({ rows: [] })

    const repo = new ProductsRepository()
    await repo.fuzzySuggest('amul')

    const [sql] = query.mock.calls[0]
    expect(sql).toMatch(/similarity\(p\.name, \$1\)/)
    expect(sql).toMatch(/similarity\(COALESCE\(p\.brand, ''\), \$1\)/)
    expect(sql).toMatch(/similarity\(COALESCE\(c\.name, ''\), \$1\)/)
    expect(sql).toMatch(/GREATEST\(/)
  })
})
