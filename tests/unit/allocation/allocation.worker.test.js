import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external collaborators BEFORE importing the SUT ─
// The worker pulls the live AllocationRepository and AllocationService when
// no deps are provided to createAllocationProcessor — we override both via
// the dependency-injection hook so no real DB / Redis / queue is touched.
// We still mock cache.js, database.js, and bullmq.js so the implicit imports
// inside service.js / repository.js stay inert.
vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../../src/config/bullmq.js', () => ({
  allocationQueue: { add: vi.fn() },
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { createAllocationProcessor } from '../../../src/workers/allocation.worker.js'
import { logger } from '../../../src/config/logger.js'

// ─── Helpers ─────────────────────────────────────────────
const SHOP_A = '11111111-1111-1111-1111-111111111111'

function makeRepoMock() {
  return {
    findByUserId: vi.fn(),
    findShopsByPincode: vi.fn(),
    findShopsByRadius: vi.fn(),
    replaceForUser: vi.fn(),
    findUsersAffectedByShop: vi.fn(),
  }
}

function makeServiceMock() {
  return {
    computeAndUpsertForUser: vi.fn(),
  }
}

/** Build a minimal BullMQ-style job. */
function makeJob({ id = 'job-1', name, data }) {
  return { id, name, data }
}

// ═══════════════════════════════════════════════════════════
// Unknown job type — Requirement 4.8 (defensive)
// ═══════════════════════════════════════════════════════════
describe('createAllocationProcessor() — unknown job', () => {
  let repository
  let service
  let process

  beforeEach(() => {
    vi.clearAllMocks()
    repository = makeRepoMock()
    service = makeServiceMock()
    process = createAllocationProcessor({ repository, service })
  })

  it('returns { ignored: true } and logs a warn for an unrecognised type', async () => {
    const job = makeJob({ name: 'unknown-thing', data: { type: 'mystery' } })

    const result = await process(job)

    expect(result).toEqual({ ignored: true })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'allocation_unknown_job_type',
        type: 'mystery',
        jobId: 'job-1',
      }),
      expect.any(String)
    )
    expect(repository.findUsersAffectedByShop).not.toHaveBeenCalled()
    expect(service.computeAndUpsertForUser).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════
// recompute-by-shop — Requirement 4.8/4.9 (cursor pagination, batching)
// ═══════════════════════════════════════════════════════════
describe('createAllocationProcessor() — recompute-by-shop', () => {
  let repository
  let service
  let process

  beforeEach(() => {
    vi.clearAllMocks()
    repository = makeRepoMock()
    service = makeServiceMock()
    process = createAllocationProcessor({ repository, service })
  })

  it('returns noop when shopId is missing', async () => {
    const job = makeJob({ name: 'recompute-by-shop', data: { type: 'recompute-by-shop' } })

    const result = await process(job)

    expect(result).toEqual({
      shopId: null,
      processedUsers: 0,
      action: 'noop',
    })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'allocation_recompute_missing_shop_id',
      }),
      expect.any(String)
    )
  })

  it('iterates batches via the cursor and stops when batch < limit', async () => {
    // Two batches: first full (200), second short — should stop after second.
    const fullBatch = Array.from({ length: 200 }, (_, i) => ({
      user_id: `u-${String(i).padStart(4, '0')}`,
      lat: 12.97,
      lng: 77.59,
      pincode: '560001',
    }))
    const shortBatch = [
      {
        user_id: 'u-0200',
        lat: 12.98,
        lng: 77.6,
        pincode: '560002',
      },
    ]

    repository.findUsersAffectedByShop
      .mockResolvedValueOnce(fullBatch)
      .mockResolvedValueOnce(shortBatch)

    service.computeAndUpsertForUser.mockResolvedValue({
      success: true,
      data: { shops: [] },
    })

    const job = makeJob({
      name: 'recompute-by-shop',
      data: { type: 'recompute-by-shop', shopId: SHOP_A },
    })

    const result = await process(job)

    // Two pagination calls: first with afterUserId=null, second with cursor
    expect(repository.findUsersAffectedByShop).toHaveBeenCalledTimes(2)
    const firstCall = repository.findUsersAffectedByShop.mock.calls[0]
    const secondCall = repository.findUsersAffectedByShop.mock.calls[1]
    expect(firstCall[0]).toBe(SHOP_A)
    expect(firstCall[1]).toMatchObject({ afterUserId: null, limit: 200 })
    expect(secondCall[1]).toMatchObject({
      afterUserId: 'u-0199', // last id of first batch
      limit: 200,
    })

    // 201 users total, all successful
    expect(service.computeAndUpsertForUser).toHaveBeenCalledTimes(201)
    expect(result).toEqual({
      shopId: SHOP_A,
      processedUsers: 201,
      action: 'allocation_recompute_by_shop',
    })
  })

  it('skips users with missing coords/pincode without throwing or counting them', async () => {
    repository.findUsersAffectedByShop
      .mockResolvedValueOnce([
        { user_id: 'u-1', lat: 12.97, lng: 77.59, pincode: '560001' }, // ok
        { user_id: 'u-2', lat: null, lng: 77.59, pincode: '560001' },   // skip
        { user_id: 'u-3', lat: 12.97, lng: null, pincode: '560001' },   // skip
        { user_id: 'u-4', lat: 12.97, lng: 77.59, pincode: null },      // skip
      ])
      .mockResolvedValueOnce([])

    service.computeAndUpsertForUser.mockResolvedValue({
      success: true,
      data: { shops: [] },
    })

    const job = makeJob({
      name: 'recompute-by-shop',
      data: { type: 'recompute-by-shop', shopId: SHOP_A },
    })

    const result = await process(job)

    // Only u-1 should have been recomputed
    expect(service.computeAndUpsertForUser).toHaveBeenCalledTimes(1)
    expect(service.computeAndUpsertForUser).toHaveBeenCalledWith('u-1', {
      lat: 12.97,
      lng: 77.59,
      pincode: '560001',
    })

    expect(result).toEqual({
      shopId: SHOP_A,
      processedUsers: 1,
      action: 'allocation_recompute_by_shop',
    })

    // Skipped users emit a structured debug log
    expect(logger.debug).toHaveBeenCalled()
  })

  it('continues processing the batch when a single user recompute rejects', async () => {
    repository.findUsersAffectedByShop
      .mockResolvedValueOnce([
        { user_id: 'u-1', lat: 12.97, lng: 77.59, pincode: '560001' },
        { user_id: 'u-2', lat: 12.98, lng: 77.6, pincode: '560002' },
      ])
      .mockResolvedValueOnce([])

    service.computeAndUpsertForUser.mockImplementation(async (userId) => {
      if (userId === 'u-1') throw new Error('db hiccup')
      return { success: true, data: { shops: [] } }
    })

    const job = makeJob({
      name: 'recompute-by-shop',
      data: { type: 'recompute-by-shop', shopId: SHOP_A },
    })

    const result = await process(job)

    // Only u-2 succeeded
    expect(result.processedUsers).toBe(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: SHOP_A,
        userId: 'u-1',
        action: 'allocation_recompute_user_failed',
      }),
      expect.any(String)
    )
  })

  it('returns the final summary { shopId, processedUsers, action } and logs info on completion', async () => {
    repository.findUsersAffectedByShop.mockResolvedValueOnce([])

    const job = makeJob({
      name: 'recompute-by-shop',
      data: { type: 'recompute-by-shop', shopId: SHOP_A },
    })

    const result = await process(job)

    expect(result).toEqual({
      shopId: SHOP_A,
      processedUsers: 0,
      action: 'allocation_recompute_by_shop',
    })
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: SHOP_A,
        processedUsers: 0,
        action: 'allocation_recompute_by_shop',
      }),
      expect.any(String)
    )
  })

  it('routes by job.data.type when present, falling back to job.name', async () => {
    repository.findUsersAffectedByShop.mockResolvedValueOnce([])

    // Use job.name only (no data.type) to confirm fallback resolution.
    const job = makeJob({
      name: 'recompute-by-shop',
      data: { shopId: SHOP_A },
    })

    const result = await process(job)
    expect(result.action).toBe('allocation_recompute_by_shop')
    expect(repository.findUsersAffectedByShop).toHaveBeenCalledTimes(1)
  })
})
