// Feature: multi-vendor-system, task 13.2
// Validates: Requirements 3.4, 11.6
//
// Stock-notifications BullMQ worker unit tests. The worker is a thin
// dispatcher that routes `wishlist-restock` jobs through a paginated
// wishlist lookup and per-user NotificationsService.sendNotification —
// these tests drive that path directly with all collaborators stubbed
// (no DB / Redis / BullMQ / FCM connections are opened).
//
// Scenarios covered (per task brief):
//   - wishlist-restock fan-out: iterates every wishlist user and calls
//     notificationsService.sendNotification for each
//   - paginates via keyset cursor (afterUserId) until a partial batch
//   - empty wishlist → notified=0 with no notification calls
//   - per-user send failure does not abort the job (counted as skipped)
//   - missing product_id / shop_id is a noop with a warn log
//   - product name lookup failure → falls back to generic copy
//   - unknown job type returns { ignored: true } with a warn log

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Inert collaborator mocks (must come before SUT import) ──
vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../../src/config/redis.js', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

// pushNotification.js imports env.js which validates required env vars
// at module load. We never exercise the FCM path in these tests (the
// NotificationsService is fully mocked), so stub it to avoid the env
// validation kicking in inside the test process.
vi.mock('../../../src/utils/pushNotification.js', () => ({
  sendPush: vi.fn().mockResolvedValue({ success: true }),
  sendPushBatch: vi.fn().mockResolvedValue({ success: true }),
}))

import { logger } from '../../../src/config/logger.js'
import { createStockNotificationsProcessor } from '../../../src/workers/stock-notifications.worker.js'

// ─── Test fixtures ───────────────────────────────────────
const PRODUCT_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_ID = '22222222-2222-2222-2222-222222222222'
const SHOP_PRODUCT_ID = '33333333-3333-3333-3333-333333333333'

function makeJob(overrides = {}) {
  return {
    id: 'job-1',
    name: 'wishlist-restock',
    data: {
      type: 'wishlist-restock',
      product_id: PRODUCT_ID,
      shop_id: SHOP_ID,
      shop_product_id: SHOP_PRODUCT_ID,
      ...(overrides.data || {}),
    },
    ...overrides,
  }
}

function makeWishlistRepoMock(usersByCall = []) {
  let call = 0
  return {
    findUsersByWishlistedProduct: vi
      .fn()
      .mockImplementation(async () => {
        const rows = usersByCall[call] || []
        call += 1
        return rows
      }),
  }
}

