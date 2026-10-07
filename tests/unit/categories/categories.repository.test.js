// Coverage for the bundle + category-product-ranking feature added in
// migration 066_category_bundles_and_ranking.sql. Mocked `query()`/
// `getClient()` let us inspect the exact SQL emitted without touching
// Postgres — this is where the actual risk lives (BUNDLE vs STANDARD
// branching, deterministic tie-breakers, transaction correctness).

import { beforeEach, describe, expect, it, vi } from 'vitest'

const clientMock = {
  query: vi.fn(),
  release: vi.fn(),
}

const databaseMock = vi.hoisted(() => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))
vi.mock('../../../src/config/database.js', () => databaseMock)

import { CategoriesRepository } from '../../../src/modules/categories/categories.repository.js'

const CATEGORY_ID = '11111111-1111-1111-1111-111111111111'
const PRODUCT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const PRODUCT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const PRODUCT_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

beforeEach(() => {
  vi.clearAllMocks()
  databaseMock.query.mockResolvedValue({ rows: [], rowCount: 0 })
  databaseMock.getClient.mockResolvedValue(clientMock)
  clientMock.query.mockResolvedValue({ rows: [], rowCount: 0 })
})

describe('CategoriesRepository.findAll — excludes bundles (positive/negative)', () => {
  it('filters out BUNDLE-type categories and enforces is_active', async () => {
    const repo = new CategoriesRepository()
    await repo.findAll()

    const [sql] = databaseMock.query.mock.calls[0]
    expect(sql).toMatch(/category_type\s*!=\s*'BUNDLE'/)
    expect(sql).toMatch(/is_active\s*=\s*true/)
  })
})

describe('CategoriesRepository.findBundles — lists only bundles', () => {
  it('filters to exactly BUNDLE-type categories', async () => {
    const repo = new CategoriesRepository()
    await repo.findBundles()

    const [sql] = databaseMock.query.mock.calls[0]
    expect(sql).toMatch(/category_type\s*=\s*'BUNDLE'/)
  })
})

describe('CategoriesRepository.findProducts — BUNDLE category (positive)', () => {
  it('sources membership from category_products, not p.category_id, ordered by rank', async () => {
    databaseMock.query.mockResolvedValueOnce({ rows: [{ id: PRODUCT_A }], rowCount: 1 })
    databaseMock.query.mockResolvedValueOnce({ rows: [{ total: 1 }], rowCount: 1 })

    const repo = new CategoriesRepository()
    await repo.findProducts(CATEGORY_ID, {
      limit: 20,
      offset: 0,
      categoryType: 'BUNDLE',
    })

    const [dataSql, dataParams] = databaseMock.query.mock.calls[0]
    expect(dataSql).toMatch(/LEFT JOIN category_products cp ON cp\.category_id = \$1 AND cp\.product_id = p\.id/)
    expect(dataSql).toMatch(/cp\.category_id IS NOT NULL/)
    // Word-boundary regex (not just substring) — a naive check would
    // false-positive on "cp.category_id" itself, which legitimately
    // appears in the JOIN clause above.
    expect(dataSql).not.toMatch(/\bp\.category_id = \$1\b/)
    expect(dataSql).toMatch(/ORDER BY cp\.rank ASC, p\.created_at DESC, p\.id ASC/)
    expect(dataParams[0]).toBe(CATEGORY_ID)
  })
})

describe('CategoriesRepository.findProducts — STANDARD category / multi-category (positive + negative)', () => {
  it('membership is the union of the real category_id AND any cross-listing via category_products (multi-category)', async () => {
    databaseMock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    databaseMock.query.mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 })

    const repo = new CategoriesRepository()
    await repo.findProducts(CATEGORY_ID, {
      limit: 20,
      offset: 0,
      categoryType: 'STANDARD',
    })

    const [dataSql] = databaseMock.query.mock.calls[0]
    // A product shows up here if it's the product's real category OR it's
    // been cross-listed — e.g. Baby Potato stays under "Fresh Vegetables"
    // (its real category_id) and can also appear under "Exotic Vegetables"
    // (cross-listed via category_products) without duplication.
    expect(dataSql).toMatch(/\(p\.category_id = \$1 OR cp\.category_id IS NOT NULL\)/)
    expect(dataSql).toMatch(/LEFT JOIN category_products cp ON cp\.category_id = \$1 AND cp\.product_id = p\.id/)
    // Deterministic fallback: rank first, then a fixed tie-breaker chain —
    // this is the fix for "sometimes alphabetical, sometimes by date".
    expect(dataSql).toMatch(/ORDER BY COALESCE\(cp\.rank, 2147483647\) ASC, p\.created_at DESC, p\.id ASC/)
  })

  it('keeps the customer-chosen sort untouched when a sort is explicitly given (join still present for cross-listing)', async () => {
    databaseMock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    databaseMock.query.mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 })

    const repo = new CategoriesRepository()
    await repo.findProducts(CATEGORY_ID, {
      limit: 20,
      offset: 0,
      sort: 'price_asc',
      categoryType: 'STANDARD',
    })

    const [dataSql] = databaseMock.query.mock.calls[0]
    expect(dataSql).toMatch(/ORDER BY p\.price ASC, p\.id ASC/)
    // The join stays even with an explicit sort — it's now part of the
    // membership condition itself, not just the default ordering.
    expect(dataSql).toMatch(/LEFT JOIN category_products cp/)
  })

  it('every sort branch ends in a deterministic p.id tie-breaker (negative: no more unordered ties)', async () => {
    const repo = new CategoriesRepository()
    for (const sort of ['price_asc', 'price_desc', 'newest', 'popular']) {
      databaseMock.query.mockClear()
      databaseMock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
      databaseMock.query.mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 })

      await repo.findProducts(CATEGORY_ID, { limit: 20, offset: 0, sort, categoryType: 'STANDARD' })

      const [dataSql] = databaseMock.query.mock.calls[0]
      expect(dataSql).toMatch(/ORDER BY [^,]+,\s*p\.id ASC/)
    }
  })
})

