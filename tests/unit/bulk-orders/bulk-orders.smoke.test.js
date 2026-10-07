import { describe, it, expect, vi, beforeEach } from 'vitest'

// ═══════════════════════════════════════════════════════════
// Bulk Orders module smoke tests
// Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 14.8, 15.9
// ═══════════════════════════════════════════════════════════
//
// Coverage:
//   - Schema gates: total_items >= 5, >= 3 distinct products,
//                   delivery_date window enforced by service
//   - Module wiring: Repository/Service/Controller export shape
//   - State machine: valid + invalid transitions
//   - Service.create happy path with allocation guard
//   - Service.submit retains DRAFT and surfaces failed items on insufficient stock
//   - Service confirm-flow: SELECT FOR UPDATE deduction inside a transaction
//   - Service cancel-after-confirm: stock restore inside a transaction

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
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { getClient } from '../../../src/config/database.js'
import {
  BulkOrdersService,
  STATE_MACHINE,
} from '../../../src/modules/bulk-orders/bulk-orders.service.js'
import { BulkOrdersRepository } from '../../../src/modules/bulk-orders/bulk-orders.repository.js'
import { BulkOrdersController } from '../../../src/modules/bulk-orders/bulk-orders.controller.js'
import {
  createBulkOrderSchema,
  updateStatusSchema,
  listBulkOrdersQuerySchema,
  bulkOrderIdParamSchema,
  BULK_ORDER_STATUSES,
} from '../../../src/modules/bulk-orders/bulk-orders.schema.js'

// ─── Test fixtures ─────────────────────────────────────────
const SHOP_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const ORDER_ID = '33333333-3333-4333-8333-333333333333'
const PRODUCT_A = '44444444-4444-4444-8444-444444444444'
const PRODUCT_B = '55555555-5555-4555-8555-555555555555'
const PRODUCT_C = '66666666-6666-4666-8666-666666666666'

const inThe = {
  hours: (n) => new Date(Date.now() + n * 3600 * 1000).toISOString(),
  days: (n) => new Date(Date.now() + n * 86400 * 1000).toISOString(),
}

const validPayload = () => ({
  shop_id: SHOP_ID,
  items: [
    { product_id: PRODUCT_A, quantity: 2, price: 50, name: 'A' },
    { product_id: PRODUCT_B, quantity: 2, price: 25, name: 'B' },
    { product_id: PRODUCT_C, quantity: 1, price: 30, name: 'C' },
  ],
  total_items: 5,
  subtotal: 180,
  total_amount: 180,
  delivery_date: inThe.days(7),
  delivery_slot: '10:00-12:00',
  delivery_address: {
    line1: '123 Main',
    city: 'BLR',
    state: 'KA',
    pincode: '560001',
  },
  payment_method: 'COD',
})

