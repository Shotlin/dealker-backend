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

const sendNotificationMock = vi.fn().mockResolvedValue({})
vi.mock('../../../src/modules/notifications/notifications.service.js', () => ({
  NotificationsService: vi.fn().mockImplementation(() => ({
    sendNotification: sendNotificationMock,
  })),
}))
vi.mock('../../../src/modules/notifications/notifications.repository.js', () => ({
  NotificationsRepository: vi.fn().mockImplementation(() => ({})),
}))

const creditWalletMock = vi.fn(async () => ({}))
vi.mock('../../../src/modules/admin/customers/customers.repository.js', () => ({
  AdminCustomersRepository: vi.fn().mockImplementation(() => ({
    creditWallet: creditWalletMock,
  })),
}))

const { AdminOrdersService } = await import(
  '../../../src/modules/admin/orders/orders.service.js'
)

/**
 * Coverage for the customer push/in-app notification wiring in
 * AdminOrdersService (2026-07-04) — previously every admin-driven status
 * change, cancellation, and refund called
 * `notificationQueue.add('order-status-changed', {...})`, but the BullMQ
 * notification worker's switch only handles job.data.type values of
 * 'push' / 'in-app' / 'order-status', and these calls never set a `type`
 * field — so the job silently fell into the "Unknown notification job
 * type" branch and did nothing, for every status this feature has ever
 * existed. This suite locks in the real fix: AdminOrdersService now sends
 * notifications directly via NotificationsService, the same working path
 * already used by the rider-facing delivery flow.
 */

const ORDER_ID = '33333333-3333-3333-3333-333333333333'
const USER_ID = '44444444-4444-4444-4444-444444444444'
const ADMIN_ID = '55555555-5555-5555-5555-555555555555'
const PAYMENT_ID = '66666666-6666-6666-6666-666666666666'

function makeOrder(overrides = {}) {
  return {
    id: ORDER_ID,
    order_number: 'GRO-TEST-001',
    user_id: USER_ID,
    status: 'PACKED',
    payment_status: 'PENDING',
    total_amount: '250.00',
    ...overrides,
  }
}

function makeService({ order, payment = null, fastify = {} }) {
  const repository = {
    findById: vi.fn(async () => order),
    getOrderPayment: vi.fn(async () => payment),
    updateStatus: vi.fn(async () => order.status),
  }
  const service = new AdminOrdersService(repository, fastify)
  return { service, repository }
}

beforeEach(() => {
  sendNotificationMock.mockClear()
  creditWalletMock.mockClear()
})

describe('AdminOrdersService.updateStatus — customer notification', () => {
  it('notifies the customer with an OUT_FOR_DELIVERY-mapped message (positive)', async () => {
    const { service } = makeService({ order: makeOrder({ status: 'PACKED' }) })

    await service.updateStatus(ORDER_ID, 'OUT_FOR_DELIVERY', ADMIN_ID, null, '127.0.0.1')

    expect(sendNotificationMock).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        type: 'ORDER_STATUS',
        data: expect.objectContaining({ timelineType: 'PICKED_UP', status: 'OUT_FOR_DELIVERY' }),
      })
    )
  })

  it('never sends a notification when there is no fastify instance (no socket/notifications context)', async () => {
    const { service } = makeService({ order: makeOrder({ status: 'PACKED' }), fastify: null })

    await service.updateStatus(ORDER_ID, 'OUT_FOR_DELIVERY', ADMIN_ID, null, '127.0.0.1')

    expect(sendNotificationMock).not.toHaveBeenCalled()
  })
})

describe('AdminOrdersService.cancelOrder — customer notification', () => {
  it('notifies CANCELLED for a never-paid order with no follow-up refund notification (positive/negative)', async () => {
    const { service } = makeService({ order: makeOrder({ status: 'CONFIRMED', payment_status: 'PENDING' }) })

    await service.cancelOrder(ORDER_ID, { reason: 'Out of stock', refundTo: 'wallet' }, ADMIN_ID, '127.0.0.1')

    expect(sendNotificationMock).toHaveBeenCalledTimes(1)
    expect(sendNotificationMock).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ data: expect.objectContaining({ timelineType: 'CANCELLED' }) })
    )
  })

  it('sends both a CANCELLED and a refund notification when a paid order is cancelled with a wallet refund (positive)', async () => {
    const order = makeOrder({ status: 'CONFIRMED', payment_status: 'PAID', total_amount: '104.00' })
    const payment = { id: PAYMENT_ID, amount: '104.00', status: 'PAID', razorpay_payment_id: null }
    const { service } = makeService({ order, payment })

    await service.cancelOrder(ORDER_ID, { reason: 'Customer request', refundTo: 'wallet' }, ADMIN_ID, '127.0.0.1')

    expect(sendNotificationMock).toHaveBeenCalledTimes(2)
    expect(sendNotificationMock).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ data: expect.objectContaining({ timelineType: 'CANCELLED' }) })
    )
    expect(sendNotificationMock).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        body: expect.stringContaining('₹104'),
        data: expect.objectContaining({ timelineType: 'REFUNDED', refundAmount: 104, refundTo: 'wallet' }),
      })
    )
  })
})

