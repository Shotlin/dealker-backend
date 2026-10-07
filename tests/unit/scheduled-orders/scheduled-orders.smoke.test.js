import { describe, it, expect, vi, beforeEach } from 'vitest'

// Avoid touching Redis/Postgres/BullMQ during the smoke test
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

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// Stub the BullMQ queue module so importing the service doesn't open
// connections; tests that exercise enqueue/cancel pass an explicit stub.
vi.mock('../../../src/config/bullmq.js', () => ({
  scheduledOrdersQueue: {
    add: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn().mockResolvedValue(null),
  },
}))

import {
  ScheduledOrdersService,
  jobIdFor,
} from '../../../src/modules/scheduled-orders/scheduled-orders.service.js'
import { ScheduledOrdersRepository } from '../../../src/modules/scheduled-orders/scheduled-orders.repository.js'
import { ScheduledOrdersController } from '../../../src/modules/scheduled-orders/scheduled-orders.controller.js'
import {
  createScheduledOrderSchema,
  listScheduledOrdersQuerySchema,
  scheduledOrderIdParamSchema,
  SCHEDULED_ORDERS_CONSTANTS,
  REPEAT_TYPES,
  STATUS_VALUES,
} from '../../../src/modules/scheduled-orders/scheduled-orders.schema.js'

// ═══════════════════════════════════════════════════════════
// Smoke tests — module wiring + Zod schema correctness
// Validates: Requirements 10.1, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 14.5, 14.7
// ═══════════════════════════════════════════════════════════

const VALID_SHOP = '550e8400-e29b-41d4-a716-446655440000'
const VALID_PRODUCT = '660e8400-e29b-41d4-a716-446655440001'
const VALID_ID = '770e8400-e29b-41d4-a716-446655440002'

const validAddress = { lat: 12.9716, lng: 77.5946, line1: '1 Main St', city: 'BLR' }

function futureDateMs(hours, fromMs = Date.now()) {
  return new Date(fromMs + hours * 60 * 60 * 1000)
}

// ────────────────────────────────────────────────────────────
// Bootstrap
// ────────────────────────────────────────────────────────────
describe('scheduled-orders module bootstrap', () => {
  it('exports the Repository / Service / Controller classes', () => {
    const repo = new ScheduledOrdersRepository()
    const service = new ScheduledOrdersService(repo)
    const controller = new ScheduledOrdersController(service)

    expect(typeof service.create).toBe('function')
    expect(typeof service.list).toBe('function')
    expect(typeof service.getById).toBe('function')
    expect(typeof service.cancel).toBe('function')

    expect(typeof controller.create).toBe('function')
    expect(typeof controller.list).toBe('function')
    expect(typeof controller.getOne).toBe('function')
    expect(typeof controller.cancel).toBe('function')

    expect(typeof repo.findByIdForUser).toBe('function')
    expect(typeof repo.findManyByUser).toBe('function')
    expect(typeof repo.countActiveForUser).toBe('function')
    expect(typeof repo.create).toBe('function')
    expect(typeof repo.updateStatus).toBe('function')
    expect(typeof repo.isUserAllocatedToShop).toBe('function')
  })

  it('repository never selects with SELECT *', () => {
    expect(ScheduledOrdersRepository.SELECT_COLUMNS).toMatch(/id, user_id/)
    expect(ScheduledOrdersRepository.SELECT_COLUMNS).not.toContain('*')
  })

  it('jobIdFor returns canonical scheduled-order:{id} shape', () => {
    expect(jobIdFor('abc')).toBe('scheduled-order:abc')
  })
})

