import { describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn().mockResolvedValue({ rows: [{ has_prior: false }] })

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

import { CouponsRepository } from '../../../src/modules/coupons/coupons.repository.js'

/**
 * Regression coverage for hasPriorOrder() — used by FIRST_TIME coupon
 * targeting. Previously gated on `delivered_at IS NOT NULL`, which
 * correctly stopped a stuck-PENDING failed-payment order from permanently
 * costing a genuine first-time customer their eligibility, but reopened a
 * worse hole: nothing stopped placing several orders back-to-back before
 * the first one ever reached DELIVERED, each still counting as
 * "first-time" (reported: the same first-time discount applied on three
 * separate real orders for one customer). It must now exclude only
 * CANCELLED — including PENDING, since a coupon is consumed the moment an
 * order is placed, not once delivered — relying on payment-expiry.
 * worker.js to auto-cancel any order genuinely abandoned mid-payment
 * instead of excluding PENDING here.
 */
describe('CouponsRepository.hasPriorOrder — gated on placement, not delivery', () => {
  it('excludes only CANCELLED, counts PENDING, and never references delivered_at', async () => {
    queryMock.mockClear()
    const repo = new CouponsRepository()

    await repo.hasPriorOrder('user-1')

    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/status\s*!=\s*'CANCELLED'/i)
    expect(sql).not.toMatch(/PENDING/i)
    expect(sql).not.toMatch(/delivered_at/i)
    expect(params).toEqual(['user-1'])
  })
})

/**
 * Coverage for resolveMatchingProductIds() (088) — the query that
 * determines which cart products a category/product-scoped coupon
 * actually applies to. A category id can be either an ordinary category
 * (matched via products.category_id) or a BUNDLE-type category
 * (066_category_bundles_and_ranking.sql — matched via category_products),
 * so both must be checked without the caller needing to know which kind
 * of id it passed.
 */
describe('CouponsRepository.resolveMatchingProductIds', () => {
  it('returns every cart product unchanged, with no DB query, when the coupon has no scope at all', async () => {
    queryMock.mockClear()
    const repo = new CouponsRepository()

    const result = await repo.resolveMatchingProductIds(['p1', 'p2'], {
      applicableCategoryIds: null,
      applicableProductIds: null,
    })

    expect(result).toEqual(new Set(['p1', 'p2']))
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('short-circuits to an empty set (no query) when the cart itself is empty', async () => {
    queryMock.mockClear()
    const repo = new CouponsRepository()

    const result = await repo.resolveMatchingProductIds([], {
      applicableCategoryIds: ['cat-1'],
      applicableProductIds: null,
    })

    expect(result).toEqual(new Set())
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('queries with both a direct category_id match and a category_products (bundle) EXISTS check, OR-ed together', async () => {
    queryMock.mockClear()
    queryMock.mockResolvedValueOnce({ rows: [{ product_id: 'p1' }, { product_id: 'p3' }] })
    const repo = new CouponsRepository()

    const result = await repo.resolveMatchingProductIds(['p1', 'p2', 'p3'], {
      applicableCategoryIds: ['cat-dairy', 'bundle-combo'],
      applicableProductIds: null,
    })

    expect(result).toEqual(new Set(['p1', 'p3']))
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/p\.category_id\s*=\s*ANY/i)
    expect(sql).toMatch(/category_products/i)
    expect(sql).toMatch(/EXISTS/i)
    expect(params).toEqual([['p1', 'p2', 'p3'], null, ['cat-dairy', 'bundle-combo']])
  })

  it('queries with a direct product_id match when applicableProductIds is set, passing null for the category param', async () => {
    queryMock.mockClear()
    queryMock.mockResolvedValueOnce({ rows: [{ product_id: 'p2' }] })
    const repo = new CouponsRepository()

    const result = await repo.resolveMatchingProductIds(['p1', 'p2'], {
      applicableCategoryIds: null,
      applicableProductIds: ['p2'],
    })

    expect(result).toEqual(new Set(['p2']))
    const [, params] = queryMock.mock.calls[0]
    expect(params).toEqual([['p1', 'p2'], ['p2'], null])
  })
})
