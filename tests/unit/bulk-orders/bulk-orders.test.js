import { describe, it, expect, vi, beforeEach } from 'vitest'

// ═══════════════════════════════════════════════════════════════════════
// Bulk Orders module — extended unit tests
// Validates: Requirements 9.1, 9.2, 9.4, 9.6, 9.7
//
// Complements bulk-orders.smoke.test.js with deeper coverage of:
//   1. Schema edge cases (item shape, ranges, list query, params)
//   2. Service.create — order_number format, JWT user wiring, allocation
//   3. Service.submit — owner check, DRAFT-only, UNAVAILABLE flag,
//      duplicate product_id aggregation
//   4. Service.updateStatus — non-stock transitions, SUBMITTED->CANCELLED,
//      cross-shop rejection, INVALID_STATE_TRANSITION mid-tx, error rollback
//   5. Service.cancel — owner enforcement, allowed source statuses,
//      CONFIRMED routes to shop manager flow
//   6. Service.list — customer / shop staff / Super Admin scoping
//   7. Repository SQL safety — parameterized $1..$N, FOR UPDATE, no SELECT *,
//      applyShopProductStock is_available/sold_out_at semantics
// ═══════════════════════════════════════════════════════════════════════

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

import { getClient, query } from '../../../src/config/database.js'
import { BulkOrdersService } from '../../../src/modules/bulk-orders/bulk-orders.service.js'
import { BulkOrdersRepository } from '../../../src/modules/bulk-orders/bulk-orders.repository.js'
import {
  createBulkOrderSchema,
  updateStatusSchema,
  listBulkOrdersQuerySchema,
  bulkOrderIdParamSchema,
} from '../../../src/modules/bulk-orders/bulk-orders.schema.js'

// ─── Test fixtures ─────────────────────────────────────────────────────
const SHOP_ID = '11111111-1111-4111-8111-111111111111'
const SHOP_ID_OTHER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID_OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ORDER_ID = '33333333-3333-4333-8333-333333333333'
const PRODUCT_A = '44444444-4444-4444-8444-444444444444'
const PRODUCT_B = '55555555-5555-4555-8555-555555555555'
const PRODUCT_C = '66666666-6666-4666-8666-666666666666'

const inThe = {
  hours: (n) => new Date(Date.now() + n * 3600 * 1000).toISOString(),
  days: (n) => new Date(Date.now() + n * 86400 * 1000).toISOString(),
}

const validPayload = (overrides = {}) => ({
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
  ...overrides,
})

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
    findMany: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  }
  return { service: new BulkOrdersService(repo), repo }
}

const makeTxClient = () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  release: vi.fn(),
})

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════
// 1. Schema validation — extended (Req 9.2, 9.6, 9.9)
// ═══════════════════════════════════════════════════════════════════════

describe('createBulkOrderSchema — item shape (Req 9.2)', () => {
  it('rejects items with quantity < 1', () => {
    const p = validPayload()
    p.items = [
      { product_id: PRODUCT_A, quantity: 0, price: 50 },
      { product_id: PRODUCT_B, quantity: 2, price: 25 },
      { product_id: PRODUCT_C, quantity: 3, price: 30 },
    ]
    expect(createBulkOrderSchema.safeParse(p).success).toBe(false)
  })

  it('rejects items with negative price', () => {
    const p = validPayload()
    p.items = [
      { product_id: PRODUCT_A, quantity: 2, price: -1 },
      { product_id: PRODUCT_B, quantity: 2, price: 25 },
      { product_id: PRODUCT_C, quantity: 1, price: 30 },
    ]
    expect(createBulkOrderSchema.safeParse(p).success).toBe(false)
  })

  it('accepts price = 0 (free item) when other constraints hold', () => {
    const p = validPayload()
    p.items = [
      { product_id: PRODUCT_A, quantity: 2, price: 0 },
      { product_id: PRODUCT_B, quantity: 2, price: 25 },
      { product_id: PRODUCT_C, quantity: 1, price: 30 },
    ]
    expect(createBulkOrderSchema.safeParse(p).success).toBe(true)
  })

  it('rejects items with non-uuid product_id', () => {
    const p = validPayload()
    p.items[0].product_id = 'not-a-uuid'
    expect(createBulkOrderSchema.safeParse(p).success).toBe(false)
  })

  it('rejects total_amount > 999999.99', () => {
    const p = validPayload({ total_amount: 1000000 })
    expect(createBulkOrderSchema.safeParse(p).success).toBe(false)
  })

  it('accepts total_amount at the lower bound 0.01', () => {
    const p = validPayload({ total_amount: 0.01, subtotal: 0.01 })
    expect(createBulkOrderSchema.safeParse(p).success).toBe(true)
  })

  it('rejects total_items > sum of item quantities (sanity check)', () => {
    const p = validPayload({ total_items: 99 })
    expect(createBulkOrderSchema.safeParse(p).success).toBe(false)
  })

  it('accepts total_items equal to sum of item quantities', () => {
    // Sum of item quantities = 5; total_items = 5 should be valid.
    const p = validPayload({ total_items: 5 })
    expect(createBulkOrderSchema.safeParse(p).success).toBe(true)
  })

  it('rejects malformed delivery_date strings', () => {
    const p = validPayload({ delivery_date: 'tomorrow' })
    expect(createBulkOrderSchema.safeParse(p).success).toBe(false)
  })

  it('accepts an ISO delivery_date (window enforced by service)', () => {
    const p = validPayload({ delivery_date: '2099-01-01T00:00:00.000Z' })
    // Schema is window-agnostic (Req 9.6 enforced in the service).
    expect(createBulkOrderSchema.safeParse(p).success).toBe(true)
  })

  it('defaults discount_amount and delivery_fee to 0 when omitted', () => {
    const p = validPayload()
    delete p.discount_amount
    delete p.delivery_fee
    const r = createBulkOrderSchema.safeParse(p)
    expect(r.success).toBe(true)
    expect(r.data.discount_amount).toBe(0)
    expect(r.data.delivery_fee).toBe(0)
  })

  it('requires delivery_address with line1/city/state/pincode', () => {
    const p = validPayload()
    p.delivery_address = { line1: '123' } // missing city/state/pincode
    expect(createBulkOrderSchema.safeParse(p).success).toBe(false)
  })

  it('rejects unknown payment_method values', () => {
    const p = validPayload({ payment_method: 'CASH_APP' })
    expect(createBulkOrderSchema.safeParse(p).success).toBe(false)
  })
})

