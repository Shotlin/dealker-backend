// Regression coverage for a real production bug: every customer-facing
// product query displayed the master products.price/sale_price instead of
// the shop's own shop_products listing price — cart/checkout mostly got
// this right, but browsing showed a different number than what was
// actually charged. Root-caused via order BKLOO-20260718-005 (a shop
// listing priced at ₹150 while the master catalog said ₹290 for the same
// variant — a data-entry mistake that this pricing-pipeline bug made much
// harder to spot, since the browse screens never revealed the mismatch).
//
// The same class of bug existed for stock_quantity: every customer-facing
// query displayed the master products.stock_quantity, so a product a shop
// had actually stocked (or actually run out of) could show the wrong
// availability in search/browse purely because of the unrelated master
// catalog number. Fixed alongside price via the same shop_price join.

import { describe, expect, it, vi, beforeEach } from 'vitest'

const queryMock = vi.fn(async () => ({ rows: [] }))
vi.mock('../../../src/config/database.js', () => ({
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
}))

const { ProductsRepository } = await import('../../../src/modules/products/products.repository.js')

beforeEach(() => {
  queryMock.mockClear()
})

const SHOP_A = '11111111-1111-1111-1111-111111111111'

describe('ProductsRepository — customer-facing price resolution', () => {
  it('findById() joins shop_products and prefers the shop price when allocatedShopIds is set', async () => {
    const repo = new ProductsRepository()
    await repo.findById('product-1', [SHOP_A])

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toContain('LEFT JOIN LATERAL')
    expect(sql).toMatch(/COALESCE\(shop_price\.sp_price, p\.price\) AS price/)
    expect(sql).toMatch(/COALESCE\(shop_price\.sp_sale_price, p\.sale_price\) AS sale_price/)
    // The allocatedShopIds array is bound once for visibility and once
    // for the price join — both must carry the real shop id array.
    expect(params.filter((p) => Array.isArray(p) && p.includes(SHOP_A)).length).toBe(2)
  })

  it('findById() falls back to the master price for admin/anonymous callers (allocatedShopIds = null)', async () => {
    const repo = new ProductsRepository()
    await repo.findById('product-1', null)

    const [sql] = queryMock.mock.calls[0]
    expect(sql).not.toContain('LEFT JOIN LATERAL')
    expect(sql).toMatch(/p\.price AS price,\s*p\.sale_price AS sale_price/)
  })

  it('findMany() (plain branch) resolves price from shop_products when scoped to a customer', async () => {
    const repo = new ProductsRepository()
    await repo.findMany({ allocatedShopIds: [SHOP_A] })

    const [sql] = queryMock.mock.calls[0]
    expect(sql).toContain('LEFT JOIN LATERAL')
    expect(sql).toMatch(/COALESCE\(shop_price\.sp_price, p\.price\) AS price/)
  })

  it('findMany() (groupOptions branch) resolves price from shop_products when scoped to a customer', async () => {
    const repo = new ProductsRepository()
    await repo.findMany({ allocatedShopIds: [SHOP_A], groupOptions: true })

    const [sql] = queryMock.mock.calls[0]
    expect(sql).toContain('LEFT JOIN LATERAL')
    expect(sql).toMatch(/COALESCE\(shop_price\.sp_price, p\.price\) AS price/)
  })

  it('does not apply the shop-price join for admin listing calls', async () => {
    const repo = new ProductsRepository()
    await repo.findMany({ status: 'active' })

    const [sql] = queryMock.mock.calls[0]
    expect(sql).not.toContain('LEFT JOIN LATERAL')
  })
})

