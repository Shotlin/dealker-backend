// Coverage for the admin-configurable category-to-category "Pair With"
// mapping added in migration 080_category_suggestion_rules.sql. Mocked
// `query()`/`getClient()` let us inspect the exact SQL emitted without
// touching Postgres — the real risk here is the delete-then-insert
// transaction (must be atomic) and the service's fallback-on-error /
// cache-invalidation behavior.

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

const cacheMock = vi.hoisted(() => ({
  cacheDel: vi.fn(),
}))
vi.mock('../../../src/utils/cache.js', () => cacheMock)

import { ProductSuggestionsRepository } from '../../../src/modules/product-suggestions/product-suggestions.repository.js'
import { ProductSuggestionsService } from '../../../src/modules/product-suggestions/product-suggestions.service.js'

const DAIRY = '11111111-1111-1111-1111-111111111111'
const BAKERY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const PRODUCE = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

beforeEach(() => {
  vi.clearAllMocks()
  databaseMock.query.mockResolvedValue({ rows: [] })
  databaseMock.getClient.mockResolvedValue(clientMock)
  clientMock.query.mockResolvedValue({ rows: [] })
})

describe('ProductSuggestionsRepository.replaceRulesForSource — atomic delete-then-insert', () => {
  it('wraps the delete + inserts in BEGIN/COMMIT and inserts one row per target, in order', async () => {
    clientMock.query.mockResolvedValue({ rows: [] })
    databaseMock.query.mockResolvedValueOnce({ rows: [{ target_category_id: BAKERY }, { target_category_id: PRODUCE }] })

    const repo = new ProductSuggestionsRepository()
    await repo.replaceRulesForSource(DAIRY, [BAKERY, PRODUCE])

    const calls = clientMock.query.mock.calls.map((c) => c[0])
    expect(calls[0]).toBe('BEGIN')
    expect(calls[1]).toMatch(/DELETE FROM category_suggestion_rules/)
    expect(calls[2]).toMatch(/INSERT INTO category_suggestion_rules/)
    expect(calls[3]).toMatch(/INSERT INTO category_suggestion_rules/)
    expect(calls[calls.length - 1]).toBe('COMMIT')

    // display_order increments 0, 1 in submission order
    const insertParams = clientMock.query.mock.calls.filter((c) => /INSERT/.test(c[0])).map((c) => c[1])
    expect(insertParams[0]).toEqual([DAIRY, BAKERY, 0])
    expect(insertParams[1]).toEqual([DAIRY, PRODUCE, 1])
  })

  it('rolls back and rethrows when an insert fails (e.g. invalid category id)', async () => {
    clientMock.query.mockImplementation((sql) => {
      if (sql.startsWith('INSERT')) return Promise.reject(Object.assign(new Error('fk violation'), { code: '23503' }))
      return Promise.resolve({ rows: [] })
    })

    const repo = new ProductSuggestionsRepository()
    await expect(repo.replaceRulesForSource(DAIRY, ['not-a-real-category'])).rejects.toThrow()

    const calls = clientMock.query.mock.calls.map((c) => c[0])
    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    expect(clientMock.release).toHaveBeenCalled()
  })
})

describe('ProductSuggestionsRepository.getTargetCategoryIds', () => {
  it('queries only active rules for the source category, ordered by display_order', async () => {
    databaseMock.query.mockResolvedValueOnce({ rows: [{ target_category_id: BAKERY }] })

    const repo = new ProductSuggestionsRepository()
    const result = await repo.getTargetCategoryIds(DAIRY)

    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).toMatch(/source_category_id\s*=\s*\$1/)
    expect(sql).toMatch(/is_active\s*=\s*true/)
    expect(sql).toMatch(/ORDER BY display_order/)
    expect(params).toEqual([DAIRY])
    expect(result).toEqual([BAKERY])
  })
})

describe('ProductSuggestionsService.replaceRules', () => {
  it('invalidates the pairwith-categories cache key for the source category on success', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ target_category_id: BAKERY }] })

    const service = new ProductSuggestionsService(new ProductSuggestionsRepository())
    const result = await service.replaceRules(DAIRY, [BAKERY])

    expect(result.success).toBe(true)
    expect(cacheMock.cacheDel).toHaveBeenCalledWith(`products:pairwith-categories:v1:${DAIRY}`)
  })

  it('deduplicates repeated target category ids before saving', async () => {
    databaseMock.query.mockResolvedValue({ rows: [] })
    const repo = new ProductSuggestionsRepository()
    const spy = vi.spyOn(repo, 'replaceRulesForSource')

    const service = new ProductSuggestionsService(repo)
    await service.replaceRules(DAIRY, [BAKERY, BAKERY, PRODUCE])

    expect(spy).toHaveBeenCalledWith(DAIRY, [BAKERY, PRODUCE])
  })

  it('returns a clean validation failure (not a 500) when a target category id does not exist', async () => {
    const repo = new ProductSuggestionsRepository()
    vi.spyOn(repo, 'replaceRulesForSource').mockRejectedValueOnce(
      Object.assign(new Error('fk violation'), { code: '23503' })
    )

    const service = new ProductSuggestionsService(repo)
    const result = await service.replaceRules(DAIRY, ['not-a-real-category'])

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/do not exist/i)
    expect(cacheMock.cacheDel).not.toHaveBeenCalled()
  })
})
