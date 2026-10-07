import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external collaborators BEFORE importing the SUT ─────────────
// Same conventions as tests/unit/shop-products/shop-products.service.test.js
// so the suites stay aligned.

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

vi.mock('../../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn().mockResolvedValue(undefined) },
  stockNotificationsQueue: { add: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('../../../src/plugins/socketio.plugin.js', () => ({
  getSocketIo: vi.fn().mockReturnValue(null),
}))

import { ShopProductsService } from '../../../src/modules/shop-products/shop-products.service.js'
import {
  cacheGet,
  cacheSet,
  cacheDeletePattern,
} from '../../../src/utils/cache.js'
import { getClient } from '../../../src/config/database.js'

// ═══════════════════════════════════════════════════════════════════════
// Test fixtures
// ═══════════════════════════════════════════════════════════════════════

const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_PRODUCT_ID = '22222222-2222-2222-2222-222222222222'
const PRODUCT_ID = '33333333-3333-3333-3333-333333333333'
const USER_ID = '44444444-4444-4444-4444-444444444444'
const STAFF_USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const STAFF_USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

const ADMIN_ACTOR = { id: USER_ID, role: 'ADMIN' }

/**
 * Build a fully-populated shop_products repository mock plus an in-memory
 * stock_quantity / is_available state machine that the service drives via
 * findByIdForUpdate → applyStockUpdate. The mock mirrors the real repo's
 * is_available / sold_out_at flag transitions (Req 11.1, 11.6) so the
 * service emits the same post-commit transitions a real DB would produce.
 */
function makeShopProductsRepoMock(initialState = {}) {
  const state = {
    id: SHOP_PRODUCT_ID,
    shop_id: SHOP_ID,
    product_id: PRODUCT_ID,
    stock_quantity: 5,
    is_available: true,
    sold_out_at: null,
    low_stock_threshold: 5,
    deleted_at: null,
    ...initialState,
  }

  return {
    _state: state,
    create: vi.fn(),
    findById: vi.fn(),
    findByShopAndProduct: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    findByIdForUpdate: vi.fn().mockImplementation(async () => ({ ...state })),
    applyStockUpdate: vi
      .fn()
      .mockImplementation(async (_c, _id, _shopId, newQty) => {
        const prevQty = state.stock_quantity
        state.stock_quantity = newQty
        if (newQty === 0) {
          state.is_available = false
          state.sold_out_at = new Date()
        } else if (prevQty === 0 && newQty > 0) {
          state.is_available = true
          state.sold_out_at = null
        }
        return { ...state }
      }),
    findProductMetaById: vi
      .fn()
      .mockResolvedValue({ product_id: PRODUCT_ID, product_name: 'Milk' }),
  }
}

/**
 * Transactional pg client recorder so we can assert BEGIN/COMMIT/ROLLBACK
 * ordering relative to side-effect dispatch.
 */
function makeTxClientMock() {
  const calls = []
  const client = {
    query: vi.fn((sql) => {
      calls.push(sql)
      return Promise.resolve({ rows: [], rowCount: 0 })
    }),
    release: vi.fn(),
  }
  return { client, calls }
}

function makeIoMock() {
  const emit = vi.fn()
  const to = vi.fn().mockReturnValue({ emit })
  const io = { to, emit }
  return { io, to, emit }
}

function makeShopStaffRepoMock(userIds = []) {
  return {
    findActiveUserIdsByShopAndRoles: vi.fn().mockResolvedValue(userIds),
  }
}

function makeNotificationsServiceMock() {
  return { sendNotification: vi.fn().mockResolvedValue(undefined) }
}

function makeQueueMock() {
  return { add: vi.fn().mockResolvedValue(undefined) }
}

function makeService({
  repo,
  shopStaffRepo,
  notificationsService,
  notificationQueueOverride,
  stockNotificationsQueueOverride,
  io,
} = {}) {
  return new ShopProductsService(repo || makeShopProductsRepoMock(), {
    shopStaffRepository: shopStaffRepo || makeShopStaffRepoMock(),
    notificationsService:
      notificationsService === undefined
        ? makeNotificationsServiceMock()
        : notificationsService,
    notificationQueue: notificationQueueOverride || makeQueueMock(),
    stockNotificationsQueue:
      stockNotificationsQueueOverride || makeQueueMock(),
    getIo: () => io || null,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  cacheGet.mockResolvedValue(null)
  cacheSet.mockResolvedValue(undefined)
  cacheDeletePattern.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════
// 1.  Stock 5 → 0  — emits stock_out + notifies staff (Req 11.1-11.4)
// ═══════════════════════════════════════════════════════════════════════

describe('stock 5 → 0 transition (Req 11.1, 11.2, 11.3, 11.4)', () => {
  it('emits Socket.IO `shop:product:stock_out` to channel `shop:{shop_id}` after commit', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 5 })
    const { io, to, emit } = makeIoMock()
    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo, io })

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 0 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(true)
    expect(result.data.stock_quantity).toBe(0)
    expect(result.data.is_available).toBe(false)

    // Channel + event
    expect(to).toHaveBeenCalledWith(`shop:${SHOP_ID}`)
    expect(emit).toHaveBeenCalledTimes(1)
    const [event, payload] = emit.mock.calls[0]
    expect(event).toBe('shop:product:stock_out')
    expect(payload).toMatchObject({
      shop_product_id: SHOP_PRODUCT_ID,
      product_id: PRODUCT_ID,
      shop_id: SHOP_ID,
      stock_quantity: 0,
    })
    expect(payload.sold_out_at).toBeDefined()

    // Side effect must fire AFTER COMMIT (Req 11.2 — atomic w/ tx end)
    expect(calls).toContain('COMMIT')
    const commitIdx = client.query.mock.calls.findIndex(
      (c) => c[0] === 'COMMIT'
    )
    const commitOrder = client.query.mock.invocationCallOrder[commitIdx]
    const emitOrder = emit.mock.invocationCallOrder[0]
    expect(emitOrder).toBeGreaterThan(commitOrder)
  })

  it('pushes a stock-out notification to every active SHOP_ADMIN/SHOP_MANAGER for the shop (Req 11.4)', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 5 })
    const shopStaffRepo = makeShopStaffRepoMock([STAFF_USER_A, STAFF_USER_B])
    const notificationsService = makeNotificationsServiceMock()
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo, shopStaffRepo, notificationsService })

    await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 0 },
      ADMIN_ACTOR
    )

    expect(
      shopStaffRepo.findActiveUserIdsByShopAndRoles
    ).toHaveBeenCalledWith(SHOP_ID, ['SHOP_ADMIN', 'SHOP_MANAGER'])

    expect(notificationsService.sendNotification).toHaveBeenCalledTimes(2)
    const userIds = notificationsService.sendNotification.mock.calls.map(
      (c) => c[0]
    )
    expect(userIds.sort()).toEqual([STAFF_USER_A, STAFF_USER_B].sort())

    for (const [, payload] of notificationsService.sendNotification.mock.calls) {
      expect(payload.type).toBe('stock_out')
      expect(payload.data).toMatchObject({
        shop_id: SHOP_ID,
        shop_product_id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 0,
      })
    }
  })

  it('falls back to enqueuing on notificationQueue when no notificationsService is wired', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 5 })
    const shopStaffRepo = makeShopStaffRepoMock([STAFF_USER_A])
    const notificationQueueOverride = makeQueueMock()
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({
      repo,
      shopStaffRepo,
      notificationsService: null,
      notificationQueueOverride,
    })

    await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 0 },
      ADMIN_ACTOR
    )

    expect(notificationQueueOverride.add).toHaveBeenCalledTimes(1)
    const [name, data] = notificationQueueOverride.add.mock.calls[0]
    expect(name).toBe('push')
    expect(data).toMatchObject({
      type: 'push',
      userId: STAFF_USER_A,
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 2.  Stock 0 → 5  — emits restocked + enqueues wishlist fan-out (Req 11.6, 3.4)
// ═══════════════════════════════════════════════════════════════════════

describe('stock 0 → 5 transition (Req 11.6, 3.4)', () => {
  it('emits Socket.IO `shop:product:restocked` and enqueues wishlist-restock job', async () => {
    const repo = makeShopProductsRepoMock({
      stock_quantity: 0,
      is_available: false,
      sold_out_at: new Date(),
    })
    const { io, to, emit } = makeIoMock()
    const stockNotificationsQueueOverride = makeQueueMock()
    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({
      repo,
      io,
      stockNotificationsQueueOverride,
    })

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 5 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(true)
    expect(result.data.stock_quantity).toBe(5)
    expect(result.data.is_available).toBe(true)
    expect(result.data.sold_out_at).toBeNull()

    // Restocked event
    expect(to).toHaveBeenCalledWith(`shop:${SHOP_ID}`)
    expect(emit).toHaveBeenCalledTimes(1)
    const [event, payload] = emit.mock.calls[0]
    expect(event).toBe('shop:product:restocked')
    expect(payload).toMatchObject({
      shop_product_id: SHOP_PRODUCT_ID,
      product_id: PRODUCT_ID,
      shop_id: SHOP_ID,
      stock_quantity: 5,
    })

    // Wishlist fan-out
    expect(stockNotificationsQueueOverride.add).toHaveBeenCalledTimes(1)
    const [name, data] = stockNotificationsQueueOverride.add.mock.calls[0]
    expect(name).toBe('wishlist-restock')
    expect(data).toMatchObject({
      type: 'wishlist-restock',
      shop_product_id: SHOP_PRODUCT_ID,
      product_id: PRODUCT_ID,
      shop_id: SHOP_ID,
    })

    // Side effect AFTER COMMIT
    expect(calls).toContain('COMMIT')
    const commitIdx = client.query.mock.calls.findIndex(
      (c) => c[0] === 'COMMIT'
    )
    const commitOrder = client.query.mock.invocationCallOrder[commitIdx]
    const emitOrder = emit.mock.invocationCallOrder[0]
    const enqueueOrder =
      stockNotificationsQueueOverride.add.mock.invocationCallOrder[0]
    expect(emitOrder).toBeGreaterThan(commitOrder)
    expect(enqueueOrder).toBeGreaterThan(commitOrder)
  })

  it('does NOT emit a stock-out event or notify staff on a restock', async () => {
    const repo = makeShopProductsRepoMock({
      stock_quantity: 0,
      is_available: false,
    })
    const shopStaffRepo = makeShopStaffRepoMock([STAFF_USER_A])
    const notificationsService = makeNotificationsServiceMock()
    const { io, emit } = makeIoMock()
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({
      repo,
      io,
      shopStaffRepo,
      notificationsService,
    })

    await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 5 },
      ADMIN_ACTOR
    )

    // Exactly one event, and it is the restocked one — never both.
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0]).toBe('shop:product:restocked')

    // Staff push notifications fire ONLY on stock-out / low-stock, not restock.
    expect(notificationsService.sendNotification).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 3.  Stock 10 → 3 (threshold=5)  — notifies low stock (Req 11.9)
// ═══════════════════════════════════════════════════════════════════════

describe('low-stock threshold transition (Req 11.9)', () => {
  it('stock 10 → 3 with threshold=5 notifies staff with low_stock payload', async () => {
    const repo = makeShopProductsRepoMock({
      stock_quantity: 10,
      low_stock_threshold: 5,
    })
    const shopStaffRepo = makeShopStaffRepoMock([STAFF_USER_A])
    const notificationsService = makeNotificationsServiceMock()
    const { io, emit } = makeIoMock()
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo, io, shopStaffRepo, notificationsService })

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 3 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(true)
    expect(notificationsService.sendNotification).toHaveBeenCalledTimes(1)
    const [userId, payload] =
      notificationsService.sendNotification.mock.calls[0]
    expect(userId).toBe(STAFF_USER_A)
    expect(payload.type).toBe('low_stock')
    expect(payload.data).toMatchObject({
      shop_id: SHOP_ID,
      shop_product_id: SHOP_PRODUCT_ID,
      stock_quantity: 3,
      low_stock_threshold: 5,
    })

    // No Socket.IO emit on a low-stock transition (only on stock_out/restock)
    expect(emit).not.toHaveBeenCalled()
  })

  it('stock 10 → 7 with threshold=5 does NOT notify (above threshold)', async () => {
    const repo = makeShopProductsRepoMock({
      stock_quantity: 10,
      low_stock_threshold: 5,
    })
    const shopStaffRepo = makeShopStaffRepoMock([STAFF_USER_A])
    const notificationsService = makeNotificationsServiceMock()
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo, shopStaffRepo, notificationsService })

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 7 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(true)
    // No staff lookup happened because no transition fires
    expect(
      shopStaffRepo.findActiveUserIdsByShopAndRoles
    ).not.toHaveBeenCalled()
    expect(notificationsService.sendNotification).not.toHaveBeenCalled()
  })

  it('stock 10 → 5 with threshold=5 (boundary) notifies staff', async () => {
    const repo = makeShopProductsRepoMock({
      stock_quantity: 10,
      low_stock_threshold: 5,
    })
    const shopStaffRepo = makeShopStaffRepoMock([STAFF_USER_A])
    const notificationsService = makeNotificationsServiceMock()
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo, shopStaffRepo, notificationsService })

    await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 5 },
      ADMIN_ACTOR
    )

    expect(notificationsService.sendNotification).toHaveBeenCalledTimes(1)
    expect(notificationsService.sendNotification.mock.calls[0][1].type).toBe(
      'low_stock'
    )
  })

  it('stock 5 → 8 (increase) does NOT notify (no deduction transition)', async () => {
    const repo = makeShopProductsRepoMock({
      stock_quantity: 5,
      low_stock_threshold: 5,
    })
    const shopStaffRepo = makeShopStaffRepoMock([STAFF_USER_A])
    const notificationsService = makeNotificationsServiceMock()
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo, shopStaffRepo, notificationsService })

    await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 8 },
      ADMIN_ACTOR
    )

    expect(notificationsService.sendNotification).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 4.  Failure paths — rollback skips ALL side effects (Req 11.8)
