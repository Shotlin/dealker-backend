// Root-cause regression test for the "All tab's header image/colors leak into
// Chicken/Fish/Mutton" report. `buildTabManifestResponse` is what `/theme/tabs`
// (read by both the dashboard's WYSIWYG preview and the mobile app) returns for
// EVERY tab of a store in one call — each tab's `theme_data` must be All's
// cascade with the header image isolated, REGARDLESS of whether the tab has
// ANY app_themes row of its own (row.theme_data == null is the exact case a
// brand-new, never-customized tab is in — the bug this locks in).

import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/database.js', () => ({ query: vi.fn() }))
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
  cacheDeletePattern: vi.fn(),
}))
vi.mock('../../../src/config/bullmq.js', () => ({ allocationQueue: { add: vi.fn() } }))

import { buildTabManifestResponse } from '../../../src/modules/themes/public.controller.js'

const ALL_THEME_DATA = {
  sections: {
    topBar: { backgroundColor: '#111111', textColor: '#ffffff' },
    categoryTabs: { backgroundColor: '#111111' },
    headerBackground: {
      imageUrl: 'https://cdn.test/all-header.png',
      extendToPromoBar: true,
      recommendedWidth: 1080,
      topRegionHeight: 564,
      promoRegionHeight: 161,
      totalHeight: 725,
    },
  },
}

const allRow = (overrides = {}) => ({
  tab_id: 'tab-all',
  store_key: 'zepto',
  tab_key: 'all',
  tab_label: 'All',
  tab_icon_url: null,
  tab_text_color: null,
  tab_order: 0,
  theme_id: 'theme-all',
  ab_variant: 'A',
  theme_data: ALL_THEME_DATA,
  variant_b_theme_data: null,
  variant_b_split: null,
  ...overrides,
})

const tabRow = (tabKey, overrides = {}) => ({
  tab_id: `tab-${tabKey}`,
  store_key: 'zepto',
  tab_key: tabKey,
  tab_label: tabKey,
  tab_icon_url: null,
  tab_text_color: null,
  tab_order: 1,
  theme_id: null,
  ab_variant: 'A',
  theme_data: null,
  variant_b_theme_data: null,
  variant_b_split: null,
  ...overrides,
})

function tabDataByKey(rows, key) {
  const response = buildTabManifestResponse('zepto', rows)
  return response.tabs.find((t) => t.tab_key === key).theme_data
}

describe('buildTabManifestResponse — header image isolation', () => {
  it('a brand-new tab with NO app_themes row (theme_data == null) inherits colors but NOT the header image — the reported bug', () => {
    const rows = [allRow(), tabRow('chicken')]
    const chicken = tabDataByKey(rows, 'chicken')

    expect(chicken.sections.topBar.backgroundColor).toBe('#111111') // cascaded from All
    expect(chicken.sections.headerBackground.imageUrl).toBeNull() // NOT leaked
    expect(chicken.sections.headerBackground.extendToPromoBar).toBe(false)
    expect(chicken.sections.headerBackground.topRegionHeight).toBeUndefined()
  })

  it('a tab that already has its own theme_data (no image of its own) also does not inherit the image', () => {
    const rows = [
      allRow(),
      tabRow('fish', {
        theme_id: 'theme-fish',
        theme_data: { sections: { topBar: { backgroundColor: '#00FF00' } } },
      }),
    ]
    const fish = tabDataByKey(rows, 'fish')

    expect(fish.sections.topBar.backgroundColor).toBe('#00FF00') // its own
    expect(fish.sections.headerBackground.imageUrl).toBeNull()
  })

  it('a tab that explicitly sets its OWN header image keeps exactly that image', () => {
    const rows = [
      allRow(),
      tabRow('mutton', {
        theme_id: 'theme-mutton',
        theme_data: {
          sections: { headerBackground: { imageUrl: 'https://cdn.test/mutton.png' } },
        },
      }),
    ]
    const mutton = tabDataByKey(rows, 'mutton')

    expect(mutton.sections.headerBackground.imageUrl).toBe('https://cdn.test/mutton.png')
    expect(mutton.sections.topBar.backgroundColor).toBe('#111111') // still cascades
  })

  it('the All tab itself always keeps its own header image', () => {
    const rows = [allRow(), tabRow('eggs')]
    expect(tabDataByKey(rows, 'all').sections.headerBackground.imageUrl).toBe(
      'https://cdn.test/all-header.png'
    )
  })

  it('applies the same isolation to the B variant of an A/B test, including when variant B is itself unset', () => {
    const rows = [
      allRow(),
      tabRow('chicken', {
        theme_id: 'theme-chicken',
        theme_data: { sections: { topBar: { backgroundColor: '#ABCDEF' } } },
        variant_b_theme_data: null,
      }),
    ]
    const response = buildTabManifestResponse('zepto', rows)
    const chicken = response.tabs.find((t) => t.tab_key === 'chicken')
    // Pre-existing (unrelated to this fix): mergeThemeData(base, null) returns
    // base, so `ab_test` is present with split_percent 0 whenever "All" has a
    // theme, even with no B variant configured — resolveForUser() on the
    // mobile side never selects it at 0%. What THIS fix must guarantee is that
    // its theme_data is isolated exactly like variant A's.
    expect(chicken.ab_test.split_percent).toBe(0)
    expect(chicken.ab_test.variant_b_data.sections.headerBackground.imageUrl).toBeNull()

    const withVariantB = [
      allRow(),
      tabRow('fish', {
        theme_id: 'theme-fish',
        theme_data: { sections: { topBar: { backgroundColor: '#111' } } },
        variant_b_theme_data: { sections: { topBar: { backgroundColor: '#222' } } },
        variant_b_split: 50,
      }),
    ]
    const fish = buildTabManifestResponse('zepto', withVariantB).tabs.find(
      (t) => t.tab_key === 'fish'
    )
    expect(fish.ab_test.variant_b_data.sections.headerBackground.imageUrl).toBeNull()
    expect(fish.ab_test.variant_b_data.sections.topBar.backgroundColor).toBe('#222')
  })

  it('a store with no All theme at all leaves every tab without a header image and without a crash', () => {
    const rows = [tabRow('chicken'), tabRow('fish')]
    const response = buildTabManifestResponse('zepto', rows)
    for (const tab of response.tabs) {
      expect(tab.theme_data).toBeNull()
    }
  })

  it("two different physical shops of the SAME store never share a tab's resolved theme_data", () => {
    // buildTabManifestResponse is called once per (storeKey, shopId) with rows
    // already filtered by the repository's shop-aware SQL (getTabManifestRows) —
    // this only asserts the pure function treats each row set independently.
    const kolkataRows = [allRow(), tabRow('chicken', { theme_id: 't1', theme_data: { sections: { topBar: { backgroundColor: '#K' } } } })]
    const delhiRows = [
      allRow({ theme_data: { sections: { topBar: { backgroundColor: '#D' }, headerBackground: { imageUrl: 'https://cdn.test/delhi.png' } } } }),
      tabRow('chicken'),
    ]

    const kolkataChicken = tabDataByKey(kolkataRows, 'chicken')
    const delhiChicken = tabDataByKey(delhiRows, 'chicken')

    expect(kolkataChicken.sections.topBar.backgroundColor).toBe('#K')
    expect(delhiChicken.sections.topBar.backgroundColor).toBe('#D')
    expect(delhiChicken.sections.headerBackground.imageUrl).toBeNull()
  })
})
