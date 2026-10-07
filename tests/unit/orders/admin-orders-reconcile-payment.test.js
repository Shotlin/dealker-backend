import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  getClient: vi.fn(),
}))
vi.mock('../../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn() },
  orderQueue: { add: vi.fn() },
}))
vi.mock('../../../src/utils/activityLogger.js', () => ({ logAdminActivity: vi.fn() }))

const reconcileWithRazorpayMock = vi.fn()
vi.mock('../../../src/modules/payments/payments.service.js', () => ({
  PaymentsService: vi.fn().mockImplementation(() => ({
    reconcileWithRazorpay: reconcileWithRazorpayMock,
  })),
}))
vi.mock('../../../src/modules/payments/payments.repository.js', () => ({
  PaymentsRepository: vi.fn().mockImplementation(() => ({})),
}))

const razorpayFetchMock = vi.fn()
vi.mock('../../../src/config/razorpay.js', () => ({
  razorpay: { payments: { fetch: (...args) => razorpayFetchMock(...args) } },
  getRazorpayKeyId: () => 'rzp_test_key',
  getRazorpayKeySecret: () => 'secret',
  getRazorpayWebhookSecret: () => undefined,
  getRazorpayMode: () => 'TEST',
  refreshRazorpayClient: vi.fn(),
}))

import { AdminOrdersService } from '../../../src/modules/admin/orders/orders.service.js'

const ORDER_ID = 'order-1'
const SHOP_A = 'shop-a'

function makeService({ order, payment } = {}) {
  const repository = {
    findById: vi.fn(async () => order ?? { id: ORDER_ID, shop_id: SHOP_A, status: 'ORDER_PLACED', order_number: 'FC-A-1' }),
    getOrderPayment: vi.fn(async () => payment ?? null),
  }
  const service = new AdminOrdersService(repository, null)
  return { service, repository }
}

describe('AdminOrdersService.reconcilePayment', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports "nothing to reconcile" when the order has no online payment at all', async () => {
    const { service } = makeService({ payment: null })
    const result = await service.reconcilePayment(ORDER_ID, SHOP_A)

    expect(result.captured).toBe(false)
    expect(reconcileWithRazorpayMock).not.toHaveBeenCalled()
  })

  it('routes a captured result through the shared reconcileWithRazorpay helper — never a second, parallel finalization path', async () => {
    const { service } = makeService({ payment: { razorpay_order_id: 'rzp_order_1' } })
    reconcileWithRazorpayMock.mockResolvedValue({ captured: true, success: true, needsManualReview: false })

    const result = await service.reconcilePayment(ORDER_ID, SHOP_A)

    expect(reconcileWithRazorpayMock).toHaveBeenCalledWith('rzp_order_1', 'ADMIN_MANUAL_RECONCILE')
    expect(result.captured).toBe(true)
    expect(result.needsManualReview).toBe(false)
  })

  it('surfaces needsManualReview when Razorpay confirms a capture but the order already moved on', async () => {
    const { service } = makeService({
      order: { id: ORDER_ID, shop_id: SHOP_A, status: 'CANCELLED', order_number: 'FC-A-1' },
      payment: { razorpay_order_id: 'rzp_order_2' },
    })
    reconcileWithRazorpayMock.mockResolvedValue({ captured: true, success: true, needsManualReview: true })

    const result = await service.reconcilePayment(ORDER_ID, SHOP_A)

    expect(result.needsManualReview).toBe(true)
    expect(result.message).toMatch(/manual review/i)
  })
})

describe('AdminOrdersService.bulkReconcilePayments', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports each order independently — one failure does not abort the batch', async () => {
    const repository = {
      findById: vi.fn(async (id) => (id === 'order-good'
        ? { id: 'order-good', shop_id: SHOP_A, status: 'ORDER_PLACED' }
        : null)),
      getOrderPayment: vi.fn(async () => ({ razorpay_order_id: 'rzp_x' })),
    }
    const service = new AdminOrdersService(repository, null)
    reconcileWithRazorpayMock.mockResolvedValue({ captured: false })

    const results = await service.bulkReconcilePayments(['order-good', 'order-missing'], null)

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ orderId: 'order-good', captured: false })
    expect(results[1]).toMatchObject({ orderId: 'order-missing', captured: false, error: expect.stringContaining('not found') })
  })

  it('refuses more than 50 orders in one call', async () => {
    const service = new AdminOrdersService({ findById: vi.fn() }, null)
    const ids = Array.from({ length: 51 }, (_, i) => `order-${i}`)
    await expect(service.bulkReconcilePayments(ids, null)).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('AdminOrdersService.getRazorpayDetails', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns only mapped fields Razorpay actually supplied — never fabricates missing gateway metadata', async () => {
    const { service } = makeService({ payment: { razorpay_payment_id: 'rzp_pay_1' } })
    razorpayFetchMock.mockResolvedValue({
      id: 'rzp_pay_1',
      status: 'captured',
      method: 'upi',
      amount: 21000,
      currency: 'INR',
      vpa: 'user@okhdfcbank',
      created_at: 1790000000,
    })

    const result = await service.getRazorpayDetails(ORDER_ID, SHOP_A)

    expect(result.amount).toBe(210)
    expect(result.vpa).toBe('user@okhdfcbank')
    expect(result.bank).toBeNull()
    expect(result.card).toBeNull()
    expect(result.createdAt).toBe(new Date(1790000000 * 1000).toISOString())
  })

  it('throws 404 when the order has no razorpay_payment_id at all', async () => {
    const { service } = makeService({ payment: null })
    await expect(service.getRazorpayDetails(ORDER_ID, SHOP_A)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('never leaks Razorpay credentials — the config module is imported for the client, not exposed on the response', async () => {
    const { service } = makeService({ payment: { razorpay_payment_id: 'rzp_pay_2' } })
    razorpayFetchMock.mockResolvedValue({ id: 'rzp_pay_2', status: 'captured' })

    const result = await service.getRazorpayDetails(ORDER_ID, SHOP_A)

    expect(JSON.stringify(result)).not.toMatch(/key_secret|RAZORPAY_KEY_SECRET/i)
  })
})