// ═══════════════════════════════════════════════════════════════════════

describe('rollback path skips all side effects (Req 11.8)', () => {
  it('INSUFFICIENT_STOCK rollback emits no Socket.IO event and queues no jobs', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 3 })
    const shopStaffRepo = makeShopStaffRepoMock([STAFF_USER_A])
    const notificationsService = makeNotificationsServiceMock()
    const { io, emit } = makeIoMock()
    const stockNotificationsQueueOverride = makeQueueMock()
    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({
      repo,
      io,
      shopStaffRepo,
      notificationsService,
      stockNotificationsQueueOverride,
    })

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { delta: -10 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('INSUFFICIENT_STOCK')
    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')

    // No side effects
    expect(emit).not.toHaveBeenCalled()
    expect(notificationsService.sendNotification).not.toHaveBeenCalled()
    expect(stockNotificationsQueueOverride.add).not.toHaveBeenCalled()
    // No staff lookup either — handler is never invoked on rollback
    expect(
      shopStaffRepo.findActiveUserIdsByShopAndRoles
    ).not.toHaveBeenCalled()
  })

  it('NEGATIVE_STOCK rollback emits no Socket.IO event and queues no jobs', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 5 })
    const notificationsService = makeNotificationsServiceMock()
    const { io, emit } = makeIoMock()
    const stockNotificationsQueueOverride = makeQueueMock()
    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({
      repo,
      io,
      notificationsService,
      stockNotificationsQueueOverride,
    })

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: -1 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('NEGATIVE_STOCK')
    expect(calls).toContain('ROLLBACK')
    expect(emit).not.toHaveBeenCalled()
    expect(notificationsService.sendNotification).not.toHaveBeenCalled()
    expect(stockNotificationsQueueOverride.add).not.toHaveBeenCalled()
  })

  it('FORBIDDEN authz rejection never opens a transaction nor fires side effects', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 5 })
    const notificationsService = makeNotificationsServiceMock()
    const { io, emit } = makeIoMock()
    const stockNotificationsQueueOverride = makeQueueMock()
    const svc = makeService({
      repo,
      io,
      notificationsService,
      stockNotificationsQueueOverride,
    })

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 0 },
      { id: USER_ID, shopRole: 'SHOP_VIEWER' }
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('FORBIDDEN')
    expect(getClient).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect(notificationsService.sendNotification).not.toHaveBeenCalled()
    expect(stockNotificationsQueueOverride.add).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 5.  Best-effort isolation — side effect failures don't fail the API
