import { describe, it, expect, vi, beforeEach } from 'vitest'

// ═══════════════════════════════════════════════════════════════════════
// Scheduled Orders module — extended unit tests
// Validates: Requirements 10.1, 10.5, 10.6, 10.7, 10.8, 10.9
//
// Complements scheduled-orders.smoke.test.js with deeper coverage of:
//   1. Service.create — 1d future success, delay computation,
//      queue-failure non-fatality (Req 10.7, 10.2)
//   2. Service.list   — userId scope, status filter, pagination defaults
//                       (Req 14.5/14.7)
//   3. Service.getById — owner scope, NOT_FOUND envelope
//   4. Service.cancel — BullMQ job removal jobId, failure-is-non-fatal
//      (Req 10.6)
//   5. Repository SQL safety — parameterised $N, no SELECT *, FOR UPDATE,
//      filters on status='SCHEDULED', ::jsonb casts on createSuccessor
//   6. Schema deeper coverage — repeat_type enum, required scheduled_for
// ═══════════════════════════════════════════════════════════════════════

// Avoid touching Redis / Postgres / BullMQ during the tests.
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

vi.mock('../../../src/config/bullmq.js', () => ({
  scheduledOrdersQueue: {
    add: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn().mockResolvedValue(null),
  },
}))

import { query } from '../../../src/config/database.js'
import {
  ScheduledOrdersService,
  jobIdFor,
} from '../../../src/modules/scheduled-orders/scheduled-orders.service.js'
import { ScheduledOrdersRepository } from '../../../src/modules/scheduled-orders/scheduled-orders.repository.js'
import {
  createScheduledOrderSchema,
  listScheduledOrdersQuerySchema,
  SCHEDULED_ORDERS_CONSTANTS,
} from '../../../src/modules/scheduled-orders/scheduled-orders.schema.js'

// ─── Test fixtures ─────────────────────────────────────────────────────
const SHOP_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const OWNER_OTHER = '33333333-3333-4333-8333-333333333333'
const SCHEDULED_ID = '44444444-4444-4444-8444-444444444444'
const PLACED_ORDER_ID = '55555555-5555-4555-8555-555555555555'
const PRODUCT_ID = '66666666-6666-4666-8666-666666666666'

const validAddress = {
  lat: 12.9716,
  lng: 77.5946,
  line1: '1 Main St',
  city: 'BLR',
}

const futureDate = (hours, fromMs = Date.now()) =>
  new Date(fromMs + hours * 60 * 60 * 1000)

const baseCreateData = (overrides = {}) => ({
  shop_id: SHOP_ID,
  items: [{ product_id: PRODUCT_ID, quantity: 1 }],
  subtotal: 50,
  delivery_address: validAddress,
  payment_method: 'COD',
  scheduled_for: futureDate(3),
  repeat_type: 'ONCE',
  ...overrides,
})

const makeQueue = () => ({
  add: vi.fn().mockResolvedValue(undefined),
  getJob: vi.fn().mockResolvedValue(null),
})

const makeRepoStub = () => ({
  isUserAllocatedToShop: vi.fn(),
  countActiveForUser: vi.fn(),
  create: vi.fn(),
  findByIdForUser: vi.fn(),
  findManyByUser: vi.fn(),
  updateStatus: vi.fn(),
})

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════
// 1. Service.create — extended (Req 10.7, 10.2, 10.8, 10.9)
// ═══════════════════════════════════════════════════════════════════════