describe('CategoriesRepository.findProducts — shop-scoped price/stock (the reported "category page shows the wrong store price" bug)', () => {
  const SHOP_A = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
  const SHOP_B = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'

  it('with no allocatedShopIds (admin/anonymous), selects the plain master columns unchanged (negative: no regression)', async () => {
    databaseMock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    databaseMock.query.mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 })

    const repo = new CategoriesRepository()
    await repo.findProducts(CATEGORY_ID, { limit: 20, offset: 0, categoryType: 'STANDARD' })

    const [dataSql] = databaseMock.query.mock.calls[0]
    expect(dataSql).toMatch(/p\.price AS price/)
    expect(dataSql).toMatch(/p\.sale_price AS sale_price/)
    expect(dataSql).toMatch(/p\.stock_quantity AS stock_quantity/)
    expect(dataSql).not.toMatch(/LEFT JOIN LATERAL/)
  })

  it('with allocatedShopIds, resolves price/sale_price/stock from the shop_products LATERAL join, never the bare master columns (the actual bug)', async () => {
    databaseMock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    databaseMock.query.mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 })

    const repo = new CategoriesRepository()
    await repo.findProducts(CATEGORY_ID, {
      limit: 20,
      offset: 0,
      categoryType: 'STANDARD',
      allocatedShopIds: [SHOP_A],
    })

    const [dataSql, dataParams] = databaseMock.query.mock.calls[0]
    expect(dataSql).toMatch(/LEFT JOIN LATERAL/)
    expect(dataSql).toMatch(/COALESCE\(shop_price\.sp_price, p\.price\) AS price/)
    expect(dataSql).toMatch(/shop_price\.sp_sale_price AS sale_price/)
    expect(dataSql).toMatch(/COALESCE\(shop_price\.sp_stock_quantity, p\.stock_quantity\) AS stock_quantity/)
    // The visibility EXISTS check and the price LATERAL join are two
    // separate uses of allocatedShopIds — both must be bound as real
    // query params (this is the exact bug: previously only the EXISTS
    // check used allocatedShopIds, so the price was never actually
    // resolved per-shop even though visibility filtering was correct).
    expect(dataParams.filter((p) => Array.isArray(p) && p[0] === SHOP_A)).toHaveLength(2)
  })

  it('inStock now filters on the shop-scoped stock expression, not the master column, when scoped', async () => {
    databaseMock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    databaseMock.query.mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 })

    const repo = new CategoriesRepository()
    await repo.findProducts(CATEGORY_ID, {
      limit: 20,
      offset: 0,
      categoryType: 'STANDARD',
      allocatedShopIds: [SHOP_A],
      inStock: true,
    })

    const [dataSql] = databaseMock.query.mock.calls[0]
    expect(dataSql).toMatch(/COALESCE\(shop_price\.sp_stock_quantity, p\.stock_quantity\) > 0/)
    expect(dataSql).not.toMatch(/\bp\.stock_quantity > 0\b/)
  })

  it('wholesale priceMode resolves from sp_wholesale_price, falling back through the same chain as products.repository.js', async () => {
    databaseMock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    databaseMock.query.mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 })

    const repo = new CategoriesRepository()
    await repo.findProducts(CATEGORY_ID, {
      limit: 20,
      offset: 0,
      categoryType: 'STANDARD',
      allocatedShopIds: [SHOP_A],
      priceMode: 'wholesale',
    })

    const [dataSql] = databaseMock.query.mock.calls[0]
    expect(dataSql).toMatch(
      /COALESCE\(shop_price\.sp_wholesale_price, p\.wholesale_price, shop_price\.sp_price, p\.price\) AS price/
    )
    // Wholesale has no strike-through sale price — a flat admin-set price only.
    expect(dataSql).toMatch(/NULL AS sale_price/)
  })

  it('the LATERAL join text is present in every query that shares the params array (count queries too) — a future param/placeholder count mismatch would throw at the real Postgres driver even though this mock cannot catch it, so this pins the fix in place', async () => {
    databaseMock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    databaseMock.query.mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 })

    const repo = new CategoriesRepository()
    await repo.findProducts(CATEGORY_ID, {
      limit: 20,
      offset: 0,
      categoryType: 'STANDARD',
      allocatedShopIds: [SHOP_A, SHOP_B],
    })

    const [dataSql, dataParams] = databaseMock.query.mock.calls[0]
    const [countSql, countParams] = databaseMock.query.mock.calls[1]
    expect(countSql).toMatch(/LEFT JOIN LATERAL/)
    // Every placeholder referenced in each query text must have a
    // corresponding entry in that call's own params array.
    const maxPlaceholder = (sql) => {
      const matches = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))
      return matches.length ? Math.max(...matches) : 0
    }
    expect(dataParams.length).toBeGreaterThanOrEqual(maxPlaceholder(dataSql))
    expect(countParams.length).toBeGreaterThanOrEqual(maxPlaceholder(countSql))
  })

  it('groupOptions=true also resolves shop-scoped price/stock (both the ranked data query and its count query)', async () => {
    databaseMock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    databaseMock.query.mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 })

    const repo = new CategoriesRepository()
    await repo.findProducts(CATEGORY_ID, {
      limit: 20,
      offset: 0,
      categoryType: 'STANDARD',
      allocatedShopIds: [SHOP_A],
      groupOptions: true,
    })

    const [dataSql] = databaseMock.query.mock.calls[0]
    const [countSql] = databaseMock.query.mock.calls[1]
    expect(dataSql).toMatch(/COALESCE\(shop_price\.sp_price, p\.price\) AS price/)
    expect(dataSql).toMatch(/LEFT JOIN LATERAL/)
    expect(countSql).toMatch(/LEFT JOIN LATERAL/)
  })
})

