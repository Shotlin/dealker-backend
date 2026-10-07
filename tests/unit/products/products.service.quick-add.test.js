import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external collaborators BEFORE importing the SUT ─────────────
vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  cacheDeletePattern: vi.fn(),
}))

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../../src/config/cloudinary.js', () => ({
  normalizeCloudinaryDeliveryUrl: vi.fn((url) => url),
}))

vi.mock('../../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn().mockResolvedValue(undefined) },
  stockNotificationsQueue: { add: vi.fn().mockResolvedValue(undefined) },
  allocationQueue: { add: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('../../../src/plugins/socketio.plugin.js', () => ({
  getSocketIo: vi.fn().mockReturnValue(null),
}))

import { ProductsService } from '../../../src/modules/products/products.service.js'
import { cacheGet, cacheSet } from '../../../src/utils/cache.js'

const CUSTOMER_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const CAT_1 = 'cat-1'
const CAT_2 = 'cat-2'
const RELATED_CAT = 'cat-related'

function product(id) {
  return { id, name: `Product ${id}`, slug: id }
}

function makeRepoMock() {
  return {
    findPopularByCategories: vi.fn(),
    findPopularRandom: vi.fn(),
    getSuggestionTargetCategoryIds: vi.fn(),
  }
}

function makeAllocationServiceMock(shopIds) {
  return { getStorefrontShopIds: vi.fn().mockResolvedValue(shopIds) }
}

beforeEach(() => {
  vi.clearAllMocks()
  cacheGet.mockResolvedValue(null)
  cacheSet.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════
// getQuickAdd — the same-category fetch and the related-category-id lookup
// now run concurrently (Promise.all) instead of one DB round trip after
// another. These tests pin down that the concurrency change didn't alter
// the pre-existing dedup/ordering/limit-math behavior.
// ═══════════════════════════════════════════════════════════════════════

describe('ProductsService.getQuickAdd — concurrent same-category + related-category-id resolution', () => {
  it('excludes same-category picks from the related-category query, even though both start concurrently', async () => {
    const repo = makeRepoMock()
    const sameCategoryProducts = [product('same-1'), product('same-2')]
    const relatedProducts = [product('related-1')]

    repo.findPopularByCategories
      .mockResolvedValueOnce(sameCategoryProducts) // same-category call
      .mockResolvedValueOnce(relatedProducts) // related-category call

    repo.getSuggestionTargetCategoryIds.mockResolvedValue([RELATED_CAT])
    repo.findPopularRandom.mockResolvedValue([])

    const allocation = makeAllocationServiceMock([SHOP_A])
    const svc = new ProductsService(repo, { allocationService: allocation })

    const result = await svc.getQuickAdd(
      [CAT_1, CAT_2],
      ['already-in-cart'],
      12,
      { userId: CUSTOMER_ID },
    )

    // Same-category picks come first, then related-category picks.
    expect(result.map((p) => p.id)).toEqual(['same-1', 'same-2', 'related-1'])

    // The related-category call's exclude list must contain the cart items
    // AND the ids the (concurrently-started) same-category call resolved —
    // proving `excluded` was correctly threaded through despite the two
    // initial lookups running concurrently.
    const relatedCallArgs = repo.findPopularByCategories.mock.calls[1]
    expect(relatedCallArgs[0]).toEqual([RELATED_CAT]) // relatedCategoryIds
    expect(relatedCallArgs[1]).toEqual(
      expect.arrayContaining(['already-in-cart', 'same-1', 'same-2']),
    )

    // Both the same-category product query and the related-category-id
    // lookup must have actually been invoked (neither skipped).
    expect(repo.getSuggestionTargetCategoryIds).toHaveBeenCalledWith(CAT_1)
    expect(repo.getSuggestionTargetCategoryIds).toHaveBeenCalledWith(CAT_2)
  })

  it('falls back to random picks only for the remaining shortfall after same+related', async () => {
    const repo = makeRepoMock()
    repo.findPopularByCategories
      .mockResolvedValueOnce([product('same-1')]) // 1 of a limit-12 same-category budget
      .mockResolvedValueOnce([]) // no related picks
    repo.getSuggestionTargetCategoryIds.mockResolvedValue([])
    repo.findPopularRandom.mockResolvedValue([
      product('random-1'),
      product('random-2'),
    ])

    const allocation = makeAllocationServiceMock([SHOP_A])
    const svc = new ProductsService(repo, { allocationService: allocation })

    const result = await svc.getQuickAdd([CAT_1], [], 3, {
      userId: CUSTOMER_ID,
    })

    expect(result.map((p) => p.id)).toEqual(['same-1', 'random-1', 'random-2'])
    expect(repo.findPopularRandom).toHaveBeenCalledWith(
      expect.arrayContaining(['same-1']),
      2, // limit(3) - picked.length(1)
      [SHOP_A],
    )
  })

  it('returns nothing and never queries the repo for a customer with zero shop allocations', async () => {
    const repo = makeRepoMock()
    const allocation = makeAllocationServiceMock([])
    const svc = new ProductsService(repo, { allocationService: allocation })

    const result = await svc.getQuickAdd([CAT_1], [], 12, {
      userId: CUSTOMER_ID,
    })

    expect(result).toEqual([])
    expect(repo.findPopularByCategories).not.toHaveBeenCalled()
    expect(repo.getSuggestionTargetCategoryIds).not.toHaveBeenCalled()
  })
})
