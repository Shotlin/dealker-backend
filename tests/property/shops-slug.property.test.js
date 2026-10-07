// Feature: multi-vendor-system, Property 1: Slug Generation
// **Validates: Requirements 1.2, 1.9**

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import { ShopsService } from '../../src/modules/shops/shops.service.js'

// Mock the cache utilities to avoid Redis dependency
vi.mock('../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}))

/**
 * Single-character arbitrary for shop names.
 * Constrains to ASCII letters, digits, spaces, and a few special characters
 * commonly found in shop names (apostrophes, ampersands, dots, hyphens, etc.).
 *
 * Using fast-check 4 API: characters are produced via fc.constantFrom over a
 * curated set, then composed into strings via fc.string({ unit }).
 */
const shopNameCharArbitrary = fc.constantFrom(
  // Lowercase letters
  ...'abcdefghijklmnopqrstuvwxyz'.split(''),
  // Uppercase letters
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  // Digits
  ...'0123456789'.split(''),
  // Whitespace and common shop-name punctuation
  ' ',
  '-',
  "'",
  '&',
  '.',
  ',',
  '!',
  '@',
  '#'
)

/**
 * Arbitrary for valid shop names.
 * - Length 1..100 characters
 * - Must contain at least one alphanumeric so the resulting slug is non-empty
 *   (per Requirement 1.2 the slug is derived from the name)
 */
const shopNameArbitrary = fc
  .string({ unit: shopNameCharArbitrary, minLength: 1, maxLength: 100 })
  .filter((s) => s.trim().length > 0 && /[a-zA-Z0-9]/.test(s))

describe('Property 1: Slug Generation', () => {
  let service
  let mockRepo

  beforeEach(() => {
    mockRepo = {
      findSlugsLike: vi.fn().mockResolvedValue([]),
    }
    service = new ShopsService(mockRepo)
  })

  it('generated slug is always lowercase', async () => {
    await fc.assert(
      fc.asyncProperty(shopNameArbitrary, async (name) => {
        mockRepo.findSlugsLike.mockResolvedValue([])
        const slug = await service.generateUniqueSlug(name)
        expect(slug).toBe(slug.toLowerCase())
      }),
      { numRuns: 100 }
    )
  })

  it('generated slug contains only [a-z0-9-] characters', async () => {
    await fc.assert(
      fc.asyncProperty(shopNameArbitrary, async (name) => {
        mockRepo.findSlugsLike.mockResolvedValue([])
        const slug = await service.generateUniqueSlug(name)
        if (slug.length > 0) {
          expect(slug).toMatch(/^[a-z0-9-]+$/)
        }
      }),
      { numRuns: 100 }
    )
  })

  it('generated slug has no consecutive hyphens', async () => {
    await fc.assert(
      fc.asyncProperty(shopNameArbitrary, async (name) => {
        mockRepo.findSlugsLike.mockResolvedValue([])
        const slug = await service.generateUniqueSlug(name)
        expect(slug).not.toMatch(/--/)
      }),
      { numRuns: 100 }
    )
  })

  it('generated slug does not start or end with a hyphen', async () => {
    await fc.assert(
      fc.asyncProperty(shopNameArbitrary, async (name) => {
        mockRepo.findSlugsLike.mockResolvedValue([])
        const slug = await service.generateUniqueSlug(name)
        if (slug.length > 0) {
          expect(slug[0]).not.toBe('-')
          expect(slug[slug.length - 1]).not.toBe('-')
        }
      }),
      { numRuns: 100 }
    )
  })

  it('when a slug conflict exists, the resolved slug has a numeric suffix', async () => {
    await fc.assert(
      fc.asyncProperty(
        shopNameArbitrary,
        fc.integer({ min: 1, max: 20 }),
        async (name, conflictCount) => {
          // Compute what the base slug would be (mirrors service logic)
          const baseSlug = name
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/[\s]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')

          // Skip if base slug is empty (extremely rare given the filter)
          if (baseSlug.length === 0) return

          // Simulate existing slugs: baseSlug, baseSlug-1, ..., baseSlug-(conflictCount-1)
          const existingSlugs = [baseSlug]
          for (let i = 1; i < conflictCount; i++) {
            existingSlugs.push(`${baseSlug}-${i}`)
          }
          mockRepo.findSlugsLike.mockResolvedValue(existingSlugs)

          const slug = await service.generateUniqueSlug(name)

          // Should end with a numeric suffix
          expect(slug).toMatch(/-\d+$/)
          // The suffix should be conflictCount (next available number)
          expect(slug).toBe(`${baseSlug}-${conflictCount}`)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('all generated slugs are unique across multiple shops', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(shopNameArbitrary, { minLength: 2, maxLength: 10 }),
        async (names) => {
          // Track all slugs that have been "created"
          const createdSlugs = []

          for (const name of names) {
            // Mock returns previously created slugs whose pattern matches the base
            mockRepo.findSlugsLike.mockImplementation(async (baseSlug) => {
              return createdSlugs.filter(
                (s) => s === baseSlug || s.startsWith(`${baseSlug}-`)
              )
            })

            const slug = await service.generateUniqueSlug(name)
            createdSlugs.push(slug)
          }

          // All slugs must be unique
          const uniqueSlugs = new Set(createdSlugs)
          expect(uniqueSlugs.size).toBe(createdSlugs.length)
        }
      ),
      { numRuns: 100 }
    )
  })
})
