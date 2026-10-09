/**
 * B2B abandoned cart routes — /api/v1/admin/abandoned-b2b.
 *
 * @module modules/abandoned-b2b/abandoned-b2b.routes
 */

import { AbandonedB2bService } from './abandoned-b2b.service.js'

const svc = new AbandonedB2bService()
const hoursOf = (q) => Math.min(720, Math.max(1, Number(q?.hours) || 24))

function send(reply, err) {
  if (err.statusCode) return reply.status(err.statusCode).send({ success: false, message: err.message, code: err.code })
  throw err
}

export const adminAbandonedB2bRoutes = async function abandonedB2bRoutes(fastify) {
  const view = [fastify.authenticate, fastify.requirePermission('abandoned_carts.view')]
  const manage = [fastify.authenticate, fastify.requirePermission('abandoned_carts.manage')]
  const guard = (fn) => async (request, reply) => {
    try { return { success: true, data: await fn(request) } } catch (e) { return send(reply, e) }
  }

  fastify.get('/summary', { preHandler: view, handler: guard((r) => svc.summary(hoursOf(r.query))) })
  fastify.get('/', {
    preHandler: view,
    handler: async (request) => {
      const { state = '', search = '', page = 1, limit = 25 } = request.query || {}
      return { success: true, ...(await svc.list({ state: String(state).toUpperCase(), search: String(search), hours: hoursOf(request.query), page, limit })) }
    },
  })
  fastify.get('/:orderId/history', { preHandler: view, handler: guard((r) => svc.history(r.params.orderId)) })
  fastify.post('/:orderId/follow-up', { preHandler: manage, handler: guard((r) => svc.followUp(r.params.orderId, r.body || {}, r.user?.id)) })
}
