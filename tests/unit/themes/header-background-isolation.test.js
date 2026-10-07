// "Extend into mini promotional bar" (headerBackground.extendToPromoBar + the
// A/B split heights) describes ONE specific image. When a category tab has its
// own theme, the backend strips the "All" tab's header image from the fallback
// so it doesn't leak — the extension settings must be stripped with it, or a
// category that uploads its OWN header image (without touching the toggle)
// would silently inherit "All"'s extension and split heights.

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

import {
  mergeThemeData,
  withoutFallbackHeaderImage,
} from '../../../src/modules/themes/public.controller.js'

const allTabTheme = () => ({
  sections: {
    topBar: { backgroundColor: '#111111', textColor: '#ffffff' },
    headerBackground: {
      imageUrl: 'https://cdn.test/all-header.png',
      extendToPromoBar: true,
      recommendedWidth: 1080,
      topRegionHeight: 564,
      promoRegionHeight: 161,
      totalHeight: 725,
    },
  },
})

describe('withoutFallbackHeaderImage', () => {
  it('strips the image AND the extension settings, keeps everything else', () => {
    const stripped = withoutFallbackHeaderImage(allTabTheme())
    expect(stripped.sections.headerBackground).toEqual({
      imageUrl: null,
      extendToPromoBar: false,
    })
    expect(stripped.sections.topBar).toEqual(allTabTheme().sections.topBar)
  })

  it('does not mutate the fallback theme it was given', () => {
    const original = allTabTheme()
    withoutFallbackHeaderImage(original)
    expect(original).toEqual(allTabTheme())
  })

  it('leaves themes without a headerBackground untouched', () => {
    const theme = { sections: { topBar: { backgroundColor: '#000' } } }
    expect(withoutFallbackHeaderImage(theme)).toEqual(theme)
    expect(withoutFallbackHeaderImage(null)).toBeNull()
  })
})

describe('category theme merged over the isolated "All" fallback', () => {
  it("a category's OWN image with no toggle of its own is NOT extended by All's setting", () => {
    const category = { sections: { headerBackground: { imageUrl: 'https://cdn.test/cat.png' } } }
    const merged = mergeThemeData(withoutFallbackHeaderImage(allTabTheme()), category)
    expect(merged.sections.headerBackground).toEqual({
      imageUrl: 'https://cdn.test/cat.png',
      extendToPromoBar: false,
    })
  })

  it("a category that sets its OWN extension keeps exactly its own numbers, not All's", () => {
    const category = {
      sections: {
        headerBackground: {
          imageUrl: 'https://cdn.test/cat.png',
          extendToPromoBar: true,
          recommendedWidth: 1080,
          topRegionHeight: 600,
          promoRegionHeight: 150,
          totalHeight: 750,
        },
      },
    }
    const merged = mergeThemeData(withoutFallbackHeaderImage(allTabTheme()), category)
    expect(merged.sections.headerBackground).toEqual(category.sections.headerBackground)
  })

  it('an explicit `false` from the category theme is honoured (false is not "unset")', () => {
    const merged = mergeThemeData(allTabTheme(), {
      sections: { headerBackground: { extendToPromoBar: false } },
    })
    expect(merged.sections.headerBackground.extendToPromoBar).toBe(false)
  })

  it('the All tab itself keeps its own extension untouched (no isolation applied to it)', () => {
    const merged = mergeThemeData(allTabTheme(), allTabTheme())
    expect(merged.sections.headerBackground.extendToPromoBar).toBe(true)
    expect(merged.sections.headerBackground.topRegionHeight).toBe(564)
  })
})
