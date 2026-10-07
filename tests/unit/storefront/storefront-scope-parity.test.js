// Regression: a guest and a signed-in customer at the SAME location must be
// served the SAME storefront.
//
// Bugs this locks in (all found by tracing both flows to the resolved shop):
//   1. Theme sections / tab-home used `getShopIdsForUser` (EVERY allocated
//      shop) for a signed-in customer, while the theme itself, the product
//      endpoints and a guest's storefront token all use the PRIMARY shop only.
//   2. `GET /categories/:id/products` ignored the guest token entirely
//      (context = null ⇒ the whole master catalogue for a guest).
//   3. `/theme/active` ignored the guest token.
//   4. Sections / tab-home responses did not say which shop they were built
//      for, so a client could not tell a shop response from an anonymous one.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMock = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../../../src/config/database.js', () => databaseMock)
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

import { AllocationService } from '../../../src/modules/allocation/allocation.service.js'
import { PublicThemeController } from '../../../src/modules/themes/public.controller.js'
import { CategoriesService } from '../../../src/modules/categories/categories.service.js'
import { CategoriesController } from '../../../src/modules/categories/categories.controller.js'

const SHOP_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' // primary
const SHOP_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' // also serves the address
const USER = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

const logger = { error: vi.fn() }

function allocationRows() {
  // Non-primary shop listed FIRST: an implementation that takes "the first
  // allocation" or "all allocations" must fail these tests.
  return [
    { id: '1', shop_id: SHOP_B, name: 'B', distance_km: 3, matched_pincode: '201301', is_primary: false },
    { id: '2', shop_id: SHOP_A, name: 'A', distance_km: 1, matched_pincode: '201301', is_primary: true },
  ]
}

function accountAllocationService(rows = allocationRows()) {
  const repo = { findByUserId: vi.fn().mockResolvedValue(rows) }
  return new AllocationService(repo, { queue: { add: vi.fn() } })
}

/** A request as the products/theme routes see it. */
const guestRequest = (shopIds = [SHOP_A]) => ({
  headers: { 'x-storefront-token': 'signed-guest-token' },
  server: {
    jwt: { verify: vi.fn().mockResolvedValue({ scope: 'guest-storefront', shopIds }) },
  },
  query: {},
  params: {},
})
const customerRequest = () => ({
  user: { id: USER, role: 'CUSTOMER' },
  headers: {},
  server: { jwt: { verify: vi.fn() } },
  query: {},
  params: {},
})
const anonymousRequest = () => ({
  headers: {},
  server: { jwt: { verify: vi.fn() } },
  query: {},
  params: {},
})

function themeController(allocation) {
  const ctrl = new PublicThemeController()
  ctrl.allocationService = allocation
  return ctrl
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AllocationService.getStorefrontShopIds — the one definition of the storefront shop', () => {
  it('returns ONLY the primary allocation, even when other shops also serve the address', async () => {
    expect(await accountAllocationService().getStorefrontShopIds(USER)).toEqual([SHOP_A])
  })

  it('falls back to the first allocation when none is flagged primary', async () => {
    const rows = allocationRows().map((r) => ({ ...r, is_primary: false }))
    expect(await accountAllocationService(rows).getStorefrontShopIds(USER)).toEqual([SHOP_B])
  })

  it('returns [] (never a catalogue-wide fallback) when the customer has no allocation', async () => {
    expect(await accountAllocationService([]).getStorefrontShopIds(USER)).toEqual([])
  })

  it('a guest token minted for a location names the SAME shop the account allocation picks', async () => {
    // Both flows run the same pure merge over the same candidates.
    const candidates = [
      { id: SHOP_B, created_at: '2026-01-01', distance_km: 3 },
      { id: SHOP_A, created_at: '2026-01-02', distance_km: 1 },
    ]
    const svc = accountAllocationService()
    const merged = svc.mergeAndMarkPrimary({
      pincode: '201301',
      pincodeMatches: candidates,
      radiusMatches: [],
    })
    const guestShop = merged.find((s) => s.is_primary).shop_id // what the token carries
    const accountRows = merged.map((s, i) => ({ id: String(i), name: 'x', ...s }))
    const account = accountAllocationService(accountRows)
    expect(await account.getStorefrontShopIds(USER)).toEqual([guestShop])
  })
})

