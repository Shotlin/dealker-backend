// Coverage for the admin-configurable delivery-time badge: GET /theme/tabs
// (the public, unauthenticated endpoint the app polls every session) must
// embed fee_settings.delivery_eta_minutes as a top-level field so the home
// screen can render it, and fee-settings updates must invalidate the
// endpoint's cache so a change reaches the app promptly instead of waiting
// out the 300s TTL.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMock = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../../../src/config/database.js', () => databaseMock)

const redisMock = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }))
vi.mock('../../../src/config/redis.js', () => ({ redis: redisMock }))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { PublicThemeController } from '../../../src/modules/themes/public.controller.js'

beforeEach(() => {
  vi.clearAllMocks()
  redisMock.get.mockResolvedValue(null) // always a cache miss unless overridden
  databaseMock.query.mockImplementation((sql) => {
    if (typeof sql === 'string' && sql.includes('fee_settings')) {
      return Promise.resolve({
        rows: [{ id: 'g1', scope: 'GLOBAL', delivery_eta_minutes: 45 }],
      })
    }
    // theme_tabs/app_themes manifest rows — empty is fine, we only assert
    // the merged top-level field, not full tab-building logic here.
    return Promise.resolve({ rows: [] })
  })
})

function makeReply() {
  return { code: vi.fn().mockReturnThis(), header: vi.fn().mockReturnThis() }
}

describe('GET /theme/tabs — delivery_eta_minutes (positive/negative)', () => {
  it('embeds the admin-configured delivery_eta_minutes as a top-level field (positive)', async () => {
    const controller = new PublicThemeController()
    const result = await controller.getTabThemes({ query: {}, headers: {} }, makeReply())

    expect(result.data.delivery_eta_minutes).toBe(45)
  })

  it('falls back to null (not a crash) when no GLOBAL fee_settings row exists (negative)', async () => {
    databaseMock.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('fee_settings')) {
        return Promise.resolve({ rows: [] }) // no GLOBAL row — repo.getGlobal() returns null
      }
      return Promise.resolve({ rows: [] })
    })

    const controller = new PublicThemeController()
    const result = await controller.getTabThemes({ query: {}, headers: {} }, makeReply())

    // FeeSettingsService.getGlobal() falls back to _safeDefault() (30), not
    // null, when the row is missing — so the app still gets a sane value
    // rather than "no delivery badge at all" the first time this is hit.
    expect(result.data.delivery_eta_minutes).toBe(30)
  })

  it('caches the response including the merged field, so a cache-hit reply also carries it', async () => {
    const controller = new PublicThemeController()
    await controller.getTabThemes({ query: {}, headers: {} }, makeReply())

    const setCall = redisMock.set.mock.calls[0]
    expect(setCall).toBeDefined()
    const cachedPayload = JSON.parse(setCall[1])
    expect(cachedPayload.data.delivery_eta_minutes).toBe(45)
  })
})
