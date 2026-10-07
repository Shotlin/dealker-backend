// Coverage for the "category-bound home sections sometimes miss products"
// bug: getProductsByCategoryIds() in public.controller.js only checked a
// product's primary category_id, missing the multi-category cross-listing
// join (category_products) that categories.repository.js already handles
// correctly for the regular category browse page. Also covers the
// secondary fairness fix (a section bound to multiple categories no longer
// lets one category's products crowd out another's).

import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMock = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../../../src/config/database.js', () => databaseMock)

vi.mock('../../../src/config/redis.js', () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { getProductsByCategoryIds } from '../../../src/modules/themes/public.controller.js'

const CATEGORY_A = '11111111-1111-1111-1111-111111111111'
const CATEGORY_B = '22222222-2222-2222-2222-222222222222'
const PRODUCT_X = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

beforeEach(() => {
  vi.clearAllMocks()
  databaseMock.query.mockResolvedValue({ rows: [] })
})

describe('getProductsByCategoryIds — multi-category cross-listing (positive/negative)', () => {
  it('returns [] without querying when categoryIds is empty or limit <= 0 (negative)', async () => {
    expect(await getProductsByCategoryIds([], 10)).toEqual([])
    expect(await getProductsByCategoryIds([CATEGORY_A], 0)).toEqual([])
    expect(await getProductsByCategoryIds(null, 10)).toEqual([])
    expect(databaseMock.query).not.toHaveBeenCalled()
  })

  it('matches a product via its real category_id OR cross-listing through category_products (positive — the actual bug fix)', async () => {
    await getProductsByCategoryIds([CATEGORY_A], 10)

    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).toMatch(/p\.category_id = cat\.id/)
    expect(sql).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM category_products cp\s*WHERE cp\.product_id = p\.id AND cp\.category_id = cat\.id\s*\)/
    )
    expect(params[0]).toEqual([CATEGORY_A])
    expect(params[1]).toBe(10)
  })

  it('still applies is_active / stock_quantity filters and excludeIds (negative)', async () => {
    await getProductsByCategoryIds([CATEGORY_A], 10, [PRODUCT_X])

    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).toMatch(/p\.is_active = true AND p\.stock_quantity > 0/)
    expect(sql).toMatch(/AND NOT \(p\.id = ANY\(\$3::uuid\[\]\)\)/)
    expect(params[2]).toEqual([PRODUCT_X])
  })

  it('omits the exclude clause entirely when no excludeIds are given', async () => {
    await getProductsByCategoryIds([CATEGORY_A], 10)

    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).not.toMatch(/NOT \(p\.id = ANY/)
    expect(params).toHaveLength(2)
  })

  it('interleaves fairly across multiple categories via a per-category ROW_NUMBER, not one global LIMIT (positive — fixes category starvation)', async () => {
    await getProductsByCategoryIds([CATEGORY_A, CATEGORY_B], 20)

    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).toMatch(/unnest\(\$1::uuid\[\]\) WITH ORDINALITY AS cat\(id, ord\)/)
    expect(sql).toMatch(
      /ROW_NUMBER\(\) OVER \(\s*PARTITION BY bm\.matched_category_id/
    )
    expect(sql).toMatch(/ORDER BY local_rank ASC, is_featured DESC, total_sold DESC, created_at DESC/)
    expect(params[0]).toEqual([CATEGORY_A, CATEGORY_B])
  })

  it('every column referenced in the outer ORDER BY is actually selected inside the ranked CTE (regression guard)', async () => {
    // A raw-SQL regression that string-matching alone won't catch: the
    // outer ORDER BY can only reference columns Postgres can actually see
    // on `ranked` (its own SELECT list) — referencing p.created_at inside
    // the window function's own ORDER BY does NOT make `created_at`
    // available outside the CTE. This caught a real "column created_at
    // does not exist" 500 in production before this test existed.
    await getProductsByCategoryIds([CATEGORY_A], 10)

    const [sql] = databaseMock.query.mock.calls[0]
    const cteBody = sql.slice(sql.indexOf('ranked AS ('), sql.indexOf('FROM ranked'))
    const orderByMatch = sql.match(/ORDER BY ([^\n]+)\s*LIMIT/)
    expect(orderByMatch).not.toBeNull()
    const orderColumns = orderByMatch[1]
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
    for (const column of orderColumns) {
      // local_rank is defined by the window function itself, not a plain
      // column — everything else must appear as `p.<column>` (or an alias)
      // in the CTE body.
      if (column === 'local_rank') continue
      expect(cteBody).toMatch(new RegExp(`p\\.${column}\\b`))
    }
  })

  it('deduplicates a product reachable via more than one requested category (negative: never returned twice)', async () => {
    await getProductsByCategoryIds([CATEGORY_A, CATEGORY_B], 20)

    const [sql] = databaseMock.query.mock.calls[0]
    // DISTINCT ON (product_id) ... ORDER BY product_id, ord ASC keeps only
    // the first (lowest-ordinal) match per product.
    expect(sql).toMatch(/DISTINCT ON \(product_id\) product_id, matched_category_id/)
  })

  it('does not leak the internal local_rank ranking column into the returned rows', async () => {
    await getProductsByCategoryIds([CATEGORY_A], 10)

    const [sql] = databaseMock.query.mock.calls[0]
    // local_rank is used to ORDER BY (fine — Postgres allows ordering by a
    // column of the FROM'd relation without selecting it) but must not
    // appear in the final column list itself.
    const finalColumnList = sql.slice(sql.lastIndexOf('SELECT'), sql.indexOf('FROM ranked'))
    expect(finalColumnList).not.toMatch(/local_rank/)
  })
})
