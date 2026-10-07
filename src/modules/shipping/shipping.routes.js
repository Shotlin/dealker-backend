/**
 * Shipping routes — admin settings/rules/shipments + provider webhooks.
 *
 * @module modules/shipping/shipping.routes
 */

import { ShippingService } from './shipping.service.js'

const service = new ShippingService()

/** Admin routes — mounted at /api/v1/admin/shipping */
export const shippingRoutes = async function shippingAdminRoutes(fastify) {
  fastify.get('/providers', {
    preHandler: [fastify.authenticate, fastify.requirePermission('shipping.view')],
    handler: async () => ({ success: true, data: await service.listProviderSettings() }),
  })

  fastify.put('/providers/:provider', {
    preHandler: [fastify.authenticate, fastify.requirePermission('shipping_providers.manage')],
    handler: async (request, reply) => {
      const provider = String(request.params.provider || '').toUpperCase()
      if (!['SHIPROCKET', 'BLUEDART', 'PORTER'].includes(provider)) {
        return reply.status(400).send({ success: false, message: 'Unknown provider' })
      }
      const data = await service.updateProviderSettings(provider, request.body || {}, request.user?.id)
      return { success: true, data: { ...data, api_key: undefined } }
    },
  })

  fastify.post('/providers/:provider/test', {
    preHandler: [fastify.authenticate, fastify.requirePermission('shipping_providers.manage')],
    handler: async (request, reply) => {
      const provider = String(request.params.provider || '').toUpperCase()
      try {
        const res = await service.testProvider(provider, {
          pickupPincode: request.body?.pickupPincode,
          deliveryPincode: request.body?.deliveryPincode,
        })
        return { success: true, data: res }
      } catch (err) {
        return reply.status(400).send({ success: false, message: err.message, code: err.code })
      }
    },
  })

  fastify.get('/rules', {
    preHandler: [fastify.authenticate, fastify.requirePermission('shipping.view')],
    handler: async () => ({ success: true, data: await service.listRules() }),
  })

  fastify.post('/rules', {
    preHandler: [fastify.authenticate, fastify.requirePermission('shipping.manage')],
    handler: async (request) => ({ success: true, data: await service.upsertRule(request.body || {}) }),
  })

  fastify.get('/shipments', {
    preHandler: [fastify.authenticate, fastify.requirePermission('shipping.view')],
    handler: async (request) => {
      const { status, provider, page = 1, limit = 20 } = request.query || {}
      return service.listShipments({
        status: String(status || ''), provider: String(provider || ''),
        page: Number(page), limit: Math.min(100, Number(limit)),
      })
    },
  })

  fastify.post('/seller-orders/:sellerOrderId/ship', {
    preHandler: [fastify.authenticate, fastify.requirePermission('shipping.manage')],
    handler: async (request, reply) => {
      try {
        const shipment = await service.createShipmentForSellerOrder(request.params.sellerOrderId, request.user?.id)
        return { success: true, data: shipment }
      } catch (err) {
        if (err.code === 'NOT_FOUND') return reply.status(404).send({ success: false, message: err.message })
        throw err
      }
    },
  })

  fastify.post('/shipments/:id/track', {
    preHandler: [fastify.authenticate, fastify.requirePermission('shipping.view')],
    handler: async (request, reply) => {
      try {
        return { success: true, data: await service.trackShipment(request.params.id) }
      } catch (err) {
        if (err.code === 'NOT_FOUND') return reply.status(404).send({ success: false, message: err.message })
        throw err
      }
    },
  })

  fastify.post('/shipments/:id/cancel', {
    preHandler: [fastify.authenticate, fastify.requirePermission('shipping.manage')],
    handler: async (request, reply) => {
      try {
        return await service.cancelShipment(request.params.id, request.user?.id)
      } catch (err) {
        if (err.code === 'NOT_FOUND') return reply.status(404).send({ success: false, message: err.message })
        throw err
      }
    },
  })
}

/**
 * Provider webhooks — mounted OUTSIDE /api/v1 at /api/webhook/shipping.
 * rawBody is enabled for signature verification; handlers are idempotent
 * (shipment_events is append-only, status transitions are guarded).
 */
export async function registerShippingWebhookRoutes(fastify) {
  fastify.post('/:provider', {
    schema: { tags: ['Shipping'], summary: 'Shipping provider webhook' },
    config: { rawBody: true, rateLimit: false },
    handler: async (request, reply) => {
      const provider = String(request.params.provider || '').toUpperCase()
      if (!['SHIPROCKET', 'BLUEDART', 'PORTER'].includes(provider)) {
        return reply.status(400).send({ success: false, message: 'Unknown provider' })
      }
      // TODO(wiring): verify per-provider signature against the encrypted
      // webhook secret in shipping_provider_settings before trusting payload.
      try {
        const result = await service.handleWebhook(provider, request.body || {})
        return { success: true, ...result }
      } catch (err) {
        request.log.error({ err, provider }, 'Shipping webhook failed')
        return reply.status(200).send({ success: false }) // 2xx so retries stop
      }
    },
  })
}
