// Requirement 8 ("Make dashboard → mobile propagation fast" without globally
// invalidating every shop/tab): theme:update and section:update socket
// payloads must carry enough to target one shop — otherwise every connected
// device of the same store type re-fetches on every single edit, anywhere.
//
// The shop/store a broadcast carries must come from the EDITED ROW itself
// (as read back from the repository), never from some ambient/caller-supplied
// value — that's what actually guarantees a Kolkata edit is tagged Kolkata.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/database.js', () => ({ query: vi.fn(), getClient: vi.fn() }))
vi.mock('../../../src/config/redis.js', () => ({
  redis: { get: vi.fn().mockResolvedValue(null), set: vi.fn(), del: vi.fn() },
}))
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../src/config/bullmq.js', () => ({
  allocationQueue: { add: vi.fn() },
  themeQueue: { add: vi.fn(), getJob: vi.fn().mockResolvedValue(null) },
}))
vi.mock('../../../src/utils/activityLogger.js', () => ({ logAdminActivity: vi.fn() }))

const emit = vi.fn()
const to = vi.fn(() => ({ emit }))
const fakeIo = { to }
vi.mock('../../../src/plugins/socketio.plugin.js', async () => {
  const actual = await vi.importActual('../../../src/plugins/socketio.plugin.js')
  return { ...actual, getSocketIo: () => fakeIo }
})

const sectionsRepoStub = {
  findTabById: vi.fn(),
  findById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMerchBinding: vi.fn(),
  delete: vi.fn(),
  reorder: vi.fn(),
  duplicate: vi.fn(),
  restoreSnapshot: vi.fn(),
  findVersionById: vi.fn(),
}
vi.mock('../../../src/modules/admin/sections/sections.repository.js', () => ({
  SectionsRepository: vi.fn(() => sectionsRepoStub),
}))

const themesRepoStub = {
  findById: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  createVersion: vi.fn().mockResolvedValue(2),
}
vi.mock('../../../src/modules/admin/themes/themes.repository.js', () => ({
  ThemesRepository: vi.fn(() => themesRepoStub),
}))

const { emitSectionUpdate } = await import('../../../src/plugins/socketio.plugin.js')
const { SectionsService } = await import('../../../src/modules/admin/sections/sections.service.js')
const { ThemesService } = await import('../../../src/modules/admin/themes/themes.service.js')

beforeEach(() => {
  emit.mockClear()
  to.mockClear()
  for (const fn of Object.values(sectionsRepoStub)) fn.mockReset()
  for (const fn of Object.values(themesRepoStub)) fn.mockReset()
  themesRepoStub.createVersion.mockResolvedValue(2)
})

describe('emitSectionUpdate payload', () => {
  it('carries tab_key, store_key and shop_id so a client can target one shop', () => {
    emitSectionUpdate(fakeIo, { tabKey: 'chicken', storeKey: 'zepto', shopId: 'shop-kolkata', action: 'update' })

    expect(to).toHaveBeenCalledWith('themes:live')
    expect(emit).toHaveBeenCalledWith('section:update', {
      tab_key: 'chicken',
      store_key: 'zepto',
      shop_id: 'shop-kolkata',
      action: 'update',
      timestamp: expect.any(Number),
    })
  })

  it('a shop-less (global) edit is emitted with shop_id: null, never omitted or coerced', () => {
    emitSectionUpdate(fakeIo, { tabKey: 'all', storeKey: 'zepto', shopId: null, action: 'update' })
    expect(emit.mock.calls[0][1]).toMatchObject({ shop_id: null })
  })
})

