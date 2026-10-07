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

import { AdminOrdersService } from '../../../src/modules/admin/orders/orders.service.js'

/**
 * Regression: a real, live order's `orders.status` is `ORDER_PLACED`
 * immediately after checkout (orders.service.js#placeOrder writes that
 * literal value — not 'PENDING', a different status vocabulary used
 * elsewhere). This admin module's own `ALLOWED_TRANSITIONS` state machine
 * had no `ORDER_PLACED` key at all, so `updateStatus`/`bulkUpdateStatus`
 * unconditionally rejected every freshly-placed order with "Cannot
 * transition from ORDER_PLACED to CONFIRMED" — the exact disease already
 * documented for `shop-orders/service.js`'s own transitions map.
 */
describe('AdminOrdersService.updateStatus — ORDER_PLACED is a real, transitionable status', () => {
  beforeEach(() => vi.clearAllMocks())

  it('allows ORDER_PLACED -> CONFIRMED', async () => {
    const repository = {
      findById: vi.fn(async () => ({ id: 'order-1', shop_id: null, status: 'ORDER_PLACED', order_number: 'FC-1', customer_id: 'cust-1', rider_id: null })),
      updateStatus: vi.fn(async () => 'ORDER_PLACED'),
    }
    const service = new AdminOrdersService(repository, null)

    const result = await service.updateStatus('order-1', 'CONFIRMED', 'admin-1', null, '127.0.0.1')

    expect(result).toMatchObject({ oldStatus: 'ORDER_PLACED', newStatus: 'CONFIRMED' })
    expect(repository.updateStatus).toHaveBeenCalledWith('order-1', 'CONFIRMED', 'admin-1', null)
  })

  it('allows ORDER_PLACED -> CANCELLED', async () => {
    const repository = {
      findById: vi.fn(async () => ({ id: 'order-2', shop_id: null, status: 'ORDER_PLACED', order_number: 'FC-2', customer_id: 'cust-1', rider_id: null })),
      updateStatus: vi.fn(async () => 'ORDER_PLACED'),
    }
    const service = new AdminOrdersService(repository, null)

    const result = await service.updateStatus('order-2', 'CANCELLED', 'admin-1', null, '127.0.0.1')
    expect(result.newStatus).toBe('CANCELLED')
  })

  it('still refuses an invalid transition (ORDER_PLACED -> DELIVERED, skipping the whole pipeline)', async () => {
    const repository = {
      findById: vi.fn(async () => ({ id: 'order-3', shop_id: null, status: 'ORDER_PLACED', order_number: 'FC-3' })),
      updateStatus: vi.fn(),
    }
    const service = new AdminOrdersService(repository, null)

    await expect(service.updateStatus('order-3', 'DELIVERED', 'admin-1', null, '127.0.0.1')).rejects.toMatchObject({ statusCode: 400 })
    expect(repository.updateStatus).not.toHaveBeenCalled()
  })
})