describe('listBulkOrdersQuerySchema (Req 9.9)', () => {
  it('rejects invalid status filter', () => {
    expect(
      listBulkOrdersQuerySchema.safeParse({ status: 'NOPE' }).success
    ).toBe(false)
  })

  it('rejects non-uuid shop_id filter', () => {
    expect(
      listBulkOrdersQuerySchema.safeParse({ shop_id: 'shop-1' }).success
    ).toBe(false)
  })

  it('rejects limit < 1 and limit > 100', () => {
    expect(listBulkOrdersQuerySchema.safeParse({ limit: 0 }).success).toBe(
      false
    )
    expect(listBulkOrdersQuerySchema.safeParse({ limit: 101 }).success).toBe(
      false
    )
  })

  it('rejects page < 1', () => {
    expect(listBulkOrdersQuerySchema.safeParse({ page: 0 }).success).toBe(
      false
    )
  })

  it('coerces string page/limit values', () => {
    const r = listBulkOrdersQuerySchema.safeParse({ page: '3', limit: '25' })
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ page: 3, limit: 25 })
  })
})

describe('bulkOrderIdParamSchema', () => {
  it('rejects empty id', () => {
    expect(bulkOrderIdParamSchema.safeParse({ id: '' }).success).toBe(false)
  })

  it('rejects malformed UUID', () => {
    expect(bulkOrderIdParamSchema.safeParse({ id: '12345' }).success).toBe(
      false
    )
  })
})

