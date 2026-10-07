import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Manual payment settlement — for an order delivered outside the rider
 * app / online-payment flow, an admin/finance user records that cash/UPI
 * was actually collected. `orders.payment_status` never flips to PAID just
 * because the order reached DELIVERED — see `_buildSettlementSummary`'s
 * own comment; a delivered COD order stays PENDING/PARTIALLY_PAID until
 * someone records the real collection through this path.
 *
 * Covers the scenarios the spec explicitly asked for: cash full payment,
 * UPI full payment, cash+UPI split, partial payment, final settlement
 * after a partial, and an already-paid online order refusing a new
 * settlement (its outstanding balance is genuinely ₹0, not derived from
 * this table at all).
 */
const mockClient = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() }

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  getClient: vi.fn(async () => mockClient),
}))
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn() },
  orderQueue: { add: vi.fn() },
}))
vi.mock('../../../src/utils/activityLogger.js', () => ({ logAdminActivity: vi.fn() }))

import { AdminOrdersService } from '../../../src/modules/admin/orders/orders.service.js'

const ORDER_ID = 'order-1'
const SHOP_A = 'shop-a'
const ADMIN_ID = 'admin-1'

function makeService({ order, history = [] } = {}) {
  // Stateful, like the real DB: `setPaymentStatus`/`insertSettlementEntry`
  // mutate what the post-commit refetch (`findById`/`getSettlementHistory`,
  // called without a client, against the "committed" state) sees — a
  // static mock here would make the returned summary lag one write behind
  // reality, which isn't what the real repository does.
  const state = {
    order: order ?? {
      id: ORDER_ID, shop_id: SHOP_A, order_number: 'FC-A-1',
      total_payable: '380.00', wallet_amount: '0.00', payment_status: 'PENDING',
    },
    history: [...history],
  }
  const repository = {
    findByIdForUpdate: vi.fn(async () => state.order),
    findById: vi.fn(async () => state.order),
    getSettlementHistory: vi.fn(async () => state.history),
    insertSettlementEntry: vi.fn(async (client, data) => {
      const entry = {
        id: `entry-${state.history.length + 1}`,
        order_id: data.orderId,
        entry_type: data.entryType,
        amount: data.amount,
        method: data.method,
        cash_amount: data.cashAmount || 0,
        upi_amount: data.upiAmount || 0,
        reference: data.reference || null,
        method_note: data.methodNote || null,
        internal_note: data.internalNote || null,
        reverses_entry_id: data.reversesEntryId || null,
        recorded_by: data.recordedBy,
        recorded_by_name: 'Sayan Mondal',
        created_at: '2026-09-24T10:00:00Z',
      }
      state.history = [...state.history, entry]
      return entry
    }),
    setPaymentStatus: vi.fn(async (client, orderId, paymentStatus) => {
      state.order = { ...state.order, payment_status: paymentStatus }
    }),
  }
  const service = new AdminOrdersService(repository, null)
  return { service, repository }
}

