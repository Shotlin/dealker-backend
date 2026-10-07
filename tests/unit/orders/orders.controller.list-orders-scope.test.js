import { describe, expect, it, vi } from 'vitest'

import { OrdersController } from '../../../src/modules/orders/orders.controller.js'

/**
 * Security regression: `GET /api/v1/orders` (the customer "My Orders"
 * self-service endpoint — no role/permission gate beyond `authenticate`)
 * used to scope `customerId` on `req.user?.platform_role === 'CUSTOMER'`.
 * A real customer JWT never carries a `platform_role` claim (that field
 * only exists on HQ/admin tokens — `plugins/auth.plugin.js` computes it as
 * a local variable and never writes it back onto `request.user`), so that
 * check was always false. `customerId` then fell through to the
 * client-supplied `req.query.customer_id`, or `null` if that was absent —
 * which the real mobile app never sends, meaning every real call returned
 * every order in the entire database, unfiltered, to any authenticated
 * caller. Fixed to always scope to the authenticated caller's own id,
 * ignoring the request entirely for whose orders these are.
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

describe('OrdersController.listOrders', () => {
  it('scopes to the authenticated caller, ignoring a spoofed ?customer_id query param', async () => {
    const service = { listOrders: vi.fn(async () => []) }
    const controller = new OrdersController(service)
    const reply = makeReply()

    await controller.listOrders(
      {
        userId: 'cust-1',
        user: { id: 'cust-1' },
        query: { customer_id: 'someone-elses-uuid', status: 'DELIVERED' },
      },
      reply
    )

    expect(service.listOrders).toHaveBeenCalledWith({
      customerId: 'cust-1',
      status: 'DELIVERED',
    })
  })

  it('scopes to the caller even when no query params are sent at all (the real mobile request shape)', async () => {
    const service = { listOrders: vi.fn(async () => []) }
    const controller = new OrdersController(service)
    const reply = makeReply()

    await controller.listOrders(
      { userId: 'cust-2', user: { id: 'cust-2' }, query: {} },
      reply
    )

    expect(service.listOrders).toHaveBeenCalledWith({
      customerId: 'cust-2',
      status: null,
    })
  })
})