describe('updateStatusSchema', () => {
  it('accepts an optional note string', () => {
    const r = updateStatusSchema.safeParse({
      status: 'CONFIRMED',
      note: 'ok',
    })
    expect(r.success).toBe(true)
  })

  it('rejects note longer than 500 chars', () => {
    const r = updateStatusSchema.safeParse({
      status: 'CONFIRMED',
      note: 'x'.repeat(501),
    })
    expect(r.success).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 2. Service.create — order_number format + JWT user wiring (Req 9.6, 9.8)
// ═══════════════════════════════════════════════════════════════════════

describe('BulkOrdersService.create — order_number generation (Req 9.8)', () => {
  it('produces BULK-YYYYMMDD-XXX with the current date and a 3-digit sequence', async () => {
    const { service, repo } = makeService()
    repo.countByOrderNumberPattern.mockResolvedValue(0)
    repo.existsOrderNumber.mockResolvedValue(false)
    repo.create.mockImplementation(async (input) => ({
      id: ORDER_ID,
      ...input,
    }))

    const result = await service.create(USER_ID, validPayload())
    expect(result.success).toBe(true)

    const insertArg = repo.create.mock.calls[0][0]
    const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    expect(insertArg.order_number).toBe(`BULK-${ymd}-001`)
    expect(insertArg.order_number).toMatch(/^BULK-\d{8}-\d{3}$/)
  })

  it('skips order_numbers that already exist (collision guard)', async () => {
    const { service, repo } = makeService()
    repo.countByOrderNumberPattern.mockResolvedValue(0)
    // First two candidates already exist; third must be selected.
    repo.existsOrderNumber
      .mockResolvedValueOnce(true) // 001
      .mockResolvedValueOnce(true) // 002
      .mockResolvedValueOnce(false) // 003
    repo.create.mockImplementation(async (input) => ({
      id: ORDER_ID,
      ...input,
    }))

    const result = await service.create(USER_ID, validPayload())
    expect(result.success).toBe(true)
    const insertArg = repo.create.mock.calls[0][0]
    expect(insertArg.order_number).toMatch(/^BULK-\d{8}-003$/)
  })

  it('persists user_id from the JWT (overrides any spoofed body field)', async () => {
    const { service, repo } = makeService()
    repo.create.mockImplementation(async (input) => ({
      id: ORDER_ID,
      ...input,
    }))
    const payload = validPayload()
    // Even if the client tried to spoof user_id, the service overrides it.
    payload.user_id = 'spoofed-user-id'

    await service.create(USER_ID, payload)

    const insertArg = repo.create.mock.calls[0][0]
    expect(insertArg.user_id).toBe(USER_ID)
    expect(insertArg.status).toBe('DRAFT')
  })

  it('returns UNAUTHORIZED when userId is missing', async () => {
    const { service, repo } = makeService()
    const result = await service.create(null, validPayload())
    expect(result.success).toBe(false)
    expect(result.code).toBe('UNAUTHORIZED')
    expect(repo.create).not.toHaveBeenCalled()
  })

  it('rejects with BULK_DATE_INVALID for delivery_date >30 days out', async () => {
    const { service, repo } = makeService()
    const result = await service.create(
      USER_ID,
      validPayload({ delivery_date: inThe.days(31) })
    )
    expect(result.success).toBe(false)
    expect(result.code).toBe('BULK_DATE_INVALID')
    expect(repo.create).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 3. Service.submit — extended (Req 9.3, 9.4)
// ═══════════════════════════════════════════════════════════════════════

describe('BulkOrdersService.submit — extended (Req 9.3, 9.4)', () => {
  const draft = (overrides = {}) => ({
    id: ORDER_ID,
    user_id: USER_ID,
    shop_id: SHOP_ID,
    status: 'DRAFT',
    items: [
      { product_id: PRODUCT_A, quantity: 5 },
      { product_id: PRODUCT_B, quantity: 2 },
      { product_id: PRODUCT_C, quantity: 1 },
    ],
    ...overrides,
  })

  it('returns BULK_ORDER_NOT_FOUND when caller is not the owner', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(draft())
    const result = await service.submit(USER_ID_OTHER, ORDER_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('BULK_ORDER_NOT_FOUND')
    expect(repo.findShopProductsForValidation).not.toHaveBeenCalled()
  })

  it('rejects when current status is not DRAFT (INVALID_STATE_TRANSITION)', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(draft({ status: 'SUBMITTED' }))
    const result = await service.submit(USER_ID, ORDER_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('INVALID_STATE_TRANSITION')
    expect(repo.updateStatus).not.toHaveBeenCalled()
  })

  it('flags shop_products with is_available=false as UNAVAILABLE', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(draft())
    repo.findShopProductsForValidation.mockResolvedValue([
      { product_id: PRODUCT_A, stock_quantity: 100, is_available: false, max_order_qty: 100 },
      { product_id: PRODUCT_B, stock_quantity: 100, is_available: true, max_order_qty: 100 },
      { product_id: PRODUCT_C, stock_quantity: 100, is_available: true, max_order_qty: 100 },
    ])

    const result = await service.submit(USER_ID, ORDER_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('INSUFFICIENT_STOCK')
    expect(result.failed.find((f) => f.product_id === PRODUCT_A)).toMatchObject(
      {
        reason: 'UNAVAILABLE',
        available: 100,
      }
    )
  })

  it('aggregates duplicate product_ids in items before validating', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(
      draft({
        items: [
          { product_id: PRODUCT_A, quantity: 3 },
          { product_id: PRODUCT_A, quantity: 4 }, // duplicate
          { product_id: PRODUCT_B, quantity: 2 },
          { product_id: PRODUCT_C, quantity: 1 },
        ],
      })
    )
    // Only 6 in stock for A; aggregated request is 7 -> INSUFFICIENT.
    repo.findShopProductsForValidation.mockResolvedValue([
      { product_id: PRODUCT_A, stock_quantity: 6, is_available: true, max_order_qty: 100 },
      { product_id: PRODUCT_B, stock_quantity: 100, is_available: true, max_order_qty: 100 },
      { product_id: PRODUCT_C, stock_quantity: 100, is_available: true, max_order_qty: 100 },
    ])

    const result = await service.submit(USER_ID, ORDER_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('INSUFFICIENT_STOCK')
    expect(result.failed.find((f) => f.product_id === PRODUCT_A)).toMatchObject(
      {
        requested: 7,
        available: 6,
        reason: 'INSUFFICIENT_STOCK',
      }
    )
  })

  it('does not deduct stock or open a transaction on submit', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(draft())
    repo.findShopProductsForValidation.mockResolvedValue([
      { product_id: PRODUCT_A, stock_quantity: 50, is_available: true, max_order_qty: 100 },
      { product_id: PRODUCT_B, stock_quantity: 50, is_available: true, max_order_qty: 100 },
      { product_id: PRODUCT_C, stock_quantity: 50, is_available: true, max_order_qty: 100 },
    ])
    repo.updateStatus.mockResolvedValue({ ...draft(), status: 'SUBMITTED' })

    const result = await service.submit(USER_ID, ORDER_ID)
    expect(result.success).toBe(true)
    expect(repo.applyShopProductStock).not.toHaveBeenCalled()
    expect(repo.lockShopProduct).not.toHaveBeenCalled()
    expect(getClient).not.toHaveBeenCalled() // submit() never opens a tx
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 4. Service.updateStatus — extended (Req 9.1, 9.5, 9.7)
// ═══════════════════════════════════════════════════════════════════════

describe('BulkOrdersService.updateStatus — non-stock transitions', () => {
  const at = (status) => ({
    id: ORDER_ID,
    user_id: USER_ID,
    shop_id: SHOP_ID,
    status,
    items: [{ product_id: PRODUCT_A, quantity: 3 }],
  })

  it('PROCESSING -> READY does not open a transaction or touch stock', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(at('PROCESSING'))
    repo.updateStatus.mockResolvedValue({ ...at('READY') })

    const result = await service.updateStatus(
      { id: 'mgr', role: 'CUSTOMER', shopId: SHOP_ID, shopRole: 'SHOP_MANAGER' },
      ORDER_ID,
      'READY'
    )
    expect(result.success).toBe(true)
    expect(getClient).not.toHaveBeenCalled()
    expect(repo.applyShopProductStock).not.toHaveBeenCalled()
    // Simple-status-update branch invokes the pool (no tx client).
    expect(repo.updateStatus).toHaveBeenCalledWith(ORDER_ID, 'READY')
  })

  it('READY -> DELIVERED is a simple status update', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(at('READY'))
    repo.updateStatus.mockResolvedValue({ ...at('DELIVERED') })

    const result = await service.updateStatus(
      { id: 'admin', role: 'ADMIN' },
      ORDER_ID,
      'DELIVERED'
    )
    expect(result.success).toBe(true)
    expect(getClient).not.toHaveBeenCalled()
    expect(repo.updateStatus).toHaveBeenCalledWith(ORDER_ID, 'DELIVERED')
  })

  it('SUBMITTED -> CANCELLED is a simple status update (no stock side-effects)', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(at('SUBMITTED'))
    repo.updateStatus.mockResolvedValue({ ...at('CANCELLED') })

    const result = await service.updateStatus(
      { id: 'mgr', role: 'CUSTOMER', shopId: SHOP_ID, shopRole: 'SHOP_ADMIN' },
      ORDER_ID,
      'CANCELLED'
    )
    expect(result.success).toBe(true)
    // The stock-restore transaction only runs when previous state was
    // CONFIRMED; SUBMITTED->CANCELLED falls through to the simple branch.
    expect(getClient).not.toHaveBeenCalled()
    expect(repo.applyShopProductStock).not.toHaveBeenCalled()
    expect(repo.updateStatus).toHaveBeenCalledWith(ORDER_ID, 'CANCELLED')
  })

  it('rejects shop staff scoped to a different shop', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(at('SUBMITTED'))
    repo.findStaffRole.mockResolvedValue(null)

    const result = await service.updateStatus(
      {
        id: 'staffer',
        role: 'CUSTOMER',
        shopId: SHOP_ID_OTHER, // different shop
        shopRole: 'SHOP_MANAGER',
      },
      ORDER_ID,
      'CONFIRMED'
    )
    expect(result.success).toBe(false)
    // SHOP_SCOPE_MISMATCH or FORBIDDEN both indicate the JWT shop check
    // rejected the request — neither must leak as 401.
    expect(['SHOP_SCOPE_MISMATCH', 'FORBIDDEN']).toContain(result.code)
    expect(repo.updateStatus).not.toHaveBeenCalled()
  })

  it('falls back to repo.findStaffRole when shopRole is not on the JWT', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(at('PROCESSING'))
    repo.findStaffRole.mockResolvedValue({ role: 'SHOP_MANAGER' })
    repo.updateStatus.mockResolvedValue({ ...at('READY') })

    const result = await service.updateStatus(
      { id: 'staffer', role: 'CUSTOMER' /* no shopId/shopRole */ },
      ORDER_ID,
      'READY'
    )
    expect(result.success).toBe(true)
    expect(repo.findStaffRole).toHaveBeenCalledWith('staffer', SHOP_ID)
  })

  it('returns BULK_ORDER_NOT_FOUND when the order does not exist', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(null)
    const result = await service.updateStatus(
      { id: 'admin', role: 'ADMIN' },
      ORDER_ID,
      'CONFIRMED'
    )
    expect(result.success).toBe(false)
    expect(result.code).toBe('BULK_ORDER_NOT_FOUND')
  })

  it('rolls back when the status changed between read and FOR UPDATE', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(at('SUBMITTED'))
    const client = makeTxClient()
    getClient.mockResolvedValue(client)
    // Race: another worker confirmed/cancelled before our FOR UPDATE.
    repo.findByIdForUpdate.mockResolvedValue(at('CANCELLED'))

    const result = await service.updateStatus(
      { id: 'admin', role: 'ADMIN' },
      ORDER_ID,
      'CONFIRMED'
    )
    expect(result.success).toBe(false)
    expect(result.code).toBe('INVALID_STATE_TRANSITION')
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.query).not.toHaveBeenCalledWith('COMMIT')
    expect(repo.applyShopProductStock).not.toHaveBeenCalled()
  })

  it('releases the pg client even when the transaction errors', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(at('SUBMITTED'))
    const client = makeTxClient()
    getClient.mockResolvedValue(client)
    repo.findByIdForUpdate.mockResolvedValue(at('SUBMITTED'))
    repo.lockShopProduct.mockRejectedValue(
      Object.assign(new Error('connection lost'), { code: 'ECONNRESET' })
    )

    await expect(
      service.updateStatus(
        { id: 'admin', role: 'ADMIN' },
        ORDER_ID,
        'CONFIRMED'
      )
    ).rejects.toThrow('connection lost')

    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalled()
  })

  it('translates 23514 (CHECK constraint) to INSUFFICIENT_STOCK', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(at('SUBMITTED'))
    const client = makeTxClient()
    getClient.mockResolvedValue(client)
    repo.findByIdForUpdate.mockResolvedValue(at('SUBMITTED'))
    repo.lockShopProduct.mockResolvedValue({
      id: 'sp-a',
      stock_quantity: 100,
      is_available: true,
    })
    repo.applyShopProductStock.mockRejectedValue(
      Object.assign(new Error('check_violation'), { code: '23514' })
    )

    const result = await service.updateStatus(
      { id: 'admin', role: 'ADMIN' },
      ORDER_ID,
      'CONFIRMED'
    )
    expect(result.success).toBe(false)
    expect(result.code).toBe('INSUFFICIENT_STOCK')
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 5. Service.cancel — customer-facing (Req 9.1, 9.7)
// ═══════════════════════════════════════════════════════════════════════

describe('BulkOrdersService.cancel — customer flow', () => {
  const owned = (status) => ({
    id: ORDER_ID,
    user_id: USER_ID,
    shop_id: SHOP_ID,
    status,
    items: [{ product_id: PRODUCT_A, quantity: 1 }],
  })

  it('allows DRAFT -> CANCELLED', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(owned('DRAFT'))
    repo.updateStatus.mockResolvedValue({ ...owned('CANCELLED') })

    const result = await service.cancel(USER_ID, ORDER_ID)
    expect(result.success).toBe(true)
    expect(repo.updateStatus).toHaveBeenCalledWith(ORDER_ID, 'CANCELLED')
  })

  it('allows SUBMITTED -> CANCELLED', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(owned('SUBMITTED'))
    repo.updateStatus.mockResolvedValue({ ...owned('CANCELLED') })

    const result = await service.cancel(USER_ID, ORDER_ID)
    expect(result.success).toBe(true)
  })

  it('blocks CONFIRMED with FORBIDDEN (must go through shop manager flow)', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue(owned('CONFIRMED'))

    const result = await service.cancel(USER_ID, ORDER_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('FORBIDDEN')
    expect(repo.updateStatus).not.toHaveBeenCalled()
    expect(getClient).not.toHaveBeenCalled() // no stock-restore tx opened
  })

  it('blocks PROCESSING/READY/DELIVERED with INVALID_STATE_TRANSITION', async () => {
    const { service, repo } = makeService()
    for (const s of ['PROCESSING', 'READY', 'DELIVERED']) {
      repo.findById.mockResolvedValueOnce(owned(s))
      const result = await service.cancel(USER_ID, ORDER_ID)
      expect(result.success).toBe(false)
      expect(result.code).toBe('INVALID_STATE_TRANSITION')
    }
    expect(repo.updateStatus).not.toHaveBeenCalled()
  })

  it('hides bulk orders owned by a different user (NOT_FOUND, never 403)', async () => {
    const { service, repo } = makeService()
    repo.findById.mockResolvedValue({
      ...owned('DRAFT'),
      user_id: USER_ID_OTHER,
    })

    const result = await service.cancel(USER_ID, ORDER_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('BULK_ORDER_NOT_FOUND')
  })

  it('returns UNAUTHORIZED when userId is missing', async () => {
    const { service, repo } = makeService()
    const result = await service.cancel(null, ORDER_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('UNAUTHORIZED')
    expect(repo.findById).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 6. Service.list — scoping rules (Req 9.9)
// ═══════════════════════════════════════════════════════════════════════

describe('BulkOrdersService.list — scoping', () => {
  it('scopes a customer to their own user_id (no shop scope)', async () => {
    const { service, repo } = makeService()
    repo.findMany.mockResolvedValue({ items: [], total: 0 })

    await service.list(
      { id: USER_ID, role: 'CUSTOMER' },
      { page: 1, limit: 20, shop_id: SHOP_ID_OTHER /* must be ignored */ }
    )

    const arg = repo.findMany.mock.calls[0][0]
    expect(arg).toMatchObject({ userId: USER_ID, page: 1, limit: 20 })
    expect(arg.shopId).toBeUndefined()
  })

  it('pins shop staff to their JWT shopId, ignoring shop_id query filter', async () => {
    const { service, repo } = makeService()
    repo.findMany.mockResolvedValue({ items: [], total: 0 })

    await service.list(
      {
        id: 'staffer',
        role: 'CUSTOMER',
        shopId: SHOP_ID,
        shopRole: 'SHOP_STAFF',
      },
      { page: 2, limit: 50, status: 'SUBMITTED', shop_id: SHOP_ID_OTHER }
    )

    const arg = repo.findMany.mock.calls[0][0]
    expect(arg).toMatchObject({
      shopId: SHOP_ID,
      page: 2,
      limit: 50,
      status: 'SUBMITTED',
    })
    expect(arg.userId).toBeUndefined()
  })

  it('Super Admin: X-Shop-Id (actor.shopId) takes precedence over shop_id filter', async () => {
    const { service, repo } = makeService()
    repo.findMany.mockResolvedValue({ items: [], total: 0 })

    await service.list(
      { id: 'admin', role: 'ADMIN', shopId: SHOP_ID },
      { page: 1, limit: 20, shop_id: SHOP_ID_OTHER }
    )

    const arg = repo.findMany.mock.calls[0][0]
    expect(arg.shopId).toBe(SHOP_ID)
  })

  it('Super Admin: shop_id filter passes through when no header is set', async () => {
    const { service, repo } = makeService()
    repo.findMany.mockResolvedValue({ items: [], total: 0 })

    await service.list(
      { id: 'admin', role: 'ADMIN' },
      { page: 1, limit: 20, shop_id: SHOP_ID }
    )

    const arg = repo.findMany.mock.calls[0][0]
    expect(arg.shopId).toBe(SHOP_ID)
  })

  it('Super Admin without any shop scope sees the cross-shop view', async () => {
    const { service, repo } = makeService()
    repo.findMany.mockResolvedValue({ items: [], total: 0 })

    await service.list({ id: 'admin', role: 'ADMIN' }, { page: 1, limit: 20 })

    const arg = repo.findMany.mock.calls[0][0]
    expect(arg.shopId).toBeUndefined()
    expect(arg.userId).toBeUndefined()
  })

  it('returns the repository response shape with page/limit echoed back', async () => {
    const { service, repo } = makeService()
    repo.findMany.mockResolvedValue({ items: [{ id: 'a' }], total: 1 })

    const result = await service.list(
      { id: USER_ID, role: 'CUSTOMER' },
      { page: 1, limit: 20 }
    )
    expect(result).toEqual({
      items: [{ id: 'a' }],
      total: 1,
      page: 1,
      limit: 20,
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 7. Repository SQL safety (Architecture rules)
// ═══════════════════════════════════════════════════════════════════════

describe('BulkOrdersRepository — SQL safety', () => {
  it('SELECT_COLUMNS lists every column explicitly (no SELECT *)', () => {
    const cols = BulkOrdersRepository.SELECT_COLUMNS
    expect(cols).not.toContain('*')
    for (const expected of [
      'id',
      'shop_id',
      'user_id',
      'order_number',
      'status',
      'items',
      'total_items',
      'subtotal',
      'discount_amount',
      'delivery_fee',
      'total_amount',
      'delivery_date',
      'delivery_slot',
      'delivery_address',
      'payment_method',
      'payment_status',
      'created_at',
      'updated_at',
    ]) {
      expect(cols).toContain(expected)
    }
  })

  it('findById uses parameterized $1', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    const repo = new BulkOrdersRepository()
    await repo.findById(ORDER_ID)
    const [sql, params] = query.mock.calls.at(-1)
    expect(sql).toMatch(/WHERE id = \$1/)
    expect(sql).not.toContain("'") // no string literals embedded
    expect(params).toEqual([ORDER_ID])
  })

  it('existsOrderNumber uses LIMIT 1 with $1', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    const repo = new BulkOrdersRepository()
    await repo.existsOrderNumber('BULK-20240101-001')
    const [sql, params] = query.mock.calls.at(-1)
    expect(sql).toMatch(/order_number = \$1/)
    expect(sql).toMatch(/LIMIT 1/)
    expect(params).toEqual(['BULK-20240101-001'])
  })

  it('findMany builds a fully parameterized WHERE/LIMIT/OFFSET', async () => {
    // Promise.all dispatches data + count queries.
    query
      .mockResolvedValueOnce({ rows: [] }) // data
      .mockResolvedValueOnce({ rows: [{ total: 0 }] }) // count
    const repo = new BulkOrdersRepository()
    await repo.findMany({
      userId: USER_ID,
      shopId: SHOP_ID,
      status: 'CONFIRMED',
      page: 2,
      limit: 25,
    })
    const dataCall = query.mock.calls.at(-2)
    const dataSql = dataCall[0]
    const dataParams = dataCall[1]
    expect(dataSql).toMatch(/user_id = \$1/)
    expect(dataSql).toMatch(/shop_id = \$2/)
    expect(dataSql).toMatch(/status = \$3/)
    expect(dataSql).toMatch(/LIMIT \$4 OFFSET \$5/)
    // page=2, limit=25 -> offset 25
    expect(dataParams).toEqual([USER_ID, SHOP_ID, 'CONFIRMED', 25, 25])
  })

  it('findMany omits the WHERE clause when no filters are provided', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
    const repo = new BulkOrdersRepository()
    await repo.findMany({ page: 1, limit: 20 })
    const dataSql = query.mock.calls.at(-2)[0]
    expect(dataSql).not.toMatch(/WHERE /)
    expect(dataSql).toMatch(/ORDER BY created_at DESC/)
  })

  it('create uses 15 positional params and ::jsonb casts', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ORDER_ID }] })
    const repo = new BulkOrdersRepository()
    await repo.create({
      shop_id: SHOP_ID,
      user_id: USER_ID,
      order_number: 'BULK-20240601-001',
      status: 'DRAFT',
      items: [{ product_id: PRODUCT_A, quantity: 5 }],
      total_items: 5,
      subtotal: 100,
      discount_amount: 0,
      delivery_fee: 0,
      total_amount: 100,
      delivery_date: '2099-01-01T00:00:00Z',
      delivery_slot: '10-12',
      delivery_address: {
        line1: '1',
        city: 'BLR',
        state: 'KA',
        pincode: '560001',
      },
      payment_method: 'COD',
      payment_status: 'PENDING',
    })
    const [sql, params] = query.mock.calls.at(-1)
    expect(sql).toMatch(/INSERT INTO bulk_orders/)
    expect(sql).toMatch(/\$5::jsonb/) // items
    expect(sql).toMatch(/\$13::jsonb/) // delivery_address
    expect(sql).toMatch(/RETURNING/)
    expect(params).toHaveLength(15)
    // items + delivery_address must be JSON-serialised, not passed raw.
    expect(typeof params[4]).toBe('string')
    expect(typeof params[12]).toBe('string')
    expect(JSON.parse(params[4])).toEqual([
      { product_id: PRODUCT_A, quantity: 5 },
    ])
  })

  it('updateStatus is parameterized and bumps updated_at', async () => {
    query.mockResolvedValueOnce({
      rows: [{ id: ORDER_ID, status: 'SUBMITTED' }],
    })
    const repo = new BulkOrdersRepository()
    await repo.updateStatus(ORDER_ID, 'SUBMITTED')
    const [sql, params] = query.mock.calls.at(-1)
    expect(sql).toMatch(/SET status = \$1/)
    expect(sql).toMatch(/updated_at = NOW\(\)/)
    expect(sql).toMatch(/WHERE id = \$2/)
    expect(params).toEqual(['SUBMITTED', ORDER_ID])
  })

  it('updateStatus uses the provided client when one is passed', async () => {
    const client = makeTxClient()
    client.query.mockResolvedValueOnce({ rows: [{ id: ORDER_ID }] })
    const repo = new BulkOrdersRepository()
    await repo.updateStatus(ORDER_ID, 'CONFIRMED', client)
    expect(client.query).toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it('findByIdForUpdate uses FOR UPDATE on the provided client', async () => {
    const client = makeTxClient()
    client.query.mockResolvedValueOnce({ rows: [{ id: ORDER_ID }] })
    const repo = new BulkOrdersRepository()
    await repo.findByIdForUpdate(client, ORDER_ID)
    const [sql, params] = client.query.mock.calls.at(-1)
    expect(sql).toMatch(/FOR UPDATE/)
    expect(sql).toMatch(/WHERE id = \$1/)
    expect(params).toEqual([ORDER_ID])
    expect(query).not.toHaveBeenCalled() // never via the pool
  })

  it('findShopProductsForValidation returns [] without hitting the DB on empty list', async () => {
    const repo = new BulkOrdersRepository()
    const rows = await repo.findShopProductsForValidation(null, SHOP_ID, [])
    expect(rows).toEqual([])
    expect(query).not.toHaveBeenCalled()
  })

  it('findShopProductsForValidation uses unnest($2::uuid[]) with $1 shopId', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    const repo = new BulkOrdersRepository()
    await repo.findShopProductsForValidation(null, SHOP_ID, [
      PRODUCT_A,
      PRODUCT_B,
    ])
    const [sql, params] = query.mock.calls.at(-1)
    expect(sql).toMatch(/unnest\(\$2::uuid\[\]\)/)
    expect(sql).toMatch(/sp\.shop_id = \$1/)
    expect(sql).toMatch(/sp\.deleted_at IS NULL/)
    expect(params).toEqual([SHOP_ID, [PRODUCT_A, PRODUCT_B]])
  })

  it('lockShopProduct uses FOR UPDATE filtered by deleted_at IS NULL', async () => {
    const client = makeTxClient()
    client.query.mockResolvedValueOnce({ rows: [] })
    const repo = new BulkOrdersRepository()
    await repo.lockShopProduct(client, SHOP_ID, PRODUCT_A)
    const [sql, params] = client.query.mock.calls.at(-1)
    expect(sql).toMatch(/FOR UPDATE/)
    expect(sql).toMatch(/shop_id = \$1 AND product_id = \$2/)
    expect(sql).toMatch(/deleted_at IS NULL/)
    expect(params).toEqual([SHOP_ID, PRODUCT_A])
  })

  it('applyShopProductStock encodes is_available + sold_out_at semantics', async () => {
    const client = makeTxClient()
    client.query.mockResolvedValueOnce({ rows: [] })
    const repo = new BulkOrdersRepository()
    await repo.applyShopProductStock(client, 'sp-id', 0)
    const [sql, params] = client.query.mock.calls.at(-1)
    // New stock=0 -> is_available=false, sold_out_at=NOW()
    expect(sql).toMatch(/WHEN \$1 = 0 THEN false/)
    expect(sql).toMatch(/WHEN \$1 = 0 THEN NOW\(\)/)
    // New stock>0 from previously 0 -> is_available=true, sold_out_at=NULL
    expect(sql).toMatch(/stock_quantity = 0 AND \$1 > 0 THEN true/)
    expect(sql).toMatch(/stock_quantity = 0 AND \$1 > 0 THEN NULL/)
    // updated_at is always bumped.
    expect(sql).toMatch(/updated_at = NOW\(\)/)
    expect(sql).toMatch(/deleted_at IS NULL/)
    expect(params).toEqual([0, 'sp-id'])
  })

  it('isUserAllocatedToShop joins shops to enforce is_active=true and not deleted', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    const repo = new BulkOrdersRepository()
    await repo.isUserAllocatedToShop(USER_ID, SHOP_ID)
    const [sql, params] = query.mock.calls.at(-1)
    expect(sql).toMatch(/JOIN shops s ON s\.id = a\.shop_id/)
    expect(sql).toMatch(/s\.is_active = true/)
    expect(sql).toMatch(/s\.deleted_at IS NULL/)
    expect(sql).toMatch(/a\.user_id = \$1/)
    expect(sql).toMatch(/a\.shop_id = \$2/)
    expect(params).toEqual([USER_ID, SHOP_ID])
  })

  it('findStaffRole gates on ss.is_active and shop activity', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    const repo = new BulkOrdersRepository()
    await repo.findStaffRole(USER_ID, SHOP_ID)
    const [sql, params] = query.mock.calls.at(-1)
    expect(sql).toMatch(/ss\.is_active = true/)
    expect(sql).toMatch(/ss\.deleted_at IS NULL/)
    expect(sql).toMatch(/s\.is_active = true/)
    expect(sql).toMatch(/ss\.user_id = \$1/)
    expect(sql).toMatch(/ss\.shop_id = \$2/)
    expect(params).toEqual([USER_ID, SHOP_ID])
  })
})