describe('AdminOrdersService.recordSettlement', () => {
  beforeEach(() => vi.clearAllMocks())

  it('records a full Cash payment and flips the order to PAID', async () => {
    const { service, repository } = makeService()
    const result = await service.recordSettlement(ORDER_ID, { amount: 380, method: 'CASH' }, ADMIN_ID, SHOP_A)

    expect(repository.insertSettlementEntry).toHaveBeenCalledWith(mockClient, expect.objectContaining({
      orderId: ORDER_ID, entryType: 'SETTLEMENT', amount: 380, method: 'CASH', recordedBy: ADMIN_ID,
    }))
    expect(repository.setPaymentStatus).toHaveBeenCalledWith(mockClient, ORDER_ID, 'PAID')
    expect(result.amountDue).toBe(0)
  })

  it('records a full UPI payment (with a transaction reference) and flips the order to PAID', async () => {
    const { service, repository } = makeService()
    await service.recordSettlement(ORDER_ID, { amount: 380, method: 'UPI', reference: 'UTR12345' }, ADMIN_ID, SHOP_A)

    expect(repository.insertSettlementEntry).toHaveBeenCalledWith(mockClient, expect.objectContaining({
      method: 'UPI', reference: 'UTR12345',
    }))
    expect(repository.setPaymentStatus).toHaveBeenCalledWith(mockClient, ORDER_ID, 'PAID')
  })

  it('records a Cash + UPI split that sums to the full amount and flips the order to PAID', async () => {
    const { service, repository } = makeService()
    await service.recordSettlement(
      ORDER_ID, { amount: 380, method: 'CASH_UPI', cashAmount: 200, upiAmount: 180 }, ADMIN_ID, SHOP_A
    )

    expect(repository.insertSettlementEntry).toHaveBeenCalledWith(mockClient, expect.objectContaining({
      method: 'CASH_UPI', cashAmount: 200, upiAmount: 180,
    }))
    expect(repository.setPaymentStatus).toHaveBeenCalledWith(mockClient, ORDER_ID, 'PAID')
  })

  it('rejects a Cash + UPI split whose parts do not sum to the amount received', async () => {
    const { service, repository } = makeService()
    await expect(
      service.recordSettlement(ORDER_ID, { amount: 380, method: 'CASH_UPI', cashAmount: 200, upiAmount: 100 }, ADMIN_ID, SHOP_A)
    ).rejects.toMatchObject({ code: 'SPLIT_MISMATCH' })
    expect(repository.insertSettlementEntry).not.toHaveBeenCalled()
  })

  it('records a partial ₹200 Cash payment against ₹380 due — order becomes PARTIALLY_PAID, ₹180 remains due', async () => {
    const { service, repository } = makeService()
    const result = await service.recordSettlement(ORDER_ID, { amount: 200, method: 'CASH' }, ADMIN_ID, SHOP_A)

    expect(repository.setPaymentStatus).toHaveBeenCalledWith(mockClient, ORDER_ID, 'PARTIALLY_PAID')
    expect(result.amountDue).toBe(180)
  })

  it('final settlement after a partial payment: ₹180 UPI on top of an existing ₹200 Cash entry completes the order (PAID)', async () => {
    const existingEntry = {
      id: 'entry-1', order_id: ORDER_ID, entry_type: 'SETTLEMENT', amount: '200.00', method: 'CASH',
      cash_amount: '200.00', upi_amount: '0.00', reference: null, method_note: null, internal_note: null,
      reverses_entry_id: null, recorded_by: ADMIN_ID, recorded_by_name: 'Sayan Mondal', created_at: '2026-09-24T09:00:00Z',
    }
    const { service, repository } = makeService({
      order: { id: ORDER_ID, shop_id: SHOP_A, order_number: 'FC-A-1', total_payable: '380.00', wallet_amount: '0.00', payment_status: 'PARTIALLY_PAID' },
      history: [existingEntry],
    })

    const result = await service.recordSettlement(ORDER_ID, { amount: 180, method: 'UPI' }, ADMIN_ID, SHOP_A)

    expect(repository.setPaymentStatus).toHaveBeenCalledWith(mockClient, ORDER_ID, 'PAID')
    expect(result.amountDue).toBe(0)
  })

  it('never lets the collected amount exceed the outstanding balance', async () => {
    const { service, repository } = makeService()
    await expect(
      service.recordSettlement(ORDER_ID, { amount: 500, method: 'CASH' }, ADMIN_ID, SHOP_A)
    ).rejects.toMatchObject({ code: 'EXCEEDS_OUTSTANDING' })
    expect(repository.insertSettlementEntry).not.toHaveBeenCalled()
  })

  it('requires a method note for "Other"', async () => {
    const { service } = makeService()
    await expect(
      service.recordSettlement(ORDER_ID, { amount: 380, method: 'OTHER' }, ADMIN_ID, SHOP_A)
    ).rejects.toMatchObject({ code: 'METHOD_NOTE_REQUIRED' })
  })

  it('refuses to settle an order that is already fully paid (e.g. a genuine online Razorpay payment — never touches the settlement table at all)', async () => {
    const { service, repository } = makeService({
      order: { id: ORDER_ID, shop_id: SHOP_A, order_number: 'FC-A-1', total_payable: '210.00', wallet_amount: '0.00', payment_status: 'PAID' },
    })
    await expect(
      service.recordSettlement(ORDER_ID, { amount: 210, method: 'CASH' }, ADMIN_ID, SHOP_A)
    ).rejects.toMatchObject({ code: 'NOTHING_DUE' })
    expect(repository.insertSettlementEntry).not.toHaveBeenCalled()
  })

  it('rejects a cross-shop settlement attempt (shop-staff JWT scoped to a different shop than the order)', async () => {
    const { service } = makeService()
    await expect(
      service.recordSettlement(ORDER_ID, { amount: 380, method: 'CASH' }, ADMIN_ID, 'shop-b')
    ).rejects.toMatchObject({ code: 'CROSS_SHOP_ACCESS_DENIED' })
  })
})

