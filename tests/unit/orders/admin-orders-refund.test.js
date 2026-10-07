import { describe, expect, it, vi, beforeEach } from 'vitest'

// `orders.service.js` (admin) transitively imports config/database.js and
// config/bullmq.js — mock both so this unit test needs no live DB/Redis.
vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: vi.fn(async () => ({ rows: [] })),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

vi.mock('../../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn() },
  orderQueue: { add: vi.fn() },
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const creditWalletMock = vi.fn(async () => ({}))
vi.mock('../../../src/modules/admin/customers/customers.repository.js', () => ({
  AdminCustomersRepository: vi.fn().mockImplementation(() => ({
    creditWallet: creditWalletMock,
  })),
}))

const paymentsRefundMock = vi.fn(async () => ({ success: true }))
vi.mock('../../../src/modules/payments/payments.service.js', () => ({
  PaymentsService: vi.fn().mockImplementation(() => ({
    refund: paymentsRefundMock,
  })),
}))
vi.mock('../../../src/modules/payments/payments.repository.js', () => ({
  PaymentsRepository: vi.fn().mockImplementation(() => ({})),
}))

const { AdminOrdersService } = await import(
  '../../../src/modules/admin/orders/orders.service.js'
)

const ORDER_ID = '33333333-3333-3333-3333-333333333333'
const USER_ID = '44444444-4444-4444-4444-444444444444'
const ADMIN_ID = '55555555-5555-5555-5555-555555555555'
const PAYMENT_ID = '66666666-6666-6666-6666-666666666666'

function makeOrder(overrides = {}) {
  return {
    id: ORDER_ID,
    order_number: 'GRO-TEST-001',
    user_id: USER_ID,
    status: 'DELIVERED',
    payment_status: 'PENDING',
    total_amount: '250.00',
    ...overrides,
  }
}

function makeService({ order, payment = null }) {
  const repository = {
    findById: vi.fn(async () => order),
    getOrderPayment: vi.fn(async () => payment),
    updateStatus: vi.fn(async () => order.status),
  }
  const service = new AdminOrdersService(repository, null)
  return { service, repository }
}

beforeEach(() => {
  creditWalletMock.mockClear()
  paymentsRefundMock.mockClear()
})

describe('AdminOrdersService.refundOrder', () => {
  it('rejects a refund when the order was never paid (payment_status !== PAID)', async () => {
    const { service } = makeService({ order: makeOrder({ payment_status: 'PENDING' }) })

    await expect(
      service.refundOrder(ORDER_ID, { refundTo: 'wallet' }, ADMIN_ID, '127.0.0.1')
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(creditWalletMock).not.toHaveBeenCalled()
  })

  it('credits the wallet with exactly the captured payment amount, ignoring any caller-supplied amount', async () => {
    const order = makeOrder({ payment_status: 'PAID', total_amount: '999.00' })
    const payment = { id: PAYMENT_ID, amount: '250.00', status: 'PAID', razorpay_payment_id: null }
    const { service } = makeService({ order, payment })

    // Even though the (legacy) caller tries to pass a bogus `amount`, the
    // schema no longer accepts it and the service never reads it — the
    // refund must equal the actual paid amount (250), never the inflated
    // order total (999) and never an arbitrary admin-typed figure.
    const result = await service.refundOrder(
      ORDER_ID,
      { refundTo: 'wallet', amount: 999999 },
      ADMIN_ID,
      '127.0.0.1'
    )

    expect(creditWalletMock).toHaveBeenCalledWith(USER_ID, 250, expect.any(String))
    expect(result.refundAmount).toBe(250)
  })

  it('rejects refundTo=original when there is no captured gateway payment (e.g. COD)', async () => {
    const order = makeOrder({ payment_status: 'PAID', total_amount: '104.00' })
    const { service } = makeService({ order, payment: null })

    await expect(
      service.refundOrder(ORDER_ID, { refundTo: 'original' }, ADMIN_ID, '127.0.0.1')
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(paymentsRefundMock).not.toHaveBeenCalled()
  })

  it('routes refundTo=original through PaymentsService.refund for a captured Razorpay payment', async () => {
    const order = makeOrder({ payment_status: 'PAID' })
    const payment = { id: PAYMENT_ID, amount: '250.00', status: 'PAID', razorpay_payment_id: 'pay_abc123' }
    const { service } = makeService({ order, payment })

    const result = await service.refundOrder(ORDER_ID, { refundTo: 'original' }, ADMIN_ID, '127.0.0.1')

    expect(paymentsRefundMock).toHaveBeenCalledWith(PAYMENT_ID, expect.objectContaining({ reason: expect.any(String) }))
    expect(creditWalletMock).not.toHaveBeenCalled()
    expect(result.refundAmount).toBe(250)
  })

  it('rejects refundTo=none — this endpoint always moves money, use Cancel Order for a no-refund cancellation', async () => {
    const order = makeOrder({ payment_status: 'PAID' })
    const payment = { id: PAYMENT_ID, amount: '250.00', status: 'PAID', razorpay_payment_id: 'pay_abc123' }
    const { service, repository } = makeService({ order, payment })

    await expect(
      service.refundOrder(ORDER_ID, { refundTo: 'none' }, ADMIN_ID, '127.0.0.1')
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(creditWalletMock).not.toHaveBeenCalled()
    expect(paymentsRefundMock).not.toHaveBeenCalled()
    expect(repository.updateStatus).not.toHaveBeenCalled()
  })
})

describe('AdminOrdersService.cancelOrder', () => {
  it('cancels a never-paid COD order without crediting the wallet even if refundTo=wallet', async () => {
    const order = makeOrder({ status: 'CONFIRMED', payment_status: 'PENDING' })
    const { service, repository } = makeService({ order })

    const result = await service.cancelOrder(
      ORDER_ID,
      { reason: 'Out of stock', refundTo: 'wallet' },
      ADMIN_ID,
      '127.0.0.1'
    )

    expect(creditWalletMock).not.toHaveBeenCalled()
    expect(result.refundAmount).toBe(0)
    expect(result.refundTo).toBe('none')
    expect(repository.updateStatus).toHaveBeenCalledWith(ORDER_ID, 'CANCELLED', ADMIN_ID, expect.any(String))
  })

  it('credits the wallet with the actual paid amount when cancelling a paid order', async () => {
    const order = makeOrder({ status: 'CONFIRMED', payment_status: 'PAID', total_amount: '104.00' })
    const payment = { id: PAYMENT_ID, amount: '104.00', status: 'PAID', razorpay_payment_id: null }
    const { service } = makeService({ order, payment })

    const result = await service.cancelOrder(
      ORDER_ID,
      { reason: 'Customer request', refundTo: 'wallet' },
      ADMIN_ID,
      '127.0.0.1'
    )

    expect(creditWalletMock).toHaveBeenCalledWith(USER_ID, 104, expect.any(String))
    expect(result.refundAmount).toBe(104)
    expect(result.refundTo).toBe('wallet')
  })
})
