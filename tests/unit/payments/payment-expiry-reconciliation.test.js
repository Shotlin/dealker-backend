import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression coverage for the payment-expiry worker's reconciliation
 * safety net (CLAUDE.md: "a payment timeout must NOT blindly declare an
 * order failed/expired/cancelled without checking Razorpay first").
 * Previously `_processExpiredPayments` went straight to cancel+restock for
 * every PENDING-past-expiry candidate with no Razorpay check at all.
 */

const mockClient = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() }
const queryMock = vi.fn(async () => ({ rows: [] }))

vi.mock('../../../src/config/database.js', () => ({
  query: (...args) => queryMock(...args),
  getClient: vi.fn(async () => mockClient),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const reconcileWithRazorpayMock = vi.fn()
vi.mock('../../../src/modules/payments/payments.service.js', () => ({
  PaymentsService: vi.fn().mockImplementation(() => ({
    reconcileWithRazorpay: reconcileWithRazorpayMock,
  })),
}))
vi.mock('../../../src/modules/payments/payments.repository.js', () => ({
  PaymentsRepository: vi.fn().mockImplementation(() => ({})),
}))

describe('payment-expiry.worker reconciliation safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClient.query.mockResolvedValue({ rows: [] })
    queryMock.mockResolvedValue({ rows: [] })
  })

  it('finalizes instead of cancelling when Razorpay shows a captured payment', async () => {
    vi.doMock('../../../src/config/razorpay.js', () => ({ razorpay: {} }))
    const { _processOneExpiredPaymentForTest } = await importWorker()

    reconcileWithRazorpayMock.mockResolvedValue({ captured: true, success: true })

    await _processOneExpiredPaymentForTest({
      paymentId: 'pay-1',
      orderId: 'order-1',
      razorpayOrderId: 'rzp_order_1',
      isLegacy: false,
    })

    expect(reconcileWithRazorpayMock).toHaveBeenCalledWith('rzp_order_1', 'PAYMENT_EXPIRY_RECONCILE')
    // No cancel/restock transaction should have started.
    expect(mockClient.query).not.toHaveBeenCalledWith('BEGIN')
  })

  it('fails SAFE (does not cancel) when the Razorpay check itself throws', async () => {
    vi.doMock('../../../src/config/razorpay.js', () => ({ razorpay: {} }))
    const { _processOneExpiredPaymentForTest } = await importWorker()

    reconcileWithRazorpayMock.mockRejectedValue(new Error('Razorpay API timeout'))

    await _processOneExpiredPaymentForTest({
      paymentId: 'pay-2',
      orderId: 'order-2',
      razorpayOrderId: 'rzp_order_2',
      isLegacy: false,
    })

    expect(reconcileWithRazorpayMock).toHaveBeenCalled()
    // A failed reconciliation check must never fall through to cancelling.
    expect(mockClient.query).not.toHaveBeenCalledWith('BEGIN')
  })

  it('cancels and restores stock once Razorpay confirms nothing was captured', async () => {
    vi.doMock('../../../src/config/razorpay.js', () => ({ razorpay: {} }))
    const { _processOneExpiredPaymentForTest } = await importWorker()

    reconcileWithRazorpayMock.mockResolvedValue({ captured: false })
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT id, status, payment_status, items FROM orders')) {
        return { rows: [{ id: 'order-3', status: 'PENDING', payment_status: 'PENDING', items: [] }] }
      }
      return { rows: [] }
    })

    await _processOneExpiredPaymentForTest({
      paymentId: 'pay-3',
      orderId: 'order-3',
      razorpayOrderId: 'rzp_order_3',
      isLegacy: false,
    })

    expect(reconcileWithRazorpayMock).toHaveBeenCalled()
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN')
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT')
  })

  it('skips the Razorpay check entirely for a legacy candidate with no razorpay_order_id', async () => {
    vi.doMock('../../../src/config/razorpay.js', () => ({ razorpay: {} }))
    const { _processOneExpiredPaymentForTest } = await importWorker()

    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT id, status, payment_status, items FROM orders')) {
        return { rows: [{ id: 'order-4', status: 'PENDING', payment_status: 'PENDING', items: [] }] }
      }
      return { rows: [] }
    })

    await _processOneExpiredPaymentForTest({
      paymentId: null,
      orderId: 'order-4',
      razorpayOrderId: null,
      isLegacy: true,
    })

    expect(reconcileWithRazorpayMock).not.toHaveBeenCalled()
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN')
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT')
  })
})

async function importWorker() {
  vi.resetModules()
  const mod = await import('../../../src/workers/payment-expiry.worker.js')
  return { _processOneExpiredPaymentForTest: mod.__test__processOneExpiredPayment }
}
