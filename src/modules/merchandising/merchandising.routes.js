/**
 * Merchandising routes.
 *   admin  → /api/v1/admin/merchandising
 *   public → /api/v1/discovery/sections
 *
 * @module modules/merchandising/merchandising.routes
 */

import { MerchandisingService } from './merchandising.service.js'

const service = new MerchandisingService()

function send(reply, err) {
  if (err.statusCode) return reply.status(err.statusCode).send({ success: false, message: err.message, code: err.code })
  throw err
}

export const adminMerchandisingRoutes = async function merchandisingAdminRoutes(fastify) {
  const view = [fastify.authenticate, fastify.requirePermission('merchandising.view')]
  const manage = [fastify.authenticate, fastify.requirePermission('merchandising.manage')]
  const guard = (fn) => async (request, reply) => {
    try { return { success: true, data: await fn(request) } } catch (e) { return send(reply, e) }
  }

  fastify.get('/overview', { preHandler: view, handler: guard(() => service.overview()) })

  fastify.get('/sections/:section', {
    preHandler: view,
    handler: async (request, reply) => {
      try { return { success: true, ...(await service.listSection(request.params.section, request.query || {})) } } catch (e) { return send(reply, e) }
    },
  })

  fastify.post('/move', {
    preHandler: manage,
    handler: guard((r) => service.move(r.body?.ids, r.body?.section ?? null, { startsAt: r.body?.startsAt, endsAt: r.body?.endsAt })),
  })
  fastify.post('/channels', { preHandler: manage, handler: guard((r) => service.setChannels(r.body?.ids, { b2c: r.body?.b2c, b2b: r.body?.b2b })) })
  fastify.post('/bulk', { preHandler: manage, handler: guard((r) => service.bulk(r.body?.ids, r.body?.action)) })
  fastify.post('/listings/:id/duplicate', { preHandler: manage, handler: guard((r) => service.duplicate(r.params.id, r.user?.id)) })
}

export const publicSectionRoutes = async function merchandisingPublicRoutes(fastify) {
  fastify.get('/:section', async (request, reply) => {
    try { return { success: true, data: await service.publicSection(String(request.params.section).toUpperCase(), request.query || {}) } } catch (e) { return send(reply, e) }
  })
}