// ═══════════════════════════════════════════════════════════════════════

describe('side-effect failures are isolated (Req 11.2-11.6, best-effort)', () => {
  it('a Socket.IO emit failure does NOT flip the service response', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 5 })
    const io = {
      to: vi.fn().mockImplementation(() => {
        throw new Error('socket gone')
      }),
    }
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo, io })

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 0 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(true)
    expect(result.data.stock_quantity).toBe(0)
  })

  it('a wishlist queue failure does NOT flip the service response on restock', async () => {
    const repo = makeShopProductsRepoMock({
      stock_quantity: 0,
      is_available: false,
    })
    const stockNotificationsQueueOverride = {
      add: vi.fn().mockRejectedValue(new Error('redis timeout')),
    }
    const { io, emit } = makeIoMock()
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({
      repo,
      io,
      stockNotificationsQueueOverride,
    })

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 7 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(true)
    // The Socket.IO event still fired even though the queue.add threw
    expect(emit).toHaveBeenCalledWith(
      'shop:product:restocked',
      expect.any(Object)
    )
  })

  it('a single staff notification failure does not block delivery to other staff', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 5 })
    const shopStaffRepo = makeShopStaffRepoMock([STAFF_USER_A, STAFF_USER_B])
    const notificationsService = {
      sendNotification: vi
        .fn()
        .mockRejectedValueOnce(new Error('FCM error'))
        .mockResolvedValueOnce(undefined),
    }
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo, shopStaffRepo, notificationsService })

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 0 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(true)
    expect(notificationsService.sendNotification).toHaveBeenCalledTimes(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Task 13.4 — gap-fill suites
//
// The five describe blocks above (15 tests) cover the major lifecycle
// transitions. The blocks below extend that coverage so every acceptance
// criterion in the task spec (11.1, 11.2, 11.3, 11.5, 11.8, 11.9) has at
// least one explicit assertion bound to its requirement number.
// ═══════════════════════════════════════════════════════════════════════

// ─── Helpers used by the gap-fill suites ─────────────────────────────
import { query as dbQuery } from '../../../src/config/database.js'
import { ShopProductsRepository } from '../../../src/modules/shop-products/shop-products.repository.js'

// ═══════════════════════════════════════════════════════════════════════
// Req 11.1 — Auto stock-out detection sets is_available=false AND sold_out_at
// inside the same database transaction
// ═══════════════════════════════════════════════════════════════════════

describe('Req 11.1 — auto stock-out detection within the stock-deduction tx', () => {
  it('records sold_out_at as a non-null timestamp on the updated row when stock hits zero', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 4 })
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo })

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 0 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(true)
    expect(result.data.is_available).toBe(false)
    expect(result.data.sold_out_at).toBeInstanceOf(Date)
  })

  it('runs applyStockUpdate (the is_available/sold_out_at write) BEFORE COMMIT (same tx)', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 2 })
    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo })

    await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 0 },
      ADMIN_ACTOR
    )

    // The mutation that flips is_available is applyStockUpdate (it is the
    // single SQL statement that writes is_available=false + sold_out_at=NOW())
    // and must be sandwiched between BEGIN and COMMIT.
    const beginIdx = calls.indexOf('BEGIN')
    const commitIdx = calls.indexOf('COMMIT')
    const applyOrder = repo.applyStockUpdate.mock.invocationCallOrder[0]
    const beginOrder = client.query.mock.invocationCallOrder[beginIdx]
    const commitOrder = client.query.mock.invocationCallOrder[commitIdx]

    expect(beginIdx).toBeGreaterThanOrEqual(0)
    expect(commitIdx).toBeGreaterThan(beginIdx)
    expect(applyOrder).toBeGreaterThan(beginOrder)
    expect(applyOrder).toBeLessThan(commitOrder)
  })

  it('does NOT change is_available when stock stays positive (e.g., 5 → 3)', async () => {
    const repo = makeShopProductsRepoMock({
      stock_quantity: 5,
      low_stock_threshold: 0, // disabled — keep this test focused on 11.1
    })
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo })

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 3 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(true)
    expect(result.data.is_available).toBe(true)
    expect(result.data.sold_out_at).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Req 11.2 — Redis cache invalidation on stock-out / restock
