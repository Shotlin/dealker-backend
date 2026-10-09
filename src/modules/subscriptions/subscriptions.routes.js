/**
 * Subscription routes.
 *   admin  → /api/v1/admin/subscriptions  (subscriptions.view / manage)
 *   vendor → /api/v1/subscriptions        (own plan + usage)
 *
 * @module modules/subscriptions/subscriptions.routes
 */

import { requireVendorScope } from '../../middlewares/vendor-scope.js'
import { SubscriptionsService } from './subscriptions.service.js'
import { vendorTimeline } from './vendor-timeline.service.js'

export const subscriptionsService = new SubscriptionsService()

function send(reply, err) {
  if (err.statusCode) return reply.status(err.statusCode).send({ success: false, message: err.message, code: err.code })
  throw err
}

export const adminSubscriptionsRoutes = async function subscriptionsAdminRoutes(fastify) {
  const view = [fastify.authenticate, fastify.requirePermission('subscriptions.view')]
  const manage = [fastify.authenticate, fastify.requirePermission('subscriptions.manage')]
  const svc = subscriptionsService
  const guard = (fn) => async (request, reply) => {
    try { return { success: true, data: await fn(request) } } catch (e) { return send(reply, e) }
  }

  fastify.get('/overview', { preHandler: view, handler: guard(() => svc.overview()) })
  fastify.get('/plans', { preHandler: view, handler: guard(() => svc.plans()) })
  fastify.put('/plans/:id', { preHandler: manage, handler: guard((r) => svc.updatePlan(r.params.id, r.body || {})) })

  fastify.get('/vendors', {
    preHandler: view,
    handler: async (request) => {
      const { tier = '', search = '', expiring = '', page = 1, limit = 25 } = request.query || {}
      return { success: true, ...(await svc.vendors({ tier: String(tier).toUpperCase(), search: String(search), expiring: expiring === 'true' || expiring === '1', page, limit })) }
    },
  })
  fastify.get('/vendors/:vendorId', { preHandler: view, handler: guard((r) => svc.vendor(r.params.vendorId)) })
  fastify.get('/vendors/:vendorId/timeline', {
    preHandler: view,
    handler: async (request, reply) => {
      const t = await vendorTimeline(request.params.vendorId)
      if (!t) return reply.status(404).send({ success: false, message: 'Vendor not found', code: 'NOT_FOUND' })
      return { success: true, data: t }
    },
  })
  fastify.post('/vendors/:vendorId/assign', { preHandler: manage, handler: guard((r) => svc.assign(r.params.vendorId, r.body || {}, r.user?.id)) })
  fastify.post('/vendors/:vendorId/extend', { preHandler: manage, handler: guard((r) => svc.extend(r.params.vendorId, r.body?.days, r.body?.reason, r.user?.id)) })
  fastify.post('/vendors/:vendorId/cancel', { preHandler: manage, handler: guard((r) => svc.cancel(r.params.vendorId, r.body?.reason, r.user?.id)) })
}

export const vendorSubscriptionsRoutes = async function subscriptionsVendorRoutes(fastify) {
  fastify.get('/me', {
    preHandler: [fastify.authenticate, requireVendorScope({ requireVendor: true })],
    handler: async (request, reply) => {
      try { return { success: true, data: await subscriptionsService.me(request.vendorId) } } catch (e) { return send(reply, e) }
    },
  })
}