// Build a Service hooked up to a mocked repository.
const makeService = () => {
  const repo = {
    findById: vi.fn(),
    countByOrderNumberPattern: vi.fn().mockResolvedValue(0),
    existsOrderNumber: vi.fn().mockResolvedValue(false),
    isUserAllocatedToShop: vi.fn().mockResolvedValue(true),
    create: vi.fn(),
    updateStatus: vi.fn(),
    findByIdForUpdate: vi.fn(),
    findShopProductsForValidation: vi.fn(),
    lockShopProduct: vi.fn(),
    applyShopProductStock: vi.fn(),
    findStaffRole: vi.fn(),
    findMany: vi.fn(),
  }
  return { service: new BulkOrdersService(repo), repo }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════
// 1. Module wiring + repository hygiene
// ═══════════════════════════════════════════════════════════

describe('bulk-orders module bootstrap', () => {
  it('exports the Repository / Service / Controller classes', () => {
    const repo = new BulkOrdersRepository()
    const service = new BulkOrdersService(repo)
    const controller = new BulkOrdersController(service)

    expect(typeof service.create).toBe('function')
    expect(typeof service.submit).toBe('function')
    expect(typeof service.cancel).toBe('function')
    expect(typeof service.updateStatus).toBe('function')
    expect(typeof service.transitionStatus).toBe('function')
    expect(typeof service.list).toBe('function')
    expect(typeof service.getById).toBe('function')

    expect(typeof controller.create).toBe('function')
    expect(typeof controller.list).toBe('function')
    expect(typeof controller.getOne).toBe('function')
    expect(typeof controller.submit).toBe('function')
    expect(typeof controller.cancel).toBe('function')
    expect(typeof controller.updateStatus).toBe('function')
    expect(typeof controller.softDelete).toBe('function')
  })

  it('repository column projection is explicit (no SELECT *)', () => {
    expect(BulkOrdersRepository.SELECT_COLUMNS).toMatch(/id, shop_id/)
    expect(BulkOrdersRepository.SELECT_COLUMNS).not.toContain('*')
  })
})

// ═══════════════════════════════════════════════════════════
// 2. Schema validation (Req 9.2, 9.6, 9.9)
// ═══════════════════════════════════════════════════════════

describe('bulk-orders schema validation', () => {
  it('exposes the canonical lifecycle statuses (Req 9.1)', () => {
    expect(BULK_ORDER_STATUSES).toEqual([
      'DRAFT',
      'SUBMITTED',
      'CONFIRMED',
      'PROCESSING',
      'READY',
      'DELIVERED',
      'CANCELLED',
    ])
  })

  it('accepts a valid create payload (5 items, 3 distinct products)', () => {
    const result = createBulkOrderSchema.safeParse(validPayload())
    expect(result.success).toBe(true)
  })

  it('rejects payloads with total_items < 5 (Req 9.2)', () => {
    const payload = validPayload()
    payload.total_items = 4
    const result = createBulkOrderSchema.safeParse(payload)
    expect(result.success).toBe(false)
  })

  it('rejects payloads with fewer than 3 distinct product_ids (Req 9.2)', () => {
    const payload = validPayload()
    payload.items = [
      { product_id: PRODUCT_A, quantity: 3, price: 50 },
      { product_id: PRODUCT_B, quantity: 2, price: 25 },
    ]
    payload.total_items = 5
    const result = createBulkOrderSchema.safeParse(payload)
    expect(result.success).toBe(false)
  })

  it('rejects total_amount outside [0.01, 999999.99] (Req 9.2)', () => {
    const tooLow = validPayload()
    tooLow.total_amount = 0
    expect(createBulkOrderSchema.safeParse(tooLow).success).toBe(false)

    const tooHigh = validPayload()
    tooHigh.total_amount = 1_000_000
    expect(createBulkOrderSchema.safeParse(tooHigh).success).toBe(false)
  })

  it('list query caps limit at 100 and defaults to {page:1, limit:20} (Req 9.9)', () => {
    expect(listBulkOrdersQuerySchema.safeParse({}).data).toEqual({
      page: 1,
      limit: 20,
    })
    expect(
      listBulkOrdersQuerySchema.safeParse({ page: '1', limit: '101' }).success
    ).toBe(false)
  })

  it('list query coerces page/limit and accepts shop_id + status filters', () => {
    const r = listBulkOrdersQuerySchema.safeParse({
      page: '2',
      limit: '50',
      status: 'CONFIRMED',
      shop_id: SHOP_ID,
    })
    expect(r.success).toBe(true)
    expect(r.data).toEqual({
      page: 2,
      limit: 50,
      status: 'CONFIRMED',
      shop_id: SHOP_ID,
    })
  })

  it('updateStatus body schema enforces enum', () => {
    expect(updateStatusSchema.safeParse({ status: 'BOGUS' }).success).toBe(
      false
    )
    expect(updateStatusSchema.safeParse({ status: 'CONFIRMED' }).success).toBe(
      true
    )
  })

  it('id param schema enforces UUID format', () => {
    expect(bulkOrderIdParamSchema.safeParse({ id: 'not-uuid' }).success).toBe(
      false
    )
    expect(
      bulkOrderIdParamSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
      }).success
    ).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════
// 3. Delivery date window (Req 9.6)
// ═══════════════════════════════════════════════════════════

describe('BulkOrdersService.validateDeliveryDate (Req 9.6)', () => {
  const now = new Date('2024-06-01T00:00:00.000Z')
  const at = (hoursOffset) =>
    new Date(now.getTime() + hoursOffset * 3600 * 1000).toISOString()

  it('rejects delivery_date < 24h from now', () => {
    const r = BulkOrdersService.validateDeliveryDate(at(23), now)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('BULK_DATE_INVALID')
  })

  it('accepts delivery_date exactly 24h from now', () => {
    const r = BulkOrdersService.validateDeliveryDate(at(24), now)
    expect(r.ok).toBe(true)
  })

  it('accepts delivery_date exactly 30 days from now', () => {
    const r = BulkOrdersService.validateDeliveryDate(at(30 * 24), now)
    expect(r.ok).toBe(true)
  })

  it('rejects delivery_date > 30 days from now', () => {
    const r = BulkOrdersService.validateDeliveryDate(at(31 * 24), now)
    expect(r.ok).toBe(false)
  })

  it('rejects malformed input', () => {
    const r = BulkOrdersService.validateDeliveryDate('not-a-date', now)
    expect(r.ok).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════
// 4. State machine (Req 9.1)
// ═══════════════════════════════════════════════════════════

describe('BulkOrdersService.isValidTransition (Req 9.1)', () => {
  it('encodes the full lifecycle map', () => {
    expect([...STATE_MACHINE.DRAFT]).toEqual(['SUBMITTED', 'CANCELLED'])
    expect([...STATE_MACHINE.SUBMITTED]).toEqual(['CONFIRMED', 'CANCELLED'])
    expect([...STATE_MACHINE.CONFIRMED]).toEqual(['PROCESSING', 'CANCELLED'])
    expect([...STATE_MACHINE.PROCESSING]).toEqual(['READY'])
    expect([...STATE_MACHINE.READY]).toEqual(['DELIVERED'])
    expect([...STATE_MACHINE.DELIVERED]).toEqual([])
    expect([...STATE_MACHINE.CANCELLED]).toEqual([])
  })

  it('accepts only the documented transitions', () => {
    const valid = [
      ['DRAFT', 'SUBMITTED'],
      ['DRAFT', 'CANCELLED'],
      ['SUBMITTED', 'CONFIRMED'],
      ['SUBMITTED', 'CANCELLED'],
      ['CONFIRMED', 'PROCESSING'],
      ['CONFIRMED', 'CANCELLED'],
      ['PROCESSING', 'READY'],
      ['READY', 'DELIVERED'],
    ]
    for (const [from, to] of valid) {
      expect(BulkOrdersService.isValidTransition(from, to)).toBe(true)
    }
  })

  it('rejects same-state transitions and arbitrary jumps', () => {
    expect(BulkOrdersService.isValidTransition('DRAFT', 'DRAFT')).toBe(false)
    expect(BulkOrdersService.isValidTransition('DRAFT', 'CONFIRMED')).toBe(
      false
    )
    expect(BulkOrdersService.isValidTransition('DELIVERED', 'PROCESSING')).toBe(
      false
    )
    expect(BulkOrdersService.isValidTransition('CANCELLED', 'DRAFT')).toBe(
      false
    )
  })
})

// ═══════════════════════════════════════════════════════════
// 5. Service.create happy path + order_number prefix (Req 9.8)
// ═══════════════════════════════════════════════════════════

describe('BulkOrdersService.create (Req 9.6, 9.8, 5.2)', () => {
  it('inserts in DRAFT with a BULK-YYYYMMDD-XXX order_number', async () => {
    const { service, repo } = makeService()
    const inserted = {
      id: ORDER_ID,
      status: 'DRAFT',
      order_number: 'BULK-20240601-001',
      shop_id: SHOP_ID,
      user_id: USER_ID,
    }
    repo.create.mockResolvedValue(inserted)

    const result = await service.create(USER_ID, {
      ...validPayload(),
      delivery_date: inThe.days(7),
    })

    expect(result.success).toBe(true)
    expect(repo.create).toHaveBeenCalledTimes(1)
    const insertArg = repo.create.mock.calls[0][0]
    expect(insertArg.user_id).toBe(USER_ID)
    expect(insertArg.status).toBe('DRAFT')
    expect(insertArg.order_number).toMatch(/^BULK-\d{8}-\d{3}$/)
  })

  it('rejects with NO_ALLOCATION when the user is not allocated to the shop', async () => {
    const { service, repo } = makeService()
    repo.isUserAllocatedToShop.mockResolvedValue(false)

    const result = await service.create(USER_ID, {
      ...validPayload(),
      delivery_date: inThe.days(7),
    })
    expect(result.success).toBe(false)
    expect(result.code).toBe('NO_ALLOCATION')
    expect(repo.create).not.toHaveBeenCalled()
  })

  it('rejects with BULK_DATE_INVALID when delivery_date is too soon', async () => {
    const { service, repo } = makeService()
    const result = await service.create(USER_ID, {
      ...validPayload(),
      delivery_date: inThe.hours(2),
    })
    expect(result.success).toBe(false)
    expect(result.code).toBe('BULK_DATE_INVALID')
    expect(repo.create).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════
// 6. Service.submit — insufficient stock retains DRAFT (Req 9.3, 9.4)
// ═══════════════════════════════════════════════════════════

describe('BulkOrdersService.submit (Req 9.3, 9.4)', () => {
  const draftRow = () => ({
    id: ORDER_ID,
    user_id: USER_ID,
    shop_id: SHOP_ID,
    status: 'DRAFT',
    items: [
      { product_id: PRODUCT_A, quantity: 5 },
      { product_id: PRODUCT_B, quantity: 2 },
      { product_id: PRODUCT_C, quantity: 1 },
    ],
  })

  it('rejects with INSUFFICIENT_STOCK and retains DRAFT when any item is short', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(draftRow())
    repo.findShopProductsForValidation.mockResolvedValue([
      { product_id: PRODUCT_A, stock_quantity: 1, is_available: true, max_order_qty: 100 },
      { product_id: PRODUCT_B, stock_quantity: 100, is_available: true, max_order_qty: 100 },
      { product_id: PRODUCT_C, stock_quantity: 100, is_available: true, max_order_qty: 100 },
    ])

    const result = await service.submit(USER_ID, ORDER_ID)

    expect(result.success).toBe(false)
    expect(result.code).toBe('INSUFFICIENT_STOCK')
    expect(Array.isArray(result.failed)).toBe(true)
    expect(result.failed.find((f) => f.product_id === PRODUCT_A)).toEqual({
      product_id: PRODUCT_A,
      requested: 5,
      available: 1,
      reason: 'INSUFFICIENT_STOCK',
    })
    expect(repo.updateStatus).not.toHaveBeenCalled()
  })

  it('transitions DRAFT -> SUBMITTED when all items have stock', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(draftRow())
    repo.findShopProductsForValidation.mockResolvedValue([
      { product_id: PRODUCT_A, stock_quantity: 100, is_available: true, max_order_qty: 100 },
      { product_id: PRODUCT_B, stock_quantity: 100, is_available: true, max_order_qty: 100 },
      { product_id: PRODUCT_C, stock_quantity: 100, is_available: true, max_order_qty: 100 },
    ])
    repo.updateStatus.mockResolvedValue({ ...draftRow(), status: 'SUBMITTED' })

    const result = await service.submit(USER_ID, ORDER_ID)

    expect(result.success).toBe(true)
    expect(repo.updateStatus).toHaveBeenCalledWith(ORDER_ID, 'SUBMITTED')
  })

  it('flags missing shop_products as NOT_LISTED', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(draftRow())
    repo.findShopProductsForValidation.mockResolvedValue([
      { product_id: PRODUCT_B, stock_quantity: 100, is_available: true, max_order_qty: 100 },
      { product_id: PRODUCT_C, stock_quantity: 100, is_available: true, max_order_qty: 100 },
    ])

    const result = await service.submit(USER_ID, ORDER_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('INSUFFICIENT_STOCK')
    expect(result.failed.some((f) => f.reason === 'NOT_LISTED')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════
// 7. Confirm: SELECT FOR UPDATE deduction inside a transaction
//    (Req 9.5, 14.8, 15.9)
// ═══════════════════════════════════════════════════════════

describe('BulkOrdersService confirm flow (Req 9.5, 14.8, 15.9)', () => {
  const submittedRow = () => ({
    id: ORDER_ID,
    user_id: USER_ID,
    shop_id: SHOP_ID,
    status: 'SUBMITTED',
    items: [
      { product_id: PRODUCT_A, quantity: 3 },
      { product_id: PRODUCT_B, quantity: 2 },
    ],
  })

  it('locks rows, deducts stock, transitions to CONFIRMED, and COMMITs', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(submittedRow())

    // Single tx client used by getClient()
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }
    getClient.mockResolvedValue(client)

    repo.findByIdForUpdate.mockResolvedValue(submittedRow())
    repo.lockShopProduct
      .mockResolvedValueOnce({ id: 'sp-a', stock_quantity: 10, is_available: true })
      .mockResolvedValueOnce({ id: 'sp-b', stock_quantity: 5, is_available: true })
    repo.applyShopProductStock.mockImplementation(async (_c, id, qty) => ({
      id,
      stock_quantity: qty,
      is_available: qty > 0,
    }))
    repo.updateStatus.mockResolvedValue({ ...submittedRow(), status: 'CONFIRMED' })

    const result = await service.updateStatus(
      { id: 'manager', role: 'CUSTOMER', shopId: SHOP_ID, shopRole: 'SHOP_MANAGER' },
      ORDER_ID,
      'CONFIRMED'
    )

    expect(result.success).toBe(true)
    expect(client.query).toHaveBeenCalledWith('BEGIN')
    expect(client.query).toHaveBeenCalledWith('COMMIT')

    // FOR UPDATE on the bulk_orders row
    expect(repo.findByIdForUpdate).toHaveBeenCalledWith(client, ORDER_ID)
    // FOR UPDATE on each distinct shop_product
    expect(repo.lockShopProduct).toHaveBeenCalledWith(client, SHOP_ID, PRODUCT_A)
    expect(repo.lockShopProduct).toHaveBeenCalledWith(client, SHOP_ID, PRODUCT_B)

    // Stock deducted by the requested quantity
    expect(repo.applyShopProductStock).toHaveBeenCalledWith(client, 'sp-a', 7)
    expect(repo.applyShopProductStock).toHaveBeenCalledWith(client, 'sp-b', 3)

    // Status flip uses the same transaction client
    expect(repo.updateStatus).toHaveBeenCalledWith(ORDER_ID, 'CONFIRMED', client)
    expect(client.release).toHaveBeenCalled()
  })

  it('ROLLBACKs and surfaces failed items when stock is insufficient at lock time', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(submittedRow())
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }
    getClient.mockResolvedValue(client)
    repo.findByIdForUpdate.mockResolvedValue(submittedRow())
    repo.lockShopProduct
      .mockResolvedValueOnce({ id: 'sp-a', stock_quantity: 1, is_available: true })
      .mockResolvedValueOnce({ id: 'sp-b', stock_quantity: 5, is_available: true })

    const result = await service.updateStatus(
      { id: 'manager', role: 'CUSTOMER', shopId: SHOP_ID, shopRole: 'SHOP_MANAGER' },
      ORDER_ID,
      'CONFIRMED'
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('INSUFFICIENT_STOCK')
    expect(Array.isArray(result.failed)).toBe(true)
    expect(result.failed.find((f) => f.product_id === PRODUCT_A)).toMatchObject({
      requested: 3,
      available: 1,
      reason: 'INSUFFICIENT_STOCK',
    })
    // Critical: the transaction is rolled back, the status stays SUBMITTED,
    // and the ROLLBACK undoes any speculative deduction the loop performed
    // on subsequent items before the failure was decided.
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.query).not.toHaveBeenCalledWith('COMMIT')
    expect(repo.updateStatus).not.toHaveBeenCalled()
  })

  it('rejects shop staff that lack SHOP_ADMIN/SHOP_MANAGER', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(submittedRow())
    repo.findStaffRole.mockResolvedValue(null)

    const result = await service.updateStatus(
      { id: 'staffer', role: 'CUSTOMER', shopId: SHOP_ID, shopRole: 'SHOP_STAFF' },
      ORDER_ID,
      'CONFIRMED'
    )
    expect(result.success).toBe(false)
    expect(result.code).toBe('FORBIDDEN')
  })
})

// ═══════════════════════════════════════════════════════════
// 8. Cancel-after-confirm restores stock (Req 9.7, 15.9)
// ═══════════════════════════════════════════════════════════

describe('BulkOrdersService cancel-after-confirm restores stock (Req 9.7, 15.9)', () => {
  const confirmedRow = () => ({
    id: ORDER_ID,
    user_id: USER_ID,
    shop_id: SHOP_ID,
    status: 'CONFIRMED',
    items: [
      { product_id: PRODUCT_A, quantity: 4 },
      { product_id: PRODUCT_B, quantity: 1 },
    ],
  })

  it('restores stock and transitions to CANCELLED inside one transaction', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(confirmedRow())
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }
    getClient.mockResolvedValue(client)
    repo.findByIdForUpdate.mockResolvedValue(confirmedRow())
    repo.lockShopProduct
      .mockResolvedValueOnce({ id: 'sp-a', stock_quantity: 6, is_available: true })
      .mockResolvedValueOnce({ id: 'sp-b', stock_quantity: 9, is_available: true })
    repo.updateStatus.mockResolvedValue({ ...confirmedRow(), status: 'CANCELLED' })

    const result = await service.updateStatus(
      { id: 'admin', role: 'ADMIN' },
      ORDER_ID,
      'CANCELLED'
    )

    expect(result.success).toBe(true)
    expect(client.query).toHaveBeenCalledWith('BEGIN')
    expect(client.query).toHaveBeenCalledWith('COMMIT')
    // Stock RESTORED (added back), not deducted
    expect(repo.applyShopProductStock).toHaveBeenCalledWith(client, 'sp-a', 10)
    expect(repo.applyShopProductStock).toHaveBeenCalledWith(client, 'sp-b', 10)
    expect(repo.updateStatus).toHaveBeenCalledWith(ORDER_ID, 'CANCELLED', client)
  })
})

// ═══════════════════════════════════════════════════════════
// 9. Invalid transitions are rejected (Req 9.1)
// ═══════════════════════════════════════════════════════════

describe('BulkOrdersService rejects invalid transitions (Req 9.1)', () => {
  it('rejects DRAFT -> CONFIRMED via updateStatus', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue({
      id: ORDER_ID,
      user_id: USER_ID,
      shop_id: SHOP_ID,
      status: 'DRAFT',
      items: [],
    })
    const result = await service.updateStatus(
      { id: 'admin', role: 'ADMIN' },
      ORDER_ID,
      'CONFIRMED'
    )
    expect(result.success).toBe(false)
    expect(result.code).toBe('INVALID_STATE_TRANSITION')
  })

  it('rejects DELIVERED -> any via updateStatus', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue({
      id: ORDER_ID,
      user_id: USER_ID,
      shop_id: SHOP_ID,
      status: 'DELIVERED',
      items: [],
    })
    const result = await service.updateStatus(
      { id: 'admin', role: 'ADMIN' },
      ORDER_ID,
      'CANCELLED'
    )
    expect(result.success).toBe(false)
    expect(result.code).toBe('INVALID_STATE_TRANSITION')
  })

  it('customer transitionStatus only accepts SUBMITTED or CANCELLED targets', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue({
      id: ORDER_ID,
      user_id: USER_ID,
      shop_id: SHOP_ID,
      status: 'SUBMITTED',
      items: [],
    })
    const result = await service.transitionStatus(
      { id: USER_ID, role: 'CUSTOMER' },
      ORDER_ID,
      'CONFIRMED'
    )
    expect(result.success).toBe(false)
    expect(result.code).toBe('FORBIDDEN')
  })
})
