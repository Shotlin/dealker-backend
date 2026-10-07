import { describe, expect, it, vi } from 'vitest'

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

const { AdminOrdersService } = await import(
  '../../../src/modules/admin/orders/orders.service.js'
)
const { notificationQueue } = await import('../../../src/config/bullmq.js')

/**
 * Coverage for AdminOrdersService.rescheduleDelivery (delivery scheduling
 * feature, Phase 2, 2026-07-04) — the mistake-correction admin action
 * (e.g. store closed unexpectedly, existing pending orders need their
 * promised slot pushed). Not a status transition, so it has its own
 * terminal-state guard rather than reusing ALLOWED_TRANSITIONS.
 */

const ORDER_ID = '33333333-3333-3333-3333-333333333333'
const USER_ID = '44444444-4444-4444-4444-444444444444'
const ADMIN_ID = '55555555-5555-5555-5555-555555555555'

function makeOrder(overrides = {}) {
  return {
    id: ORDER_ID,
    order_number: 'GRO-TEST-002',
    user_id: USER_ID,
    rider_id: null,
    status: 'CONFIRMED',
    delivery_mode: 'ASAP',
    scheduled_slot_start: null,
    scheduled_slot_end: null,
    scheduled_slot_label: null,
    ...overrides,
  }
}

function makeService({ order, rescheduled = order }) {
  const repository = {
    findById: vi.fn(async () => order),
    rescheduleDelivery: vi.fn(async () => rescheduled),
  }
  const service = new AdminOrdersService(repository, null)
  return { service, repository }
}

const PAYLOAD = {
  scheduledSlotStart: '2026-07-06T14:00:00.000Z',
  scheduledSlotEnd: '2026-07-06T16:00:00.000Z',
  scheduledSlotLabel: 'Today, 2:00 PM – 4:00 PM',
  reason: 'Store closed unexpectedly',
}

describe('AdminOrdersService.rescheduleDelivery (positive)', () => {
  it('reschedules a PENDING/CONFIRMED/PREPARING/PACKED order and logs the reason', async () => {
    const { service, repository } = makeService({ order: makeOrder({ status: 'CONFIRMED' }) })

    const result = await service.rescheduleDelivery(ORDER_ID, PAYLOAD, ADMIN_ID, '127.0.0.1')

    expect(repository.rescheduleDelivery).toHaveBeenCalledWith(ORDER_ID, {
      scheduledSlotStart: PAYLOAD.scheduledSlotStart,
      scheduledSlotEnd: PAYLOAD.scheduledSlotEnd,
      scheduledSlotLabel: PAYLOAD.scheduledSlotLabel,
    })
    expect(result).toBeDefined()
  })

  it('queues an order-rescheduled notification for the customer', async () => {
    notificationQueue.add.mockClear()
    const { service } = makeService({ order: makeOrder({ status: 'PENDING' }) })

    await service.rescheduleDelivery(ORDER_ID, PAYLOAD, ADMIN_ID, '127.0.0.1')

    expect(notificationQueue.add).toHaveBeenCalledWith(
      'order-rescheduled',
      expect.objectContaining({ orderId: ORDER_ID, userId: USER_ID })
    )
  })
})

describe('AdminOrdersService.rescheduleDelivery (negative — terminal-state guard)', () => {
  it.each(['OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'REFUNDED'])(
    'rejects rescheduling a %s order',
    async (status) => {
      const { service, repository } = makeService({ order: makeOrder({ status }) })

      await expect(
        service.rescheduleDelivery(ORDER_ID, PAYLOAD, ADMIN_ID, '127.0.0.1')
      ).rejects.toMatchObject({ statusCode: 400 })
      expect(repository.rescheduleDelivery).not.toHaveBeenCalled()
    }
  )

  it('rejects when the order does not exist', async () => {
    const { service } = makeService({ order: null })

    await expect(
      service.rescheduleDelivery(ORDER_ID, PAYLOAD, ADMIN_ID, '127.0.0.1')
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})
