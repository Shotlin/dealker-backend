/**
 * Commission routes — mounted at /api/v1/admin/commission.
 *
 * @module modules/commission/commission.routes
 */

import { CommissionService } from './commission.service.js'

const service = new CommissionService()

function send(reply, err) {
  if (err.statusCode) return reply.status(err.statusCode).send({ success: false, message: err.message, code: err.code })
  throw err
}

export const adminCommissionRoutes = async function commissionAdminRoutes(fastify) {
  fastify.get('/rules', {
    preHandler: [fastify.authenticate, fastify.requirePermission('commission.view')],
    handler: async (request) => {
      const { scope = '', channel = '', search = '', page = 1, limit = 20 } = request.query || {}
      return service.list({
        scope: String(scope).toUpperCase(), channel: String(channel).toUpperCase(),
        search: String(search), page: Math.max(1, Number(page)), limit: Math.min(100, Math.max(1, Number(limit))),
      })
    },
  })

  fastify.post('/rules', {
    preHandler: [fastify.authenticate, fastify.requirePermission('commission.manage')],
    handler: async (request, reply) => {
      try {
        return { success: true, data: await service.create(request.body || {}, request.user?.id) }
      } catch (err) { return send(reply, err) }
    },
  })

  fastify.patch('/rules/:id', {
    preHandler: [fastify.authenticate, fastify.requirePermission('commission.manage')],
    handler: async (request, reply) => {
      try {
        return { success: true, data: await service.update(request.params.id, request.body || {}) }
      } catch (err) { return send(reply, err) }
    },
  })

  fastify.delete('/rules/:id', {
    preHandler: [fastify.authenticate, fastify.requirePermission('commission.manage')],
    handler: async (request, reply) => {
      try {
        await service.remove(request.params.id)
        return { success: true }
      } catch (err) { return send(reply, err) }
    },
  })

  fastify.post('/preview', {
    preHandler: [fastify.authenticate, fastify.requirePermission('commission.view')],
    handler: async (request, reply) => {
      try {
        return { success: true, data: await service.preview(request.body || {}) }
      } catch (err) { return send(reply, err) }
    },
  })
}
