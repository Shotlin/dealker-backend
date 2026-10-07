// Coverage for the cache-invalidation gap this session's earlier work found
// (and fixed for categories): updateGlobal() previously invalidated
// nothing, so an admin change to fee_settings.delivery_eta_minutes (now
// embedded in the public GET /theme/tabs response) could take up to the
// theme cache's 300s TTL to actually reach the app's home screen.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn(),
  cacheDeletePattern: vi.fn(),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { cacheDeletePattern } from '../../../src/utils/cache.js'
import { FeeSettingsService } from '../../../src/modules/fee-settings/fee-settings.service.js'

function makeRepoMock(overrides = {}) {
  return {
    getGlobal: vi.fn().mockResolvedValue(null),
    resolveForShop: vi.fn(),
    updateGlobal: vi.fn().mockResolvedValue({ delivery_eta_minutes: 45 }),
    upsertShop: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('FeeSettingsService.updateGlobal — home-section cache invalidation (positive)', () => {
  it('invalidates the theme tab-manifest/tab-home caches in addition to updating the row', async () => {
    const repo = makeRepoMock()
    const service = new FeeSettingsService(repo)

    const result = await service.updateGlobal({ delivery_eta_minutes: 45 })

    expect(result.delivery_eta_minutes).toBe(45)
    const patterns = cacheDeletePattern.mock.calls.map((c) => c[0])
    expect(patterns).toContain('bakaloo:tab_manifest:*')
    expect(patterns).toContain('bakaloo:tab_home:*')
  })

  it('still returns a safe default when the repo update yields nothing (negative)', async () => {
    const repo = makeRepoMock({ updateGlobal: vi.fn().mockResolvedValue(null) })
    const service = new FeeSettingsService(repo)

    const result = await service.updateGlobal({ delivery_eta_minutes: 45 })

    expect(result.delivery_eta_minutes).toBe(30) // _safeDefault()
  })
})

describe('FeeSettingsService — Quick Delivery surcharge defaults (positive)', () => {
  it('_safeDefault() disables the surcharge by default so ASAP orders are never silently charged', async () => {
    const repo = makeRepoMock({ getGlobal: vi.fn().mockResolvedValue(null) })
    const service = new FeeSettingsService(repo)

    const config = await service.getGlobal()

    expect(config.quick_delivery_surcharge_enabled).toBe(false)
    expect(config.quick_delivery_surcharge_amount).toBe(0)
    expect(config.quick_delivery_surcharge_label).toBe('Quick delivery fee')
    expect(config.quick_delivery_eta_minutes).toBe(15)
  })

  it('resolveForShop() falls back to the same safe surcharge defaults when no row exists', async () => {
    const repo = makeRepoMock({
      resolveForShop: vi.fn().mockResolvedValue({ config: null, source: 'GLOBAL' }),
    })
    const service = new FeeSettingsService(repo)

    const { config, source } = await service.resolveForShop('shop-1')

    expect(source).toBe('DEFAULT')
    expect(config.quick_delivery_surcharge_enabled).toBe(false)
  })
})

describe('FeeSettingsService.updateShop — scoped to a shop, does not touch the global home caches', () => {
  it('does not invalidate tab_manifest/tab_home (delivery_eta_minutes is a GLOBAL-only field)', async () => {
    const repo = makeRepoMock({ upsertShop: vi.fn().mockResolvedValue({ id: 'shop-config' }) })
    const service = new FeeSettingsService(repo)

    await service.updateShop('shop-1', { min_delivery_fee: 10 })

    const patterns = cacheDeletePattern.mock.calls.map((c) => c[0])
    expect(patterns).not.toContain('bakaloo:tab_manifest:*')
    expect(patterns).not.toContain('bakaloo:tab_home:*')
  })
})