describe("SectionsService broadcasts the EDITED ROW's own shop, never a different one", () => {
  const kolkataChicken = {
    id: 's1',
    tab_id: 'tab-1',
    tab_key: 'chicken',
    store_key: 'zepto',
    shop_id: 'shop-kolkata',
    config: {},
  }

  it('update() reads store_key/shop_id off the row it fetched, not off any parameter', async () => {
    sectionsRepoStub.findById.mockResolvedValue(kolkataChicken)
    sectionsRepoStub.update.mockResolvedValue(kolkataChicken)

    await new SectionsService().update('s1', { visible: false }, 'admin-1', '127.0.0.1')

    expect(emit).toHaveBeenCalledWith(
      'section:update',
      expect.objectContaining({ tab_key: 'chicken', store_key: 'zepto', shop_id: 'shop-kolkata' })
    )
  })

  it('create() broadcasts the newly-created section\'s own shop (e.g. Delhi), not a stale default', async () => {
    const delhiFish = { ...kolkataChicken, id: 's2', tab_key: 'fish', shop_id: 'shop-delhi' }
    sectionsRepoStub.findTabById.mockResolvedValue({ id: 'tab-2', key: 'fish', store_key: 'zepto' })
    sectionsRepoStub.create.mockResolvedValue({ id: 's2' })
    sectionsRepoStub.findById.mockResolvedValue(delhiFish)

    await new SectionsService().create('tab-2', { section_type: 'banner' }, 'admin-1', '127.0.0.1', 'shop-delhi')

    expect(emit).toHaveBeenCalledWith(
      'section:update',
      expect.objectContaining({ tab_key: 'fish', store_key: 'zepto', shop_id: 'shop-delhi' })
    )
  })

  it('reorder() broadcasts the shop it was called with, and null for an HQ-wide (global) reorder', async () => {
    sectionsRepoStub.reorder.mockResolvedValue([])
    sectionsRepoStub.findTabById.mockResolvedValue({ id: 'tab-1', key: 'chicken', store_key: 'zepto' })

    await new SectionsService().reorder('tab-1', ['s1', 's2'], 'admin-1', '127.0.0.1', 'shop-kolkata')
    expect(emit).toHaveBeenCalledWith(
      'section:update',
      expect.objectContaining({ shop_id: 'shop-kolkata' })
    )

    emit.mockClear()
    await new SectionsService().reorder('tab-1', ['s1', 's2'], 'admin-1', '127.0.0.1')
    expect(emit).toHaveBeenCalledWith('section:update', expect.objectContaining({ shop_id: null }))
  })

  it('never sends an update when the tab cannot be resolved (nothing to target)', async () => {
    sectionsRepoStub.findById.mockResolvedValue(null)
    const result = await new SectionsService().update('missing', { visible: false }, 'admin-1', '127.0.0.1')
    expect(result).toBeNull()
    expect(emit).not.toHaveBeenCalled()
  })
})

describe("ThemesService.update broadcasts the resolved theme's own shop_id", () => {
  it('a global (shop-less) theme edit broadcasts shop_id: null', async () => {
    const globalTheme = { id: 't1', tab_id: 'tab-1', tab_key: 'all', store_key: 'zepto', shop_id: null, theme_data: { sections: {} }, is_active: true, version: 1 }
    themesRepoStub.findById.mockResolvedValue(globalTheme)
    themesRepoStub.update.mockResolvedValue(globalTheme)

    await new ThemesService().update('t1', { theme_data: { sections: { topBar: {} } } }, 'admin-1', '127.0.0.1', null)

    expect(emit).toHaveBeenCalledWith(
      'theme:update',
      expect.objectContaining({ tabKey: 'all', storeKey: 'zepto', shopId: null })
    )
  })

  it("editing a shop-scoped theme broadcasts THAT shop's id, not the caller's ambient one", async () => {
    const kolkataTheme = { id: 't2', tab_id: 'tab-2', tab_key: 'chicken', store_key: 'zepto', shop_id: 'shop-kolkata', theme_data: { sections: {} }, is_active: false, version: 1 }
    themesRepoStub.findById.mockResolvedValue(kolkataTheme)
    themesRepoStub.update.mockResolvedValue(kolkataTheme)

    // Called as if from a Delhi-scoped session, but the target theme IS Kolkata's —
    // the broadcast must reflect the theme, not the 5th (shopId) argument.
    await new ThemesService().update('t2', { theme_data: { sections: { topBar: {} } } }, 'admin-1', '127.0.0.1', 'shop-delhi')

    expect(emit).toHaveBeenCalledWith(
      'theme:update',
      expect.objectContaining({ shopId: 'shop-kolkata' })
    )
  })
})