describe('ScheduledOrdersService.create — happy path edges', () => {
  let queue, repo, service

  beforeEach(() => {
    queue = makeQueue()
    repo = makeRepoStub()
    repo.isUserAllocatedToShop.mockResolvedValue(true)
    repo.countActiveForUser.mockResolvedValue(0)
    service = new ScheduledOrdersService(repo, { queue })
  })

  it('accepts a scheduled_for 1 day in the future (Req 10.7)', async () => {
    const scheduledFor = futureDate(24)
    repo.create.mockResolvedValue({
      id: SCHEDULED_ID,
      shop_id: SHOP_ID,
      scheduled_for: scheduledFor,
      repeat_type: 'ONCE',
    })
    const result = await service.create(
      USER_ID,
      baseCreateData({ scheduled_for: scheduledFor })
    )
    expect(result.success).toBe(true)
    expect(repo.create).toHaveBeenCalledTimes(1)
  })

  it('enqueues the delayed job with delay ≈ scheduled_for - now (Req 10.2)', async () => {
    const hours = 5
    const scheduledFor = futureDate(hours)
    repo.create.mockResolvedValue({
      id: SCHEDULED_ID,
      shop_id: SHOP_ID,
      scheduled_for: scheduledFor,
      repeat_type: 'ONCE',
    })
    await service.create(
      USER_ID,
      baseCreateData({ scheduled_for: scheduledFor })
    )
    expect(queue.add).toHaveBeenCalledTimes(1)
    const [, payload, opts] = queue.add.mock.calls[0]
    expect(payload).toEqual({ scheduledOrderId: SCHEDULED_ID })
    expect(opts.jobId).toBe(jobIdFor(SCHEDULED_ID))
    // Delay should be within ±1 minute of the actual gap.
    const expectedDelay = hours * 60 * 60 * 1000
    expect(opts.delay).toBeGreaterThan(expectedDelay - 60_000)
    expect(opts.delay).toBeLessThanOrEqual(expectedDelay)
  })

  it('clamps delay to 0 when scheduled_for is in the past on enqueue', async () => {
    // scheduled_for valid at validation (3h future) but row returned with a
    // past scheduled_for — exercises the Math.max(0, …) guard in the
    // enqueue path. Real-world this only happens if the DB clock skews.
    const validForCreate = futureDate(3)
    repo.create.mockResolvedValue({
      id: SCHEDULED_ID,
      shop_id: SHOP_ID,
      scheduled_for: futureDate(-1), // 1h in the past
      repeat_type: 'ONCE',
    })
    await service.create(
      USER_ID,
      baseCreateData({ scheduled_for: validForCreate })
    )
    const [, , opts] = queue.add.mock.calls[0]
    expect(opts.delay).toBe(0)
  })

  it('queue.add failure is non-fatal — DB row is still committed (Req 10.2 fallback)', async () => {
    queue.add.mockRejectedValue(new Error('Redis connection lost'))
    const inserted = {
      id: SCHEDULED_ID,
      shop_id: SHOP_ID,
      scheduled_for: futureDate(3),
      repeat_type: 'ONCE',
    }
    repo.create.mockResolvedValue(inserted)

    const result = await service.create(USER_ID, baseCreateData())

    expect(result.success).toBe(true)
    expect(result.data).toEqual(inserted)
    expect(repo.create).toHaveBeenCalledTimes(1)
    expect(queue.add).toHaveBeenCalledTimes(1)
  })

  it('returns UNAUTHORIZED when userId is missing', async () => {
    const result = await service.create(null, baseCreateData())
    expect(result.success).toBe(false)
    expect(result.code).toBe('UNAUTHORIZED')
  })

  it('does not enqueue when allocation check fails', async () => {
    repo.isUserAllocatedToShop.mockResolvedValue(false)
    const result = await service.create(USER_ID, baseCreateData())
    expect(result.success).toBe(false)
    expect(result.code).toBe('NO_ALLOCATION')
    expect(queue.add).not.toHaveBeenCalled()
  })

  it('does not enqueue when active cap reached', async () => {
    repo.countActiveForUser.mockResolvedValue(
      SCHEDULED_ORDERS_CONSTANTS.MAX_ACTIVE_PER_CUSTOMER
    )
    const result = await service.create(USER_ID, baseCreateData())
    expect(result.success).toBe(false)
    expect(result.code).toBe('SCHEDULE_LIMIT')
    expect(queue.add).not.toHaveBeenCalled()
  })

  it('persists payment_method default and repeat_type default', async () => {
    repo.create.mockResolvedValue({
      id: SCHEDULED_ID,
      shop_id: SHOP_ID,
      scheduled_for: futureDate(3),
      repeat_type: 'ONCE',
    })
    // Service-level defaults (caller bypasses Zod here).
    const data = baseCreateData()
    delete data.payment_method
    delete data.repeat_type
    await service.create(USER_ID, data)

    const persisted = repo.create.mock.calls[0][0]
    expect(persisted.payment_method).toBe('COD')
    expect(persisted.repeat_type).toBe('ONCE')
    expect(persisted.repeat_until).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 2. Service.list — Req 14.5 / 14.7
// ═══════════════════════════════════════════════════════════════════════

describe('ScheduledOrdersService.list', () => {
  let repo, service

  beforeEach(() => {
    repo = makeRepoStub()
    repo.findManyByUser.mockResolvedValue({ items: [], total: 0 })
    service = new ScheduledOrdersService(repo, { queue: makeQueue() })
  })

  it('forwards userId scope to the repository', async () => {
    await service.list(USER_ID, { page: 1, limit: 20 })
    expect(repo.findManyByUser).toHaveBeenCalledWith({
      userId: USER_ID,
      status: undefined,
      page: 1,
      limit: 20,
    })
  })

  it('forwards status filter when provided', async () => {
    await service.list(USER_ID, { page: 2, limit: 50, status: 'PLACED' })
    expect(repo.findManyByUser).toHaveBeenCalledWith({
      userId: USER_ID,
      status: 'PLACED',
      page: 2,
      limit: 50,
    })
  })

  it('returns the items + total + page + limit envelope', async () => {
    repo.findManyByUser.mockResolvedValue({
      items: [{ id: SCHEDULED_ID }],
      total: 1,
    })
    const result = await service.list(USER_ID, { page: 1, limit: 20 })
    expect(result).toEqual({
      items: [{ id: SCHEDULED_ID }],
      total: 1,
      page: 1,
      limit: 20,
    })
  })

  it('uses page=1 limit=20 defaults applied by the schema', () => {
    const parsed = listScheduledOrdersQuerySchema.safeParse({})
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual({ page: 1, limit: 20 })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 3. Service.getById — owner scope
// ═══════════════════════════════════════════════════════════════════════

describe('ScheduledOrdersService.getById', () => {
  let repo, service

  beforeEach(() => {
    repo = makeRepoStub()
    service = new ScheduledOrdersService(repo, { queue: makeQueue() })
  })

  it('returns SCHEDULED_ORDER_NOT_FOUND when row missing', async () => {
    repo.findByIdForUser.mockResolvedValue(null)
    const result = await service.getById(USER_ID, SCHEDULED_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('SCHEDULED_ORDER_NOT_FOUND')
  })

  it('owner scope — repository receives the caller userId, not another user', async () => {
    repo.findByIdForUser.mockResolvedValue(null)
    await service.getById(USER_ID, SCHEDULED_ID)
    expect(repo.findByIdForUser).toHaveBeenCalledWith(SCHEDULED_ID, USER_ID)
    expect(repo.findByIdForUser).not.toHaveBeenCalledWith(
      SCHEDULED_ID,
      OWNER_OTHER
    )
  })

  it('returns the row when found', async () => {
    const row = { id: SCHEDULED_ID, user_id: USER_ID, status: 'SCHEDULED' }
    repo.findByIdForUser.mockResolvedValue(row)
    const result = await service.getById(USER_ID, SCHEDULED_ID)
    expect(result.success).toBe(true)
    expect(result.data).toBe(row)
  })

  it('returns UNAUTHORIZED when userId missing', async () => {
    const result = await service.getById(null, SCHEDULED_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('UNAUTHORIZED')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 4. Service.cancel — BullMQ job removal (Req 10.6)
// ═══════════════════════════════════════════════════════════════════════

describe('ScheduledOrdersService.cancel — queue side effects', () => {
  let queue, repo, service, jobRemove

  beforeEach(() => {
    jobRemove = vi.fn().mockResolvedValue(undefined)
    queue = {
      add: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue({ remove: jobRemove }),
    }
    repo = makeRepoStub()
    service = new ScheduledOrdersService(repo, { queue })
  })

  it('looks up the BullMQ job by canonical jobId scheduled-order:{id}', async () => {
    repo.findByIdForUser.mockResolvedValue({
      id: SCHEDULED_ID,
      user_id: USER_ID,
      shop_id: SHOP_ID,
      status: 'SCHEDULED',
    })
    repo.updateStatus.mockResolvedValue({
      id: SCHEDULED_ID,
      status: 'CANCELLED',
    })
    await service.cancel(USER_ID, SCHEDULED_ID)
    expect(queue.getJob).toHaveBeenCalledWith(`scheduled-order:${SCHEDULED_ID}`)
    expect(queue.getJob).toHaveBeenCalledWith(jobIdFor(SCHEDULED_ID))
    expect(jobRemove).toHaveBeenCalledTimes(1)
  })

  it('does not call remove when the job is already gone', async () => {
    queue.getJob = vi.fn().mockResolvedValue(null)
    repo.findByIdForUser.mockResolvedValue({
      id: SCHEDULED_ID,
      user_id: USER_ID,
      shop_id: SHOP_ID,
      status: 'FAILED',
    })
    repo.updateStatus.mockResolvedValue({
      id: SCHEDULED_ID,
      status: 'CANCELLED',
    })
    const result = await service.cancel(USER_ID, SCHEDULED_ID)
    expect(result.success).toBe(true)
    expect(jobRemove).not.toHaveBeenCalled()
  })

  it('queue.getJob failure is non-fatal — DB cancel still succeeds', async () => {
    queue.getJob = vi.fn().mockRejectedValue(new Error('Redis down'))
    repo.findByIdForUser.mockResolvedValue({
      id: SCHEDULED_ID,
      user_id: USER_ID,
      shop_id: SHOP_ID,
      status: 'SCHEDULED',
    })
    repo.updateStatus.mockResolvedValue({
      id: SCHEDULED_ID,
      status: 'CANCELLED',
    })

    const result = await service.cancel(USER_ID, SCHEDULED_ID)

    expect(result.success).toBe(true)
    expect(repo.updateStatus).toHaveBeenCalledWith(SCHEDULED_ID, 'CANCELLED')
  })

  it('job.remove() failure is non-fatal — DB cancel still succeeds', async () => {
    queue.getJob = vi.fn().mockResolvedValue({
      remove: vi.fn().mockRejectedValue(new Error('boom')),
    })
    repo.findByIdForUser.mockResolvedValue({
      id: SCHEDULED_ID,
      user_id: USER_ID,
      shop_id: SHOP_ID,
      status: 'SCHEDULED',
    })
    repo.updateStatus.mockResolvedValue({
      id: SCHEDULED_ID,
      status: 'CANCELLED',
    })

    const result = await service.cancel(USER_ID, SCHEDULED_ID)

    expect(result.success).toBe(true)
  })

  it('skips queue interaction entirely when no queue is configured', async () => {
    const repoNoQueue = makeRepoStub()
    repoNoQueue.findByIdForUser.mockResolvedValue({
      id: SCHEDULED_ID,
      user_id: USER_ID,
      shop_id: SHOP_ID,
      status: 'SCHEDULED',
    })
    repoNoQueue.updateStatus.mockResolvedValue({
      id: SCHEDULED_ID,
      status: 'CANCELLED',
    })
    const svc = new ScheduledOrdersService(repoNoQueue, { queue: null })
    const result = await svc.cancel(USER_ID, SCHEDULED_ID)
    expect(result.success).toBe(true)
  })

  it('returns UNAUTHORIZED when userId missing', async () => {
    const result = await service.cancel(null, SCHEDULED_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('UNAUTHORIZED')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 5. Repository SQL safety
// ═══════════════════════════════════════════════════════════════════════

const lastCall = (fn) => fn.mock.calls[fn.mock.calls.length - 1]
const normalize = (sql) => sql.replace(/\s+/g, ' ').trim()

describe('ScheduledOrdersRepository — SQL safety', () => {
  let repo
  beforeEach(() => {
    repo = new ScheduledOrdersRepository()
  })

  it('SELECT_COLUMNS is an explicit projection (no SELECT *)', () => {
    const cols = ScheduledOrdersRepository.SELECT_COLUMNS
    expect(cols).not.toContain('*')
    for (const col of [
      'id',
      'user_id',
      'shop_id',
      'items',
      'subtotal',
      'delivery_address',
      'payment_method',
      'scheduled_for',
      'repeat_type',
      'repeat_until',
      'status',
      'placed_order_id',
      'failure_reason',
      'created_at',
      'updated_at',
    ]) {
      expect(cols).toContain(col)
    }
  })

  it('findByIdForUser uses parameterised $1, $2 placeholders + scopes user_id', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    await repo.findByIdForUser(SCHEDULED_ID, USER_ID)
    const [sql, params] = lastCall(query)
    const flat = normalize(sql)
    expect(flat).toMatch(/WHERE id = \$1 AND user_id = \$2/)
    expect(flat).not.toMatch(/SELECT \*/)
    expect(params).toEqual([SCHEDULED_ID, USER_ID])
  })

  it('findById uses parameterised $1', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    await repo.findById(SCHEDULED_ID)
    const [sql, params] = lastCall(query)
    expect(normalize(sql)).toMatch(/WHERE id = \$1/)
    expect(params).toEqual([SCHEDULED_ID])
  })

  it('findByIdForUpdate uses FOR UPDATE on a transaction client', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    await repo.findByIdForUpdate(client, SCHEDULED_ID)
    const [sql, params] = client.query.mock.calls[0]
    const flat = normalize(sql)
    expect(flat).toMatch(/FOR UPDATE/)
    expect(flat).toMatch(/WHERE id = \$1/)
    expect(params).toEqual([SCHEDULED_ID])
  })

  it('countActiveForUser filters status = SCHEDULED with parameterised user_id', async () => {
    query.mockResolvedValueOnce({ rows: [{ total: 7 }] })
    const result = await repo.countActiveForUser(USER_ID)
    const [sql, params] = lastCall(query)
    const flat = normalize(sql)
    expect(flat).toMatch(/COUNT\(\*\)::int/)
    expect(flat).toMatch(/user_id = \$1/)
    expect(flat).toMatch(/status = 'SCHEDULED'/)
    expect(params).toEqual([USER_ID])
    expect(result).toBe(7)
  })

  it('linkPlacedOrder uses parameterised $1, $2 with no string concat', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: SCHEDULED_ID }] }),
    }
    await repo.linkPlacedOrder(client, SCHEDULED_ID, PLACED_ORDER_ID)
    const [sql, params] = client.query.mock.calls[0]
    const flat = normalize(sql)
    expect(flat).toMatch(/UPDATE scheduled_orders/)
    expect(flat).toMatch(/SET placed_order_id = \$1/)
    expect(flat).toMatch(/WHERE id = \$2/)
    expect(params).toEqual([PLACED_ORDER_ID, SCHEDULED_ID])
  })

  it('updateStatusIfCurrent UPDATE is guarded by status = $5', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: SCHEDULED_ID }] }),
    }
    await repo.updateStatusIfCurrent(
      client,
      SCHEDULED_ID,
      'SCHEDULED',
      'PROCESSING'
    )
    const [sql, params] = client.query.mock.calls[0]
    const flat = normalize(sql)
    expect(flat).toMatch(/WHERE id = \$4 AND status = \$5/)
    // Param order: newStatus, placed_order_id, failure_reason, id, expectedStatus
    expect(params).toEqual([
      'PROCESSING',
      null,
      null,
      SCHEDULED_ID,
      'SCHEDULED',
    ])
  })

  it('createSuccessor casts items + delivery_address with ::jsonb and binds $1..$9', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: SCHEDULED_ID }] }),
    }
    const parent = {
      user_id: USER_ID,
      shop_id: SHOP_ID,
      items: [{ product_id: PRODUCT_ID, quantity: 1 }],
      subtotal: 50,
      delivery_address: validAddress,
      payment_method: 'COD',
      repeat_type: 'WEEKLY',
      repeat_until: null,
    }
    const next = futureDate(7 * 24)
    await repo.createSuccessor(client, parent, next)
    const [sql, params] = client.query.mock.calls[0]
    const flat = normalize(sql)
    expect(flat).toMatch(/\$3::jsonb/)
    expect(flat).toMatch(/\$5::jsonb/)
    for (let i = 1; i <= 9; i++) {
      expect(flat).toContain(`$${i}`)
    }
    expect(params).toHaveLength(9)
    expect(typeof params[2]).toBe('string')
    expect(JSON.parse(params[2])).toEqual(parent.items)
    expect(typeof params[4]).toBe('string')
    expect(JSON.parse(params[4])).toEqual(parent.delivery_address)
    expect(params[6]).toBe(next)
  })

  it('create() INSERT uses ::jsonb casts for items + delivery_address', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: SCHEDULED_ID }] })
    await repo.create({
      user_id: USER_ID,
      shop_id: SHOP_ID,
      items: [{ product_id: PRODUCT_ID, quantity: 2 }],
      subtotal: 100,
      delivery_address: validAddress,
      payment_method: 'COD',
      scheduled_for: futureDate(3),
      repeat_type: 'ONCE',
      repeat_until: null,
    })
    const [sql, params] = lastCall(query)
    const flat = normalize(sql)
    expect(flat).toMatch(/\$3::jsonb/)
    expect(flat).toMatch(/\$5::jsonb/)
    expect(flat).toMatch(/INSERT INTO scheduled_orders/)
    expect(flat).toMatch(/'SCHEDULED'\s*\)/) // status defaults to SCHEDULED in SQL
    expect(typeof params[2]).toBe('string')
    expect(typeof params[4]).toBe('string')
  })

  it('isUserAllocatedToShop joins shops with active+not-deleted filter', async () => {
    query.mockResolvedValueOnce({ rows: [{}] })
    const ok = await repo.isUserAllocatedToShop(USER_ID, SHOP_ID)
    const [sql, params] = lastCall(query)
    const flat = normalize(sql)
    expect(flat).toMatch(/FROM user_shop_allocations a/)
    expect(flat).toMatch(/JOIN shops s ON s\.id = a\.shop_id/)
    expect(flat).toMatch(/s\.is_active = true/)
    expect(flat).toMatch(/s\.deleted_at IS NULL/)
    expect(flat).toMatch(/a\.user_id = \$1/)
    expect(flat).toMatch(/a\.shop_id = \$2/)
    expect(params).toEqual([USER_ID, SHOP_ID])
    expect(ok).toBe(true)
  })

  it('findManyByUser uses parameterised LIMIT/OFFSET and respects status filter', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: SCHEDULED_ID }] })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
    await repo.findManyByUser({
      userId: USER_ID,
      status: 'SCHEDULED',
      page: 2,
      limit: 25,
    })
    expect(query).toHaveBeenCalledTimes(2)
    const [dataSql, dataParams] = query.mock.calls[0]
    const [countSql, countParams] = query.mock.calls[1]
    const dataFlat = normalize(dataSql)
    expect(dataFlat).toMatch(/WHERE user_id = \$1 AND status = \$2/)
    expect(dataFlat).toMatch(/LIMIT \$3 OFFSET \$4/)
    expect(dataParams).toEqual([USER_ID, 'SCHEDULED', 25, 25])
    expect(normalize(countSql)).toMatch(/COUNT\(\*\)::int/)
    expect(countParams).toEqual([USER_ID, 'SCHEDULED'])
  })

  it('findManyByUser without status filter omits status placeholder', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
    await repo.findManyByUser({ userId: USER_ID, page: 1, limit: 20 })
    const [dataSql, dataParams] = query.mock.calls[0]
    const flat = normalize(dataSql)
    expect(flat).toMatch(/WHERE user_id = \$1/)
    expect(flat).not.toMatch(/status = \$/)
    expect(flat).toMatch(/LIMIT \$2 OFFSET \$3/)
    expect(dataParams).toEqual([USER_ID, 20, 0])
  })

  it('updateStatus binds the status / id / extras as $1..$4', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: SCHEDULED_ID }] })
    await repo.updateStatus(SCHEDULED_ID, 'CANCELLED')
    const [sql, params] = lastCall(query)
    const flat = normalize(sql)
    expect(flat).toMatch(/SET status = \$1/)
    expect(flat).toMatch(/WHERE id = \$4/)
    expect(params).toEqual(['CANCELLED', null, null, SCHEDULED_ID])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 6. Schema validation — extra coverage