// ────────────────────────────────────────────────────────────
// Schema validation
// ────────────────────────────────────────────────────────────
describe('scheduled-orders schema validation', () => {
  const baseBody = () => ({
    shop_id: VALID_SHOP,
    items: [{ product_id: VALID_PRODUCT, quantity: 2 }],
    subtotal: 100,
    delivery_address: validAddress,
    payment_method: 'COD',
    scheduled_for: futureDateMs(3).toISOString(),
    repeat_type: 'ONCE',
  })

  it('exposes the canonical REPEAT_TYPES enum', () => {
    expect(REPEAT_TYPES).toEqual(['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY'])
  })

  it('exposes the canonical STATUS_VALUES enum', () => {
    expect(STATUS_VALUES).toEqual([
      'SCHEDULED',
      'PROCESSING',
      'PLACED',
      'FAILED',
      'CANCELLED',
    ])
  })

  it('accepts a well-formed body', () => {
    const result = createScheduledOrderSchema.safeParse(baseBody())
    expect(result.success).toBe(true)
  })

  it('rejects an empty items array (Req 10.1 — must have >= 1 item)', () => {
    const body = baseBody()
    body.items = []
    const result = createScheduledOrderSchema.safeParse(body)
    expect(result.success).toBe(false)
  })

  it('rejects items with quantity < 1', () => {
    const body = baseBody()
    body.items = [{ product_id: VALID_PRODUCT, quantity: 0 }]
    const result = createScheduledOrderSchema.safeParse(body)
    expect(result.success).toBe(false)
  })

  it('rejects items with non-uuid product_id', () => {
    const body = baseBody()
    body.items = [{ product_id: 'not-a-uuid', quantity: 1 }]
    const result = createScheduledOrderSchema.safeParse(body)
    expect(result.success).toBe(false)
  })

  // Req 10.10 — repeat_until cannot precede scheduled_for
  it('rejects repeat_until < scheduled_for (Req 10.10)', () => {
    const scheduledFor = futureDateMs(48)
    const before = new Date(scheduledFor.getTime() - 24 * 60 * 60 * 1000)
    const body = {
      ...baseBody(),
      scheduled_for: scheduledFor.toISOString(),
      repeat_type: 'WEEKLY',
      repeat_until: before.toISOString(),
    }
    const result = createScheduledOrderSchema.safeParse(body)
    expect(result.success).toBe(false)
  })

  it('accepts repeat_until equal to scheduled_for', () => {
    const scheduledFor = futureDateMs(48)
    const body = {
      ...baseBody(),
      scheduled_for: scheduledFor.toISOString(),
      repeat_type: 'WEEKLY',
      repeat_until: scheduledFor.toISOString(),
    }
    expect(createScheduledOrderSchema.safeParse(body).success).toBe(true)
  })

  it('rejects repeat_until on a ONCE schedule', () => {
    const scheduledFor = futureDateMs(48)
    const body = {
      ...baseBody(),
      scheduled_for: scheduledFor.toISOString(),
      repeat_type: 'ONCE',
      repeat_until: futureDateMs(96).toISOString(),
    }
    const result = createScheduledOrderSchema.safeParse(body)
    expect(result.success).toBe(false)
  })

  // List query schema: pagination defaults + max
  it('uses default page=1 limit=20 on list', () => {
    const result = listScheduledOrdersQuerySchema.safeParse({})
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ page: 1, limit: 20 })
  })

  it('caps list limit at 100', () => {
    const result = listScheduledOrdersQuerySchema.safeParse({
      page: '1',
      limit: '101',
    })
    expect(result.success).toBe(false)
  })

  it('coerces query strings to numbers', () => {
    const result = listScheduledOrdersQuerySchema.safeParse({
      page: '3',
      limit: '50',
    })
    expect(result.success).toBe(true)
    expect(result.data.page).toBe(3)
    expect(result.data.limit).toBe(50)
  })

  it('rejects invalid status filter', () => {
    expect(
      listScheduledOrdersQuerySchema.safeParse({ status: 'BOGUS' }).success
    ).toBe(false)
  })

  it('id param schema requires UUID', () => {
    expect(scheduledOrderIdParamSchema.safeParse({ id: 'x' }).success).toBe(
      false
    )
    expect(
      scheduledOrderIdParamSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
      }).success
    ).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────
