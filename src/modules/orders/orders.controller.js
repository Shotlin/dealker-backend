/**
 * Orders Controller — HTTP Handler Layer for Orders & Fulfilment
 * Source of truth: Blueprint §06.7, Phase 8
 *
 * @module modules/orders/orders.controller
 */

export class OrdersController {
  /**
   * @param {import('./orders.service.js').OrdersService} service
   */
  constructor(service) {
    this.service = service
  }

  createOrderFromQuote = async (req, reply) => {
    const customerId = req.userId || req.user.id
    const order = await this.service.createOrderFromQuote(customerId, req.body)
    return reply.status(201).send({ success: true, data: order })
  }

  placeOrder = async (req, reply) => {
    const customerId = req.userId || req.user.id
    const result = await this.service.placeOrder(customerId, req.body)
    return reply.status(201).send({ success: true, data: result })
  }

  transitionOrderStatus = async (req, reply) => {
    const { orderId } = req.params
    const actorId = req.userId || req.user.id
    const updated = await this.service.transitionOrderStatus(orderId, actorId, req.body.status, req.body.notes)
    return reply.status(200).send({ success: true, data: updated })
  }

  createFulfilmentTask = async (req, reply) => {
    const { orderId } = req.params
    const actorId = req.userId || req.user.id
    const task = await this.service.createFulfilmentTask(orderId, actorId, req.body)
    return reply.status(201).send({ success: true, data: task })
  }

  updateFulfilmentTaskStatus = async (req, reply) => {
    const { taskId } = req.params
    const actorId = req.userId || req.user.id
    const task = await this.service.updateFulfilmentTaskStatus(taskId, actorId, req.body.status, req.body.notes)
    return reply.status(200).send({ success: true, data: task })
  }

  getOrderById = async (req, reply) => {
    const { orderId } = req.params
    // Scope the read: the owner, HQ/admin users (`platform_role` /
    // ADMIN-family role), or staff of the order's own shop. Any other
    // authenticated caller must not be able to read someone else's
    // address, phone and items by guessing/knowing an order id.
    const role = req.user?.platform_role || req.user?.role
    const viewer = {
      userId: req.userId || req.user?.id,
      isPlatformStaff: Boolean(req.user?.platform_role) || role === 'ADMIN' || role === 'SUPER_ADMIN',
      shopId: req.user?.shopId || null,
    }
    const order = await this.service.getOrderById(orderId, viewer)
    return reply.status(200).send({ success: true, data: order })
  }

  // Self-service "my orders" — always the caller's own orders. The former
  // `req.user?.platform_role === 'CUSTOMER'` gate was always false for a
  // real customer JWT (customer tokens never carry a `platform_role`
  // claim — see `plugins/auth.plugin.js`, which only ever computes that
  // as a local variable, never writes it back onto `request.user`), so
  // `customerId` always fell through to the client-supplied
  // `req.query.customer_id` (or `null` — no filter at all). This route
  // has no role/permission gate, so any authenticated caller could pass
  // `?customer_id=<uuid>` to read another customer's full order history,
  // or omit it entirely to receive every order in the database. Fixed to
  // never trust anything from the request for whose orders these are.
  listOrders = async (req, reply) => {
    const params = {
      customerId: req.userId || req.user.id,
      status: req.query.status || null,
    }
    const orders = await this.service.listOrders(params)
    return reply.status(200).send({ success: true, data: orders })
  }

  getActiveOrder = async (req, reply) => {
    const customerId = req.userId || req.user.id
    const order = await this.service.getActiveOrder(customerId)
    if (!order) {
      return reply.status(404).send({ success: false, message: 'No active order' })
    }
    return reply.status(200).send({ success: true, data: order })
  }

  cancelOrder = async (req, reply) => {
    const customerId = req.userId || req.user.id
    const { orderId } = req.params
    const result = await this.service.cancelOrder(customerId, orderId, req.body?.reason)
    if (result.paymentConfirmed) {
      return reply.status(409).send({
        success: false,
        paymentConfirmed: true,
        message: 'This order is already paid and cannot be cancelled.',
        data: result.order,
      })
    }
    return reply.status(200).send({ success: true, data: result.order })
  }

  reorder = async (req, reply) => {
    const customerId = req.userId || req.user.id
    const { orderId } = req.params
    const result = await this.service.reorder(customerId, orderId)
    // The mobile client (order_remote_datasource.dart#reorder) reads
    // `itemCount` from `data` but `warnings` as a top-level sibling of
    // `data` — matches that existing contract rather than nesting both
    // under `data`, since the client is already shipped expecting this.
    const { warnings, ...data } = result
    return reply.status(200).send({ success: true, data, warnings })
  }


  getInvoice = async (req, reply) => {
    const customerId = req.userId || req.user.id
    const { orderId } = req.params
    const result = await this.service.getInvoice(customerId, orderId)
    if (!result.success) {
      return reply.status(result.statusCode || 400).send({ success: false, message: result.message })
    }
    return reply
      .type('application/pdf')
      .header('Content-Disposition', `attachment; filename=invoice-${result.orderNumber}.pdf`)
      .send(result.buffer)
  }
}