describe('AdminOrdersService.refundOrder — customer notification', () => {
  it('notifies REFUNDED with the actual refunded amount (positive)', async () => {
    const order = makeOrder({ status: 'DELIVERED', payment_status: 'PAID', total_amount: '250.00' })
    const payment = { id: PAYMENT_ID, amount: '250.00', status: 'PAID', razorpay_payment_id: null }
    const { service } = makeService({ order, payment })

    await service.refundOrder(ORDER_ID, { refundTo: 'wallet' }, ADMIN_ID, '127.0.0.1')

    expect(sendNotificationMock).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        body: expect.stringContaining('₹250'),
        data: expect.objectContaining({ timelineType: 'REFUNDED', refundAmount: 250, refundTo: 'wallet' }),
      })
    )
  })

  it('never notifies when refundTo=none — the call is rejected before any notification is queued', async () => {
    const order = makeOrder({ status: 'DELIVERED', payment_status: 'PAID' })
    const payment = { id: PAYMENT_ID, amount: '250.00', status: 'PAID', razorpay_payment_id: 'pay_abc' }
    const { service } = makeService({ order, payment })

    await expect(
      service.refundOrder(ORDER_ID, { refundTo: 'none' }, ADMIN_ID, '127.0.0.1')
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(sendNotificationMock).not.toHaveBeenCalled()
  })
})

describe('AdminOrdersService — Socket.IO live-sync emit on cancel/refund (2026-07-04)', () => {
  // Reported bug: an admin cancelling/refunding an order was correct in the
  // DB (re-cancelling correctly got rejected by the API) and the push
  // notification fired, but the customer's app kept showing the pre-change
  // status because — unlike updateStatus()/rescheduleDelivery() — neither
  // cancelOrder() nor refundOrder() ever called `fastify.emitOrderUpdate`,
  // the Socket.IO event the mobile app's live-sync listens for to
  // invalidate its cache and refresh the UI immediately.
  function makeServiceWithSocket(order, payment = null) {
    const emitOrderUpdate = vi.fn()
    const repository = {
      findById: vi.fn(async () => order),
      getOrderPayment: vi.fn(async () => payment),
      updateStatus: vi.fn(async () => order.status),
    }
    const service = new AdminOrdersService(repository, { emitOrderUpdate })
    return { service, emitOrderUpdate }
  }

  it('cancelOrder emits order:status with the CANCELLED status (positive)', async () => {
    const order = makeOrder({ status: 'CONFIRMED', payment_status: 'PENDING' })
    const { service, emitOrderUpdate } = makeServiceWithSocket(order)

    await service.cancelOrder(ORDER_ID, { reason: 'Out of stock' }, ADMIN_ID, '127.0.0.1')

    expect(emitOrderUpdate).toHaveBeenCalledWith(
      ORDER_ID,
      [USER_ID],
      expect.objectContaining({ status: 'CANCELLED' })
    )
  })

  it('refundOrder emits order:status with the REFUNDED status (positive)', async () => {
    const order = makeOrder({ status: 'DELIVERED', payment_status: 'PAID', total_amount: '250.00' })
    const payment = { id: PAYMENT_ID, amount: '250.00', status: 'PAID', razorpay_payment_id: null }
    const { service, emitOrderUpdate } = makeServiceWithSocket(order, payment)

    await service.refundOrder(ORDER_ID, { refundTo: 'wallet' }, ADMIN_ID, '127.0.0.1')

    expect(emitOrderUpdate).toHaveBeenCalledWith(
      ORDER_ID,
      [USER_ID],
      expect.objectContaining({ status: 'REFUNDED' })
    )
  })

  it('does not throw when there is no fastify/socket instance (negative)', async () => {
    const order = makeOrder({ status: 'CONFIRMED', payment_status: 'PENDING' })
    const repository = {
      findById: vi.fn(async () => order),
      getOrderPayment: vi.fn(async () => null),
      updateStatus: vi.fn(async () => order.status),
    }
    const service = new AdminOrdersService(repository, null)

    await expect(
      service.cancelOrder(ORDER_ID, { reason: 'Out of stock' }, ADMIN_ID, '127.0.0.1')
    ).resolves.toMatchObject({ status: 'CANCELLED' })
  })
})
