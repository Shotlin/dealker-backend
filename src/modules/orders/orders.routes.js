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
  // Courier shipments of one order (Shiprocket / Porter / Blue Dart / self): status steps, AWB, tracking link.
  // Status only — no rider or live-location data. Scoped to the signed-in customer's own order.
  fastify.get('/:orderId/shipments', {
    preHandler: [fastify.authenticate],
    schema: { params: { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string', format: 'uuid' } } } },
  }, async (request, reply) => {
    const { query } = await import('../../config/database.js')
    const userId = request.userId || request.user.id
    const { rows: own } = await query(`SELECT id FROM orders WHERE id = $1 AND customer_id = $2`, [request.params.orderId, userId])
    if (!own[0]) return reply.code(404).send({ success: false, message: 'Order not found', code: 'NOT_FOUND' })
    const { rows } = await query(
      `SELECT so.seller_order_number, v.name AS seller_name, s.id, s.provider, s.awb, s.courier_name, s.status, s.estimated_delivery, s.tracking_url, s.updated_at
         FROM seller_orders so
         JOIN shipments s ON s.seller_order_id = so.id
         LEFT JOIN vendors v ON v.id = so.vendor_id
        WHERE so.order_id = $1 ORDER BY so.created_at`, [request.params.orderId])
    const ids = rows.map((r) => r.id)
    const events = ids.length
      ? (await query(`SELECT shipment_id, status, note, event_location, occurred_at FROM shipment_events WHERE shipment_id = ANY($1::uuid[]) ORDER BY occurred_at, id`, [ids])).rows
      : []
    return {
      success: true,
      data: rows.map((r) => ({
        parcel: r.seller_order_number,
        seller_name: r.seller_name || null,
        provider: r.provider,
        courier_name: r.courier_name,
        awb: r.awb,
        status: r.status,
        estimated_delivery: r.estimated_delivery,
        tracking_url: r.tracking_url,
        updated_at: r.updated_at,
        events: events.filter((e) => e.shipment_id === r.id).map((e) => ({ status: e.status, note: e.note, location: e.event_location, at: e.occurred_at })),
      })),
    }
  })

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
