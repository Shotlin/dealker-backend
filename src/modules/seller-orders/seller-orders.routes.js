/**
 * Seller Orders routes — vendor + platform surfaces.
 * Mounted at /api/v1/seller-orders.
 *
 * Vendor requests are scoped by requireVendorScope → request.vendorId.
 * Platform users (vendorId null) need the seller_orders.view/manage
 * permissions to list across the marketplace.
 *
 * @module modules/seller-orders/seller-orders.routes
 */

import { requireVendorScope } from '../../middlewares/vendor-scope.js'
import { SellerOrdersService } from './seller-orders.service.js'

const service = new SellerOrdersService()

export const sellerOrdersRoutes = async function sellerOrderRoutes(fastify) {
  fastify.get('/', {
    preHandler: [fastify.authenticate, requireVendorScope()],
    handler: async (request) => {
      const { orderId, status, fulfilmentStatus, search, page = 1, limit = 20 } = request.query || {}
      return service.list({
        vendorId: request.vendorId || null,
        orderId: orderId || null,
        status: String(status || ''),
        fulfilmentStatus: String(fulfilmentStatus || ''),
        search: String(search || ''),
        page: Number(page),
        limit: Math.min(100, Number(limit)),
      })
    },
  })

  fastify.get('/:id', {
    preHandler: [fastify.authenticate, requireVendorScope()],
    handler: async (request, reply) => {
      const row = await service.getById(request.params.id, request.vendorId || null)
      if (!row) return reply.status(404).send({ success: false, message: 'Seller order not found' })
      return { success: true, data: row }
    },
  })

  fastify.post('/:id/status', {
    preHandler: [fastify.authenticate, requireVendorScope()],
    handler: async (request, reply) => {
      const { status, reason } = request.body || {}
      try {
        const row = await service.updateStatus(
          request.params.id, request.vendorId || null, String(status || ''),
          request.user?.id, reason ? String(reason) : null
        )
        return { success: true, data: row }
      } catch (err) {
        if (err.code === 'NOT_FOUND') return reply.status(404).send({ success: false, message: err.message })
        if (err.code === 'INVALID_STATUS') return reply.status(400).send({ success: false, message: err.message })
        if (err.code === 'FORBIDDEN_TRANSITION') return reply.status(err.statusCode || 403).send({ success: false, message: err.message })
        throw err
      }
    },
  })
}
