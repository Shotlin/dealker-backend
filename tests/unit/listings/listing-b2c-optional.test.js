import { describe, expect, it, vi } from 'vitest'

// A wholesale (B2B) listing must NOT also appear to customers unless the vendor opts in to B2C.

vi.hoisted(() => {
  const d = { JWT_ACCESS_SECRET: 'a'.repeat(64), JWT_REFRESH_SECRET: 'b'.repeat(64), COOKIE_SECRET: 'c'.repeat(32),
    DB_NAME: 'x', DB_USER: 'x', DB_PASSWORD: 'x' }
  for (const [k, v] of Object.entries(d)) process.env[k] ||= v
})

const h = vi.hoisted(() => ({ client: { query: vi.fn(), release: vi.fn() }, query: vi.fn() }))
vi.mock('../../../src/config/database.js', () => ({ query: h.query, getClient: async () => h.client }))
vi.mock('../../../src/config/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../../../src/modules/subscriptions/subscriptions.service.js', () => ({ SubscriptionsService: class { async assertCanList() {} } }))
vi.mock('../../../src/modules/qc/qc.service.js', () => ({ QcService: class { async autoIfEnabled() {} }, QC_STATUSES: [] }))

const { listingsService, wantsB2c } = await import('../../../src/modules/listings/listings.service.js')

const base = { name: 'iPhone 16', categoryId: 'c1', condition: 'NEW', stock: 10, images: ['a', 'b', 'c'] }

describe('B2C is optional on a B2B listing', () => {
  it('wantsB2c: explicit flag wins; B2B without the flag is B2B-only; no flags = retail', () => {
    expect(wantsB2c({ sellB2b: true })).toBe(false)
    expect(wantsB2c({ sellB2b: true, sellB2c: true })).toBe(true)
    expect(wantsB2c({ sellB2b: true, sellB2c: false })).toBe(false)
    expect(wantsB2c({ sellB2c: false })).toBe(false)
    expect(wantsB2c({})).toBe(true)
    expect(wantsB2c({ sellB2b: false })).toBe(true)
  })

  it('a B2B-only request needs no retail price and is not stored as B2C', () => {
    expect(() => listingsService.validate({ ...base, sellB2b: true, wholesalePrice: 900, moq: 2 })).not.toThrow()
    expect(() => listingsService.validate({ ...base, sellB2b: true, sellB2c: true, wholesalePrice: 900, moq: 2 }))
      .toThrow(/Selling price is required/)
  })

  it('create() writes sell_b2c = false for a B2B request that does not ask for B2C', async () => {
    const inserts = []
    h.client.query.mockImplementation(async (sql, params) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] }
      if (/FROM shops s JOIN vendors v/.test(sql)) return { rows: [{ id: 'shop-1' }] }
      if (/INSERT INTO products/.test(sql)) return { rows: [{ id: 'p1' }] }
      if (/INSERT INTO shop_products/.test(sql)) { inserts.push(params); return { rows: [{ id: 'sp1' }] } }
      return { rows: [] }
    })
    // detail() after commit is not under test
    vi.spyOn(listingsService, 'detail').mockResolvedValue({ ok: true })
    await listingsService.create({ ...base, sellB2b: true, wholesalePrice: 900, moq: 2 }, { vendorId: 'v1' })
    // params: …, $18 moq, $19 sell_b2c, $20 sell_b2b
    expect(inserts[0][18]).toBe(false)
    expect(inserts[0][19]).toBe(true)
  })
})
