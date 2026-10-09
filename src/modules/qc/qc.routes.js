/**
 * QC routes — mounted at /api/v1/admin/qc.
 *
 * @module modules/qc/qc.routes
 */

import { QcService } from './qc.service.js'

export const qcService = new QcService()

function send(reply, err) {
  if (err.statusCode) return reply.status(err.statusCode).send({ success: false, message: err.message, code: err.code })
  throw err
}

export const adminQcRoutes = async function qcAdminRoutes(fastify) {
  const view = [fastify.authenticate, fastify.requirePermission('qc.view')]
  const manage = [fastify.authenticate, fastify.requirePermission('qc.manage')]
  const settings = [fastify.authenticate, fastify.requirePermission('qc.settings')]

  fastify.get('/stats', { preHandler: view, handler: async () => ({ success: true, data: await qcService.stats() }) })

  fastify.get('/listings', {
    preHandler: view,
    handler: async (request) => {
      const { status = '', mode = '', search = '', page = 1, limit = 25 } = request.query || {}
      return { success: true, ...(await qcService.queue({ status: String(status), mode: String(mode), search: String(search), page, limit })) }
    },
  })

  fastify.get('/listings/:id', {
    preHandler: view,
    handler: async (request, reply) => {
      try { return { success: true, data: await qcService.detail(request.params.id) } } catch (e) { return send(reply, e) }
    },
  })

  fastify.post('/listings/:id/status', {
    preHandler: manage,
    schema: { body: { type: 'object', required: ['status'], properties: { status: { type: 'string' }, notes: { type: 'string', maxLength: 1000 } } } },
    handler: async (request, reply) => {
      try {
        return { success: true, data: await qcService.setManual(request.params.id, request.body.status, request.body.notes, request.user?.id) }
      } catch (e) { return send(reply, e) }
    },
  })

  fastify.post('/listings/:id/run-auto', {
    preHandler: manage,
    handler: async (request, reply) => {
      try {
        await qcService.runAuto(request.params.id, request.user?.id)
        return { success: true, data: await qcService.detail(request.params.id) }
      } catch (e) { return send(reply, e) }
    },
  })

  fastify.post('/run-auto', {
    preHandler: manage,
    handler: async (request) => {
      const statuses = Array.isArray(request.body?.statuses) && request.body.statuses.length ? request.body.statuses : ['QC_PENDING']
      return { success: true, data: await qcService.runAutoBulk(request.user?.id, { statuses }) }
    },
  })

  fastify.get('/config', {
    preHandler: view,
    handler: async () => ({ success: true, data: { settings: await qcService.getSettings(), rules: await qcService.getRules() } }),
  })

  fastify.put('/config', {
    preHandler: settings,
    handler: async (request, reply) => {
      try { return { success: true, data: await qcService.updateConfig(request.body || {}, request.user?.id) } } catch (e) { return send(reply, e) }
    },
  })
}
