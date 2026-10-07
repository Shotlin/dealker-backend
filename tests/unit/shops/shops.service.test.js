import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external dependencies BEFORE importing service ─
vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  cacheDeletePattern: vi.fn(),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// Prevent the pincodesChanged/radiusChanged/pincodeOnlyChanged recompute
// branch from touching a real Redis connection — it previously had zero
// test coverage (every existing update() test only changes fields like
// phone/name, which never enter that branch) so this was never needed
// until the pincode_only toggle test below started exercising it.
vi.mock('../../../src/config/bullmq.js', () => ({
  allocationQueue: { add: vi.fn().mockResolvedValue({ id: 'job-1' }) },
}))

import { ShopsService } from '../../../src/modules/shops/shops.service.js'
import {
  cacheGet,
  cacheSet,
  cacheDel,
  cacheDeletePattern,
} from '../../../src/utils/cache.js'
import { logger } from '../../../src/config/logger.js'
import {
  getCachedServiceablePincodes,
  setCachedServiceablePincodes,
} from '../../../src/utils/serviceable-pincode-cache.js'
import { allocationQueue } from '../../../src/config/bullmq.js'

// ─── Helpers ─────────────────────────────────────────────
function createRepoMock() {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findBySlug: vi.fn(),
    findSlugsLike: vi.fn(),
    findByBranchCode: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
  }
}

const VALID_SHOP_INPUT = {
  name: 'Fresh Mart Indiranagar',
  address_line1: '100 Main Road',
  city: 'Bangalore',
  state: 'Karnataka',
  pincode: '560038',
  lat: 12.9716,
  lng: 77.5946,
  serviceable_pincodes: [],
  delivery_radius_km: 5.0,
  operating_hours: {},
  commission_rate: 10.0,
}

const SHOP_ID = '550e8400-e29b-41d4-a716-446655440000'
const USER_ID = '11111111-1111-1111-1111-111111111111'

const MOCK_SHOP = {
  id: SHOP_ID,
  name: 'Fresh Mart Indiranagar',
  slug: 'fresh-mart-indiranagar',
  branch_code: 'BAN001',
  description: null,
  logo_url: null,
  banner_url: null,
  phone: null,
  email: null,
  address_line1: '100 Main Road',
  address_line2: null,
  city: 'Bangalore',
  state: 'Karnataka',
  pincode: '560038',
  lat: 12.9716,
  lng: 77.5946,
  serviceable_pincodes: [],
  delivery_radius_km: 5.0,
  is_active: true,
  is_verified: false,
  operating_hours: {},
  commission_rate: 10.0,
  total_orders: 0,
  total_revenue: 0,
  created_by: USER_ID,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
}