describe('PublicThemeController — guest and signed-in customer resolve the same shop', () => {
  it('theme shop, product-visibility shops and /theme/active agree for a signed-in customer', async () => {
    const ctrl = themeController(accountAllocationService())
    const req = customerRequest()
    expect(await ctrl._resolveThemeShopId(req)).toBe(SHOP_A)
    expect(await ctrl._resolveShopId(req)).toBe(SHOP_A)
    // Used to be [SHOP_B, SHOP_A] (every allocated shop).
    expect(await ctrl._resolveAllocatedShopIds(req)).toEqual([SHOP_A])
  })

  it('theme shop, product-visibility shops and /theme/active agree for a guest', async () => {
    const ctrl = themeController(accountAllocationService())
    const req = guestRequest()
    expect(await ctrl._resolveThemeShopId(req)).toBe(SHOP_A)
    // Used to be null: /theme/active ignored the guest token.
    expect(await ctrl._resolveShopId(req)).toBe(SHOP_A)
    expect(await ctrl._resolveAllocatedShopIds(req)).toEqual([SHOP_A])
  })

  it('guest and customer are therefore indistinguishable to every theme lookup', async () => {
    const ctrl = themeController(accountAllocationService())
    const [g, c] = [guestRequest(), customerRequest()]
    expect(await ctrl._resolveThemeShopId(g)).toBe(await ctrl._resolveThemeShopId(c))
    expect(await ctrl._resolveAllocatedShopIds(g)).toEqual(await ctrl._resolveAllocatedShopIds(c))
  })

  it('an anonymous caller (no token) resolves NO shop and no products — never a default store', async () => {
    const ctrl = themeController(accountAllocationService())
    const req = anonymousRequest()
    expect(await ctrl._resolveThemeShopId(req)).toBeNull()
    expect(await ctrl._resolveAllocatedShopIds(req)).toEqual([])
  })

  describe('response carries the shop it was built for', () => {
    function stubQueries() {
      databaseMock.query.mockImplementation(async (sql) =>
        /FROM theme_tabs/.test(sql)
          ? { rows: [{ id: 'tab-1', store_key: 'zepto', key: 'all', merch_config: {} }] }
          : { rows: [] }
      )
    }

    it.each([
      ['guest', guestRequest],
      ['signed-in customer', customerRequest],
    ])('sections + tab-home echo shop_id for a %s', async (_label, makeRequest) => {
      stubQueries()
      const ctrl = themeController(accountAllocationService())
      const reply = { code: vi.fn().mockReturnThis(), header: vi.fn().mockReturnThis() }

      const sectionsReq = { ...makeRequest(), params: { tabKey: 'all' }, query: { store_key: 'zepto' } }
      const sections = await ctrl.getSectionManifest(sectionsReq, reply)
      expect(sections.data.shop_id).toBe(SHOP_A)

      const homeReq = { ...makeRequest(), params: { key: 'all' }, query: { store_key: 'zepto' } }
      const home = await ctrl.getTabHomeContent(homeReq, reply)
      expect(home.data.shop_id).toBe(SHOP_A)
    })

    it('an anonymous caller is told shop_id = null, so a client can refuse to cache it under a shop', async () => {
      stubQueries()
      const ctrl = themeController(accountAllocationService())
      const reply = { code: vi.fn().mockReturnThis(), header: vi.fn().mockReturnThis() }
      const req = { ...anonymousRequest(), params: { tabKey: 'all' }, query: { store_key: 'zepto' } }
      const sections = await ctrl.getSectionManifest(req, reply)
      expect(sections.data.shop_id).toBeNull()
    })
  })
})

describe('Category products — same scoping as the product endpoints', () => {
  function categoryService(allocation) {
    const repo = {
      findById: vi.fn().mockResolvedValue({ id: 'cat-1', category_type: 'standard' }),
      findProducts: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    }
    return { repo, svc: new CategoriesService(repo, { allocationService: allocation }) }
  }

  it('a guest is scoped to the token shop (was: unscoped master catalogue)', async () => {
    const { repo, svc } = categoryService(accountAllocationService())
    const controller = new CategoriesController(svc)
    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() }
    await controller.getProducts({ ...guestRequest(), params: { id: 'cat-1' }, query: {} }, reply)
    expect(repo.findProducts).toHaveBeenCalledWith(
      'cat-1',
      expect.objectContaining({ allocatedShopIds: [SHOP_A] })
    )
  })

  it('a signed-in customer is scoped to the primary shop only', async () => {
    const { repo, svc } = categoryService(accountAllocationService())
    const controller = new CategoriesController(svc)
    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() }
    await controller.getProducts({ ...customerRequest(), params: { id: 'cat-1' }, query: {} }, reply)
    expect(repo.findProducts).toHaveBeenCalledWith(
      'cat-1',
      expect.objectContaining({ allocatedShopIds: [SHOP_A] })
    )
  })

  it('guest and customer get the identical shop scope', async () => {
    const a = categoryService(accountAllocationService())
    const b = categoryService(accountAllocationService())
    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() }
    await new CategoriesController(a.svc).getProducts({ ...guestRequest(), params: { id: 'cat-1' }, query: {} }, reply)
    await new CategoriesController(b.svc).getProducts({ ...customerRequest(), params: { id: 'cat-1' }, query: {} }, reply)
    expect(a.repo.findProducts.mock.calls[0][1].allocatedShopIds).toEqual(
      b.repo.findProducts.mock.calls[0][1].allocatedShopIds
    )
  })

  it('a caller with no resolved shop gets an empty page, never the master catalogue', async () => {
    const { repo, svc } = categoryService(accountAllocationService([]))
    const controller = new CategoriesController(svc)
    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() }
    await controller.getProducts({ ...anonymousRequest(), params: { id: 'cat-1' }, query: {} }, reply)
    expect(repo.findProducts).not.toHaveBeenCalled()
    const body = reply.send.mock.calls[0][0]
    expect(body.data).toEqual([])
  })

  it('staff/admin (non-customer) callers stay unscoped', async () => {
    const { repo, svc } = categoryService(accountAllocationService())
    const controller = new CategoriesController(svc)
    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() }
    const staff = { ...customerRequest(), user: { id: 'admin-1', role: 'ADMIN' }, params: { id: 'cat-1' }, query: {} }
    await controller.getProducts(staff, reply)
    expect(repo.findProducts).toHaveBeenCalledWith(
      'cat-1',
      expect.objectContaining({ allocatedShopIds: null })
    )
  })
})
