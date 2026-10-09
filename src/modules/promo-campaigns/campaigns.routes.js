/**
 * Campaign routes — mounted at /api/v1/admin/campaigns.
 *
 * @module modules/promo-campaigns/campaigns.routes
 */

import { CampaignsService } from './campaigns.service.js'

export const campaignsService = new CampaignsService()

function send(reply, err) {
  if (err.statusCode) return reply.status(err.statusCode).send({ success: false, message: err.message, code: err.code })
  throw err
}

export const adminCampaignsRoutes = async function campaignsAdminRoutes(fastify) {
  const view = [fastify.authenticate, fastify.requirePermission('campaigns.view')]
  const manage = [fastify.authenticate, fastify.requirePermission('campaigns.manage')]
  const svc = campaignsService
  const guard = (fn) => async (request, reply) => {
    try { return { success: true, data: await fn(request) } } catch (e) { return send(reply, e) }
  }

  fastify.get('/overview', { preHandler: view, handler: guard(() => svc.overview()) })
  fastify.get('/', {
    preHandler: view,
    handler: async (request) => {
      const { status = '', type = '', search = '', page = 1, limit = 20 } = request.query || {}
      return { success: true, ...(await svc.list({ status: String(status).toUpperCase(), type: String(type).toUpperCase(), search: String(search), page, limit })) }
    },
  })
  fastify.post('/', { preHandler: manage, handler: async (request, reply) => {
    try { return reply.status(201).send({ success: true, data: await svc.create(request.body || {}, request.user?.id) }) } catch (e) { return send(reply, e) }
  } })
  fastify.post('/preview', { preHandler: view, handler: guard((r) => svc.preview(r.body || {})) })
  fastify.get('/:id', { preHandler: view, handler: guard((r) => svc.get(r.params.id)) })
  fastify.patch('/:id', { preHandler: manage, handler: guard((r) => svc.update(r.params.id, r.body || {})) })
  fastify.delete('/:id', { preHandler: manage, handler: guard(async (r) => { await svc.remove(r.params.id); return { deleted: true } }) })
  fastify.post('/:id/schedule', { preHandler: manage, handler: guard((r) => svc.schedule(r.params.id)) })
  fastify.post('/:id/start', { preHandler: manage, handler: guard((r) => svc.start(r.params.id, r.user?.id)) })
  fastify.post('/:id/end', { preHandler: manage, handler: guard((r) => svc.end(r.params.id, r.body?.reason || 'Ended by admin', r.user?.id)) })
  fastify.post('/:id/cancel', { preHandler: manage, handler: guard((r) => svc.cancel(r.params.id, r.body?.reason)) })
}