// ═══════════════════════════════════════════════════════════
// ShopsService.create()
// ═══════════════════════════════════════════════════════════
describe('ShopsService.create()', () => {
  let repo
  let service

  beforeEach(() => {
    vi.clearAllMocks()
    repo = createRepoMock()
    service = new ShopsService(repo)
  })

  it('generates unique slug and branch_code, persists shop, invalidates active-shops cache', async () => {
    repo.findSlugsLike.mockResolvedValue([])
    repo.findByBranchCode.mockResolvedValue(null)
    repo.create.mockResolvedValue(MOCK_SHOP)

    const result = await service.create(VALID_SHOP_INPUT, USER_ID)

    expect(repo.findSlugsLike).toHaveBeenCalledWith('fresh-mart-indiranagar')
    expect(repo.findByBranchCode).toHaveBeenCalledWith('BAN001')
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Fresh Mart Indiranagar',
        slug: 'fresh-mart-indiranagar',
        branch_code: 'BAN001',
        created_by: USER_ID,
      })
    )
    expect(cacheDeletePattern).toHaveBeenCalledWith('bakaloo:shops:active:*')
    expect(result).toEqual(MOCK_SHOP)
  })

  it('appends -1 to slug when base slug already exists', async () => {
    repo.findSlugsLike.mockResolvedValue(['fresh-mart-indiranagar'])
    repo.findByBranchCode.mockResolvedValue(null)
    repo.create.mockResolvedValue({ ...MOCK_SHOP, slug: 'fresh-mart-indiranagar-1' })

    await service.create(VALID_SHOP_INPUT, USER_ID)

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'fresh-mart-indiranagar-1' })
    )
  })

  it('increments suffix beyond highest existing numeric suffix', async () => {
    repo.findSlugsLike.mockResolvedValue([
      'fresh-mart-indiranagar',
      'fresh-mart-indiranagar-1',
      'fresh-mart-indiranagar-3',
    ])
    repo.findByBranchCode.mockResolvedValue(null)
    repo.create.mockResolvedValue(MOCK_SHOP)

    await service.create(VALID_SHOP_INPUT, USER_ID)

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'fresh-mart-indiranagar-4' })
    )
  })

  it('logs creation with structured context', async () => {
    repo.findSlugsLike.mockResolvedValue([])
    repo.findByBranchCode.mockResolvedValue(null)
    repo.create.mockResolvedValue(MOCK_SHOP)

    await service.create(VALID_SHOP_INPUT, USER_ID)

    expect(logger.info).toHaveBeenCalledWith(
      { userId: USER_ID, shopId: SHOP_ID, action: 'shop_created' },
      'Shop created'
    )
  })
})

