/**
 * Orders Routes — Fastify Plugin for Orders & Fulfilment Endpoints
 * Source of truth: Blueprint §06.7, Phase 8
 *
 * @module modules/orders/orders.routes
 */

import { OrdersRepository } from './orders.repository.js'
import { CartQuoteRepository } from '../cart-quote/cart-quote.repository.js'
import { OrdersService } from './orders.service.js'
import { OrdersController } from './orders.controller.js'
import { PaymentSettingsService } from '../payment-settings/payment-settings.service.js'
import { PlaceMobileOrderSchema, UpdateOrderStatusSchema, CreateFulfilmentTaskSchema, UpdateFulfilmentTaskSchema } from './orders.schema.js'

export async function ordersRoutes(fastify) {
  const repository = new OrdersRepository()
  const quoteRepository = new CartQuoteRepository()
  const service = new OrdersService(repository, quoteRepository, {
    paymentSettingsService: new PaymentSettingsService(),
    fastify,
  })
  const controller = new OrdersController(service)

  // 1. Place an order from the current mobile cart.
  fastify.post('/', {
    preHandler: [fastify.authenticate],
    schema: { body: PlaceMobileOrderSchema },
    handler: controller.placeOrder,
  })

  // 1a. Currently active (in-progress) order — powers the mobile "track
  // your order" banner. Registered as a static path, so it's matched
  // before the `/:orderId` param route below regardless of source order —
  // previously there was no route for this at all, and the mobile app's
  // literal `/orders/active` request was falling through to `/:orderId`
  // with `orderId="active"`, which then crashed on the UUID cast
  // ("invalid input syntax for type uuid") as an opaque 500.
  fastify.get('/active', {
    preHandler: [fastify.authenticate],
    handler: controller.getActiveOrder,
  })

  // 1b. Cancel an order the customer's own Razorpay checkout never
  // completed (dismissed/cancelled/failed before payment). Was entirely
  // unrouted — every such attempt from the mobile app 404'd silently.
  fastify.post('/:orderId/cancel', {
    preHandler: [fastify.authenticate],
    handler: controller.cancelOrder,
  })

  // 1c. Best-effort follow-up the mobile app calls right after a
  // successful cancel — see OrdersService#reorder's doc comment.
  fastify.post('/:orderId/reorder', {
    preHandler: [fastify.authenticate],
    handler: controller.reorder,
  })

  // 1d. Invoice PDF — OrdersService#getInvoice already existed and worked,
  // it just had no route (dashboard-side equivalent has one).
  fastify.get('/:orderId/invoice', {
    preHandler: [fastify.authenticate],
    handler: controller.getInvoice,
  })

  // 2. Transition Order Status (17-State Machine)
  fastify.patch('/:orderId/status', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('orders.update'),
    ],
    schema: { body: UpdateOrderStatusSchema },
    handler: controller.transitionOrderStatus,
  })

  // 3. Create Fulfilment Task (Picking / Packing)
  fastify.post('/:orderId/fulfilment-tasks', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('fulfilment.manage'),
    ],
    schema: { body: CreateFulfilmentTaskSchema },
    handler: controller.createFulfilmentTask,
  })

  // 4. Update Fulfilment Task Status
  fastify.patch('/fulfilment-tasks/:taskId', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('fulfilment.manage'),
    ],
    schema: { body: UpdateFulfilmentTaskSchema },
    handler: controller.updateFulfilmentTaskStatus,
  })

  // 5. Get Order by ID
  fastify.get('/:orderId', {
    preHandler: [fastify.authenticate],
    handler: controller.getOrderById,
  })

  // 6. List Orders
  fastify.get('/', {
    preHandler: [fastify.authenticate],
    handler: controller.listOrders,
  })
}

export default ordersRoutes
