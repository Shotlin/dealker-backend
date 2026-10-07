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

vi.mock('../../../src/config/bullmq.js', () => ({
  allocationQueue: { add: vi.fn() },
}))

import { AllocationService } from '../../../src/modules/allocation/allocation.service.js'
import {
  cacheGet,
  cacheSet,
  cacheDel,
} from '../../../src/utils/cache.js'
import { logger } from '../../../src/config/logger.js'

// ─── Helpers ─────────────────────────────────────────────
function createRepoMock() {
  return {
    findByUserId: vi.fn(),
    findShopsByPincode: vi.fn(),
    findShopsByRadius: vi.fn(),
    replaceForUser: vi.fn(),
    findUsersAffectedByShop: vi.fn(),
  }
}

const USER_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_A = '22222222-2222-2222-2222-22222222222a'
const SHOP_B = '22222222-2222-2222-2222-22222222222b'
const SHOP_C = '22222222-2222-2222-2222-22222222222c'

// ═══════════════════════════════════════════════════════════
// AllocationService.mergeAndMarkPrimary() — Requirement 4.3, 4.4
// ═══════════════════════════════════════════════════════════
describe('AllocationService.mergeAndMarkPrimary()', () => {
  let service

  beforeEach(() => {
    vi.clearAllMocks()
    service = new AllocationService(createRepoMock(), {
      queue: { add: vi.fn() },
    })
  })

  it('returns empty array when no shops match', () => {
    const result = service.mergeAndMarkPrimary({
      pincode: '560001',
      pincodeMatches: [],
      radiusMatches: [],
    })
    expect(result).toEqual([])
  })

  it('deduplicates shops appearing in both pincode and radius result sets', () => {
    const result = service.mergeAndMarkPrimary({
      pincode: '560001',
      pincodeMatches: [
        { id: SHOP_A, created_at: '2024-01-01T00:00:00Z', distance_km: 2.5 },
      ],
      radiusMatches: [
        { id: SHOP_A, created_at: '2024-01-01T00:00:00Z', distance_km: 2.5 },
        { id: SHOP_B, created_at: '2024-01-02T00:00:00Z', distance_km: 1.0 },
      ],
    })

    const ids = result.map((a) => a.shop_id).sort()
    expect(ids).toEqual([SHOP_A, SHOP_B])
  })

  it('marks closest shop as primary by smallest distance_km', () => {
    const result = service.mergeAndMarkPrimary({
      pincode: '560001',
      pincodeMatches: [
        { id: SHOP_A, created_at: '2024-01-01T00:00:00Z', distance_km: 5.0 },
      ],
      radiusMatches: [
        { id: SHOP_B, created_at: '2024-01-02T00:00:00Z', distance_km: 1.5 },
        { id: SHOP_C, created_at: '2024-01-03T00:00:00Z', distance_km: 3.0 },
      ],
    })

    const primary = result.find((a) => a.is_primary)
    expect(primary?.shop_id).toBe(SHOP_B)
    expect(result.filter((a) => a.is_primary)).toHaveLength(1)
  })

  it('breaks distance ties by earliest created_at (Requirement 4.4)', () => {
    const result = service.mergeAndMarkPrimary({
      pincode: '560001',
      pincodeMatches: [],
      radiusMatches: [
        { id: SHOP_A, created_at: '2024-03-15T00:00:00Z', distance_km: 2.0 },
        { id: SHOP_B, created_at: '2024-01-10T00:00:00Z', distance_km: 2.0 },
        { id: SHOP_C, created_at: '2024-02-20T00:00:00Z', distance_km: 2.0 },
      ],
    })

    const primary = result.find((a) => a.is_primary)
    expect(primary?.shop_id).toBe(SHOP_B)
  })

  it('preserves matched_pincode for pincode-matched shops; null for radius-only', () => {
    const result = service.mergeAndMarkPrimary({
      pincode: '560001',
      pincodeMatches: [
        { id: SHOP_A, created_at: '2024-01-01T00:00:00Z', distance_km: 5.0 },
      ],
      radiusMatches: [
        { id: SHOP_B, created_at: '2024-01-02T00:00:00Z', distance_km: 1.0 },
      ],
    })

    const a = result.find((x) => x.shop_id === SHOP_A)
    const b = result.find((x) => x.shop_id === SHOP_B)
    expect(a?.matched_pincode).toBe('560001')
    expect(b?.matched_pincode).toBeNull()
  })

  it('NULL distances rank last when picking primary', () => {
    const result = service.mergeAndMarkPrimary({
      pincode: '560001',
      pincodeMatches: [
        { id: SHOP_A, created_at: '2024-01-01T00:00:00Z', distance_km: null },
      ],
      radiusMatches: [
        { id: SHOP_B, created_at: '2024-01-02T00:00:00Z', distance_km: 7.5 },
      ],
    })

    const primary = result.find((a) => a.is_primary)
    expect(primary?.shop_id).toBe(SHOP_B)
  })
})

