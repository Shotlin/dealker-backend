import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/bullmq.js', () => ({ themeQueue: { add: vi.fn() } }))
vi.mock('../../../src/plugins/socketio.plugin.js', () => ({
  emitSectionUpdate: vi.fn(),
  getSocketIo: vi.fn(),
}))
vi.mock('../../../src/utils/cache.js', () => ({ cacheDeletePattern: vi.fn() }))
vi.mock('../../../src/utils/activityLogger.js', () => ({ logAdminActivity: vi.fn() }))
vi.mock('../../../src/modules/admin/sections/sections.repository.js', () => ({
  SectionsRepository: class SectionsRepository {},
}))

import { mergeSectionConfig } from '../../../src/modules/admin/sections/sections.service.js'

describe('section header config persistence', () => {
  it('merges a section header into only the targeted section config without dropping existing merchandising values', () => {
    const merged = mergeSectionConfig(
      {
        title: 'Our current hits',
        product_card_style: 'PREMIUM_FRESH',
        section_header: { style: 'text', visible: true },
      },
      {
        section_header: {
          style: 'text_graphic',
          image_url: 'https://cdn.test/kolkata-slider.webp',
          image_aspect_ratio: 3.6,
          horizontal_margin: 16,
        },
      },
    )

    expect(merged).toEqual({
      title: 'Our current hits',
      product_card_style: 'PREMIUM_FRESH',
      section_header: {
        style: 'text_graphic',
        visible: true,
        image_url: 'https://cdn.test/kolkata-slider.webp',
        image_aspect_ratio: 3.6,
        horizontal_margin: 16,
      },
    })
  })
})
