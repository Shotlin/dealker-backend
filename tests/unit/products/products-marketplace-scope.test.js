// Vendor listings must reach customers: customers are only allocated the
// platform shop, so the products scope also carries vendor shops that sell
// at least one approved/active/B2C/nationwide listing. The repository gates
// every row on those same conditions, so a pending/paused/B2B-only listing
// is never exposed by adding its shop to the scope.

import { describe, expect, it, vi, beforeEach } from 'vitest'

const queryMock = vi.fn(async () => ({ rows: [] }))
vi.mock('../../../src/config/database.js', () => ({
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
}))
vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => {}),
  cacheDeletePattern: vi.fn(async () => {}),
}))

const { ProductsRepository } = await import('../../../src/modules/products/products.repository.js')
const { ProductsService } = await import('../../../src/modules/products/products.service.js')

const PLATFORM = '11111111-1111-1111-1111-111111111111'
const VENDOR_A = '22222222-2222-2222-2222-222222222222'
const GATE = /s\.vendor_id IS NULL OR \(sp\.approval_status = 'APPROVED' AND sp\.listing_status = 'ACTIVE' AND sp\.sell_b2c = TRUE AND sp\.nationwide_shipping_enabled = TRUE\)/

beforeEach(() => queryMock.mockReset().mockResolvedValue({ rows: [] }))

describe('ProductsService — marketplace shop scope', () => {
  const svc = (marketplace) => {
    const repo = { findMarketplaceShopIds: vi.fn(async () => marketplace) }
    const s = new ProductsService(repo, { allocationService: { getStorefrontShopIds: vi.fn(async () => [PLATFORM]) } })
    return { s, repo }
  }

  it('adds vendor shops to a customer with a resolved storefront', async () => {
    const { s } = svc([VENDOR_A])
    expect(await s._resolveAllocatedShopIds({ userId: 'u1' })).toEqual([PLATFORM, VENDOR_A])
  })

  it('does not widen a customer with no allocation (must stay empty)', async () => {
    const repo = { findMarketplaceShopIds: vi.fn(async () => [VENDOR_A]) }
    const s = new ProductsService(repo, { allocationService: { getStorefrontShopIds: vi.fn(async () => []) } })
    expect(await s._resolveAllocatedShopIds({ userId: 'u1' })).toEqual([])
    expect(repo.findMarketplaceShopIds).not.toHaveBeenCalled()
  })

  it('leaves unscoped (admin/anonymous) reads alone', async () => {
    const { s, repo } = svc([VENDOR_A])
    expect(await s._resolveAllocatedShopIds(null)).toBeNull()
    expect(repo.findMarketplaceShopIds).not.toHaveBeenCalled()
  })

  it('fails closed to the platform scope if the vendor lookup errors', async () => {
    const repo = { findMarketplaceShopIds: vi.fn(async () => { throw new Error('db down') }) }
    const s = new ProductsService(repo, { allocationService: { getStorefrontShopIds: vi.fn(async () => [PLATFORM]) } })
    expect(await s._resolveAllocatedShopIds({ userId: 'u1' })).toEqual([PLATFORM])
  })
})

describe('ProductsRepository — vendor listing gate', () => {
  it('findById() only exposes approved/active/B2C/nationwide vendor listings (visibility and price)', async () => {
    await new ProductsRepository().findById('p1', [PLATFORM, VENDOR_A])
    const [sql] = queryMock.mock.calls[0]
    expect(sql.match(new RegExp(GATE.source, 'g'))?.length).toBeGreaterThanOrEqual(2)
  })

  it('findMarketplaceShopIds() selects only live vendor shops with a customer-visible listing', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ shop_id: VENDOR_A }] })
    expect(await new ProductsRepository().findMarketplaceShopIds()).toEqual([VENDOR_A])
    const [sql] = queryMock.mock.calls[0]
    expect(sql).toMatch(/approval_status = 'APPROVED'/)
    expect(sql).toMatch(/sell_b2c = TRUE/)
    expect(sql).toMatch(/nationwide_shipping_enabled = TRUE/)
  })
})
