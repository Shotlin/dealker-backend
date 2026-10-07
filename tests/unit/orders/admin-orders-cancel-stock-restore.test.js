import { describe, expect, it, vi, beforeEach } from 'vitest'

// Regression coverage for a real bug found investigating order
// BKLOO-20260718-005: cancelling it after its shop_product listing had
// already been deleted meant stock restoration failed internally
// (applyStockChange excludes soft-deleted rows), but the failure was only
// ever logged server-side — the admin who cancelled the order saw a plain
// "Order cancelled" success with no indication inventory wasn't restored.

const fakeClientQuery = vi.fn().mockResolvedValue({ rows: [] })
const fakeClient = { query: fakeClientQuery, release: vi.fn() }
const getClientMock = vi.fn().mockResolvedValue(fakeClient)

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: vi.fn(async () => ({ rows: [] })),
  getClient: (...args) => getClientMock(...args),
  closePool: vi.fn(),
}))

vi.mock('../../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn() },
  orderQueue: { add: vi.fn() },
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../../src/modules/notifications/notifications.service.js', () => ({
  NotificationsService: vi.fn().mockImplementation(() => ({
    sendNotification: vi.fn().mockResolvedValue({}),
  })),
}))
vi.mock('../../../src/modules/notifications/notifications.repository.js', () => ({
  NotificationsRepository: vi.fn().mockImplementation(() => ({})),
}))

const restoreStockForCancelledOrderMock = vi.fn()
const invalidateShopCacheMock = vi.fn().mockResolvedValue(undefined)
vi.mock('../../../src/modules/shop-products/shop-products.repository.js', () => ({
  ShopProductsRepository: vi.fn().mockImplementation(() => ({
    restoreStockForCancelledOrder: (...args) => restoreStockForCancelledOrderMock(...args),
  })),
}))
vi.mock('../../../src/modules/shop-products/shop-products.service.js', () => ({
  ShopProductsService: vi.fn().mockImplementation(() => ({
    invalidateShopCache: invalidateShopCacheMock,
  })),
}))

const { AdminOrdersService } = await import(
  '../../../src/modules/admin/orders/orders.service.js'
)

const ORDER_ID = '33333333-3333-3333-3333-333333333333'
const USER_ID = '44444444-4444-4444-4444-444444444444'
const ADMIN_ID = '55555555-5555-5555-5555-555555555555'
const SHOP_ID = '77777777-7777-7777-7777-777777777777'

function makeOrder(overrides = {}) {
  return {
    id: ORDER_ID,
    order_number: 'BKLOO-20260718-005',
    user_id: USER_ID,
    shop_id: SHOP_ID,
    status: 'CONFIRMED',
    payment_status: 'PENDING',
    total_amount: '196.00',
    ...overrides,
  }
}

function makeService(order) {
  const repository = {
    findById: vi.fn(async () => order),
    getOrderItems: vi.fn(async () => [{ shopProductId: 'sp-500', quantity: 1, name: 'Sumul Malai Peda' }]),
    getOrderPayment: vi.fn(async () => null),
    updateStatus: vi.fn(async () => order.status),
  }
  const service = new AdminOrdersService(repository, {})
  return { service, repository }
}

beforeEach(() => {
  vi.clearAllMocks()
  getClientMock.mockResolvedValue(fakeClient)
  fakeClientQuery.mockResolvedValue({ rows: [] })
})

describe('AdminOrdersService.cancelOrder — stock restore result surfaced', () => {
  it('includes no stockRestoreWarning when every line restores successfully', async () => {
    restoreStockForCancelledOrderMock.mockResolvedValue({ restoredCount: 1, failedItems: [] })
    const { service } = makeService(makeOrder())

    const result = await service.cancelOrder(ORDER_ID, { reason: 'Out of stock' }, ADMIN_ID, '127.0.0.1')

    expect(result.stockRestoreWarning).toBeUndefined()
  })

  it('includes stockRestoreWarning naming the affected product when a line fails to restore', async () => {
    restoreStockForCancelledOrderMock.mockResolvedValue({
      restoredCount: 0,
      failedItems: [{ shopProductId: 'sp-500', productName: 'Sumul Malai Peda', reason: 'Shop product not found' }],
    })
    const { service } = makeService(makeOrder())

    const result = await service.cancelOrder(ORDER_ID, { reason: 'Out of stock' }, ADMIN_ID, '127.0.0.1')

    expect(result.status).toBe('CANCELLED')
    expect(result.stockRestoreWarning).toMatch(/Sumul Malai Peda/)
  })

  it('still returns a warning (not a thrown error) when the whole restore transaction fails', async () => {
    getClientMock.mockResolvedValueOnce(undefined) // client.query on undefined throws inside _restoreStockForCancellation
    const { service } = makeService(makeOrder())

    const result = await service.cancelOrder(ORDER_ID, { reason: 'Out of stock' }, ADMIN_ID, '127.0.0.1')

    expect(result.status).toBe('CANCELLED')
    expect(result.stockRestoreWarning).toBeTruthy()
  })
})