// Pure helpers (Req 10.7, 10.6)
// ────────────────────────────────────────────────────────────
describe('ScheduledOrdersService.validateScheduledFor (Req 10.7)', () => {
  it('rejects times less than 2 hours in the future', () => {
    const now = new Date('2024-01-01T00:00:00Z')
    const result = ScheduledOrdersService.validateScheduledFor(
      new Date(now.getTime() + 60 * 60 * 1000), // 1h in future
      now
    )
    expect(result.ok).toBe(false)
    expect(result.code).toBe('VALIDATION_ERROR')
  })

  it('accepts times exactly 2 hours in the future', () => {
    const now = new Date('2024-01-01T00:00:00Z')
    const result = ScheduledOrdersService.validateScheduledFor(
      new Date(now.getTime() + 2 * 60 * 60 * 1000),
      now
    )
    expect(result.ok).toBe(true)
  })

  it('rejects past times', () => {
    const now = new Date('2024-01-01T00:00:00Z')
    const result = ScheduledOrdersService.validateScheduledFor(
      new Date(now.getTime() - 60 * 60 * 1000),
      now
    )
    expect(result.ok).toBe(false)
  })

  it('rejects unparseable inputs', () => {
    const now = new Date('2024-01-01T00:00:00Z')
    const result = ScheduledOrdersService.validateScheduledFor('not-a-date', now)
    expect(result.ok).toBe(false)
  })
})

describe('ScheduledOrdersService.canCustomerCancelFrom (Req 10.6)', () => {
  it('allows cancel from SCHEDULED', () => {
    expect(ScheduledOrdersService.canCustomerCancelFrom('SCHEDULED')).toBe(true)
  })
  it('allows cancel from FAILED', () => {
    expect(ScheduledOrdersService.canCustomerCancelFrom('FAILED')).toBe(true)
  })
  it('rejects cancel from PROCESSING / PLACED / CANCELLED', () => {
    expect(ScheduledOrdersService.canCustomerCancelFrom('PROCESSING')).toBe(
      false
    )
    expect(ScheduledOrdersService.canCustomerCancelFrom('PLACED')).toBe(false)
    expect(ScheduledOrdersService.canCustomerCancelFrom('CANCELLED')).toBe(
      false
    )
  })
})

// ────────────────────────────────────────────────────────────
// Service create-time guards (Req 10.7, 10.8, 10.9)
// ────────────────────────────────────────────────────────────
describe('ScheduledOrdersService.create — allocation + active cap', () => {
  let queue, repoStub, service

  beforeEach(() => {
    queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(null),
    }
    repoStub = {
      isUserAllocatedToShop: vi.fn(),
      countActiveForUser: vi.fn(),
      create: vi.fn(),
    }
    service = new ScheduledOrdersService(repoStub, { queue })
  })

  const baseData = () => ({
    shop_id: VALID_SHOP,
    items: [{ product_id: VALID_PRODUCT, quantity: 1 }],
    subtotal: 50,
    delivery_address: validAddress,
    payment_method: 'COD',
    scheduled_for: futureDateMs(3),
    repeat_type: 'ONCE',
  })

  it('rejects with NO_ALLOCATION when shop is not in user allocations (Req 10.8)', async () => {
    repoStub.isUserAllocatedToShop.mockResolvedValue(false)
    const result = await service.create('user-1', baseData())
    expect(result.success).toBe(false)
    expect(result.code).toBe('NO_ALLOCATION')
    expect(repoStub.create).not.toHaveBeenCalled()
  })

  it('rejects with SCHEDULE_LIMIT when active count >= 20 (Req 10.9)', async () => {
    repoStub.isUserAllocatedToShop.mockResolvedValue(true)
    repoStub.countActiveForUser.mockResolvedValue(
      SCHEDULED_ORDERS_CONSTANTS.MAX_ACTIVE_PER_CUSTOMER
    )
    const result = await service.create('user-1', baseData())
    expect(result.success).toBe(false)
    expect(result.code).toBe('SCHEDULE_LIMIT')
    expect(repoStub.create).not.toHaveBeenCalled()
  })

  it('rejects with VALIDATION_ERROR when scheduled_for is < 2h in the future (Req 10.7)', async () => {
    repoStub.isUserAllocatedToShop.mockResolvedValue(true)
    repoStub.countActiveForUser.mockResolvedValue(0)
    const data = baseData()
    data.scheduled_for = futureDateMs(1) // 1h in the future
    const result = await service.create('user-1', data)
    expect(result.success).toBe(false)
    expect(result.code).toBe('VALIDATION_ERROR')
    expect(repoStub.create).not.toHaveBeenCalled()
  })

  it('inserts and enqueues a delayed job on success', async () => {
    repoStub.isUserAllocatedToShop.mockResolvedValue(true)
    repoStub.countActiveForUser.mockResolvedValue(0)
    repoStub.create.mockResolvedValue({
      id: VALID_ID,
      shop_id: VALID_SHOP,
      scheduled_for: futureDateMs(3),
      repeat_type: 'ONCE',
    })

    const result = await service.create('user-1', baseData())
    expect(result.success).toBe(true)
    expect(repoStub.create).toHaveBeenCalledTimes(1)
    expect(queue.add).toHaveBeenCalledWith(
      'fire-scheduled-order',
      { scheduledOrderId: VALID_ID },
      expect.objectContaining({ jobId: jobIdFor(VALID_ID) })
    )
  })
})