// ═══════════════════════════════════════════════════════════════════════

describe('Req 11.2 — Redis cache invalidated on stock-out and restock', () => {
  it('invalidates the shop-products listing cache (pattern delete) on stock 5 → 0', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 5 })
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo })

    await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 0 },
      ADMIN_ACTOR
    )

    expect(cacheDeletePattern).toHaveBeenCalledWith(
      `bakaloo:shop-products:v1:${SHOP_ID}:*`
    )
  })

  it('cache invalidation fires AFTER COMMIT (never from inside the tx)', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 5 })
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo })

    await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 0 },
      ADMIN_ACTOR
    )

    const commitIdx = client.query.mock.calls.findIndex(
      (c) => c[0] === 'COMMIT'
    )
    const commitOrder = client.query.mock.invocationCallOrder[commitIdx]
    const cacheOrder = cacheDeletePattern.mock.invocationCallOrder[0]
    expect(cacheOrder).toBeGreaterThan(commitOrder)
  })

  it('also invalidates the cache on a 0 → N restock', async () => {
    const repo = makeShopProductsRepoMock({
      stock_quantity: 0,
      is_available: false,
    })
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo })

    await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 12 },
      ADMIN_ACTOR
    )

    expect(cacheDeletePattern).toHaveBeenCalledWith(
      `bakaloo:shop-products:v1:${SHOP_ID}:*`
    )
  })

  it('does NOT invalidate the cache when the transaction rolls back', async () => {
    // delta below current stock → INSUFFICIENT_STOCK → ROLLBACK path
    const repo = makeShopProductsRepoMock({ stock_quantity: 1 })
    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo })

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { delta: -5 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(false)
    expect(calls).toContain('ROLLBACK')
    expect(cacheDeletePattern).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Req 11.3 — Socket.IO payload completeness
// ═══════════════════════════════════════════════════════════════════════

describe('Req 11.3 — Socket.IO stock-out payload carries the required fields', () => {
  it('payload includes product_id, product_name, shop_id, stock_quantity=0, sold_out_at', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 5 })
    repo.findProductMetaById.mockResolvedValueOnce({
      product_id: PRODUCT_ID,
      product_name: 'Amul Toned Milk 500ml',
    })
    const { io, emit } = makeIoMock()
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo, io })

    await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 0 },
      ADMIN_ACTOR
    )

    const [event, payload] = emit.mock.calls[0]
    expect(event).toBe('shop:product:stock_out')
    expect(payload).toEqual(
      expect.objectContaining({
        shop_product_id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        product_name: 'Amul Toned Milk 500ml',
        shop_id: SHOP_ID,
        stock_quantity: 0,
      })
    )
    // sold_out_at must be present and non-null (Req 11.1 surfaced via 11.3)
    expect(payload.sold_out_at).toBeDefined()
    expect(payload.sold_out_at).not.toBeNull()
  })

  it('emits to the correct channel `shop:{shop_id}` (no other rooms)', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 5 })
    const { io, to } = makeIoMock()
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo, io })

    await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 0 },
      ADMIN_ACTOR
    )

    expect(to).toHaveBeenCalledTimes(1)
    expect(to).toHaveBeenCalledWith(`shop:${SHOP_ID}`)
  })

  it('falls back to a null product_name when meta lookup fails (best-effort)', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 5 })
    repo.findProductMetaById.mockRejectedValueOnce(new Error('db blip'))
    const { io, emit } = makeIoMock()
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo, io })

    await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 0 },
      ADMIN_ACTOR
    )

    const [, payload] = emit.mock.calls[0]
    expect(payload.product_name).toBeNull()
    expect(payload.shop_id).toBe(SHOP_ID)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Req 11.5 — Stock-out products are excluded from customer-facing queries