describe('AdminOrdersService.getSettlementInfo — already-paid online order', () => {
  it('shows ₹0 due for an order paid entirely via Razorpay, with zero settlement rows', async () => {
    const { service } = makeService({
      order: { id: ORDER_ID, shop_id: SHOP_A, order_number: 'FC-A-1', total_payable: '210.00', wallet_amount: '0.00', payment_status: 'PAID' },
      history: [],
    })
    const info = await service.getSettlementInfo(ORDER_ID, SHOP_A)
    expect(info.amountDue).toBe(0)
    expect(info.paymentStatus).toBe('PAID')
  })
})

describe('AdminOrdersService.reverseSettlement', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reverses a settlement entry via a new REVERSAL row — never edits/deletes the original — and recomputes status back down', async () => {
    const original = {
      id: 'entry-1', order_id: ORDER_ID, entry_type: 'SETTLEMENT', amount: '380.00', method: 'CASH',
      cash_amount: '380.00', upi_amount: '0.00', reference: null, method_note: null, internal_note: null,
      reverses_entry_id: null, recorded_by: ADMIN_ID, recorded_by_name: 'Sayan Mondal', created_at: '2026-09-24T09:00:00Z',
    }
    const { service, repository } = makeService({
      order: { id: ORDER_ID, shop_id: SHOP_A, order_number: 'FC-A-1', total_payable: '380.00', wallet_amount: '0.00', payment_status: 'PAID' },
      history: [original],
    })

    const result = await service.reverseSettlement(ORDER_ID, 'entry-1', 'Entered wrong amount', ADMIN_ID, SHOP_A)

    expect(repository.insertSettlementEntry).toHaveBeenCalledWith(mockClient, expect.objectContaining({
      entryType: 'REVERSAL', amount: 380, reversesEntryId: 'entry-1', internalNote: 'Entered wrong amount',
    }))
    expect(repository.setPaymentStatus).toHaveBeenCalledWith(mockClient, ORDER_ID, 'PENDING')
    expect(result.amountDue).toBe(380)
  })

  it('refuses to reverse the same entry twice', async () => {
    const original = {
      id: 'entry-1', order_id: ORDER_ID, entry_type: 'SETTLEMENT', amount: '380.00', method: 'CASH',
      cash_amount: '380.00', upi_amount: '0.00', reference: null, method_note: null, internal_note: null,
      reverses_entry_id: null, recorded_by: ADMIN_ID, recorded_by_name: 'Sayan Mondal', created_at: '2026-09-24T09:00:00Z',
    }
    const reversal = {
      id: 'entry-2', order_id: ORDER_ID, entry_type: 'REVERSAL', amount: '380.00', method: 'CASH',
      cash_amount: '380.00', upi_amount: '0.00', reference: null, method_note: null, internal_note: 'oops',
      reverses_entry_id: 'entry-1', recorded_by: ADMIN_ID, recorded_by_name: 'Sayan Mondal', created_at: '2026-09-24T09:05:00Z',
    }
    const { service, repository } = makeService({ history: [original, reversal] })

    await expect(
      service.reverseSettlement(ORDER_ID, 'entry-1', 'again', ADMIN_ID, SHOP_A)
    ).rejects.toMatchObject({ code: 'ALREADY_REVERSED' })
    expect(repository.insertSettlementEntry).not.toHaveBeenCalled()
  })

  it('404s reversing an entry that does not belong to this order', async () => {
    const { service } = makeService({ history: [] })
    await expect(
      service.reverseSettlement(ORDER_ID, 'nonexistent-entry', 'x', ADMIN_ID, SHOP_A)
    ).rejects.toMatchObject({ code: 'ENTRY_NOT_FOUND' })
  })
})
