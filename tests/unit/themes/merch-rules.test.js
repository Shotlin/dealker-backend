import { describe, expect, it, vi } from 'vitest'

// merch-rules imports the DB layer; these tests only cover the pure normalisation.
vi.mock('../../../src/config/database.js', () => ({ query: vi.fn() }))
vi.mock('../../../src/modules/products/products.repository.js', () => ({
  buildCustomerVisibilitySnippet: vi.fn(),
  buildShopPriceJoin: vi.fn(),
}))
vi.mock('../../../src/utils/product-card-fields.js', () => ({ withCardFields: vi.fn(async (rows) => rows) }))

const { normalizeRules, RULE_SORTS } = await import('../../../src/modules/themes/merch-rules.js')
const { isCampaignId } = await import('../../../src/modules/themes/merch-deals.js')

const CAT = '3f2b6c1e-8a4d-4f0e-9b7a-1c2d3e4f5a6b'

describe('normalizeRules', () => {
  it('returns null when nothing is set', () => {
    expect(normalizeRules(undefined)).toBeNull()
    expect(normalizeRules(null)).toBeNull()
    expect(normalizeRules({})).toBeNull()
    expect(normalizeRules('x')).toBeNull()
  })

  it('treats a sort alone as an active rule set', () => {
    expect(normalizeRules({ sort: 'discount' })).toMatchObject({ sort: 'discount' })
  })

  it('falls back to best_selling for an unknown sort', () => {
    expect(normalizeRules({ max_price: 100, sort: 'drop table' }).sort).toBe('best_selling')
    expect(RULE_SORTS).toContain('best_selling')
  })

  it('clamps numbers and drops junk', () => {
    const r = normalizeRules({ min_price: -5, max_price: 'abc', min_discount: 500, min_rating: 9, new_within_days: 0, max_per_brand: 9999 })
    expect(r.min_price).toBeNull()
    expect(r.max_price).toBeNull()
    expect(r.min_discount).toBe(95)
    expect(r.min_rating).toBe(5)
    expect(r.new_within_days).toBeNull()
    expect(r.max_per_brand).toBe(50)
  })

  it('keeps only valid category ids and trims brand/tag lists', () => {
    const r = normalizeRules({ category_ids: [CAT, 'nope', 42], brands: [' Redmi ', '', 'boAt'], tags: ['  a '] })
    expect(r.category_ids).toEqual([CAT])
    expect(r.brands).toEqual(['Redmi', 'boAt'])
    expect(r.tags).toEqual(['a'])
  })

  it('is idempotent: normalising twice gives the same result (unset numbers stay unset)', () => {
    const once = normalizeRules({ sort: 'discount', max_per_brand: 1 })
    expect(once.max_price).toBeNull()
    expect(normalizeRules(once)).toEqual(once)
    expect(normalizeRules(once).max_price).toBeNull()
    expect(normalizeRules({ min_price: 0 }).min_price).toBe(0)
    expect(normalizeRules({ max_price: '', min_rating: 4 }).max_price).toBeNull()
  })

  it('caps list sizes', () => {
    const r = normalizeRules({ brands: Array.from({ length: 100 }, (_, i) => `b${i}`) })
    expect(r.brands).toHaveLength(30)
  })
})

describe('isCampaignId', () => {
  it('accepts uuids only', () => {
    expect(isCampaignId(CAT)).toBe(true)
    expect(isCampaignId('abc')).toBe(false)
    expect(isCampaignId(null)).toBe(false)
    expect(isCampaignId(undefined)).toBe(false)
    expect(isCampaignId(123)).toBe(false)
  })
})