// (filter on is_available = true). Verifies the repo SQL the service relies on.
// ═══════════════════════════════════════════════════════════════════════

describe('Req 11.5 — customer queries filter on is_available = true', () => {
  it('forwards is_available="true" through the service to the repo', async () => {
    const repo = makeShopProductsRepoMock()
    repo.findMany.mockResolvedValueOnce({ items: [], total: 0 })
    cacheGet.mockResolvedValueOnce(null)
    const svc = makeService({ repo })

    await svc.list(SHOP_ID, {
      page: 1,
      limit: 20,
      is_available: 'true',
    })

    expect(repo.findMany).toHaveBeenCalledTimes(1)
    expect(repo.findMany.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        shopId: SHOP_ID,
        is_available: 'true',
      })
    )
  })

  it('repo.findMany builds a parameterised `sp.is_available = true` predicate', async () => {
    const repo = new ShopProductsRepository()
    dbQuery.mockResolvedValue({ rows: [{ total: 0 }], rowCount: 0 })

    await repo.findMany({
      shopId: SHOP_ID,
      page: 1,
      limit: 20,
      is_available: 'true',
    })

    // First query is the data SELECT, second is the COUNT — both must filter.
    const sqlData = dbQuery.mock.calls[0][0]
    const sqlCount = dbQuery.mock.calls[1][0]
    expect(sqlData).toContain('sp.is_available = true')
    expect(sqlCount).toContain('sp.is_available = true')

    // Defence-in-depth: the predicate is a literal SQL fragment, not an
    // interpolated user value, and shop_id stays parameterised at $1.
    expect(dbQuery.mock.calls[0][1][0]).toBe(SHOP_ID)
    expect(sqlData).not.toContain("sp.is_available = 'true'")
  })

  it('does NOT add the is_available filter when the caller omits it (admin / dashboard)', async () => {
    const repo = new ShopProductsRepository()
    dbQuery.mockResolvedValue({ rows: [{ total: 0 }], rowCount: 0 })

    await repo.findMany({ shopId: SHOP_ID, page: 1, limit: 20 })

    const sql = dbQuery.mock.calls[0][0]
    expect(sql).not.toContain('sp.is_available = true')
    expect(sql).not.toContain('sp.is_available = false')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Req 11.8 — Transaction safety: SELECT FOR UPDATE + all-or-nothing rollback
// ═══════════════════════════════════════════════════════════════════════

describe('Req 11.8 — transaction safety (SELECT FOR UPDATE, all-or-nothing)', () => {
  it('issues BEGIN before findByIdForUpdate (the FOR UPDATE locking read)', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 5 })
    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo })

    await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 0 },
      ADMIN_ACTOR
    )

    expect(calls[0]).toBe('BEGIN')
    const beginOrder = client.query.mock.invocationCallOrder[0]
    const lockOrder = repo.findByIdForUpdate.mock.invocationCallOrder[0]
    expect(lockOrder).toBeGreaterThan(beginOrder)
  })

  it('passes the same tx client into findByIdForUpdate and applyStockUpdate (single tx)', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 5 })
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo })

    await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 0 },
      ADMIN_ACTOR
    )

    expect(repo.findByIdForUpdate.mock.calls[0][0]).toBe(client)
    expect(repo.applyStockUpdate.mock.calls[0][0]).toBe(client)
  })

  it('rolls back and surfaces SHOP_PRODUCT_NOT_FOUND when the locked row is missing', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 5 })
    repo.findByIdForUpdate.mockResolvedValueOnce(null)
    const { io, emit } = makeIoMock()
    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo, io })

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 0 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('SHOP_PRODUCT_NOT_FOUND')
    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    expect(repo.applyStockUpdate).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect(cacheDeletePattern).not.toHaveBeenCalled()
  })

  it('rolls back and skips side effects when applyStockUpdate throws inside the tx', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 5 })
    repo.applyStockUpdate.mockRejectedValueOnce(new Error('write failed'))
    const { io, emit } = makeIoMock()
    const stockNotificationsQueueOverride = makeQueueMock()
    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({
      repo,
      io,
      stockNotificationsQueueOverride,
    })

    await expect(
      svc.updateStock(
        SHOP_ID,
        SHOP_PRODUCT_ID,
        { stock_quantity: 0 },
        ADMIN_ACTOR
      )
    ).rejects.toThrow('write failed')

    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    expect(emit).not.toHaveBeenCalled()
    expect(cacheDeletePattern).not.toHaveBeenCalled()
    expect(stockNotificationsQueueOverride.add).not.toHaveBeenCalled()
  })

  it('translates a DB CHECK violation (SQLSTATE 23514) into NEGATIVE_STOCK with no side effects', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 5 })
    const checkViolation = Object.assign(new Error('check_violation'), {
      code: '23514',
    })
    repo.applyStockUpdate.mockRejectedValueOnce(checkViolation)
    const { io, emit } = makeIoMock()
    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo, io })

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 0 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('NEGATIVE_STOCK')
    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    expect(emit).not.toHaveBeenCalled()
    expect(cacheDeletePattern).not.toHaveBeenCalled()
  })

  it('always releases the pg client (via finally), even on throw', async () => {
    const repo = makeShopProductsRepoMock({ stock_quantity: 5 })
    repo.applyStockUpdate.mockRejectedValueOnce(new Error('boom'))
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo })

    await expect(
      svc.updateStock(
        SHOP_ID,
        SHOP_PRODUCT_ID,
        { stock_quantity: 0 },
        ADMIN_ACTOR
      )
    ).rejects.toThrow('boom')

    expect(client.release).toHaveBeenCalledTimes(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Req 11.9 — Low-stock threshold notifications (extended)
// ═══════════════════════════════════════════════════════════════════════

describe('Req 11.9 — low-stock threshold notifications (extended)', () => {
  it('threshold=0 (disabled) suppresses low-stock notifications even after a deduction', async () => {
    const repo = makeShopProductsRepoMock({
      stock_quantity: 4,
      low_stock_threshold: 0,
    })
    const shopStaffRepo = makeShopStaffRepoMock([STAFF_USER_A])
    const notificationsService = makeNotificationsServiceMock()
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo, shopStaffRepo, notificationsService })

    await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 1 },
      ADMIN_ACTOR
    )

    expect(notificationsService.sendNotification).not.toHaveBeenCalled()
  })

  it('low-stock notification fires AFTER COMMIT (never from inside the tx)', async () => {
    const repo = makeShopProductsRepoMock({
      stock_quantity: 10,
      low_stock_threshold: 5,
    })
    const shopStaffRepo = makeShopStaffRepoMock([STAFF_USER_A])
    const notificationsService = makeNotificationsServiceMock()
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo, shopStaffRepo, notificationsService })

    await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 3 },
      ADMIN_ACTOR
    )

    const commitIdx = client.query.mock.calls.findIndex(
      (c) => c[0] === 'COMMIT'
    )
    const commitOrder = client.query.mock.invocationCallOrder[commitIdx]
    const notifyOrder =
      notificationsService.sendNotification.mock.invocationCallOrder[0]
    expect(notifyOrder).toBeGreaterThan(commitOrder)
  })

  it('queries shop staff scoped by SHOP_ADMIN/SHOP_MANAGER roles only (no SHOP_VIEWER fan-out)', async () => {
    const repo = makeShopProductsRepoMock({
      stock_quantity: 10,
      low_stock_threshold: 5,
    })
    const shopStaffRepo = makeShopStaffRepoMock([STAFF_USER_A, STAFF_USER_B])
    const notificationsService = makeNotificationsServiceMock()
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo, shopStaffRepo, notificationsService })

    await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 3 },
      ADMIN_ACTOR
    )

    expect(
      shopStaffRepo.findActiveUserIdsByShopAndRoles
    ).toHaveBeenCalledWith(SHOP_ID, ['SHOP_ADMIN', 'SHOP_MANAGER'])
    expect(notificationsService.sendNotification).toHaveBeenCalledTimes(2)
  })

  it('low-stock payload includes the current stock_quantity and threshold', async () => {
    const repo = makeShopProductsRepoMock({
      stock_quantity: 8,
      low_stock_threshold: 4,
    })
    const shopStaffRepo = makeShopStaffRepoMock([STAFF_USER_A])
    const notificationsService = makeNotificationsServiceMock()
    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = makeService({ repo, shopStaffRepo, notificationsService })

    await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 2 },
      ADMIN_ACTOR
    )

    const [, payload] = notificationsService.sendNotification.mock.calls[0]
    expect(payload.type).toBe('low_stock')
    expect(payload.data).toEqual(
      expect.objectContaining({
        shop_id: SHOP_ID,
        shop_product_id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 2,
        low_stock_threshold: 4,
      })
    )
  })
})
