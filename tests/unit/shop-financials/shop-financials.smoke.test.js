import { describe, it, expect, vi } from 'vitest'

// Avoid touching Redis/Postgres during the smoke test
vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  ShopFinancialsService,
  SHOP_FINANCIALS_CACHE_PREFIX,
  SHOP_FINANCIALS_CACHE_TTL_SECONDS,
} from '../../../src/modules/shop-financials/shop-financials.service.js'
import { ShopFinancialsRepository } from '../../../src/modules/shop-financials/shop-financials.repository.js'
import { ShopFinancialsController } from '../../../src/modules/shop-financials/shop-financials.controller.js'
import {
  listShopFinancialsQuerySchema,
  shopFinancialIdParamSchema,
  PERIOD_TYPES,
  PAYOUT_STATUSES,
} from '../../../src/modules/shop-financials/shop-financials.schema.js'

// ═══════════════════════════════════════════════════════════
// Smoke tests — module wiring + Zod schema correctness
// Validates: Requirements 6.1, 6.5, 6.6, 14.5, 14.7
// ═══════════════════════════════════════════════════════════

describe('shop-financials module bootstrap', () => {
  it('exports the Repository / Service / Controller classes', () => {
    const repo = new ShopFinancialsRepository()
    const service = new ShopFinancialsService(repo)
    const controller = new ShopFinancialsController(service)

    expect(typeof service.list).toBe('function')
    expect(typeof service.getById).toBe('function')
    expect(typeof service.invalidateForShop).toBe('function')
    expect(typeof service.authorizeRead).toBe('function')
    expect(typeof service.cacheKeyForList).toBe('function')

    expect(typeof controller.list).toBe('function')
    expect(typeof controller.getOne).toBe('function')

    expect(typeof repo.findById).toBe('function')
    expect(typeof repo.findMany).toBe('function')
  })

  it('repository never selects with SELECT *', () => {
    // Defence-in-depth: column projection must be explicit. This catches
    // refactors that accidentally reintroduce SELECT *.
    expect(ShopFinancialsRepository.SELECT_COLUMNS).toMatch(/id, shop_id/)
    expect(ShopFinancialsRepository.SELECT_COLUMNS).not.toContain('*')
  })
})

describe('shop-financials schema validation', () => {
  // Requirement 6.1 — period_type is one of DAILY / WEEKLY / MONTHLY
  it('exposes the canonical PERIOD_TYPES enum', () => {
    expect(PERIOD_TYPES).toEqual(['DAILY', 'WEEKLY', 'MONTHLY'])
  })

  it('exposes the canonical PAYOUT_STATUSES enum', () => {
    expect(PAYOUT_STATUSES).toEqual(['PENDING', 'PROCESSING', 'PAID', 'HELD'])
  })

  // Requirement 6.6 — pagination default 20, max 100
  it('uses default page=1 limit=20 on list', () => {
    const result = listShopFinancialsQuerySchema.safeParse({})
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ page: 1, limit: 20 })
  })

  it('caps list limit at 100', () => {
    const result = listShopFinancialsQuerySchema.safeParse({
      page: '1',
      limit: '101',
    })
    expect(result.success).toBe(false)
  })

  it('coerces numeric query params from strings', () => {
    const result = listShopFinancialsQuerySchema.safeParse({
      page: '3',
      limit: '50',
    })
    expect(result.success).toBe(true)
    expect(result.data.page).toBe(3)
    expect(result.data.limit).toBe(50)
  })

  it('accepts valid period_type and date range', () => {
    const result = listShopFinancialsQuerySchema.safeParse({
      period_type: 'DAILY',
      from: '2024-01-01',
      to: '2024-01-31',
      page: 1,
      limit: 20,
    })
    expect(result.success).toBe(true)
    expect(result.data.period_type).toBe('DAILY')
    expect(result.data.from).toBe('2024-01-01')
    expect(result.data.to).toBe('2024-01-31')
  })

  it('rejects invalid period_type', () => {
    const result = listShopFinancialsQuerySchema.safeParse({
      period_type: 'YEARLY',
    })
    expect(result.success).toBe(false)
  })

  it('rejects malformed date strings', () => {
    expect(
      listShopFinancialsQuerySchema.safeParse({ from: '01/01/2024' }).success
    ).toBe(false)
    expect(
      listShopFinancialsQuerySchema.safeParse({ from: '2024-1-1' }).success
    ).toBe(false)
  })

  it('rejects fictitious calendar dates', () => {
    // Feb 30 doesn't exist — caught by the calendar refine
    const result = listShopFinancialsQuerySchema.safeParse({
      from: '2024-02-30',
    })
    expect(result.success).toBe(false)
  })

  it('rejects from > to range', () => {
    const result = listShopFinancialsQuerySchema.safeParse({
      from: '2024-02-01',
      to: '2024-01-01',
    })
    expect(result.success).toBe(false)
  })

  it('accepts equal from and to (single-day window)', () => {
    const result = listShopFinancialsQuerySchema.safeParse({
      from: '2024-01-15',
      to: '2024-01-15',
    })
    expect(result.success).toBe(true)
  })

  it('accepts valid payout_status filter', () => {
    for (const status of PAYOUT_STATUSES) {
      const result = listShopFinancialsQuerySchema.safeParse({
        payout_status: status,
      })
      expect(result.success).toBe(true)
    }
  })

  // params schema requires UUID
  it('rejects non-UUID id param', () => {
    expect(
      shopFinancialIdParamSchema.safeParse({ id: 'not-a-uuid' }).success
    ).toBe(false)
    expect(
      shopFinancialIdParamSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
      }).success
    ).toBe(true)
  })
})