function makeNotificationsServiceMock(overrides = {}) {
  return {
    sendNotification: vi.fn().mockResolvedValue({ id: 'n-1' }),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════
// wishlist-restock fan-out (Req 3.4, 11.6)
// ═══════════════════════════════════════════════════════════

describe('createStockNotificationsProcessor — wishlist-restock', () => {
  it('iterates every wishlist user and calls sendNotification once each', async () => {
    const wishlistRepository = makeWishlistRepoMock([
      [
        { user_id: 'u1' },
        { user_id: 'u2' },
        { user_id: 'u3' },
      ],
    ])
    const notificationsService = makeNotificationsServiceMock()
    const processor = createStockNotificationsProcessor({
      wishlistRepository,
      notificationsService,
      findProductMeta: vi.fn().mockResolvedValue({ name: 'Organic Milk' }),
      batchSize: 200,
    })

    const result = await processor(makeJob())

    expect(notificationsService.sendNotification).toHaveBeenCalledTimes(3)
    const userIds = notificationsService.sendNotification.mock.calls.map(
      ([uid]) => uid
    )
    expect(userIds).toEqual(['u1', 'u2', 'u3'])

    // Payload shape: each call carries restock metadata + product name
    for (const [, payload] of notificationsService.sendNotification.mock
      .calls) {
      expect(payload.type).toBe('restock')
      expect(payload.title).toMatch(/back in stock/i)
      expect(payload.body).toContain('Organic Milk')
      expect(payload.data).toMatchObject({
        product_id: PRODUCT_ID,
        shop_id: SHOP_ID,
        shop_product_id: SHOP_PRODUCT_ID,
        action: 'wishlist_restock',
      })
    }

    expect(result).toMatchObject({
      productId: PRODUCT_ID,
      shopId: SHOP_ID,
      notified: 3,
      skipped: 0,
      action: 'wishlist-restock',
    })
  })

  it('paginates via keyset cursor across multiple full batches', async () => {
    // First two batches are "full" (size 2), third batch is partial → stop.
    const wishlistRepository = makeWishlistRepoMock([
      [{ user_id: 'u1' }, { user_id: 'u2' }],
      [{ user_id: 'u3' }, { user_id: 'u4' }],
      [{ user_id: 'u5' }],
    ])
    const notificationsService = makeNotificationsServiceMock()
    const processor = createStockNotificationsProcessor({
      wishlistRepository,
      notificationsService,
      findProductMeta: vi.fn().mockResolvedValue({ name: 'Apples' }),
      batchSize: 2,
    })

    const result = await processor(makeJob())

    // First call has no cursor; subsequent calls pass the previous batch's
    // last user_id as `afterUserId`.
    expect(wishlistRepository.findUsersByWishlistedProduct).toHaveBeenNthCalledWith(
      1,
      PRODUCT_ID,
      { afterUserId: null, limit: 2 }
    )
    expect(wishlistRepository.findUsersByWishlistedProduct).toHaveBeenNthCalledWith(
      2,
      PRODUCT_ID,
      { afterUserId: 'u2', limit: 2 }
    )
    expect(wishlistRepository.findUsersByWishlistedProduct).toHaveBeenNthCalledWith(
      3,
      PRODUCT_ID,
      { afterUserId: 'u4', limit: 2 }
    )
    // Loop stops after partial batch — no 4th call.
    expect(wishlistRepository.findUsersByWishlistedProduct).toHaveBeenCalledTimes(3)

    expect(notificationsService.sendNotification).toHaveBeenCalledTimes(5)
    expect(result.notified).toBe(5)
  })

  it('returns notified=0 when no users have wishlisted the product', async () => {
    const wishlistRepository = makeWishlistRepoMock([[]])
    const notificationsService = makeNotificationsServiceMock()
    const processor = createStockNotificationsProcessor({
      wishlistRepository,
      notificationsService,
      findProductMeta: vi.fn().mockResolvedValue({ name: 'Bread' }),
    })

    const result = await processor(makeJob())

    expect(notificationsService.sendNotification).not.toHaveBeenCalled()
    expect(result).toMatchObject({ notified: 0, skipped: 0 })
  })

  it('counts a per-user send failure as skipped without aborting the job', async () => {
    const wishlistRepository = makeWishlistRepoMock([
      [{ user_id: 'u1' }, { user_id: 'u2' }, { user_id: 'u3' }],
    ])
    const notificationsService = {
      sendNotification: vi
        .fn()
        // u1 succeeds, u2 throws, u3 succeeds.
        .mockResolvedValueOnce({ id: 'n-1' })
        .mockRejectedValueOnce(new Error('FCM down'))
        .mockResolvedValueOnce({ id: 'n-3' }),
    }
    const processor = createStockNotificationsProcessor({
      wishlistRepository,
      notificationsService,
      findProductMeta: vi.fn().mockResolvedValue({ name: 'Eggs' }),
    })

    const result = await processor(makeJob())

    expect(notificationsService.sendNotification).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ notified: 2, skipped: 1 })
    expect(logger.error).toHaveBeenCalled()
    const [errCtx] = logger.error.mock.calls[0]
    expect(errCtx).toMatchObject({
      userId: 'u2',
      productId: PRODUCT_ID,
      shopId: SHOP_ID,
      action: 'stock_notifications_send_failed',
    })
  })

  it('falls back to generic copy when product lookup fails', async () => {
    const wishlistRepository = makeWishlistRepoMock([[{ user_id: 'u1' }]])
    const notificationsService = makeNotificationsServiceMock()
    const processor = createStockNotificationsProcessor({
      wishlistRepository,
      notificationsService,
      findProductMeta: vi
        .fn()
        .mockRejectedValue(new Error('db unavailable')),
    })

    const result = await processor(makeJob())

    expect(result).toMatchObject({ notified: 1, skipped: 0 })
    const [, payload] = notificationsService.sendNotification.mock.calls[0]
    // Generic body — product name was unavailable.
    expect(payload.body).toMatch(/wishlist/i)
    expect(payload.body).toMatch(/back in stock/i)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'stock_notifications_product_lookup_failed',
        productId: PRODUCT_ID,
      }),
      expect.any(String)
    )
  })

  it('falls back to generic copy when product is missing (null meta)', async () => {
    const wishlistRepository = makeWishlistRepoMock([[{ user_id: 'u1' }]])
    const notificationsService = makeNotificationsServiceMock()
    const processor = createStockNotificationsProcessor({
      wishlistRepository,
      notificationsService,
      findProductMeta: vi.fn().mockResolvedValue(null),
    })

    await processor(makeJob())

    const [, payload] = notificationsService.sendNotification.mock.calls[0]
    expect(payload.body).toMatch(/wishlist/i)
  })

  it('returns a noop when product_id is missing', async () => {
    const wishlistRepository = makeWishlistRepoMock([])
    const notificationsService = makeNotificationsServiceMock()
    const processor = createStockNotificationsProcessor({
      wishlistRepository,
      notificationsService,
    })

    const result = await processor(
      makeJob({
        data: {
          type: 'wishlist-restock',
          shop_id: SHOP_ID,
          // product_id intentionally omitted
        },
      })
    )

    expect(result).toMatchObject({ notified: 0, skipped: 0, action: 'noop' })
    expect(wishlistRepository.findUsersByWishlistedProduct).not.toHaveBeenCalled()
    expect(notificationsService.sendNotification).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'stock_notifications_missing_ids',
      }),
      expect.any(String)
    )
  })

  it('returns a noop when shop_id is missing', async () => {
    const wishlistRepository = makeWishlistRepoMock([])
    const notificationsService = makeNotificationsServiceMock()
    const processor = createStockNotificationsProcessor({
      wishlistRepository,
      notificationsService,
    })

    const result = await processor(
      makeJob({
        data: {
          type: 'wishlist-restock',
          product_id: PRODUCT_ID,
          // shop_id intentionally omitted
        },
      })
    )

    expect(result.action).toBe('noop')
    expect(wishlistRepository.findUsersByWishlistedProduct).not.toHaveBeenCalled()
  })

  it('returns { ignored: true } for unknown job types', async () => {
    const wishlistRepository = makeWishlistRepoMock([])
    const notificationsService = makeNotificationsServiceMock()
    const processor = createStockNotificationsProcessor({
      wishlistRepository,
      notificationsService,
    })

    const result = await processor({
      id: 'job-x',
      name: 'something-else',
      data: { type: 'something-else' },
    })

    expect(result).toEqual({ ignored: true })
    expect(wishlistRepository.findUsersByWishlistedProduct).not.toHaveBeenCalled()
    expect(notificationsService.sendNotification).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'stock_notifications_unknown_job_type',
      }),
      expect.any(String)
    )
  })

  it('clamps batchSize to a sane minimum of 1', async () => {
    const wishlistRepository = makeWishlistRepoMock([
      [{ user_id: 'u1' }],
      [],
    ])
    const notificationsService = makeNotificationsServiceMock()
    const processor = createStockNotificationsProcessor({
      wishlistRepository,
      notificationsService,
      findProductMeta: vi.fn().mockResolvedValue({ name: 'X' }),
      batchSize: 0, // invalid → should clamp to 1
    })

    await processor(makeJob())

    const callArgs =
      wishlistRepository.findUsersByWishlistedProduct.mock.calls[0][1]
    expect(callArgs.limit).toBe(1)
  })
})