// ═══════════════════════════════════════════════════════════
// ShopsService.getById() — Requirement 1.7 (Redis caching)
// ═══════════════════════════════════════════════════════════
describe('ShopsService.getById()', () => {
  let repo
  let service

  beforeEach(() => {
    vi.clearAllMocks()
    repo = createRepoMock()
    service = new ShopsService(repo)
  })

  it('returns cached shop without calling repo when cache hit', async () => {
    cacheGet.mockResolvedValue(MOCK_SHOP)

    const result = await service.getById(SHOP_ID)

    expect(cacheGet).toHaveBeenCalledWith(`bakaloo:shops:v1:${SHOP_ID}`)
    expect(repo.findById).not.toHaveBeenCalled()
    expect(result).toEqual(MOCK_SHOP)
  })

  it('falls back to DB and caches result on cache miss', async () => {
    cacheGet.mockResolvedValue(null)
    repo.findById.mockResolvedValue(MOCK_SHOP)

    const result = await service.getById(SHOP_ID)

    expect(repo.findById).toHaveBeenCalledWith(SHOP_ID)
    expect(cacheSet).toHaveBeenCalledWith(
      `bakaloo:shops:v1:${SHOP_ID}`,
      MOCK_SHOP,
      300 // TTL per Requirement 1.7
    )
    expect(result).toEqual(MOCK_SHOP)
  })

  it('returns null and does not cache when shop not found', async () => {
    cacheGet.mockResolvedValue(null)
    repo.findById.mockResolvedValue(null)

    const result = await service.getById(SHOP_ID)

    expect(result).toBeNull()
    expect(cacheSet).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════
// ShopsService.list() — Requirement 1.6 (pagination)
// ═══════════════════════════════════════════════════════════
describe('ShopsService.list()', () => {
  let repo
  let service

  beforeEach(() => {
    vi.clearAllMocks()
    repo = createRepoMock()
    service = new ShopsService(repo)
  })

  it('returns paginated shop list with total count and echoes page/limit', async () => {
    repo.findMany.mockResolvedValue({
      shops: [MOCK_SHOP, { ...MOCK_SHOP, id: 'other' }],
      total: 42,
    })

    const result = await service.list({ page: 2, limit: 20 })

    expect(repo.findMany).toHaveBeenCalledWith({ page: 2, limit: 20 })
    expect(result).toEqual({
      shops: expect.any(Array),
      total: 42,
      page: 2,
      limit: 20,
    })
    expect(result.shops).toHaveLength(2)
  })

  it('passes filter params (city, is_active, search) through to the repository', async () => {
    repo.findMany.mockResolvedValue({ shops: [], total: 0 })

    await service.list({
      page: 1,
      limit: 50,
      city: 'Bangalore',
      is_active: 'true',
      search: 'fresh',
    })

    expect(repo.findMany).toHaveBeenCalledWith({
      page: 1,
      limit: 50,
      city: 'Bangalore',
      is_active: 'true',
      search: 'fresh',
    })
  })

  it('returns empty list with total=0 when no shops match', async () => {
    repo.findMany.mockResolvedValue({ shops: [], total: 0 })

    const result = await service.list({ page: 1, limit: 20 })

    expect(result.shops).toEqual([])
    expect(result.total).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════
// ShopsService.update() — Requirement 1.8 (validation), 1.7 (cache)
// ═══════════════════════════════════════════════════════════
describe('ShopsService.update()', () => {
  let repo
  let service

  beforeEach(() => {
    vi.clearAllMocks()
    repo = createRepoMock()
    service = new ShopsService(repo)
  })

  it('returns SHOP_NOT_FOUND when shop does not exist', async () => {
    repo.findById.mockResolvedValue(null)

    const result = await service.update(SHOP_ID, { phone: '9999999999' }, USER_ID)

    expect(result).toEqual({
      success: false,
      message: 'Shop not found',
      code: 'SHOP_NOT_FOUND',
    })
    expect(repo.update).not.toHaveBeenCalled()
  })

  it('updates without regenerating slug when name is unchanged', async () => {
    repo.findById.mockResolvedValue(MOCK_SHOP)
    repo.update.mockResolvedValue({ ...MOCK_SHOP, phone: '9999999999' })

    const result = await service.update(SHOP_ID, { phone: '9999999999' }, USER_ID)

    expect(repo.findSlugsLike).not.toHaveBeenCalled()
    expect(repo.update).toHaveBeenCalledWith(SHOP_ID, { phone: '9999999999' })
    expect(result.success).toBe(true)
    expect(result.shop.phone).toBe('9999999999')
  })

  it('regenerates slug when shop name changes', async () => {
    repo.findById.mockResolvedValue(MOCK_SHOP)
    repo.findSlugsLike.mockResolvedValue([])
    repo.update.mockResolvedValue({
      ...MOCK_SHOP,
      name: 'New Name',
      slug: 'new-name',
    })

    const result = await service.update(SHOP_ID, { name: 'New Name' }, USER_ID)

    expect(repo.findSlugsLike).toHaveBeenCalledWith('new-name')
    expect(repo.update).toHaveBeenCalledWith(SHOP_ID, {
      name: 'New Name',
      slug: 'new-name',
    })
    expect(result.success).toBe(true)
  })

  it('invalidates per-id and active-shops caches after successful update', async () => {
    repo.findById.mockResolvedValue(MOCK_SHOP)
    repo.update.mockResolvedValue(MOCK_SHOP)

    await service.update(SHOP_ID, { phone: '9999999999' }, USER_ID)

    expect(cacheDel).toHaveBeenCalledWith(`bakaloo:shops:v1:${SHOP_ID}`)
    expect(cacheDeletePattern).toHaveBeenCalledWith('bakaloo:shops:active:*')
  })

  it('returns SHOP_NOT_FOUND if repo.update returns null (race with delete)', async () => {
    repo.findById.mockResolvedValue(MOCK_SHOP)
    repo.update.mockResolvedValue(null)

    const result = await service.update(SHOP_ID, { phone: '9' }, USER_ID)

    expect(result.success).toBe(false)
    expect(result.code).toBe('SHOP_NOT_FOUND')
  })

  it('persists a pincode_only toggle even with no pincode/radius edit', async () => {
    repo.findById.mockResolvedValue({ ...MOCK_SHOP, pincode_only: false })
    repo.update.mockResolvedValue({ ...MOCK_SHOP, pincode_only: true })

    const result = await service.update(SHOP_ID, { pincode_only: true }, USER_ID)

    expect(repo.update).toHaveBeenCalledWith(SHOP_ID, { pincode_only: true })
    expect(result.success).toBe(true)
    expect(result.shop.pincode_only).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════
// ShopsService.delete() — Requirement 1.5 (soft delete + cache)
// ═══════════════════════════════════════════════════════════
describe('ShopsService.delete()', () => {
  let repo
  let service

  beforeEach(() => {
    vi.clearAllMocks()
    repo = createRepoMock()
    service = new ShopsService(repo)
  })

  it('soft-deletes via repo, invalidates caches, logs action', async () => {
    repo.findById.mockResolvedValue(MOCK_SHOP)
    repo.softDelete.mockResolvedValue(true)

    const result = await service.delete(SHOP_ID, USER_ID)

    expect(repo.softDelete).toHaveBeenCalledWith(SHOP_ID)
    expect(cacheDel).toHaveBeenCalledWith(`bakaloo:shops:v1:${SHOP_ID}`)
    expect(cacheDeletePattern).toHaveBeenCalledWith('bakaloo:shops:active:*')
    expect(logger.info).toHaveBeenCalledWith(
      { userId: USER_ID, shopId: SHOP_ID, action: 'shop_deleted' },
      'Shop soft-deleted'
    )
    expect(result).toEqual({ success: true })
  })

  it('returns SHOP_NOT_FOUND when shop does not exist', async () => {
    repo.findById.mockResolvedValue(null)

    const result = await service.delete(SHOP_ID, USER_ID)

    expect(repo.softDelete).not.toHaveBeenCalled()
    expect(result).toEqual({
      success: false,
      message: 'Shop not found',
      code: 'SHOP_NOT_FOUND',
    })
  })

  it('returns SHOP_NOT_FOUND if repo.softDelete returns false', async () => {
    repo.findById.mockResolvedValue(MOCK_SHOP)
    repo.softDelete.mockResolvedValue(false)

    const result = await service.delete(SHOP_ID, USER_ID)

    expect(result.success).toBe(false)
    expect(result.code).toBe('SHOP_NOT_FOUND')
  })
})

// ═══════════════════════════════════════════════════════════
// ShopsService.generateBranchCode() — Requirement 1.2
// ═══════════════════════════════════════════════════════════
describe('ShopsService.generateBranchCode()', () => {
  let repo
  let service

  beforeEach(() => {
    vi.clearAllMocks()
    repo = createRepoMock()
    service = new ShopsService(repo)
  })

  it('produces 3-letter prefix + 3-digit sequential code (BAN001)', async () => {
    repo.findByBranchCode.mockResolvedValue(null)

    const code = await service.generateBranchCode('Bangalore')

    expect(code).toBe('BAN001')
  })

  it('skips taken codes and returns next available number for same city', async () => {
    repo.findByBranchCode
      .mockResolvedValueOnce({ id: 'a', branch_code: 'BAN001' })
      .mockResolvedValueOnce({ id: 'b', branch_code: 'BAN002' })
      .mockResolvedValueOnce(null)

    const code = await service.generateBranchCode('Bangalore')

    expect(code).toBe('BAN003')
    expect(repo.findByBranchCode).toHaveBeenNthCalledWith(1, 'BAN001')
    expect(repo.findByBranchCode).toHaveBeenNthCalledWith(2, 'BAN002')
    expect(repo.findByBranchCode).toHaveBeenNthCalledWith(3, 'BAN003')
  })

  it('uses different prefix per city — Mumbai => MUM001, Delhi => DEL001', async () => {
    repo.findByBranchCode.mockResolvedValue(null)

    const mum = await service.generateBranchCode('Mumbai')
    const del = await service.generateBranchCode('Delhi')

    expect(mum).toBe('MUM001')
    expect(del).toBe('DEL001')
  })

  it('pads short city names with X (e.g. "Goa" => "GOA001", "Up" => "UPX001")', async () => {
    repo.findByBranchCode.mockResolvedValue(null)

    expect(await service.generateBranchCode('Goa')).toBe('GOA001')
    expect(await service.generateBranchCode('Up')).toBe('UPX001')
    expect(await service.generateBranchCode('A')).toBe('AXX001')
  })

  it('strips non-letter characters from city before building prefix', async () => {
    repo.findByBranchCode.mockResolvedValue(null)

    const code = await service.generateBranchCode('New Delhi-1')

    // "New Delhi-1" -> uppercase letters only -> "NEWDELHI" -> first 3 -> "NEW"
    expect(code).toBe('NEW001')
  })
})


// ═══════════════════════════════════════════════════════════
// Service-area edits must not leave stale PIN / allocation state behind
// ═══════════════════════════════════════════════════════════
describe('ShopsService — service-area change side effects', () => {
  const SHOP_ID = '550e8400-e29b-41d4-a716-446655440000'
  const USER_ID = '660e8400-e29b-41d4-a716-446655440000'
  let repo
  let service

  beforeEach(() => {
    vi.clearAllMocks()
    repo = createRepoMock()
    service = new ShopsService(repo)
    setCachedServiceablePincodes(new Set(['700016']))
  })

  const shopRow = (pins) => ({
    id: SHOP_ID,
    name: 'Kolkata',
    lat: 22.57,
    lng: 88.36,
    serviceable_pincodes: pins,
    delivery_radius_km: 5,
    pincode_only: true,
  })

  it('update() drops the in-process validate-pincode cache', async () => {
    repo.findById.mockResolvedValue(shopRow(['700016']))
    repo.update.mockResolvedValue(shopRow(['700016', '201301']))

    await service.update(SHOP_ID, { serviceable_pincodes: ['700016', '201301'] }, USER_ID)

    expect(getCachedServiceablePincodes()).toBeUndefined()
  })

  it('update() enqueues an allocation recompute when the PIN list changes', async () => {
    repo.findById.mockResolvedValue(shopRow(['700016']))
    repo.update.mockResolvedValue(shopRow(['700016', '201301']))

    await service.update(SHOP_ID, { serviceable_pincodes: ['700016', '201301'] }, USER_ID)

    expect(allocationQueue.add).toHaveBeenCalledWith(
      'recompute-by-shop',
      { type: 'recompute-by-shop', shopId: SHOP_ID },
      { jobId: `recompute-by-shop:${SHOP_ID}` }
    )
  })

  it('update() does NOT enqueue a recompute when the cleaned list is unchanged', async () => {
    repo.findById.mockResolvedValue(shopRow(['201301']))
    repo.update.mockResolvedValue(shopRow(['201301']))

    // Legacy dirty input that normalises to the stored list.
    await service.update(SHOP_ID, { serviceable_pincodes: [' 201301 ', '201301'] }, USER_ID)

    expect(allocationQueue.add).not.toHaveBeenCalled()
  })

  it('update() recomputes when an existing dirty row is cleaned (stored [201301, 201301] → [201301])', async () => {
    repo.findById.mockResolvedValue(shopRow(['201301', '201301']))
    repo.update.mockResolvedValue(shopRow(['201301']))

    await service.update(SHOP_ID, { serviceable_pincodes: ['201301'] }, USER_ID)

    expect(allocationQueue.add).toHaveBeenCalledTimes(1)
  })

  it('create() and delete() also drop the validate-pincode cache', async () => {
    repo.findSlugsLike.mockResolvedValue([])
    repo.findByBranchCode.mockResolvedValue(null)
    repo.create.mockResolvedValue({ id: SHOP_ID })
    await service.create({ ...VALID_SHOP_INPUT }, USER_ID)
    expect(getCachedServiceablePincodes()).toBeUndefined()

    setCachedServiceablePincodes(new Set(['700016']))
    repo.findById.mockResolvedValue(shopRow(['700016']))
    repo.softDelete.mockResolvedValue(true)
    await service.delete(SHOP_ID, USER_ID)
    expect(getCachedServiceablePincodes()).toBeUndefined()
  })
})
