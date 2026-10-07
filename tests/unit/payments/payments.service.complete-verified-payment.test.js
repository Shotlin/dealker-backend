import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression coverage for `PaymentsService#completeVerifiedPayment` — the
 * ONE centralized, idempotent payment-finalization path that
 * `verifyPayment()` (client callback) and `handleWebhook()`'s
 * payment.authorized/order.paid/payment.captured cases both now route
 * through, replacing what used to be two independently-drifting copies of
 * the same ~10-step confirmation cascade.
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
  orderQueue: { add: vi.fn(async () => {}) },
}))
vi.mock('../../../src/config/razorpay.js', () => ({
  razorpay: null,
  getRazorpayKeyId: () => undefined,
  getRazorpayKeySecret: () => undefined,
  getRazorpayWebhookSecret: () => undefined,
  getRazorpayMode: () => null,
  refreshRazorpayClient: vi.fn(),
}))

// Dynamic-import side effect modules used by the post-commit cascade —
// stubbed so the cascade runs without touching real DB/queue code, while
// still letting us assert it actually ran (or didn't).
const clearCartMock = vi.fn(async () => {})
const clearExtrasMock = vi.fn(async () => {})
vi.mock('../../../src/modules/cart/cart.repository.js', () => ({
  CartRepository: vi.fn().mockImplementation(() => ({
    clearCart: clearCartMock,
    clearExtras: clearExtrasMock,
  })),
}))

const recordUsageForOrderMock = vi.fn(async () => {})
vi.mock('../../../src/modules/coupons/coupons.service.js', () => ({
  CouponsService: vi.fn().mockImplementation(() => ({
    recordUsageForOrder: recordUsageForOrderMock,
  })),
}))
vi.mock('../../../src/modules/coupons/coupons.repository.js', () => ({
  CouponsRepository: vi.fn().mockImplementation(() => ({})),
}))

const sendNotificationMock = vi.fn(async () => {})
vi.mock('../../../src/modules/notifications/notifications.service.js', () => ({
  NotificationsService: vi.fn().mockImplementation(() => ({
    sendNotification: sendNotificationMock,
  })),
}))
vi.mock('../../../src/modules/notifications/notifications.repository.js', () => ({
  NotificationsRepository: vi.fn().mockImplementation(() => ({})),
}))
vi.mock('../../../src/modules/notifications/customer-order-event.helper.js', () => ({
  buildCustomerOrderEventNotification: vi.fn((x) => x),
}))

import { PaymentsService } from '../../../src/modules/payments/payments.service.js'

function makeService({ payment, order, claimWalletDebitResult = null } = {}) {
  const repo = {
    findByRazorpayOrderIdForUpdate: vi.fn(async () => payment),
    updatePayment: vi.fn(async (id, data) => ({ ...payment, ...data, id })),
  }
  const ordersRepo = {
    findByIdForUpdate: vi.fn(async () => order),
    updateStatus: vi.fn(async () => ({})),
    claimWalletDebit: vi.fn(async () => claimWalletDebitResult),
  }
  const cashbackService = { evaluateAndCredit: vi.fn(async () => {}) }
  const fastify = { emitDashboardNewOrder: vi.fn(), emitDashboardPayment: vi.fn() }

  const service = new PaymentsService(repo, fastify)
  service.ordersRepo = ordersRepo
  service.cashbackService = cashbackService

  return { service, repo, ordersRepo, cashbackService, fastify }
}

