import { ShiprocketService } from './shiprocket.service.js'
import { ShiprocketOrdersService } from './shiprocket.orders.service.js'
import { requireShopScope } from '../../middlewares/shop-scope.js'
import { success } from '../../utils/apiResponse.js'

/**
 * Shiprocket settings admin routes. Prefix: /api/v1/admin/shiprocket
 *   GET  /settings — masked view      PUT /settings — save credentials/pickup
 *   POST /test     — draft or stored credentials, lists pickup locations
 */
export default async function shiprocketRoutes(fastify) {
  const service = new ShiprocketService()
  const orders = new ShiprocketOrdersService()
  const scoped = [fastify.authenticate, fastify.requireAdmin, requireShopScope({ requireShop: false })]
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]
  const tags = ['Admin - Shiprocket']

  fastify.get('/settings', { schema: { tags }, preHandler: adminAuth }, async (req, reply) =>
    reply.send(success(await service.get(), 'Shiprocket settings fetched')))

  fastify.put('/settings', {
    schema: {
      tags,
      body: {
        type: 'object',
        properties: {
          email: { type: 'string', maxLength: 200 },
          password: { type: 'string', maxLength: 200 },
          pickupLocation: { type: 'string', maxLength: 200 },
          deliveryPartner: { type: 'string', enum: ['OWN_RIDERS', 'SHIPROCKET'] },
          simulationMode: { type: 'boolean' },
        },
      },
    },
    preHandler: adminAuth,
  }, async (req, reply) =>
    reply.send(success(await service.save(req.body, req.user?.id), 'Shiprocket settings saved')))

  fastify.post('/test', {
    schema: {
      tags,
      body: {
        type: 'object',
        properties: { email: { type: 'string', maxLength: 200 }, password: { type: 'string', maxLength: 200 } },
      },
    },
    preHandler: adminAuth,
  }, async (req, reply) => {
    const result = await service.test(req.body || {}, req.user?.id)
    return reply.send(success(result, result.success ? 'Connection successful' : 'Connection failed'))
  })

  const orderParams = { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string', format: 'uuid' } } }
  const handle = (fn, msg) => async (req, reply) => reply.send(success(await fn(req), msg))

  // Per-order Shiprocket Quick delivery (prepaid orders only)
  fastify.get('/orders/:orderId', { schema: { tags, params: orderParams }, preHandler: scoped },
    handle((req) => orders.get(req.params.orderId), 'Shiprocket delivery fetched'))
  fastify.post('/orders/:orderId/check', { schema: { tags, params: orderParams }, preHandler: scoped },
    handle((req) => orders.check(req.params.orderId, req.shopId), 'Checked'))
  fastify.post('/orders/:orderId/assign', { schema: { tags, params: orderParams }, preHandler: scoped },
    handle((req) => orders.assign(req.params.orderId, req.user?.id, req.shopId), 'Assigned to Shiprocket'))
  fastify.post('/orders/:orderId/refresh', { schema: { tags, params: orderParams }, preHandler: scoped },
    handle((req) => orders.refresh(req.params.orderId), 'Refreshed'))
  fastify.post('/orders/:orderId/simulate-advance', { schema: { tags, params: orderParams }, preHandler: scoped },
    handle((req) => orders.advanceSimulation(req.params.orderId, req.user?.id, req.shopId), 'Demo delivery advanced'))
  fastify.post('/orders/:orderId/cancel', { schema: { tags, params: orderParams }, preHandler: scoped },
    handle((req) => orders.cancel(req.params.orderId, req.user?.id, req.shopId), 'Cancelled'))
}
