// Feature: multi-vendor-system, task 10.3
// Validates: Requirements 10.2, 10.3, 10.4, 10.5, 14.6
//
// Scheduled-orders BullMQ worker unit tests. The worker is a thin
// dispatcher that routes `fire-scheduled-order` jobs to
// ScheduledOrdersService.processFire — these tests drive that service
// path directly with all collaborators stubbed (no DB / Redis / BullMQ
// connections are opened).
//
// Scenarios covered (per task brief):
//   - SCHEDULED → PROCESSING → PLACED with placed_order_id link
//   - SCHEDULED → PROCESSING → FAILED on stock failure with reason
//   - Recurrence row inserted only on PLACED (DAILY / WEEKLY / MONTHLY)
//   - Recurrence skipped past repeat_until
//   - ONCE schedules do not recur
//   - Idempotent on already-PROCESSING / PLACED / CANCELLED rows
//   - computeNextScheduledFor (Property 15 sanity)
//   - Worker dispatcher: missing scheduledOrderId, unknown job type

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Inert collaborator mocks (must come before SUT import) ──
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

vi.mock('../../../src/config/redis.js', () => ({
  redis: {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
  },
}))

vi.mock('../../../src/config/bullmq.js', () => ({
  scheduledOrdersQueue: {
    add: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn().mockResolvedValue(null),
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

import { getClient } from '../../../src/config/database.js'
import { logger } from '../../../src/config/logger.js'
import { ScheduledOrdersService } from '../../../src/modules/scheduled-orders/scheduled-orders.service.js'
import { createScheduledOrderProcessor } from '../../../src/workers/scheduled-orders.worker.js'

// ─── Test fixtures ───────────────────────────────────────
const SCHEDULED_ID = 'aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SUCCESSOR_ID = 'aaaa2222-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const USER_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const PRODUCT_ID = '22222222-2222-2222-2222-222222222222'
const SHOP_PRODUCT_ID = '33333333-3333-3333-3333-333333333333'
const PLACED_ORDER_ID = 'ffff1111-ffff-ffff-ffff-ffffffffffff'

function makeClientMock() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  }
}

function makeQueueMock() {
  return {
    add: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn().mockResolvedValue(null),
  }
}

function makeBaseRow(overrides = {}) {
  return {
    id: SCHEDULED_ID,
    user_id: USER_ID,
    shop_id: SHOP_ID,
    items: [{ product_id: PRODUCT_ID, quantity: 2 }],
    subtotal: 100,
    delivery_address: { lat: 12.97, lng: 77.59, line1: '1 Main St' },
    payment_method: 'COD',
    scheduled_for: new Date('2024-06-01T10:00:00.000Z'),
    repeat_type: 'ONCE',
    repeat_until: null,
    status: 'SCHEDULED',
    placed_order_id: null,
    failure_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

function makeRepoMock(overrides = {}) {
  return {
    findByIdForUpdate: vi.fn(),
    updateStatusIfCurrent: vi.fn(),
    linkPlacedOrder: vi
      .fn()
      .mockImplementation((_c, id, placedOrderId) =>
        Promise.resolve({ id, placed_order_id: placedOrderId })
      ),
    createSuccessor: vi.fn(),
    ...overrides,
  }
}

function makeShopProductsRepoMock(overrides = {}) {
  return {
    findByShopAndProduct: vi.fn().mockResolvedValue({
      id: SHOP_PRODUCT_ID,
      shop_id: SHOP_ID,
      product_id: PRODUCT_ID,
      price: 50,
      sale_price: null,
      stock_quantity: 10,
      max_order_qty: 50,
      is_available: true,
      deleted_at: null,
    }),
    ...overrides,
  }
}

function makeOrderSplitterMock(overrides = {}) {
  return {
    splitCart: vi.fn().mockImplementation((items) => {
      const m = new Map()
      for (const i of items) {
        const arr = m.get(i.shopId)
        if (arr) arr.push(i)
        else m.set(i.shopId, [i])
      }
      return m
    }),
    createOrders: vi
      .fn()
      .mockResolvedValue([{ id: PLACED_ORDER_ID, shopId: SHOP_ID }]),
    ...overrides,
  }
}

function buildService({
  repo,
  shopProductsRepo,
  orderSplitter,
  notificationsService,
  queue,
} = {}) {
  return new ScheduledOrdersService(repo || makeRepoMock(), {
    queue: queue || makeQueueMock(),
    shopProductsRepository: shopProductsRepo || makeShopProductsRepoMock(),
    ordersRepository: { create: vi.fn(), generateOrderNumber: vi.fn() },
    orderSplitter: orderSplitter || makeOrderSplitterMock(),
    notificationsService: notificationsService || null,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════
// Pure helper — Property 15 (Req 10.3)
// ═══════════════════════════════════════════════════════════

describe('ScheduledOrdersService.computeNextScheduledFor (Req 10.3)', () => {
  it('DAILY adds exactly 24 hours', () => {
    const cur = new Date('2024-06-01T10:00:00.000Z')
    const next = ScheduledOrdersService.computeNextScheduledFor(cur, 'DAILY')
    expect(next.getTime() - cur.getTime()).toBe(24 * 60 * 60 * 1000)
  })

  it('WEEKLY adds exactly 7 days', () => {
    const cur = new Date('2024-06-01T10:00:00.000Z')
    const next = ScheduledOrdersService.computeNextScheduledFor(cur, 'WEEKLY')
    expect(next.getTime() - cur.getTime()).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('MONTHLY adds one calendar month', () => {
    const cur = new Date('2024-06-15T10:30:00.000Z')
    const next = ScheduledOrdersService.computeNextScheduledFor(cur, 'MONTHLY')
    expect(next.toISOString()).toBe('2024-07-15T10:30:00.000Z')
  })

  it('MONTHLY rolls Dec → next year Jan correctly', () => {
    const cur = new Date('2024-12-20T05:00:00.000Z')
    const next = ScheduledOrdersService.computeNextScheduledFor(cur, 'MONTHLY')
    expect(next.toISOString()).toBe('2025-01-20T05:00:00.000Z')
  })

  it('MONTHLY clamps to last day of target month (Jan 31 → Feb 29 in 2024)', () => {
    const cur = new Date('2024-01-31T08:00:00.000Z')
    const next = ScheduledOrdersService.computeNextScheduledFor(cur, 'MONTHLY')
    // 2024 is a leap year — Feb has 29 days.
    expect(next.toISOString()).toBe('2024-02-29T08:00:00.000Z')
  })

  it('ONCE returns null', () => {
    const cur = new Date('2024-06-01T10:00:00.000Z')
    expect(
      ScheduledOrdersService.computeNextScheduledFor(cur, 'ONCE')
    ).toBeNull()
  })

  it('returns null on unparseable input', () => {
    expect(
      ScheduledOrdersService.computeNextScheduledFor('garbage', 'DAILY')
    ).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════
// processFire — happy path (Req 10.2, 10.5)
// ═══════════════════════════════════════════════════════════

describe('ScheduledOrdersService.processFire — happy path', () => {
  it('SCHEDULED → PROCESSING → PLACED links placed_order_id (Req 10.2)', async () => {
    const client = makeClientMock()
    getClient.mockResolvedValue(client)

    const repo = makeRepoMock()
    repo.findByIdForUpdate.mockResolvedValue(makeBaseRow())
    // First UPDATE claims SCHEDULED → PROCESSING; second sets PLACED.
    repo.updateStatusIfCurrent
      .mockResolvedValueOnce({ id: SCHEDULED_ID, status: 'PROCESSING' })
      .mockResolvedValueOnce({ id: SCHEDULED_ID, status: 'PLACED' })

    const orderSplitter = makeOrderSplitterMock()
    const service = buildService({ repo, orderSplitter })

    const result = await service.processFire({ scheduledOrderId: SCHEDULED_ID })

    // BEGIN + COMMIT bracket
    expect(client.query).toHaveBeenCalledWith('BEGIN')
    expect(client.query).toHaveBeenCalledWith('COMMIT')
    // Status transitions
    expect(repo.updateStatusIfCurrent).toHaveBeenNthCalledWith(
      1,
      client,
      SCHEDULED_ID,
      'SCHEDULED',
      'PROCESSING'
    )
    expect(repo.updateStatusIfCurrent).toHaveBeenNthCalledWith(
      2,
      client,
      SCHEDULED_ID,
      'PROCESSING',
      'PLACED',
      { placed_order_id: PLACED_ORDER_ID }
    )
    // Order placed and linked
    expect(orderSplitter.createOrders).toHaveBeenCalledTimes(1)
    expect(repo.linkPlacedOrder).toHaveBeenCalledWith(
      client,
      SCHEDULED_ID,
      PLACED_ORDER_ID
    )
    // Result
    expect(result).toMatchObject({
      status: 'PLACED',
      scheduledOrderId: SCHEDULED_ID,
      placedOrderId: PLACED_ORDER_ID,
      successorId: null, // ONCE → no successor
    })
    // Client released
    expect(client.release).toHaveBeenCalled()
  })

  it('passes the OrderSplitter cart-shaped items with shopProductId', async () => {
    const client = makeClientMock()
    getClient.mockResolvedValue(client)

    const repo = makeRepoMock()
    repo.findByIdForUpdate.mockResolvedValue(makeBaseRow())
    repo.updateStatusIfCurrent
      .mockResolvedValueOnce({ id: SCHEDULED_ID, status: 'PROCESSING' })
      .mockResolvedValueOnce({ id: SCHEDULED_ID, status: 'PLACED' })

    const orderSplitter = makeOrderSplitterMock()
    const service = buildService({ repo, orderSplitter })

    await service.processFire({ scheduledOrderId: SCHEDULED_ID })

    const callArgs = orderSplitter.createOrders.mock.calls[0][0]
    const groups = callArgs.groups
    expect(groups.size).toBe(1)
    const items = groups.get(SHOP_ID)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      productId: PRODUCT_ID,
      shopId: SHOP_ID,
      shopProductId: SHOP_PRODUCT_ID,
      quantity: 2,
      lineTotal: 100, // 2 × 50
    })
    expect(callArgs.payment).toMatchObject({
      method: 'COD',
      status: 'PENDING',
    })
  })
})

// ═══════════════════════════════════════════════════════════
// processFire — recurrence (Req 10.3)
// ═══════════════════════════════════════════════════════════

describe('ScheduledOrdersService.processFire — recurrence (Req 10.3)', () => {
  it('DAILY schedule inserts a successor row exactly +24h ahead', async () => {
    const client = makeClientMock()
    getClient.mockResolvedValue(client)

    const baseRow = makeBaseRow({ repeat_type: 'DAILY' })
    const repo = makeRepoMock()
    repo.findByIdForUpdate.mockResolvedValue(baseRow)
    repo.updateStatusIfCurrent
      .mockResolvedValueOnce({ id: SCHEDULED_ID, status: 'PROCESSING' })
      .mockResolvedValueOnce({ id: SCHEDULED_ID, status: 'PLACED' })
    repo.createSuccessor.mockResolvedValue({
      id: SUCCESSOR_ID,
      scheduled_for: new Date('2024-06-02T10:00:00.000Z'),
    })

    const queue = makeQueueMock()
    const service = buildService({ repo, queue })

    const result = await service.processFire({ scheduledOrderId: SCHEDULED_ID })

    expect(repo.createSuccessor).toHaveBeenCalledTimes(1)
    const [, parentArg, nextAtArg] = repo.createSuccessor.mock.calls[0]
    expect(parentArg.id).toBe(SCHEDULED_ID)
    expect(nextAtArg.toISOString()).toBe('2024-06-02T10:00:00.000Z')

    // Successor's delayed BullMQ job is enqueued post-commit
    expect(queue.add).toHaveBeenCalledWith(
      'fire-scheduled-order',
      { scheduledOrderId: SUCCESSOR_ID },
      expect.objectContaining({
        jobId: `scheduled-order:${SUCCESSOR_ID}`,
      })
    )

    expect(result.successorId).toBe(SUCCESSOR_ID)
  })

  it('WEEKLY successor is scheduled 7 days ahead', async () => {
    const client = makeClientMock()
    getClient.mockResolvedValue(client)

    const baseRow = makeBaseRow({ repeat_type: 'WEEKLY' })
    const repo = makeRepoMock()
    repo.findByIdForUpdate.mockResolvedValue(baseRow)
    repo.updateStatusIfCurrent
      .mockResolvedValueOnce({ status: 'PROCESSING' })
      .mockResolvedValueOnce({ status: 'PLACED' })
    repo.createSuccessor.mockResolvedValue({
      id: SUCCESSOR_ID,
      scheduled_for: new Date('2024-06-08T10:00:00.000Z'),
    })

    const service = buildService({ repo })
    await service.processFire({ scheduledOrderId: SCHEDULED_ID })

    const nextAtArg = repo.createSuccessor.mock.calls[0][2]
    expect(nextAtArg.toISOString()).toBe('2024-06-08T10:00:00.000Z')
  })

  it('ONCE schedules do not insert a successor', async () => {
    const client = makeClientMock()
    getClient.mockResolvedValue(client)

    const repo = makeRepoMock()
    repo.findByIdForUpdate.mockResolvedValue(
      makeBaseRow({ repeat_type: 'ONCE' })
    )
    repo.updateStatusIfCurrent
      .mockResolvedValueOnce({ status: 'PROCESSING' })
      .mockResolvedValueOnce({ status: 'PLACED' })

    const service = buildService({ repo })
    const result = await service.processFire({ scheduledOrderId: SCHEDULED_ID })

    expect(repo.createSuccessor).not.toHaveBeenCalled()
    expect(result.successorId).toBeNull()
  })

  it('skips successor when next > repeat_until (Req 10.3)', async () => {
    const client = makeClientMock()
    getClient.mockResolvedValue(client)

    const repo = makeRepoMock()
    // scheduled_for = 2024-06-01, repeat_until = 2024-06-05 →
    // next would be 2024-06-08 > repeat_until, so no successor.
    repo.findByIdForUpdate.mockResolvedValue(
      makeBaseRow({
        repeat_type: 'WEEKLY',
        repeat_until: new Date('2024-06-05T10:00:00.000Z'),
      })
    )
    repo.updateStatusIfCurrent
      .mockResolvedValueOnce({ status: 'PROCESSING' })
      .mockResolvedValueOnce({ status: 'PLACED' })

    const service = buildService({ repo })
    const result = await service.processFire({ scheduledOrderId: SCHEDULED_ID })

    expect(repo.createSuccessor).not.toHaveBeenCalled()
    expect(result.successorId).toBeNull()
    expect(result.status).toBe('PLACED')
  })
})

// ═══════════════════════════════════════════════════════════
// processFire — stock failure (Req 10.4)
// ═══════════════════════════════════════════════════════════

describe('ScheduledOrdersService.processFire — stock failure (Req 10.4)', () => {
  it('rolls back, marks FAILED with reason, and sends push notification', async () => {
    // Outer transaction client (rolled back on stock failure)
    const fireClient = makeClientMock()
    // Separate transaction client used by recordFailure to mark FAILED
    const failClient = makeClientMock()
    getClient
      .mockResolvedValueOnce(fireClient)
      .mockResolvedValueOnce(failClient)

    const baseRow = makeBaseRow({ repeat_type: 'WEEKLY' })
    const repo = makeRepoMock()
    repo.findByIdForUpdate
      // 1st call inside processFire (before claim)
      .mockResolvedValueOnce(baseRow)
      // 2nd call inside recordFailure
      .mockResolvedValueOnce({ ...baseRow, status: 'PROCESSING' })
    repo.updateStatusIfCurrent
      // claim succeeds
      .mockResolvedValueOnce({ id: SCHEDULED_ID, status: 'PROCESSING' })
      // recordFailure marks FAILED
      .mockResolvedValueOnce({
        id: SCHEDULED_ID,
        status: 'FAILED',
        failure_reason: 'Items unavailable',
      })

    // OrderSplitter raises CHECKOUT_PARTIAL_FAIL with INSUFFICIENT_STOCK
    const stockErr = new Error('One or more items failed checkout validation')
    stockErr.code = 'CHECKOUT_PARTIAL_FAIL'
    stockErr.failures = [
      {
        productId: PRODUCT_ID,
        shopId: SHOP_ID,
        reason: 'Only 1 unit available',
        code: 'INSUFFICIENT_STOCK',
      },
    ]
    const orderSplitter = makeOrderSplitterMock({
      createOrders: vi.fn().mockRejectedValue(stockErr),
    })

    const sendNotification = vi.fn().mockResolvedValue(undefined)
    const notificationsService = { sendNotification }

    const service = buildService({
      repo,
      orderSplitter,
      notificationsService,
    })

    const result = await service.processFire({ scheduledOrderId: SCHEDULED_ID })

    // Outer fire transaction rolled back
    expect(fireClient.query).toHaveBeenCalledWith('ROLLBACK')
    // Successor must NOT be inserted on FAILED
    expect(repo.createSuccessor).not.toHaveBeenCalled()
    // recordFailure ran in its own transaction
    expect(failClient.query).toHaveBeenCalledWith('BEGIN')
    expect(failClient.query).toHaveBeenCalledWith('COMMIT')
    expect(repo.updateStatusIfCurrent).toHaveBeenLastCalledWith(
      failClient,
      SCHEDULED_ID,
      'PROCESSING',
      'FAILED',
      expect.objectContaining({ failure_reason: expect.any(String) })
    )
    // Push notification sent to the customer
    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(sendNotification.mock.calls[0][0]).toBe(USER_ID)
    expect(sendNotification.mock.calls[0][1]).toMatchObject({
      type: 'scheduled_order',
      data: expect.objectContaining({ scheduledOrderId: SCHEDULED_ID }),
    })
    // Result shape
    expect(result.status).toBe('FAILED')
    expect(result.scheduledOrderId).toBe(SCHEDULED_ID)
    expect(result.failures).toHaveLength(1)
    // Both clients released
    expect(fireClient.release).toHaveBeenCalled()
    expect(failClient.release).toHaveBeenCalled()
  })

  it('marks FAILED when shop_product is missing entirely (catalog gone)', async () => {
    const fireClient = makeClientMock()
    const failClient = makeClientMock()
    getClient
      .mockResolvedValueOnce(fireClient)
      .mockResolvedValueOnce(failClient)

    const repo = makeRepoMock()
    repo.findByIdForUpdate
      .mockResolvedValueOnce(makeBaseRow())
      .mockResolvedValueOnce({ ...makeBaseRow(), status: 'PROCESSING' })
    repo.updateStatusIfCurrent
      .mockResolvedValueOnce({ status: 'PROCESSING' })
      .mockResolvedValueOnce({ status: 'FAILED' })

    // shop product lookup returns null — product no longer in shop
    const shopProductsRepo = makeShopProductsRepoMock({
      findByShopAndProduct: vi.fn().mockResolvedValue(null),
    })

    const service = buildService({ repo, shopProductsRepo })
    const result = await service.processFire({ scheduledOrderId: SCHEDULED_ID })

    expect(result.status).toBe('FAILED')
    expect(repo.createSuccessor).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════
// processFire — idempotency (Req 10.5)
// ═══════════════════════════════════════════════════════════

describe('ScheduledOrdersService.processFire — idempotency (Req 10.5)', () => {
  it('exits NOOP when row is already PLACED', async () => {
    const client = makeClientMock()
    getClient.mockResolvedValue(client)

    const repo = makeRepoMock()
    repo.findByIdForUpdate.mockResolvedValue(
      makeBaseRow({ status: 'PLACED', placed_order_id: PLACED_ORDER_ID })
    )

    const orderSplitter = makeOrderSplitterMock()
    const service = buildService({ repo, orderSplitter })

    const result = await service.processFire({ scheduledOrderId: SCHEDULED_ID })

    expect(result).toMatchObject({
      status: 'NOOP',
      reason: 'ALREADY_TERMINAL',
      from: 'PLACED',
    })
    // No claim, no order, no successor
    expect(repo.updateStatusIfCurrent).not.toHaveBeenCalled()
    expect(orderSplitter.createOrders).not.toHaveBeenCalled()
    expect(repo.createSuccessor).not.toHaveBeenCalled()
    // Transaction was committed (no work to do) and client released
    expect(client.query).toHaveBeenCalledWith('BEGIN')
    expect(client.query).toHaveBeenCalledWith('COMMIT')
    expect(client.release).toHaveBeenCalled()
  })

  it('exits NOOP when row is already PROCESSING', async () => {
    const client = makeClientMock()
    getClient.mockResolvedValue(client)

    const repo = makeRepoMock()
    repo.findByIdForUpdate.mockResolvedValue(
      makeBaseRow({ status: 'PROCESSING' })
    )
    const service = buildService({ repo })

    const result = await service.processFire({ scheduledOrderId: SCHEDULED_ID })
    expect(result.status).toBe('NOOP')
    expect(result.from).toBe('PROCESSING')
  })

  it('exits NOOP when row is CANCELLED', async () => {
    const client = makeClientMock()
    getClient.mockResolvedValue(client)

    const repo = makeRepoMock()
    repo.findByIdForUpdate.mockResolvedValue(
      makeBaseRow({ status: 'CANCELLED' })
    )
    const service = buildService({ repo })

    const result = await service.processFire({ scheduledOrderId: SCHEDULED_ID })
    expect(result).toMatchObject({ status: 'NOOP', from: 'CANCELLED' })
  })

  it('exits NOOP when row is missing entirely', async () => {
    const client = makeClientMock()
    getClient.mockResolvedValue(client)

    const repo = makeRepoMock()
    repo.findByIdForUpdate.mockResolvedValue(null)
    const service = buildService({ repo })

    const result = await service.processFire({ scheduledOrderId: SCHEDULED_ID })
    expect(result).toMatchObject({ status: 'NOOP', reason: 'NOT_FOUND' })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════
// processFire — guard rails
// ═══════════════════════════════════════════════════════════

describe('ScheduledOrdersService.processFire — guard rails', () => {
  it('returns NOOP when scheduledOrderId is missing', async () => {
    const service = buildService({})
    const result = await service.processFire({})
    expect(result).toEqual({ status: 'NOOP', reason: 'MISSING_ID' })
  })

  it('throws when worker collaborators are not wired up', async () => {
    const service = new ScheduledOrdersService(makeRepoMock(), {
      queue: makeQueueMock(),
    })
    await expect(
      service.processFire({ scheduledOrderId: SCHEDULED_ID })
    ).rejects.toThrow(/processFire requires/)
  })

  it('re-throws unexpected infrastructure errors so BullMQ retries', async () => {
    const client = makeClientMock()
    getClient.mockResolvedValue(client)

    const repo = makeRepoMock()
    // Unexpected DB error during the first findByIdForUpdate
    repo.findByIdForUpdate.mockRejectedValue(new Error('connection lost'))

    const service = buildService({ repo })

    await expect(
      service.processFire({ scheduledOrderId: SCHEDULED_ID })
    ).rejects.toThrow('connection lost')
    // Client released and rollback attempted
    expect(client.release).toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════
// Worker dispatcher (createScheduledOrderProcessor)
// ═══════════════════════════════════════════════════════════

describe('createScheduledOrderProcessor', () => {
  it('routes fire-scheduled-order jobs to processFire', async () => {
    const processFire = vi
      .fn()
      .mockResolvedValue({ status: 'PLACED', placedOrderId: PLACED_ORDER_ID })
    const processor = createScheduledOrderProcessor({
      scheduledOrdersService: { processFire },
    })

    const result = await processor({
      id: 'job-1',
      name: 'fire-scheduled-order',
      data: {
        type: 'fire-scheduled-order',
        scheduledOrderId: SCHEDULED_ID,
      },
    })

    expect(processFire).toHaveBeenCalledWith({
      scheduledOrderId: SCHEDULED_ID,
      ordersService: null,
    })
    expect(result).toMatchObject({ status: 'PLACED' })
  })

  it('returns ignored when scheduledOrderId is missing', async () => {
    const processFire = vi.fn()
    const processor = createScheduledOrderProcessor({
      scheduledOrdersService: { processFire },
    })

    const result = await processor({
      id: 'job-2',
      name: 'fire-scheduled-order',
      data: { type: 'fire-scheduled-order' },
    })

    expect(processFire).not.toHaveBeenCalled()
    expect(result).toEqual({ ignored: true, reason: 'MISSING_ID' })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'scheduled_order_fire_missing_id',
      }),
      expect.any(String)
    )
  })

  it('logs and returns ignored on unknown job types', async () => {
    const processFire = vi.fn()
    const processor = createScheduledOrderProcessor({
      scheduledOrdersService: { processFire },
    })

    const result = await processor({
      id: 'job-3',
      name: 'mystery',
      data: { type: 'mystery' },
    })

    expect(processFire).not.toHaveBeenCalled()
    expect(result).toEqual({ ignored: true })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'scheduled_order_unknown_job_type',
        type: 'mystery',
      }),
      expect.any(String)
    )
  })

  it('routes by job.data.type when present, falling back to job.name', async () => {
    const processFire = vi.fn().mockResolvedValue({ status: 'NOOP' })
    const processor = createScheduledOrderProcessor({
      scheduledOrdersService: { processFire },
    })

    await processor({
      id: 'job-4',
      name: 'mystery', // ignored
      data: {
        type: 'fire-scheduled-order',
        scheduledOrderId: SCHEDULED_ID,
      },
    })
    expect(processFire).toHaveBeenCalledTimes(1)
  })
})