describe('ProductsRepository — customer-facing stock resolution', () => {
  it('findById() resolves stock_quantity from shop_products when allocatedShopIds is set', async () => {
    const repo = new ProductsRepository()
    await repo.findById('product-1', [SHOP_A])

    const [sql] = queryMock.mock.calls[0]
    expect(sql).toMatch(/COALESCE\(shop_price\.sp_stock_quantity, p\.stock_quantity\) AS stock_quantity/)
  })

  it('findById() falls back to master stock_quantity for admin/anonymous callers', async () => {
    const repo = new ProductsRepository()
    await repo.findById('product-1', null)

    const [sql] = queryMock.mock.calls[0]
    expect(sql).toMatch(/p\.stock_quantity AS stock_quantity/)
  })

  it('findMany() out_of_stock/low_stock/inStock filters reference the resolved shop stock, not the raw master column, when customer-scoped', async () => {
    const repo = new ProductsRepository()
    await repo.findMany({ allocatedShopIds: [SHOP_A], status: 'out_of_stock' })
    let [sql] = queryMock.mock.calls[0]
    expect(sql).toMatch(/COALESCE\(shop_price\.sp_stock_quantity, p\.stock_quantity\) = 0/)

    queryMock.mockClear()
    await repo.findMany({ allocatedShopIds: [SHOP_A], inStock: true })
    ;[sql] = queryMock.mock.calls[0]
    expect(sql).toMatch(/COALESCE\(shop_price\.sp_stock_quantity, p\.stock_quantity\) > 0/)
  })

  it('findMany() count query joins shop_products too, so a customer-scoped stock filter does not reference an undefined alias', async () => {
    const repo = new ProductsRepository()
    await repo.findMany({ allocatedShopIds: [SHOP_A], status: 'out_of_stock' })

    // [0] = data query, [1] = count query — both must carry the LATERAL
    // join whenever the WHERE clause references shop_price.*.
    const [countSql] = queryMock.mock.calls[1]
    expect(countSql).toContain('LEFT JOIN LATERAL')
    expect(countSql).toMatch(/shop_price\.sp_stock_quantity/)
  })

  it('findRelated()/findPairWith() require shop stock > 0, not master stock, when customer-scoped', async () => {
    const repo = new ProductsRepository()
    await repo.findRelated('product-1', 'cat-1', 10, [SHOP_A])
    let [sql] = queryMock.mock.calls[0]
    expect(sql).toMatch(/COALESCE\(shop_price\.sp_stock_quantity, p\.stock_quantity\) > 0/)

    queryMock.mockClear()
    await repo.findPairWith('product-1', 'cat-1', 10, [SHOP_A])
    ;[sql] = queryMock.mock.calls[0]
    expect(sql).toMatch(/COALESCE\(shop_price\.sp_stock_quantity, p\.stock_quantity\) > 0/)
  })
})

// Regression coverage for a real bug this fix introduced and shipped to
// production before being caught: fullTextSearch()'s countSql never joins
// shop_price (it only counts matching ids), so it must never be called with
// the extra shopPrice param that buildShopPriceJoin() appends to `params`
// for the main data query — Postgres rejects the bind with "supplies N
// parameters, but prepared statement requires N-1" the moment a customer
// (allocatedShopIds set) searches. The SQL-text regex tests above wouldn't
// catch this class of bug at all, since the string looks fine — only the
// actual param COUNT passed alongside it is wrong. Caught via a live
// production dry-run immediately after deploying, not by the test suite.
function maxPlaceholder(sql) {
  const matches = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))
  return matches.length ? Math.max(...matches) : 0
}

