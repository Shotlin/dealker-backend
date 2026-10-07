import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Coverage for the 2026-07-03 production incident: Razorpay's own API
 * rejected our account credentials with a 401, and because
 * `razorpay.orders.create()` was awaited uncaught, that 401 propagated
 * through the global error handler (which trusted `error.statusCode`
 * verbatim) and reached the customer looking exactly like their own
 * session had expired — when in fact their session was completely
 * valid. createPaymentOrder must now catch SDK failures and return the
 * module's normal `{ success: false }` shape instead of throwing.
 */

vi.mock('../../../src/config/razorpay.js', () => ({
  razorpay: { orders: { create: vi.fn() } },
  getRazorpayKeyId: () => 'rzp_test_key',
  getRazorpayKeySecret: () => 'test-key-secret',
  getRazorpayWebhookSecret: () => undefined,
  getRazorpayMode: () => 'TEST',
  refreshRazorpayClient: vi.fn(),
}))
vi.mock('../../../src/config/env.js', () => ({
  env: { RAZORPAY_KEY_ID: 'rzp_test_key' },
}))
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../../src/config/bullmq.js', () => ({ orderQueue: { add: vi.fn() } }))
vi.mock('../../../src/modules/orders/orders.repository.js', () => ({
  OrdersRepository: vi.fn().mockImplementation(() => ({
    findByIdAndUser: vi.fn(),
    updateStatus: vi.fn(),
  })),
}))
vi.mock('../../../src/modules/payment-settings/payment-settings.service.js', () => ({
  PaymentSettingsService: vi.fn().mockImplementation(() => ({
    getConfig: vi.fn().mockResolvedValue({ razorpayEnabled: true }),
  })),
}))
vi.mock('../../../src/modules/cashback/cashback.service.js', () => ({
  CashbackService: vi.fn().mockImplementation(() => ({})),
}))

const { PaymentsService } = await import('../../../src/modules/payments/payments.service.js')
const { razorpay } = await import('../../../src/config/razorpay.js')

function service() {
  const repo = {
    findByOrderId: vi.fn(),
    create: vi.fn().mockResolvedValue({ id: 'payment-1' }),
  }
  const svc = new PaymentsService(repo)
  svc.ordersRepo.findByIdAndUser = vi.fn().mockResolvedValue({
    id: 'order-1',
    orderNumber: 'GRO-1',
    paymentMethod: 'ONLINE',
    paymentStatus: 'PENDING',
    totalAmount: 100,
  })
  svc.ordersRepo.updateStatus = vi.fn().mockResolvedValue(undefined)
  repo.findByOrderId.mockResolvedValue(null)
  return svc
}

describe('PaymentsService.createPaymentOrder — Razorpay SDK failure (negative)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns a normal failure result (not a thrown 401) when Razorpay rejects our API credentials', async () => {
    const err = new Error('Authentication failed')
    err.statusCode = 401
    err.error = { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' }
    razorpay.orders.create.mockRejectedValue(err)

    const svc = service()
    const result = await svc.createPaymentOrder('user-1', 'order-1')

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/try again/i)
  })

  it('does not throw — the caller (controller) always receives a resolved promise', async () => {
    const err = new Error('Gateway timeout')
    err.statusCode = 504
    razorpay.orders.create.mockRejectedValue(err)

    const svc = service()
    await expect(svc.createPaymentOrder('user-1', 'order-1')).resolves.toMatchObject({
      success: false,
    })
  })
})

describe('PaymentsService.createPaymentOrder — happy path (positive, regression guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('still returns success with Razorpay order data when the SDK call succeeds', async () => {
    razorpay.orders.create.mockResolvedValue({ id: 'order_rzp_1' })
    const svc = service()

    const result = await svc.createPaymentOrder('user-1', 'order-1')

    expect(result.success).toBe(true)
    expect(result.data.razorpayOrderId).toBe('order_rzp_1')
  })
})
