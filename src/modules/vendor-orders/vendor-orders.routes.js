/**
 * Vendor order inbox — /api/v1/manage/orders (vendor scope only).
 * @module modules/vendor-orders/vendor-orders.routes
 */
import { requireVendorScope } from '../../middlewares/vendor-scope.js'
import { list } from './vendor-orders.service.js'

export async function vendorOrdersRoutes(fastify) {
  fastify.get('/', {
    preHandler: [fastify.authenticate, requireVendorScope(), async (request, reply) => {
      if (!request.vendorId) return reply.code(403).send({ success: false, code: 'FORBIDDEN', message: 'Vendor access required' })
    }],
    handler: async (request, reply) => {
      try {
        const { type, tab, q, page, limit } = request.query || {}
        return { success: true, ...(await list(request.vendorId, { type, tab, q: String(q || ''), page, limit })) }
      } catch (err) {
        if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ success: false, code: err.code, message: err.message })
        throw err
      }
    },
  })
}