// ═══════════════════════════════════════════════════════════
// AllocationService.computeAndUpsertForUser() — Requirement 4.6
// ═══════════════════════════════════════════════════════════
describe('AllocationService.computeAndUpsertForUser()', () => {
  let repo
  let service
  let queue

  beforeEach(() => {
    vi.clearAllMocks()
    repo = createRepoMock()
    queue = { add: vi.fn() }
    service = new AllocationService(repo, { queue })
  })

  it('rejects with NO_COORDINATES when lat/lng missing (Requirement 4.6)', async () => {
    const result = await service.computeAndUpsertForUser(USER_ID, {
      pincode: '560001',
    })
    expect(result.success).toBe(false)
    expect(result.code).toBe('NO_COORDINATES')
    expect(repo.findShopsByPincode).not.toHaveBeenCalled()
    expect(repo.findShopsByRadius).not.toHaveBeenCalled()
  })

  it('rejects with NO_PINCODE when pincode missing', async () => {
    const result = await service.computeAndUpsertForUser(USER_ID, {
      lat: 12.97,
      lng: 77.59,
    })
    expect(result.success).toBe(false)
    expect(result.code).toBe('NO_PINCODE')
  })

  it('runs both candidate queries in parallel and replaces allocations', async () => {
    repo.findShopsByPincode.mockResolvedValue([
      { id: SHOP_A, created_at: '2024-01-01T00:00:00Z', distance_km: 2.0 },
    ])
    repo.findShopsByRadius.mockResolvedValue([
      { id: SHOP_B, created_at: '2024-01-02T00:00:00Z', distance_km: 0.5 },
    ])
    repo.replaceForUser.mockResolvedValue(2)
    repo.findByUserId.mockResolvedValue([])
    cacheGet.mockResolvedValue(null)

    const result = await service.computeAndUpsertForUser(USER_ID, {
      lat: 12.97,
      lng: 77.59,
      pincode: '560001',
    })

    expect(result.success).toBe(true)
    expect(repo.findShopsByPincode).toHaveBeenCalledWith('560001', {
      lat: 12.97,
      lng: 77.59,
    })
    expect(repo.findShopsByRadius).toHaveBeenCalledWith(12.97, 77.59)
    expect(repo.replaceForUser).toHaveBeenCalledTimes(1)
    const upsertArgs = repo.replaceForUser.mock.calls[0]
    expect(upsertArgs[0]).toBe(USER_ID)
    expect(upsertArgs[1]).toHaveLength(2)
    // SHOP_B is closer so it should be primary
    const primary = upsertArgs[1].find((a) => a.is_primary)
    expect(primary.shop_id).toBe(SHOP_B)
    expect(cacheDel).toHaveBeenCalledWith(`bakaloo:allocation:v1:${USER_ID}`)
  })

  it('persists empty list when no shops match (Requirement 4.7)', async () => {
    repo.findShopsByPincode.mockResolvedValue([])
    repo.findShopsByRadius.mockResolvedValue([])
    repo.replaceForUser.mockResolvedValue(0)
    repo.findByUserId.mockResolvedValue([])
    cacheGet.mockResolvedValue(null)

    const result = await service.computeAndUpsertForUser(USER_ID, {
      lat: 1.0,
      lng: 1.0,
      pincode: '999999',
    })

    expect(result.success).toBe(true)
    expect(repo.replaceForUser).toHaveBeenCalledWith(USER_ID, [])
  })
})

