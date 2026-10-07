import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: vi.fn(),
  getClient: vi.fn(async () => mockClient),
  closePool: vi.fn(),
}))
vi.mock('../../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn() },
  orderQueue: { add: vi.fn() },
  smsQueue: { add: vi.fn() },
  themeQueue: { add: vi.fn() },
  allocationQueue: { add: vi.fn() },
  settlementQueue: { add: vi.fn() },
  payoutQueue: { add: vi.fn() },
  stockNotificationsQueue: { add: vi.fn() },
  scheduledOrdersQueue: { add: vi.fn() },
  reportPrecomputeQueue: { add: vi.fn() },
}))
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const mockClient = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() }

import { OrdersService } from '../../../src/modules/orders/orders.service.js'

function makeService({ order } = {}) {
  const repository = {
    findByIdAndUser: vi.fn(async () => order),
    getActiveOrder: vi.fn(async () => order ?? null),
    getOrderItems: vi.fn(async () => []),
    logStatusTransition: vi.fn(async () => ({})),
  }
  const shopProductsRepository = {
    restoreStockForCancelledOrder: vi.fn(async () => ({ restoredCount: 1, failedItems: [] })),
  }
  const service = new OrdersService(repository, null, { shopProductsRepository })
  return { service, repository, shopProductsRepository }
}

describe('OrdersService.cancelOrder', () => {
  beforeEach(() => {
    mockClient.query.mockClear()
  })

  it('cancels a not-yet-paid order and restores its stock', async () => {
    const { service, repository, shopProductsRepository } = makeService({
      order: { id: 'order-1', status: 'ORDER_PLACED', paymentStatus: 'PENDING' },
    })
    const result = await service.cancelOrder('cust-1', 'order-1', 'Payment cancelled by user')

    expect(result.paymentConfirmed).toBe(false)
    expect(shopProductsRepository.restoreStockForCancelledOrder).toHaveBeenCalled()
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'CANCELLED'"), ['order-1']
    )
    expect(repository.logStatusTransition).toHaveBeenCalledWith(
      'order-1', 'ORDER_PLACED', 'CANCELLED', 'cust-1', 'Payment cancelled by user'
    )
  })

  it('refuses to cancel an order the backend already has marked PAID — a captured payment must never be silently orphaned', async () => {
    const { service, shopProductsRepository } = makeService({
      order: { id: 'order-1', status: 'CONFIRMED', paymentStatus: 'PAID' },
    })
    const result = await service.cancelOrder('cust-1', 'order-1', 'user backed out')

    expect(result.paymentConfirmed).toBe(true)
    expect(shopProductsRepository.restoreStockForCancelledOrder).not.toHaveBeenCalled()
  })

  it('a repeat cancel on an already-cancelled order is a harmless no-op, not an error', async () => {
    const { service, shopProductsRepository } = makeService({
      order: { id: 'order-1', status: 'CANCELLED', paymentStatus: 'FAILED' },
    })
    const result = await service.cancelOrder('cust-1', 'order-1', 'retry')

    expect(result.alreadyCancelled).toBe(true)
    expect(shopProductsRepository.restoreStockForCancelledOrder).not.toHaveBeenCalled()
  })

  it('404s for an order that does not belong to this customer', async () => {
    const { service } = makeService({ order: null })
    await expect(service.cancelOrder('cust-1', 'order-1', null)).rejects.toThrow('Order not found')
  })
})

describe('OrdersService.getActiveOrder', () => {
  it('returns the in-progress order for the "track your order" banner', async () => {
    const { service, repository } = makeService({ order: { id: 'order-1', status: 'CONFIRMED' } })
    const result = await service.getActiveOrder('cust-1')
    expect(result.id).toBe('order-1')
    expect(repository.getActiveOrder).toHaveBeenCalledWith('cust-1')
  })

  it('returns null (not a thrown error) when nothing is active — was previously a 500 from /orders/:orderId matching the literal string "active"', async () => {
    const { service } = makeService({ order: null })
    const result = await service.getActiveOrder('cust-1')
    expect(result).toBeNull()
  })
})