describe('ShopFinancialsService.authorizeRead (Requirements 14.5, 14.7)', () => {
  // Only platform ADMIN, SHOP_ADMIN, SHOP_MANAGER may view financials
  const svc = () => new ShopFinancialsService(new ShopFinancialsRepository())

  it('allows platform ADMIN', () => {
    expect(svc().authorizeRead({ role: 'ADMIN' }).ok).toBe(true)
  })

  it('allows SHOP_ADMIN and SHOP_MANAGER', () => {
    expect(svc().authorizeRead({ shopRole: 'SHOP_ADMIN' }).ok).toBe(true)
    expect(svc().authorizeRead({ shopRole: 'SHOP_MANAGER' }).ok).toBe(true)
  })

  it('rejects SHOP_STAFF and SHOP_VIEWER (no view_financials permission)', () => {
    const r1 = svc().authorizeRead({ shopRole: 'SHOP_STAFF' })
    const r2 = svc().authorizeRead({ shopRole: 'SHOP_VIEWER' })
    expect(r1.ok).toBe(false)
    expect(r1.code).toBe('FORBIDDEN')
    expect(r2.ok).toBe(false)
    expect(r2.code).toBe('FORBIDDEN')
  })

  it('rejects unrelated platform roles', () => {
    expect(svc().authorizeRead({ role: 'CUSTOMER' }).ok).toBe(false)
    expect(svc().authorizeRead({ role: 'RIDER' }).ok).toBe(false)
  })

  it('rejects null actor with UNAUTHORIZED', () => {
    const decision = svc().authorizeRead(null)
    expect(decision.ok).toBe(false)
    expect(decision.code).toBe('UNAUTHORIZED')
  })
})

describe('ShopFinancialsService cache key shape (design.md Caching Strategy)', () => {
  const svc = () => new ShopFinancialsService(new ShopFinancialsRepository())

  it('uses the canonical bakaloo:financials:v1 prefix and 900s TTL', () => {
    expect(SHOP_FINANCIALS_CACHE_PREFIX).toBe('bakaloo:financials:v1')
    expect(SHOP_FINANCIALS_CACHE_TTL_SECONDS).toBe(900)
  })

  it('builds bakaloo:financials:v1:{shop}:{period}:{from}:{to}:{status}:p{page}', () => {
    const key = svc().cacheKeyForList('shop-uuid', {
      period_type: 'DAILY',
      from: '2024-01-01',
      to: '2024-01-31',
      page: 1,
      limit: 20,
    })
    expect(key).toBe(
      'bakaloo:financials:v1:shop-uuid:DAILY:2024-01-01:2024-01-31:all:p1:l20'
    )
  })

  it('encodes "all" for unset filter slots so keys do not alias', () => {
    const key = svc().cacheKeyForList('shop-uuid', { page: 2, limit: 50 })
    // Every slot present, even when filter is omitted, so two distinct
    // filter combinations cannot accidentally produce the same key.
    expect(key).toBe('bakaloo:financials:v1:shop-uuid:all:all:all:all:p2:l50')
  })

  it('produces different keys for different filter combinations', () => {
    const s = svc()
    const a = s.cacheKeyForList('shop', {
      period_type: 'DAILY',
      page: 1,
      limit: 20,
    })
    const b = s.cacheKeyForList('shop', {
      period_type: 'WEEKLY',
      page: 1,
      limit: 20,
    })
    expect(a).not.toBe(b)
  })

  it('invalidateForShop is a no-op when shopId is missing', async () => {
    // Should not throw — guards against accidentally clearing all keys.
    await expect(svc().invalidateForShop(null)).resolves.toBeUndefined()
    await expect(svc().invalidateForShop('')).resolves.toBeUndefined()
  })
})