// ═══════════════════════════════════════════════════════════════════════

describe('createScheduledOrderSchema — repeat_type enum + scheduled_for required', () => {
  const baseBody = () => ({
    shop_id: SHOP_ID,
    items: [{ product_id: PRODUCT_ID, quantity: 1 }],
    subtotal: 100,
    delivery_address: validAddress,
    payment_method: 'COD',
    scheduled_for: futureDate(3).toISOString(),
    repeat_type: 'ONCE',
  })

  it('rejects unknown repeat_type values', () => {
    const body = baseBody()
    body.repeat_type = 'YEARLY'
    expect(createScheduledOrderSchema.safeParse(body).success).toBe(false)
  })

  it('accepts each REPEAT_TYPES value', () => {
    for (const rt of ['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY']) {
      const body = baseBody()
      body.repeat_type = rt
      // ONCE is fine without repeat_until; others get a far-future bound.
      if (rt !== 'ONCE') body.repeat_until = futureDate(60 * 24).toISOString()
      const result = createScheduledOrderSchema.safeParse(body)
      expect(result.success).toBe(true)
    }
  })

  it('requires scheduled_for', () => {
    const body = baseBody()
    delete body.scheduled_for
    expect(createScheduledOrderSchema.safeParse(body).success).toBe(false)
  })

  it('rejects subtotal < 0', () => {
    const body = baseBody()
    body.subtotal = -1
    expect(createScheduledOrderSchema.safeParse(body).success).toBe(false)
  })

  it('rejects more than 50 items (cap matches max_order_qty rule)', () => {
    const body = baseBody()
    body.items = Array.from({ length: 51 }, () => ({
      product_id: PRODUCT_ID,
      quantity: 1,
    }))
    expect(createScheduledOrderSchema.safeParse(body).success).toBe(false)
  })

  it('rejects delivery_address without coordinates', () => {
    const body = baseBody()
    body.delivery_address = { line1: '1 Main St', city: 'BLR' }
    expect(createScheduledOrderSchema.safeParse(body).success).toBe(false)
  })

  it('coerces scheduled_for ISO string into a Date', () => {
    const iso = futureDate(3).toISOString()
    const result = createScheduledOrderSchema.safeParse({
      ...baseBody(),
      scheduled_for: iso,
    })
    expect(result.success).toBe(true)
    expect(result.data.scheduled_for).toBeInstanceOf(Date)
  })
})