// ═══════════════════════════════════════════════════════════
// AllocationService.getForUser() — Caching (TTL 600s)
// ═══════════════════════════════════════════════════════════
describe('AllocationService.getForUser()', () => {
  let repo
  let service

  beforeEach(() => {
    vi.clearAllMocks()
    repo = createRepoMock()
    service = new AllocationService(repo, { queue: { add: vi.fn() } })
  })

  it('returns cached payload without calling repo when cache hit', async () => {
    cacheGet.mockResolvedValue({ shops: [{ id: 'x' }] })

    const result = await service.getForUser(USER_ID)

    expect(cacheGet).toHaveBeenCalledWith(`bakaloo:allocation:v1:${USER_ID}`)
    expect(repo.findByUserId).not.toHaveBeenCalled()
    expect(result.shops).toHaveLength(1)
  })

  it('falls back to repo and caches result with TTL 600s on miss', async () => {
    cacheGet.mockResolvedValue(null)
    repo.findByUserId.mockResolvedValue([
      {
        id: 'alloc-1',
        shop_id: SHOP_A,
        name: 'Fresh Mart',
        distance_km: '2.50',
        matched_pincode: '560001',
        is_primary: true,
      },
    ])

    const result = await service.getForUser(USER_ID)

    expect(result.shops).toEqual([
      {
        id: 'alloc-1',
        shop_id: SHOP_A,
        name: 'Fresh Mart',
        distance_km: 2.5,
        matched_pincode: '560001',
        is_primary: true,
      },
    ])
    expect(cacheSet).toHaveBeenCalledWith(
      `bakaloo:allocation:v1:${USER_ID}`,
      result,
      600
    )
  })
})

