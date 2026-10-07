import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: vi.fn(),
  getClient: vi.fn(),
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

import { OrdersService } from '../../../src/modules/orders/orders.service.js'

/**
 * Regression coverage for `POST /orders/:id/reorder` — previously a hard
 * no-op (`return { orderId, status }`) despite being the backend for the
 * mobile app's "Reorder"/"Buy Again" button (orders_screen.dart,
 * order_detail_screen.dart via ReorderUseCase, which reads
 * `itemCount`/`warnings` from the response and navigates to the cart
 * expecting it to be populated) and the post-cancel cart-restore in
 * checkout_provider.dart/payment_provider.dart. A tap on "Buy Again" always
 * showed the client's canned "Items added to cart" toast while the cart
 * never actually changed. Fixed to walk `order.items` (the JSONB snapshot
 * already on the order row from checkout — no join needed) and add each
 * one through the same `CartService.addItem` a live `/cart/items` call
 * uses, reporting per-item failures as warnings instead of failing the
 * whole reorder.
 */
function makeService({ order, addItemResults } = {}) {
  const repository = {
    findByIdAndUser: vi.fn(async () => order),
  }
  const cartService = {
    addItem: vi.fn(async () => addItemResults.shift() ?? { success: true }),
  }
  const service = new OrdersService(repository, null, { cartService })
  return { service, repository, cartService }
}

describe('OrdersService.reorder', () => {
  it('adds every item from the order back into the cart and reports how many were added', async () => {
    const order = {
      id: 'order-1',
      status: 'DELIVERED',
      items: [
        { productId: 'prod-1', name: 'Chicken Breast', quantity: 2 },
        { productId: 'prod-2', name: 'Mutton Curry Cut', quantity: 1 },
      ],
    }
    const { service, cartService } = makeService({
      order,
      addItemResults: [{ success: true }, { success: true }],
    })

    const result = await service.reorder('cust-1', 'order-1')

    expect(cartService.addItem).toHaveBeenCalledTimes(2)
    expect(cartService.addItem).toHaveBeenNthCalledWith(1, 'cust-1', {
      productId: 'prod-1',
      quantity: 2,
      priceMode: 'retail',
    })
    expect(cartService.addItem).toHaveBeenNthCalledWith(2, 'cust-1', {
      productId: 'prod-2',
      quantity: 1,
      priceMode: 'retail',
    })
    expect(result.itemCount).toBe(2)
    expect(result.warnings).toEqual([])
    expect(result.status).toBe('DELIVERED')
  })

  it('reports a per-item warning instead of failing the whole reorder when one product is now unavailable', async () => {
    const order = {
      id: 'order-1',
      status: 'DELIVERED',
      items: [
        { productId: 'prod-1', name: 'Chicken Breast', quantity: 1 },
        { productId: 'prod-2', name: 'Discontinued Item', quantity: 1 },
      ],
    }
    const { service } = makeService({
      order,
      addItemResults: [
        { success: true },
        { success: false, message: 'This product is currently unavailable', code: 'SHOP_PRODUCT_UNAVAILABLE' },
      ],
    })

    const result = await service.reorder('cust-1', 'order-1')

    expect(result.itemCount).toBe(1)
    expect(result.warnings).toEqual(['Discontinued Item: This product is currently unavailable'])
  })

  it('never touches stock — reorder only adds to the cart, it does not decrement anything', async () => {
    const order = { id: 'order-1', status: 'CANCELLED', items: [{ productId: 'prod-1', quantity: 1 }] }
    const { service, cartService } = makeService({ order, addItemResults: [{ success: true }] })

    await service.reorder('cust-1', 'order-1')

    for (const call of cartService.addItem.mock.calls) {
      expect(call[1]).not.toHaveProperty('delta')
    }
  })

  it('throws ORDER_NOT_FOUND for another customer\'s order id, exactly as before', async () => {
    const { service } = makeService({ order: null, addItemResults: [] })

    await expect(service.reorder('cust-1', 'not-mine')).rejects.toMatchObject({
      statusCode: 404,
      code: 'ORDER_NOT_FOUND',
    })
  })

  it('is a no-op with itemCount 0 for an order with no items array', async () => {
    const order = { id: 'order-1', status: 'DELIVERED', items: null }
    const { service, cartService } = makeService({ order, addItemResults: [] })

    const result = await service.reorder('cust-1', 'order-1')

    expect(cartService.addItem).not.toHaveBeenCalled()
    expect(result.itemCount).toBe(0)
    expect(result.warnings).toEqual([])
  })
})