describe('PaymentsService.completeVerifiedPayment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClient.query.mockResolvedValue({ rows: [] })
  })

  it('finalizes a normal payment: marks PAID, confirms the order, and runs the full cascade', async () => {
    const payment = { id: 'pay-1', orderId: 'order-1', userId: 'user-1', status: 'PENDING', amount: 210 }
    const order = { id: 'order-1', status: 'ORDER_PLACED', order_number: 'FC-KOL-1', total_payable: 210, delivery_mode: 'ASAP', created_at: new Date() }
    const { service, repo, ordersRepo } = makeService({ payment, order })

    const result = await service.completeVerifiedPayment('rzp_order_1', {
      razorpayPaymentId: 'rzp_pay_1',
      source: 'PAYMENT_VERIFY',
    })

    expect(result.success).toBe(true)
    expect(repo.updatePayment).toHaveBeenCalledWith(
      'pay-1',
      expect.objectContaining({ status: 'PAID', razorpayPaymentId: 'rzp_pay_1' }),
      mockClient
    )
    expect(ordersRepo.updateStatus).toHaveBeenCalledWith('order-1', 'CONFIRMED', { paymentStatus: 'PAID' }, mockClient)
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT')
    expect(clearCartMock).toHaveBeenCalledWith('user-1')
    expect(recordUsageForOrderMock).toHaveBeenCalledWith('order-1')
    expect(sendNotificationMock).toHaveBeenCalled()
  })

  it('is idempotent — a payment already PAID short-circuits with no cascade (duplicate webhook / racing verify)', async () => {
    const payment = { id: 'pay-2', orderId: 'order-2', userId: 'user-2', status: 'PAID', amount: 100 }
    const { service, repo, ordersRepo } = makeService({ payment, order: null })

    const result = await service.completeVerifiedPayment('rzp_order_2', { razorpayPaymentId: 'rzp_pay_2' })

    expect(result).toEqual({ success: true, skipped: true, payment })
    expect(repo.updatePayment).not.toHaveBeenCalled()
    expect(ordersRepo.updateStatus).not.toHaveBeenCalled()
    expect(clearCartMock).not.toHaveBeenCalled()
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('flags needs_manual_review and skips the whole cascade when the order already moved on (cancelled, stock restored)', async () => {
    const payment = { id: 'pay-3', orderId: 'order-3', userId: 'user-3', status: 'PENDING', amount: 300 }
    const order = { id: 'order-3', status: 'CANCELLED', order_number: 'FC-KOL-3' }
    const { service, repo, ordersRepo, fastify } = makeService({ payment, order })

    const result = await service.completeVerifiedPayment('rzp_order_3', { razorpayPaymentId: 'rzp_pay_3' })

    expect(result.success).toBe(true)
    expect(result.needsManualReview).toBe(true)
    expect(repo.updatePayment).toHaveBeenCalledWith(
      'pay-3',
      expect.objectContaining({ status: 'PAID', needsManualReview: true, reviewReason: 'captured_after_order_moved_on' }),
      mockClient
    )
    // The order's own status must NOT be touched — it stays CANCELLED,
    // never silently resurrected to CONFIRMED.
    expect(ordersRepo.updateStatus).not.toHaveBeenCalled()
    expect(clearCartMock).not.toHaveBeenCalled()
    expect(recordUsageForOrderMock).not.toHaveBeenCalled()
    expect(fastify.emitDashboardPayment).toHaveBeenCalledWith(
      expect.objectContaining({ needsManualReview: true, orderId: 'order-3' })
    )
  })

  it('refuses to resurrect a FAILED payment unless allowRecoveryFromFailed is explicitly true', async () => {
    const payment = { id: 'pay-4', orderId: 'order-4', userId: 'user-4', status: 'FAILED', amount: 150 }
    const { service, repo } = makeService({ payment, order: null })

    const result = await service.completeVerifiedPayment('rzp_order_4', { razorpayPaymentId: 'rzp_pay_4' })

    expect(result.success).toBe(false)
    expect(repo.updatePayment).not.toHaveBeenCalled()
  })

  it('recovers a FAILED payment when allowRecoveryFromFailed is true and the order is still confirmable', async () => {
    const payment = { id: 'pay-5', orderId: 'order-5', userId: 'user-5', status: 'FAILED', amount: 150 }
    const order = { id: 'order-5', status: 'ORDER_PLACED', order_number: 'FC-KOL-5', total_payable: 150, created_at: new Date() }
    const { service, repo, ordersRepo } = makeService({ payment, order })

    const result = await service.completeVerifiedPayment('rzp_order_5', {
      razorpayPaymentId: 'rzp_pay_5',
      allowRecoveryFromFailed: true,
    })

    expect(result.success).toBe(true)
    expect(repo.updatePayment).toHaveBeenCalledWith(
      'pay-5',
      expect.objectContaining({ status: 'PAID', recoveredFromFailed: true }),
      mockClient
    )
    expect(ordersRepo.updateStatus).toHaveBeenCalledWith('order-5', 'CONFIRMED', { paymentStatus: 'PAID' }, mockClient)
  })

  it('rolls back and reports failure if the DB transaction itself throws', async () => {
    const payment = { id: 'pay-6', orderId: 'order-6', userId: 'user-6', status: 'PENDING', amount: 100 }
    const order = { id: 'order-6', status: 'ORDER_PLACED' }
    const { service, repo } = makeService({ payment, order })
    repo.updatePayment.mockRejectedValueOnce(new Error('db exploded'))

    const result = await service.completeVerifiedPayment('rzp_order_6', { razorpayPaymentId: 'x' })

    expect(result.success).toBe(false)
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK')
  })
})
