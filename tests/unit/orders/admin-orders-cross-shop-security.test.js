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
vi.mock('../../../src/utils/invoiceGenerator.js', () => ({
  generateInvoicePDF: vi.fn(async () => Buffer.from('pdf')),
  generatePackingSlipPDF: vi.fn(async () => Buffer.from('pdf')),
}))

import { AdminOrdersService } from '../../../src/modules/admin/orders/orders.service.js'

const SHOP_A = 'shop-a-uuid'
const SHOP_B = 'shop-b-uuid'
const ORDER_ID = 'order-1'

/**
 * Security regression: every admin/orders endpoint besides the list
 * (GET /) previously had no shop-scope enforcement at all —
 * `preHandler: adminAuth` with no `requireShopScope()`, and the service
 * methods never checked the fetched order's own `shop_id` against
 * anything. An HQ admin who had deliberately scoped themselves to one
 * shop (via the dashboard's selector / X-Shop-Id header) could still
 * silently view or mutate another shop's order just by knowing its UUID.
 * This suite exercises `AdminOrdersService#_assertShopAccess` through
 * every public method that touches a single order by id, confirming each
 * one now refuses with 403 CROSS_SHOP_ACCESS_DENIED when the order
 * belongs to a different shop than `requestShopId`, and that "All Shops"
 * (`requestShopId` null/undefined) is never restricted.
 */
function makeService(overrides = {}) {
  const order = { id: ORDER_ID, shop_id: SHOP_A, status: 'CONFIRMED', order_number: 'FC-A-0001', customer_id: 'cust-1', ...overrides.order }
  const repository = {
    findById: vi.fn(async () => order),
    getOrderItems: vi.fn(async () => []),
    getOrderTimeline: vi.fn(async () => []),
    getOrderPayment: vi.fn(async () => null),
    getOrderDelivery: vi.fn(async () => null),
    getSettlementHistory: vi.fn(async () => []),
    getOrderNotes: vi.fn(async () => []),
    addOrderNote: vi.fn(async () => ({})),
    updateStatus: vi.fn(async () => 'CONFIRMED'),
    rescheduleDelivery: vi.fn(async () => ({})),
    assignRider: vi.fn(async () => ({})),
    ...overrides.repository,
  }
  const service = new AdminOrdersService(repository, null)
  return { service, repository, order }
}

describe('AdminOrdersService — cross-shop access denial (security)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('findById refuses an order belonging to a different shop', async () => {
    const { service } = makeService()
    await expect(service.findById(ORDER_ID, SHOP_B)).rejects.toMatchObject({
      statusCode: 403,
      code: 'CROSS_SHOP_ACCESS_DENIED',
    })
  })

  it('findById succeeds when the order belongs to the caller\'s own shop', async () => {
    const { service } = makeService()
    await expect(service.findById(ORDER_ID, SHOP_A)).resolves.toMatchObject({ id: ORDER_ID })
  })

  it('findById is never restricted for "All Shops" (requestShopId null)', async () => {
    const { service } = makeService()
    await expect(service.findById(ORDER_ID, null)).resolves.toMatchObject({ id: ORDER_ID })
  })

  it('getOrderNotes refuses a foreign shop\'s order', async () => {
    const { service } = makeService()
    await expect(service.getOrderNotes(ORDER_ID, SHOP_B)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('addOrderNote refuses a foreign shop\'s order', async () => {
    const { service } = makeService()
    await expect(service.addOrderNote(ORDER_ID, 'admin-1', 'note', '127.0.0.1', SHOP_B)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('updateStatus refuses a foreign shop\'s order (and never calls repository.updateStatus)', async () => {
    const { service, repository } = makeService()
    await expect(service.updateStatus(ORDER_ID, 'PREPARING', 'admin-1', null, '127.0.0.1', SHOP_B)).rejects.toMatchObject({ statusCode: 403 })
    expect(repository.updateStatus).not.toHaveBeenCalled()
  })

  it('rescheduleDelivery refuses a foreign shop\'s order', async () => {
    const { service } = makeService({ order: { status: 'CONFIRMED' } })
    await expect(
      service.rescheduleDelivery(ORDER_ID, { scheduledSlotStart: new Date(), scheduledSlotEnd: new Date(), scheduledSlotLabel: 'x' }, 'admin-1', '127.0.0.1', SHOP_B)
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('assignRider refuses a foreign shop\'s order', async () => {
    const { service } = makeService()
    await expect(service.assignRider(ORDER_ID, 'rider-1', 'admin-1', '127.0.0.1', SHOP_B)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('refundOrder refuses a foreign shop\'s order', async () => {
    const { service } = makeService({ order: { status: 'DELIVERED', payment_status: 'PAID' } })
    await expect(
      service.refundOrder(ORDER_ID, { reason: 'x', refundTo: 'wallet' }, 'admin-1', '127.0.0.1', SHOP_B)
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('cancelOrder refuses a foreign shop\'s order', async () => {
    const { service } = makeService({ order: { status: 'CONFIRMED' } })
    await expect(
      service.cancelOrder(ORDER_ID, { reason: 'x' }, 'admin-1', '127.0.0.1', SHOP_B)
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('getInvoice refuses a foreign shop\'s order', async () => {
    const { service } = makeService()
    await expect(service.getInvoice(ORDER_ID, SHOP_B)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('getPackingSlip refuses a foreign shop\'s order', async () => {
    const { service } = makeService()
    await expect(service.getPackingSlip(ORDER_ID, SHOP_B)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('reconcilePayment refuses a foreign shop\'s order', async () => {
    const { service } = makeService()
    await expect(service.reconcilePayment(ORDER_ID, SHOP_B)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('getRazorpayDetails refuses a foreign shop\'s order', async () => {
    const { service } = makeService()
    await expect(service.getRazorpayDetails(ORDER_ID, SHOP_B)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('bulkAssign rejects a batch containing a foreign shop\'s order before mutating anything', async () => {
    const { service, repository } = makeService({
      repository: { bulkAssign: vi.fn(async () => []) },
    })

    await expect(
      service.bulkAssign([{ orderId: ORDER_ID, riderId: 'rider-1' }], 'admin-1', '127.0.0.1', SHOP_B)
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(repository.bulkAssign).not.toHaveBeenCalled()
  })

  it('bulkUpdateStatus reports a per-item 403 instead of throwing for the whole batch', async () => {
    const { service } = makeService()
    const result = await service.bulkUpdateStatus([ORDER_ID], 'PREPARING', 'admin-1', '127.0.0.1', SHOP_B)

    expect(result.updated).toBe(0)
    expect(result.results[0]).toMatchObject({ orderId: ORDER_ID, success: false })
  })
})
