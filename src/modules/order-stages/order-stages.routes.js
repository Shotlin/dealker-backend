/**
 * Order stage routes — /api/v1/admin/order-stages.
 *   GET  /:orderId            the 9-stage timeline (orders.view)
 *   POST /:orderId/override   manual stage override (orders.override)
 *
 * @module modules/order-stages/order-stages.routes
 */

import { OrderStagesService } from './order-stages.service.js'

export const orderStagesService = new OrderStagesService()

function send(reply, err) {
  if (err.statusCode) return reply.status(err.statusCode).send({ success: false, message: err.message, code: err.code })
  throw err
}

export const adminOrderStagesRoutes = async function orderStagesRoutes(fastify) {
  fastify.get('/:orderId', {
    preHandler: [fastify.authenticate, fastify.requirePermission('orders.view')],
    handler: async (request, reply) => {
      try { return { success: true, data: await orderStagesService.get(request.params.orderId) } } catch (e) { return send(reply, e) }
    },
  })
  fastify.post('/:orderId/override', {
    preHandler: [fastify.authenticate, fastify.requirePermission('orders.override')],
    handler: async (request, reply) => {
      try {
        return { success: true, data: await orderStagesService.override(request.params.orderId, request.body?.stage, request.body?.reason, request.user?.id) }
      } catch (e) { return send(reply, e) }
    },
  })
}
