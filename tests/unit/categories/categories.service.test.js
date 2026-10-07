// Service-layer coverage for the bundle + category-product-ranking feature.
// Repository is mocked directly (this suite is about business rules, not
// SQL) — cache helpers are mocked as no-ops per project convention.

import { describe, expect, it, vi } from 'vitest'

// Mock every side-effect module the service (and its AllocationService
// dependency) could reach, so a unit test never touches real Postgres/Redis
// — same defensive convention used across the existing test suite.
vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn(),
  cacheDeletePattern: vi.fn(),
}))

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../../src/config/redis.js', () => ({
  redis: { set: vi.fn(), get: vi.fn(), del: vi.fn() },
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { cacheDeletePattern } from '../../../src/utils/cache.js'
import { CategoriesService } from '../../../src/modules/categories/categories.service.js'

const BUNDLE_ID = '11111111-1111-1111-1111-111111111111'
const STANDARD_ID = '22222222-2222-2222-2222-222222222222'
const DAIRY_PRODUCT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' // belongs to STANDARD_ID
const FRUIT_PRODUCT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' // belongs to a different real category
const INACTIVE_PRODUCT = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const UNKNOWN_PRODUCT = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

function makeRepoMock(overrides = {}) {
  return {
    findById: vi.fn(),
    findProductsByIds: vi.fn().mockResolvedValue([]),
    setCategoryProducts: vi.fn().mockResolvedValue([]),
    findBundles: vi.fn().mockResolvedValue([]),
    findCategoriesForProduct: vi.fn().mockResolvedValue([]),
    getCategoryProductRanks: vi.fn().mockResolvedValue([]),
    findProducts: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    toggleCategoryMembership: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('CategoriesService.getProducts — passes resolved category_type through (positive)', () => {
  it('forwards the category BUNDLE type to repo.findProducts', async () => {
    const repo = makeRepoMock({
      findById: vi.fn().mockResolvedValue({ id: BUNDLE_ID, category_type: 'BUNDLE' }),
    })
    const service = new CategoriesService(repo, { allocationService: { getShopIdsForUser: vi.fn() } })

    await service.getProducts(BUNDLE_ID, {})

    expect(repo.findProducts).toHaveBeenCalledWith(
      BUNDLE_ID,
      expect.objectContaining({ categoryType: 'BUNDLE' })
    )
  })

  it('forwards STANDARD type by default', async () => {
    const repo = makeRepoMock({
      findById: vi.fn().mockResolvedValue({ id: STANDARD_ID, category_type: 'STANDARD' }),
    })
    const service = new CategoriesService(repo, { allocationService: { getShopIdsForUser: vi.fn() } })

    await service.getProducts(STANDARD_ID, {})

    expect(repo.findProducts).toHaveBeenCalledWith(
      STANDARD_ID,
      expect.objectContaining({ categoryType: 'STANDARD' })
    )
  })
})

describe('CategoriesService.getProducts — priceMode threading (the "category page shows the wrong store price" fix)', () => {
  it('defaults to retail when no priceMode filter is given', async () => {
    const repo = makeRepoMock({
      findById: vi.fn().mockResolvedValue({ id: STANDARD_ID, category_type: 'STANDARD' }),
    })
    const service = new CategoriesService(repo, { allocationService: { getShopIdsForUser: vi.fn() } })

    await service.getProducts(STANDARD_ID, {})

    expect(repo.findProducts).toHaveBeenCalledWith(
      STANDARD_ID,
      expect.objectContaining({ priceMode: 'retail' })
    )
  })

  it('forwards an explicit wholesale priceMode', async () => {
    const repo = makeRepoMock({
      findById: vi.fn().mockResolvedValue({ id: STANDARD_ID, category_type: 'STANDARD' }),
    })
    const service = new CategoriesService(repo, { allocationService: { getShopIdsForUser: vi.fn() } })

    await service.getProducts(STANDARD_ID, { priceMode: 'wholesale' })

    expect(repo.findProducts).toHaveBeenCalledWith(
      STANDARD_ID,
      expect.objectContaining({ priceMode: 'wholesale' })
    )
  })

  it('an unrecognized priceMode value falls back to retail rather than passing it through unchecked', async () => {
    const repo = makeRepoMock({
      findById: vi.fn().mockResolvedValue({ id: STANDARD_ID, category_type: 'STANDARD' }),
    })
    const service = new CategoriesService(repo, { allocationService: { getShopIdsForUser: vi.fn() } })

    await service.getProducts(STANDARD_ID, { priceMode: 'not-a-real-mode' })

    expect(repo.findProducts).toHaveBeenCalledWith(
      STANDARD_ID,
      expect.objectContaining({ priceMode: 'retail' })
    )
  })
})

describe('CategoriesService.setCategoryProducts — validation (positive + negative)', () => {
  it('returns not-found when the category does not exist (negative)', async () => {
    const repo = makeRepoMock({ findById: vi.fn().mockResolvedValue(null) })
    const service = new CategoriesService(repo)

    const result = await service.setCategoryProducts(BUNDLE_ID, [DAIRY_PRODUCT])

    expect(result.success).toBe(false)
    expect(result.message).toBe('Category not found')
    expect(repo.setCategoryProducts).not.toHaveBeenCalled()
  })

  it('BUNDLE category accepts any active product regardless of its real category (positive — the whole point of a bundle)', async () => {
    const repo = makeRepoMock({
      findById: vi.fn().mockResolvedValue({ id: BUNDLE_ID, category_type: 'BUNDLE' }),
      findProductsByIds: vi.fn().mockResolvedValue([
        { id: DAIRY_PRODUCT, category_id: STANDARD_ID, is_active: true },
        { id: FRUIT_PRODUCT, category_id: 'some-other-category', is_active: true },
      ]),
    })
    const service = new CategoriesService(repo)

    const result = await service.setCategoryProducts(BUNDLE_ID, [DAIRY_PRODUCT, FRUIT_PRODUCT])

    expect(result.success).toBe(true)
    expect(repo.setCategoryProducts).toHaveBeenCalledWith(BUNDLE_ID, [DAIRY_PRODUCT, FRUIT_PRODUCT])
  })

  it('STANDARD category accepts a product whose real category is elsewhere (positive — multi-category cross-listing)', async () => {
    // Baby Potato's real category is "Fresh Vegetables" (STANDARD_ID) but
    // the admin wants it to ALSO show under "Exotic Vegetables"
    // (OTHER_CATEGORY_ID) without duplicating the product or changing its
    // real category_id.
    const OTHER_CATEGORY_ID = '33333333-3333-3333-3333-333333333333'
    const repo = makeRepoMock({
      findById: vi.fn().mockResolvedValue({ id: OTHER_CATEGORY_ID, category_type: 'STANDARD' }),
      findProductsByIds: vi.fn().mockResolvedValue([
        { id: DAIRY_PRODUCT, category_id: STANDARD_ID, is_active: true },
      ]),
    })
    const service = new CategoriesService(repo)

    const result = await service.setCategoryProducts(OTHER_CATEGORY_ID, [DAIRY_PRODUCT])

    expect(result.success).toBe(true)
    expect(repo.setCategoryProducts).toHaveBeenCalledWith(OTHER_CATEGORY_ID, [DAIRY_PRODUCT])
  })

  it('drops inactive and nonexistent product ids for both category types (negative)', async () => {
    const repo = makeRepoMock({
      findById: vi.fn().mockResolvedValue({ id: BUNDLE_ID, category_type: 'BUNDLE' }),
      findProductsByIds: vi.fn().mockResolvedValue([
        { id: DAIRY_PRODUCT, category_id: STANDARD_ID, is_active: true },
        { id: INACTIVE_PRODUCT, category_id: STANDARD_ID, is_active: false },
        // UNKNOWN_PRODUCT deliberately absent — doesn't exist
      ]),
    })
    const service = new CategoriesService(repo)

    const result = await service.setCategoryProducts(BUNDLE_ID, [DAIRY_PRODUCT, INACTIVE_PRODUCT, UNKNOWN_PRODUCT])

    expect(result.success).toBe(true)
    expect(repo.setCategoryProducts).toHaveBeenCalledWith(BUNDLE_ID, [DAIRY_PRODUCT])
  })

  it('de-duplicates repeated product ids before writing (negative: no double-ranking)', async () => {
    const repo = makeRepoMock({
      findById: vi.fn().mockResolvedValue({ id: BUNDLE_ID, category_type: 'BUNDLE' }),
      findProductsByIds: vi.fn().mockResolvedValue([
        { id: DAIRY_PRODUCT, category_id: STANDARD_ID, is_active: true },
      ]),
    })
    const service = new CategoriesService(repo)

    await service.setCategoryProducts(BUNDLE_ID, [DAIRY_PRODUCT, DAIRY_PRODUCT])

    expect(repo.setCategoryProducts).toHaveBeenCalledWith(BUNDLE_ID, [DAIRY_PRODUCT])
  })
})

describe('CategoriesService.listBundles / getCategoryProductRanks', () => {
  it('listBundles delegates to repo.findBundles (positive)', async () => {
    const repo = makeRepoMock({
      findBundles: vi.fn().mockResolvedValue([{ id: BUNDLE_ID, category_type: 'BUNDLE', image_url: null }]),
    })
    const service = new CategoriesService(repo)

    const bundles = await service.listBundles()

    expect(bundles).toHaveLength(1)
    expect(repo.findBundles).toHaveBeenCalledTimes(1)
  })

  it('getCategoryProductRanks returns not-found for a missing category (negative)', async () => {
    const repo = makeRepoMock({ findById: vi.fn().mockResolvedValue(null) })
    const service = new CategoriesService(repo)

    const result = await service.getCategoryProductRanks(STANDARD_ID)

    expect(result.success).toBe(false)
  })
})

describe('CategoriesService.toggleCategoryMembership — product edit form toggle (positive + negative)', () => {
  it('adds a product to a bundle (positive)', async () => {
    const repo = makeRepoMock({
      findById: vi.fn().mockResolvedValue({ id: BUNDLE_ID, category_type: 'BUNDLE' }),
      findProductsByIds: vi.fn().mockResolvedValue([{ id: DAIRY_PRODUCT, is_active: true }]),
    })
    const service = new CategoriesService(repo)

    const result = await service.toggleCategoryMembership(BUNDLE_ID, DAIRY_PRODUCT, true)

    expect(result.success).toBe(true)
    expect(repo.toggleCategoryMembership).toHaveBeenCalledWith(BUNDLE_ID, DAIRY_PRODUCT, true)
  })

  it('also allows cross-listing a product into a STANDARD category (positive — multi-category)', async () => {
    const repo = makeRepoMock({
      findById: vi.fn().mockResolvedValue({ id: STANDARD_ID, category_type: 'STANDARD' }),
      findProductsByIds: vi.fn().mockResolvedValue([{ id: FRUIT_PRODUCT, is_active: true }]),
    })
    const service = new CategoriesService(repo)

    const result = await service.toggleCategoryMembership(STANDARD_ID, FRUIT_PRODUCT, true)

    expect(result.success).toBe(true)
    expect(repo.toggleCategoryMembership).toHaveBeenCalledWith(STANDARD_ID, FRUIT_PRODUCT, true)
  })

  it('rejects an inactive/nonexistent product (negative)', async () => {
    const repo = makeRepoMock({
      findById: vi.fn().mockResolvedValue({ id: BUNDLE_ID, category_type: 'BUNDLE' }),
      findProductsByIds: vi.fn().mockResolvedValue([]),
    })
    const service = new CategoriesService(repo)

    const result = await service.toggleCategoryMembership(BUNDLE_ID, UNKNOWN_PRODUCT, true)

    expect(result.success).toBe(false)
    expect(repo.toggleCategoryMembership).not.toHaveBeenCalled()
  })

  it('rejects a missing category (negative)', async () => {
    const repo = makeRepoMock({ findById: vi.fn().mockResolvedValue(null) })
    const service = new CategoriesService(repo)

    const result = await service.toggleCategoryMembership(BUNDLE_ID, DAIRY_PRODUCT, false)

    expect(result.success).toBe(false)
  })
})

describe('CategoriesService.listCategoriesForProduct — "also show in other categories" picker (positive + negative)', () => {
  it('lists categories excluding the product primary one, each flagged is_member (positive)', async () => {
    const repo = makeRepoMock({
      findProductsByIds: vi.fn().mockResolvedValue([{ id: DAIRY_PRODUCT, category_id: STANDARD_ID, is_active: true }]),
      findCategoriesForProduct: vi.fn().mockResolvedValue([
        { id: BUNDLE_ID, category_type: 'BUNDLE', is_member: true, image_url: null },
      ]),
    })
    const service = new CategoriesService(repo)

    const result = await service.listCategoriesForProduct(DAIRY_PRODUCT)

    expect(result.success).toBe(true)
    expect(result.categories).toHaveLength(1)
    expect(repo.findCategoriesForProduct).toHaveBeenCalledWith(DAIRY_PRODUCT)
  })

  it('rejects a nonexistent product (negative)', async () => {
    const repo = makeRepoMock({ findProductsByIds: vi.fn().mockResolvedValue([]) })
    const service = new CategoriesService(repo)

    const result = await service.listCategoriesForProduct(UNKNOWN_PRODUCT)

    expect(result.success).toBe(false)
    expect(repo.findCategoriesForProduct).not.toHaveBeenCalled()
  })
})

describe('Cache invalidation reaches home sections, not just categories (positive)', () => {
  // A category-membership edit changes what a category-bound home section
  // should show, but the theme module caches its resolved output
  // separately (bakaloo:sections:*, bakaloo:tab_home:*,
  // bakaloo:tab_manifest:*) — missing this was why cross-listing/ranking
  // changes could take up to 5 minutes (the theme cache TTL) to appear.
  const HOME_SECTION_PATTERNS = ['bakaloo:sections:*', 'bakaloo:tab_home:*', 'bakaloo:tab_manifest:*']

  it('setCategoryProducts invalidates home-section caches in addition to categories:*', async () => {
    const repo = makeRepoMock({
      findById: vi.fn().mockResolvedValue({ id: STANDARD_ID, category_type: 'STANDARD' }),
      findProductsByIds: vi.fn().mockResolvedValue([{ id: DAIRY_PRODUCT, category_id: STANDARD_ID, is_active: true }]),
    })
    const service = new CategoriesService(repo)

    await service.setCategoryProducts(STANDARD_ID, [DAIRY_PRODUCT])

    const calledPatterns = cacheDeletePattern.mock.calls.map((c) => c[0])
    expect(calledPatterns).toContain('categories:*')
    for (const pattern of HOME_SECTION_PATTERNS) {
      expect(calledPatterns).toContain(pattern)
    }
  })

  it('toggleCategoryMembership invalidates home-section caches in addition to categories:*', async () => {
    const repo = makeRepoMock({
      findById: vi.fn().mockResolvedValue({ id: BUNDLE_ID, category_type: 'BUNDLE' }),
      findProductsByIds: vi.fn().mockResolvedValue([{ id: DAIRY_PRODUCT, is_active: true }]),
    })
    const service = new CategoriesService(repo)

    await service.toggleCategoryMembership(BUNDLE_ID, DAIRY_PRODUCT, true)

    const calledPatterns = cacheDeletePattern.mock.calls.map((c) => c[0])
    expect(calledPatterns).toContain('categories:*')
    for (const pattern of HOME_SECTION_PATTERNS) {
      expect(calledPatterns).toContain(pattern)
    }
  })
})
