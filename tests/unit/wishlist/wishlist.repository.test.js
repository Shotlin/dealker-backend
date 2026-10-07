// Feature: multi-vendor-system, task 13.2
// Validates: Requirements 3.4, 11.6 (supporting query for wishlist fan-out)
//
// Unit tests for WishlistRepository.findUsersByWishlistedProduct — the
// paginated lookup used by the stock-notifications worker. Drives the
// repository against a stubbed `query` so we can assert exact SQL
// parameter binding and cursor behaviour without touching Postgres.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

import { query } from '../../../src/config/database.js'
import { WishlistRepository } from '../../../src/modules/wishlist/wishlist.repository.js'

const PRODUCT_ID = '11111111-1111-1111-1111-111111111111'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('WishlistRepository.findUsersByWishlistedProduct', () => {
  it('queries with parameterized product_id and default limit when no cursor', async () => {
    query.mockResolvedValueOnce({
      rows: [{ user_id: 'u1' }, { user_id: 'u2' }],
    })

    const repo = new WishlistRepository()
    const rows = await repo.findUsersByWishlistedProduct(PRODUCT_ID)

    expect(rows).toEqual([{ user_id: 'u1' }, { user_id: 'u2' }])
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0]
    // Parameterized: product_id = $1, limit = $2
    expect(sql).toContain('WHERE w.product_id = $1')
    expect(sql).toContain('ORDER BY w.user_id ASC')
    expect(sql).toContain('LIMIT $2')
    expect(params).toEqual([PRODUCT_ID, 200]) // default batch size 200
  })

  it('appends keyset cursor when afterUserId is provided', async () => {
    query.mockResolvedValueOnce({ rows: [] })

    const repo = new WishlistRepository()
    await repo.findUsersByWishlistedProduct(PRODUCT_ID, {
      afterUserId: 'u-cursor',
      limit: 50,
    })

    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('w.user_id > $2')
    expect(sql).toContain('LIMIT $3')
    expect(params).toEqual([PRODUCT_ID, 'u-cursor', 50])
  })

  it('clamps limit to [1, 1000]', async () => {
    query.mockResolvedValue({ rows: [] })
    const repo = new WishlistRepository()

    await repo.findUsersByWishlistedProduct(PRODUCT_ID, { limit: 0 })
    expect(query.mock.calls[0][1]).toEqual([PRODUCT_ID, 1])

    await repo.findUsersByWishlistedProduct(PRODUCT_ID, { limit: 99999 })
    expect(query.mock.calls[1][1]).toEqual([PRODUCT_ID, 1000])

    await repo.findUsersByWishlistedProduct(PRODUCT_ID, { limit: -5 })
    expect(query.mock.calls[2][1]).toEqual([PRODUCT_ID, 1])
  })

  it('falls back to default limit when limit is not a number', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    const repo = new WishlistRepository()

    await repo.findUsersByWishlistedProduct(PRODUCT_ID, { limit: 'abc' })

    expect(query.mock.calls[0][1]).toEqual([PRODUCT_ID, 200])
  })

  it('returns an empty array when no rows match', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    const repo = new WishlistRepository()

    const rows = await repo.findUsersByWishlistedProduct(PRODUCT_ID)

    expect(rows).toEqual([])
  })
})
