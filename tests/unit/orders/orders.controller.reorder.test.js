import { describe, expect, it, vi } from 'vitest'

import { OrdersController } from '../../../src/modules/orders/orders.controller.js'

/**
 * Regression: the mobile client (order_remote_datasource.dart#reorder)
 * reads `itemCount` from the response's `data` object but `warnings` as a
 * SIBLING of `data`, not nested inside it. `OrdersService#reorder` now
 * returns `{ orderId, status, itemCount, warnings }` as one flat object —
 * if the controller just forwarded that whole object as `data` (as it did
 * before this fix), `warnings` would silently never reach the client no
 * matter how many items failed to re-add.
 */
function makeReply() {
  const reply = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    send(body) {
      this.body = body
      return this
    },
  }
  return reply
}

describe('OrdersController.reorder', () => {
  it('places warnings as a top-level sibling of data, not nested inside it', async () => {
    const service = {
      reorder: vi.fn(async () => ({
        orderId: 'order-1',
        status: 'DELIVERED',
        itemCount: 1,
        warnings: ['Discontinued Item: This product is currently unavailable'],
      })),
    }
    const controller = new OrdersController(service)
    const reply = makeReply()

    await controller.reorder(
      { userId: 'cust-1', user: { id: 'cust-1' }, params: { orderId: 'order-1' } },
      reply
    )

    expect(reply.statusCode).toBe(200)
    expect(reply.body).toEqual({
      success: true,
      data: { orderId: 'order-1', status: 'DELIVERED', itemCount: 1 },
      warnings: ['Discontinued Item: This product is currently unavailable'],
    })
    expect(reply.body.data).not.toHaveProperty('warnings')
  })

  it('sends an empty warnings array when nothing failed', async () => {
    const service = {
      reorder: vi.fn(async () => ({
        orderId: 'order-1',
        status: 'DELIVERED',
        itemCount: 2,
        warnings: [],
      })),
    }
    const controller = new OrdersController(service)
    const reply = makeReply()

    await controller.reorder(
      { userId: 'cust-1', user: { id: 'cust-1' }, params: { orderId: 'order-1' } },
      reply
    )

    expect(reply.body.warnings).toEqual([])
    expect(reply.body.data.itemCount).toBe(2)
  })
})
