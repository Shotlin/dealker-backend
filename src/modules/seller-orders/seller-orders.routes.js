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

import { requireVendorScope, isPlatformUser } from '../../middlewares/vendor-scope.js'
import { SellerOrdersService } from './seller-orders.service.js'
import { shipmentTracking } from '../order-overview/order-overview.service.js'

const service = new SellerOrdersService()

/**
 * requireVendorScope() lets any non-vendor user through with vendorId = null,
 * which the service reads as "platform-wide". Without this guard a plain
 * customer could list and change every vendor's orders (found in live QA 2026-10-14).
 */
const guard = (permission) => async (request, reply) => {
  if (request.vendorId) return
  if (isPlatformUser(request.user) && request.permissions?.includes(permission)) return
  return reply.code(403).send({ success: false, code: 'FORBIDDEN', message: 'Vendor or platform access required' })
}

export const sellerOrdersRoutes = async function sellerOrderRoutes(fastify) {
  fastify.get('/', {
    preHandler: [fastify.authenticate, requireVendorScope(), guard('seller_orders.view')],
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
    preHandler: [fastify.authenticate, requireVendorScope(), guard('seller_orders.view')],
    handler: async (request, reply) => {
      const row = await service.getById(request.params.id, request.vendorId || null)
      if (!row) return reply.status(404).send({ success: false, message: 'Seller order not found' })
      return { success: true, data: row }
    },
  })

  fastify.post('/:id/status', {
    preHandler: [fastify.authenticate, requireVendorScope(), guard('seller_orders.manage')],
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

  /**
   * Vendor ships the parcel themselves: records the courier + tracking number and marks it on its way.
   * (Delivery itself is confirmed by Dealker, which also releases the vendor's payout.)
   */
  fastify.post('/:id/ship', {
    preHandler: [fastify.authenticate, requireVendorScope(), guard('seller_orders.manage')],
    schema: { body: { type: 'object', required: ['courierName'], properties: {
      courierName: { type: 'string', minLength: 2, maxLength: 100 }, awb: { type: 'string', maxLength: 100 }, trackingUrl: { type: 'string', maxLength: 400 },
    }, additionalProperties: false } },
    handler: async (request, reply) => {
      const so = await service.getById(request.params.id, request.vendorId || null)
      if (!so) return reply.status(404).send({ success: false, message: 'Seller order not found' })
      if (String(so.payment_status).toUpperCase() !== 'PAID') {
        return reply.status(409).send({ success: false, code: 'NOT_PAID', message: 'The buyer has not paid yet' })
      }
      try {
        const { courierName, awb, trackingUrl } = request.body
        await shipmentTracking.createManual(so.id, { provider: 'SELF', courierName, awb, trackingUrl }, request.user?.id)
        const sh = (await service.getById(so.id, request.vendorId || null))?.shipment
        if (sh) await shipmentTracking.addEvent(sh.id, { status: 'PICKED_UP', note: 'Handed over by the seller' }, request.user?.id)
        return { success: true, data: await service.getById(so.id, request.vendorId || null) }
      } catch (err) {
        if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ success: false, code: err.code, message: err.message })
        throw err
      }
    },
  })
}