describe('ProductsRepository — query/params placeholder-count consistency', () => {
  it('fullTextSearch(): every query call receives exactly as many params as its highest $N placeholder, customer-scoped', async () => {
    const repo = new ProductsRepository()
    await repo.fullTextSearch('peda', { allocatedShopIds: [SHOP_A] })

    expect(queryMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    for (const [sql, params] of queryMock.mock.calls) {
      expect(params.length, `params length mismatch for query:\n${sql}`).toBe(maxPlaceholder(sql))
    }
  })

  it('fullTextSearch(): same consistency check for anonymous/admin callers (allocatedShopIds = null)', async () => {
    const repo = new ProductsRepository()
    await repo.fullTextSearch('peda', { allocatedShopIds: null })

    for (const [sql, params] of queryMock.mock.calls) {
      expect(params.length, `params length mismatch for query:\n${sql}`).toBe(maxPlaceholder(sql))
    }
  })

  it('findMany(), findRelated(), findPairWith(), fuzzySuggest(), findFeatured(), getPriceDrops(), getLastMinute(): same consistency check', async () => {
    const repo = new ProductsRepository()
    queryMock.mockClear()
    await repo.findMany({ allocatedShopIds: [SHOP_A], status: 'out_of_stock' })
    await repo.findRelated('product-1', 'cat-1', 10, [SHOP_A])
    await repo.findPairWith('product-1', 'cat-1', 10, [SHOP_A])
    await repo.fuzzySuggest('peda', 6, [SHOP_A])
    await repo.findFeatured(20, [SHOP_A])
    await repo.getPriceDrops(10, [SHOP_A])
    await repo.getLastMinute(10, [SHOP_A])

    for (const [sql, params] of queryMock.mock.calls) {
      expect(params.length, `params length mismatch for query:\n${sql}`).toBe(maxPlaceholder(sql))
    }
  })
})

describe('ProductsRepository.findFamilyOptions — overwrites price, never leaves both fields', () => {
  it('overwrites price/sale_price from the matched shop listing and drops the redundant sp_* keys (standalone product)', async () => {
    const repo = new ProductsRepository()
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'product-1', price: '290.00', sale_price: null, product_family_id: null }],
      })
      .mockResolvedValueOnce({
        rows: [{
          product_id: 'product-1', shop_product_id: 'sp-1', shop_id: SHOP_A,
          sp_price: '150.00', sp_sale_price: null,
          stock_quantity: 98, max_order_qty: 100, is_available: true,
        }],
      })

    const result = await repo.findFamilyOptions('product-1', [SHOP_A])

    expect(result.options).toHaveLength(1)
    const [option] = result.options
    expect(option.price).toBe('150.00')
    expect(option.sale_price).toBeNull()
    expect(option).not.toHaveProperty('sp_price')
    expect(option).not.toHaveProperty('sp_sale_price')
    // A shop's own stock (98) must win over whatever the master row had —
    // a shop with real stock showing "not available" because of an
    // unrelated master stock number is the other half of this bug.
    expect(option.stock_quantity).toBe(98)
    expect(option).not.toHaveProperty('sp_stock_quantity')
    expect(option).not.toHaveProperty('sp_is_available')
  })

  it('overwrites price for every option in a family, not just the first', async () => {
    const repo = new ProductsRepository()
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'product-500g', price: '290.00', sale_price: null, product_family_id: 'family-1' }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'family-1', name: 'Sumul Malai Peda' }],
      })
      .mockResolvedValueOnce({
        rows: [
          { id: 'product-100g', price: '150.00', sale_price: null, product_family_id: 'family-1' },
          { id: 'product-500g', price: '290.00', sale_price: null, product_family_id: 'family-1' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { product_id: 'product-100g', shop_product_id: 'sp-100', shop_id: SHOP_A, sp_price: '290.00', sp_sale_price: null, stock_quantity: 100, max_order_qty: 100, is_available: true },
          { product_id: 'product-500g', shop_product_id: 'sp-500', shop_id: SHOP_A, sp_price: '150.00', sp_sale_price: null, stock_quantity: 98, max_order_qty: 100, is_available: true },
        ],
      })

    const result = await repo.findFamilyOptions('product-500g', [SHOP_A])

    const byId = Object.fromEntries(result.options.map((o) => [o.id, o]))
    // The exact bug from BKLOO-20260718-005: the shop's 100gm/500gm
    // listings had their prices crossed. Whatever the shop_products rows
    // say is what must come through — never the master price sitting
    // alongside it.
    expect(byId['product-100g'].price).toBe('290.00')
    expect(byId['product-500g'].price).toBe('150.00')
    expect(byId['product-100g']).not.toHaveProperty('sp_price')
    expect(byId['product-500g']).not.toHaveProperty('sp_price')
    // Same crossing bug, for stock: each shop listing's own stock number
    // must come through per-option, never the sibling's or the master's.
    expect(byId['product-100g'].stock_quantity).toBe(100)
    expect(byId['product-500g'].stock_quantity).toBe(98)
    expect(byId['product-100g']).not.toHaveProperty('sp_stock_quantity')
    expect(byId['product-500g']).not.toHaveProperty('sp_stock_quantity')
  })
})

describe('B2B pricing', () => {
  it('resolves shop wholesale prices for lists, details, search and featured products', async () => {
    const repo = new ProductsRepository()
    await repo.findMany({ allocatedShopIds: [SHOP_A], priceMode: 'wholesale' })
    await repo.findById('product-1', [SHOP_A], 'wholesale')
    await repo.fullTextSearch('peda', { allocatedShopIds: [SHOP_A], priceMode: 'wholesale' })
    await repo.findFeatured(20, [SHOP_A], 'wholesale')
    const dataQueries = queryMock.mock.calls.filter(([sql]) => sql.includes(' AS price'))
    expect(dataQueries.length).toBeGreaterThanOrEqual(4)
    for (const [sql, params] of dataQueries) {
      expect(sql).toContain('COALESCE(shop_price.sp_wholesale_price, p.wholesale_price, shop_price.sp_price, p.price) AS price')
      expect(sql).toContain('NULL AS sale_price')
      expect(params.length).toBe(maxPlaceholder(sql))
    }
  })
})