describe('CategoriesRepository.setCategoryProducts — transactional replace (positive + negative)', () => {
  it('deletes existing membership then inserts the new list with sequential ranks, then commits', async () => {
    clientMock.query.mockResolvedValue({ rows: [], rowCount: 0 })
    databaseMock.query.mockResolvedValueOnce({ rows: [] }) // getCategoryProductRanks after commit

    const repo = new CategoriesRepository()
    await repo.setCategoryProducts(CATEGORY_ID, [PRODUCT_A, PRODUCT_B, PRODUCT_C])

    const calls = clientMock.query.mock.calls.map((c) => c[0])
    expect(calls[0]).toBe('BEGIN')
    expect(calls[1]).toMatch(/DELETE FROM category_products WHERE category_id = \$1/)
    expect(calls[calls.length - 1]).toBe('COMMIT')

    // Three inserts, one per product, with rank = array index (0,1,2) —
    // this is exactly what makes "drag to reorder" work: the admin sends
    // the full list in the new order and rank is just the position.
    const inserts = clientMock.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO category_products'))
    expect(inserts).toHaveLength(3)
    expect(inserts[0][1]).toEqual([CATEGORY_ID, PRODUCT_A, 0])
    expect(inserts[1][1]).toEqual([CATEGORY_ID, PRODUCT_B, 1])
    expect(inserts[2][1]).toEqual([CATEGORY_ID, PRODUCT_C, 2])

    expect(clientMock.release).toHaveBeenCalledTimes(1)
  })

  it('rolls back and releases the client if an insert fails (negative)', async () => {
    clientMock.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.startsWith('INSERT')) {
        return Promise.reject(new Error('constraint violation'))
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })

    const repo = new CategoriesRepository()
    await expect(repo.setCategoryProducts(CATEGORY_ID, [PRODUCT_A])).rejects.toThrow('constraint violation')

    const calls = clientMock.query.mock.calls.map((c) => c[0])
    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    expect(clientMock.release).toHaveBeenCalledTimes(1)
  })

  it('replacing with an empty list clears all membership (negative: bundle can be emptied)', async () => {
    clientMock.query.mockResolvedValue({ rows: [], rowCount: 0 })
    databaseMock.query.mockResolvedValueOnce({ rows: [] })

    const repo = new CategoriesRepository()
    await repo.setCategoryProducts(CATEGORY_ID, [])

    const inserts = clientMock.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO category_products'))
    expect(inserts).toHaveLength(0)
    const calls = clientMock.query.mock.calls.map((c) => c[0])
    expect(calls).toContain('DELETE FROM category_products WHERE category_id = $1')
    expect(calls).toContain('COMMIT')
  })
})