// ═══════════════════════════════════════════════════════════
// AllocationService.enqueueShopAreaChange() — Requirement 4.8
// ═══════════════════════════════════════════════════════════
describe('AllocationService.enqueueShopAreaChange()', () => {
  let repo
  let service
  let queue

  beforeEach(() => {
    vi.clearAllMocks()
    repo = createRepoMock()
    queue = { add: vi.fn() }
    service = new AllocationService(repo, { queue })
  })

  it('enqueues a recompute-by-shop job with deterministic jobId for idempotency', async () => {
    queue.add.mockResolvedValue({ id: 'job-1' })

    const id = await service.enqueueShopAreaChange(SHOP_A)

    expect(queue.add).toHaveBeenCalledWith(
      'recompute-by-shop',
      { type: 'recompute-by-shop', shopId: SHOP_A },
      { jobId: `recompute-by-shop:${SHOP_A}` }
    )
    expect(id).toBe('job-1')
  })

  it('returns null and does not throw when queue.add fails', async () => {
    queue.add.mockRejectedValue(new Error('redis down'))

    const id = await service.enqueueShopAreaChange(SHOP_A)
    expect(id).toBeNull()
  })

  it('returns null when shopId is missing (defensive guard)', async () => {
    const id = await service.enqueueShopAreaChange(null)
    expect(id).toBeNull()
    expect(queue.add).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════
// computeAndUpsertForUser() — replaceForUser shape, response shape,
// cache priming via getForUser (Requirements 4.1, 4.4)
// ═══════════════════════════════════════════════════════════
describe('AllocationService.computeAndUpsertForUser() — persistence + response shape', () => {
  let repo
  let service

  beforeEach(() => {
    vi.clearAllMocks()
    repo = createRepoMock()
    service = new AllocationService(repo, { queue: { add: vi.fn() } })
  })

  it('passes merged allocations with primary flag set to replaceForUser', async () => {
    repo.findShopsByPincode.mockResolvedValue([
      { id: SHOP_A, created_at: '2024-01-01T00:00:00Z', distance_km: 4.0 },
    ])
    repo.findShopsByRadius.mockResolvedValue([
      { id: SHOP_B, created_at: '2024-01-02T00:00:00Z', distance_km: 1.5 },
    ])
    repo.replaceForUser.mockResolvedValue(2)
    repo.findByUserId.mockResolvedValue([])
    cacheGet.mockResolvedValue(null)

    await service.computeAndUpsertForUser(USER_ID, {
      lat: 12.97,
      lng: 77.59,
      pincode: '560001',
    })

    expect(repo.replaceForUser).toHaveBeenCalledTimes(1)
    const [userIdArg, allocations] = repo.replaceForUser.mock.calls[0]
    expect(userIdArg).toBe(USER_ID)

    // Exactly one row must be flagged primary
    const primaries = allocations.filter((a) => a.is_primary)
    expect(primaries).toHaveLength(1)
    expect(primaries[0].shop_id).toBe(SHOP_B) // closer

    // Persistence shape only contains canonical fields (no created_at leakage)
    for (const a of allocations) {
      expect(Object.keys(a).sort()).toEqual(
        ['distance_km', 'is_primary', 'matched_pincode', 'shop_id']
      )
      expect(typeof a.shop_id).toBe('string')
      expect(typeof a.is_primary).toBe('boolean')
    }
  })

  it('returns { success: true, data: { shops } } shape via getForUser re-read', async () => {
    repo.findShopsByPincode.mockResolvedValue([])
    repo.findShopsByRadius.mockResolvedValue([
      { id: SHOP_A, created_at: '2024-01-01T00:00:00Z', distance_km: 2.5 },
    ])
    repo.replaceForUser.mockResolvedValue(1)
    repo.findByUserId.mockResolvedValue([
      {
        id: 'alloc-1',
        shop_id: SHOP_A,
        name: 'Fresh Mart',
        distance_km: 2.5,
        matched_pincode: null,
        is_primary: true,
      },
    ])
    cacheGet.mockResolvedValue(null)

    const result = await service.computeAndUpsertForUser(USER_ID, {
      lat: 12.97,
      lng: 77.59,
      pincode: '560001',
    })

    expect(result).toEqual({
      success: true,
      data: {
        shops: [
          {
            id: 'alloc-1',
            shop_id: SHOP_A,
            name: 'Fresh Mart',
            distance_km: 2.5,
            matched_pincode: null,
            is_primary: true,
          },
        ],
      },
    })
    expect(repo.findByUserId).toHaveBeenCalledWith(USER_ID)
  })

  it('invalidates user cache before re-read so the re-read primes Redis', async () => {
    repo.findShopsByPincode.mockResolvedValue([])
    repo.findShopsByRadius.mockResolvedValue([])
    repo.replaceForUser.mockResolvedValue(0)
    repo.findByUserId.mockResolvedValue([])
    cacheGet.mockResolvedValue(null)

    await service.computeAndUpsertForUser(USER_ID, {
      lat: 12.97,
      lng: 77.59,
      pincode: '560001',
    })

    const cacheKey = `bakaloo:allocation:v1:${USER_ID}`
    expect(cacheDel).toHaveBeenCalledWith(cacheKey)
    expect(cacheSet).toHaveBeenCalledWith(cacheKey, { shops: [] }, 600)

    // Order: cacheDel must be called before cacheSet (priming via re-read)
    const delOrder = cacheDel.mock.invocationCallOrder[0]
    const setOrder = cacheSet.mock.invocationCallOrder[0]
    expect(delOrder).toBeLessThan(setOrder)
  })
})

// ═══════════════════════════════════════════════════════════
// AllocationService.getForUser() — DB-string coercion (Req 4.5)
// ═══════════════════════════════════════════════════════════
describe('AllocationService.getForUser() — DB type coercion', () => {
  let repo
  let service

  beforeEach(() => {
    vi.clearAllMocks()
    repo = createRepoMock()
    service = new AllocationService(repo, { queue: { add: vi.fn() } })
    cacheGet.mockResolvedValue(null)
  })

  it('coerces distance_km string ("2.50") from pg numeric to JS Number', async () => {
    repo.findByUserId.mockResolvedValue([
      {
        id: 'alloc-1',
        shop_id: SHOP_A,
        name: 'Fresh Mart',
        distance_km: '2.50',
        matched_pincode: '560001',
        is_primary: true,
      },
    ])

    const result = await service.getForUser(USER_ID)

    expect(result.shops[0].distance_km).toBe(2.5)
    expect(typeof result.shops[0].distance_km).toBe('number')
  })

  it('keeps distance_km null when DB returns null', async () => {
    repo.findByUserId.mockResolvedValue([
      {
        id: 'alloc-2',
        shop_id: SHOP_B,
        name: 'Corner Mart',
        distance_km: null,
        matched_pincode: '560001',
        is_primary: false,
      },
    ])

    const result = await service.getForUser(USER_ID)
    expect(result.shops[0].distance_km).toBeNull()
  })

  it('normalises is_primary truthy/falsy variants to strict booleans', async () => {
    repo.findByUserId.mockResolvedValue([
      {
        id: 'a-1',
        shop_id: SHOP_A,
        name: 'A',
        distance_km: 1.0,
        matched_pincode: null,
        is_primary: true,
      },
      {
        id: 'a-2',
        shop_id: SHOP_B,
        name: 'B',
        distance_km: 2.0,
        matched_pincode: null,
        // pg may surface BOOLEAN as 't'/'f' or 1/0 in some drivers — anything
        // other than === true should be normalised to false.
        is_primary: 't',
      },
      {
        id: 'a-3',
        shop_id: SHOP_C,
        name: 'C',
        distance_km: 3.0,
        matched_pincode: null,
        is_primary: 0,
      },
    ])

    const result = await service.getForUser(USER_ID)
    expect(result.shops.map((s) => s.is_primary)).toEqual([true, false, false])
  })
})

// ═══════════════════════════════════════════════════════════
// enqueueShopAreaChange — job naming + structured logging (Req 4.8, 4.9)
// ═══════════════════════════════════════════════════════════
describe('AllocationService.enqueueShopAreaChange() — job naming + logging', () => {
  let repo
  let service
  let queue

  beforeEach(() => {
    vi.clearAllMocks()
    repo = createRepoMock()
    queue = { add: vi.fn() }
    service = new AllocationService(repo, { queue })
  })

  it('uses the job name "recompute-by-shop"', async () => {
    queue.add.mockResolvedValue({ id: 'job-1' })
    await service.enqueueShopAreaChange(SHOP_A)
    expect(queue.add).toHaveBeenCalledWith(
      'recompute-by-shop',
      expect.any(Object),
      expect.any(Object)
    )
  })

  it('emits a structured info log on enqueue success with shopId/jobId/action', async () => {
    queue.add.mockResolvedValue({ id: 'job-42' })
    await service.enqueueShopAreaChange(SHOP_A)
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: SHOP_A,
        jobId: 'job-42',
        action: 'allocation_job_enqueued',
      }),
      expect.any(String)
    )
  })

  it('emits a structured error log on queue failure with shopId/err/action', async () => {
    queue.add.mockRejectedValue(new Error('redis down'))
    await service.enqueueShopAreaChange(SHOP_A)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: SHOP_A,
        err: 'redis down',
        action: 'allocation_enqueue_failed',
      }),
      expect.any(String)
    )
  })
})