// ────────────────────────────────────────────────────────────
// Service cancel — only SCHEDULED or FAILED (Req 10.6)
// ────────────────────────────────────────────────────────────
describe('ScheduledOrdersService.cancel — Req 10.6', () => {
  let queue, repoStub, service

  beforeEach(() => {
    queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue({ remove: vi.fn().mockResolvedValue() }),
    }
    repoStub = {
      findByIdForUser: vi.fn(),
      updateStatus: vi.fn(),
    }
    service = new ScheduledOrdersService(repoStub, { queue })
  })

  it('cancels from SCHEDULED and removes the queued job', async () => {
    repoStub.findByIdForUser.mockResolvedValue({
      id: VALID_ID,
      user_id: 'user-1',
      shop_id: VALID_SHOP,
      status: 'SCHEDULED',
    })
    repoStub.updateStatus.mockResolvedValue({ id: VALID_ID, status: 'CANCELLED' })

    const result = await service.cancel('user-1', VALID_ID)
    expect(result.success).toBe(true)
    expect(repoStub.updateStatus).toHaveBeenCalledWith(VALID_ID, 'CANCELLED')
    expect(queue.getJob).toHaveBeenCalledWith(jobIdFor(VALID_ID))
  })

  it('cancels from FAILED', async () => {
    repoStub.findByIdForUser.mockResolvedValue({
      id: VALID_ID,
      user_id: 'user-1',
      shop_id: VALID_SHOP,
      status: 'FAILED',
    })
    repoStub.updateStatus.mockResolvedValue({ id: VALID_ID, status: 'CANCELLED' })

    const result = await service.cancel('user-1', VALID_ID)
    expect(result.success).toBe(true)
  })

  it('rejects cancel from PROCESSING with INVALID_STATE_TRANSITION', async () => {
    repoStub.findByIdForUser.mockResolvedValue({
      id: VALID_ID,
      user_id: 'user-1',
      shop_id: VALID_SHOP,
      status: 'PROCESSING',
    })
    const result = await service.cancel('user-1', VALID_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('INVALID_STATE_TRANSITION')
    expect(repoStub.updateStatus).not.toHaveBeenCalled()
  })

  it('rejects cancel from PLACED with INVALID_STATE_TRANSITION', async () => {
    repoStub.findByIdForUser.mockResolvedValue({
      id: VALID_ID,
      user_id: 'user-1',
      shop_id: VALID_SHOP,
      status: 'PLACED',
    })
    const result = await service.cancel('user-1', VALID_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('INVALID_STATE_TRANSITION')
  })

  it('rejects cancel from CANCELLED', async () => {
    repoStub.findByIdForUser.mockResolvedValue({
      id: VALID_ID,
      user_id: 'user-1',
      shop_id: VALID_SHOP,
      status: 'CANCELLED',
    })
    const result = await service.cancel('user-1', VALID_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('INVALID_STATE_TRANSITION')
  })

  it('returns SCHEDULED_ORDER_NOT_FOUND when row is missing or owned by another user', async () => {
    repoStub.findByIdForUser.mockResolvedValue(null)
    const result = await service.cancel('user-1', VALID_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('SCHEDULED_ORDER_NOT_FOUND')
  })
})
