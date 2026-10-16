// A customer adding a vendor's product by productId alone (what the app sends)
// must resolve to that vendor's listing when their own storefront does not
// carry it — but never when the listing is pending/paused/B2B-only.

import { describe, expect, it, vi, beforeEach } from 'vitest'

const queryMock = vi.fn()
vi.mock('../../../src/config/database.js', () => ({
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
}))
vi.mock('../../../src/config/redis.js', () => ({ default: {}, redis: {} }))

const { CartRepository } = await import('../../../src/modules/cart/cart.repository.js')

beforeEach(() => queryMock.mockReset())

describe('CartRepository.findShopProductsForProduct — marketplace fallback', () => {
  it('returns allocation rows when the storefront carries the product (no fallback query)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ shop_id: 's1' }] })
    const rows = await new CartRepository().findShopProductsForProduct('u1', 'p1')
    expect(rows).toEqual([{ shop_id: 's1' }])
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to approved/active/B2C/nationwide vendor listings when none is allocated', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ shop_id: 'vendor-shop' }] })
    const rows = await new CartRepository().findShopProductsForProduct('u1', 'p1')
    expect(rows).toEqual([{ shop_id: 'vendor-shop' }])
    const [sql, params] = queryMock.mock.calls[1]
    expect(sql).toMatch(/approval_status = 'APPROVED'/)
    expect(sql).toMatch(/listing_status = 'ACTIVE'/)
    expect(sql).toMatch(/sell_b2c = TRUE/)
    expect(sql).toMatch(/nationwide_shipping_enabled = TRUE/)
    expect(params).toEqual(['p1'])
  })
})
