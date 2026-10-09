/**
 * Pricing routes — mounted at /api/v1/admin/pricing.
 *
 * @module modules/pricing/pricing.routes
 */

import { PricingService } from './pricing.service.js'

const service = new PricingService()

function send(reply, err) {
  if (err.statusCode) return reply.status(err.statusCode).send({ success: false, message: err.message, code: err.code })
  throw err
}

export const adminPricingRoutes = async function pricingAdminRoutes(fastify) {
  const view = [fastify.authenticate, fastify.requirePermission('pricing.view')]
  const manage = [fastify.authenticate, fastify.requirePermission('pricing.manage')]
  const guard = (fn) => async (request, reply) => {
    try { return { success: true, data: await fn(request) } } catch (e) { return send(reply, e) }
  }

  fastify.get('/brands', { preHandler: view, handler: guard(() => service.brands()) })
  fastify.post('/price/preview', { preHandler: view, handler: guard((r) => service.previewPrice(r.body || {})) })
  fastify.post('/price/apply', { preHandler: manage, handler: guard((r) => service.applyPrice(r.body || {}, r.user?.id)) })
  fastify.post('/stock/preview', { preHandler: view, handler: guard((r) => service.previewStock(r.body || {})) })
  fastify.post('/stock/apply', { preHandler: manage, handler: guard((r) => service.applyStock(r.body || {}, r.user?.id)) })

  fastify.get('/batches', {
    preHandler: view,
    handler: async (request) => ({ success: true, ...(await service.batches(request.query || {})) }),
  })
  fastify.get('/batches/:id', {
    preHandler: view,
    handler: async (request, reply) => {
      try { return { success: true, ...(await service.batchItems(request.params.id, request.query || {})) } } catch (e) { return send(reply, e) }
    },
  })
  fastify.post('/batches/:id/revert', { preHandler: manage, handler: guard((r) => service.revert(r.params.id, r.user?.id)) })
}