describe('AllocationService — PIN normalisation before matching', () => {
  it('resolveForLocation() passes a whitespace-stripped PIN to the pincode query', async () => {
    const repo = createRepoMock()
    repo.findShopsByPincode.mockResolvedValue([])
    repo.findShopsByRadius.mockResolvedValue([])
    const service = new AllocationService(repo, { queue: { add: vi.fn() } })

    await service.resolveForLocation({ lat: 28.5, lng: 77.4, pincode: ' 201 301 ' })

    expect(repo.findShopsByPincode).toHaveBeenCalledWith('201301', { lat: 28.5, lng: 77.4 })
  })

  it('resolveForLocation() with no PIN skips the pincode query (radius-only matching)', async () => {
    const repo = createRepoMock()
    repo.findShopsByPincode.mockResolvedValue([])
    repo.findShopsByRadius.mockResolvedValue([])
    const service = new AllocationService(repo, { queue: { add: vi.fn() } })

    await service.resolveForLocation({ lat: 28.5, lng: 77.4 })
    await service.resolveForLocation({ lat: 28.5, lng: 77.4, pincode: '   ' })

    expect(repo.findShopsByPincode).not.toHaveBeenCalled()
    expect(repo.findShopsByRadius).toHaveBeenCalledTimes(2)
  })

  it('computeAndUpsertForUser() matches on the whitespace-stripped PIN', async () => {
    const repo = createRepoMock()
    repo.findShopsByPincode.mockResolvedValue([])
    repo.findShopsByRadius.mockResolvedValue([])
    repo.replaceForUser.mockResolvedValue(0)
    repo.findByUserId.mockResolvedValue([])
    const service = new AllocationService(repo, { queue: { add: vi.fn() } })

    await service.computeAndUpsertForUser('u1', { lat: 28.5, lng: 77.4, pincode: ' 201301\n' })

    expect(repo.findShopsByPincode).toHaveBeenCalledWith('201301', { lat: 28.5, lng: 77.4 })
  })
})
