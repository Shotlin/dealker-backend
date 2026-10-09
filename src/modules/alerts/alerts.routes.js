/**
 * Notification centre routes — /api/v1/admin/alerts.
 * Read state is per admin; Notification Control (settings) needs alerts.manage.
 *
 * @module modules/alerts/alerts.routes
 */

import { AlertsService } from './alerts.service.js'

export const alertsService = new AlertsService()

function send(reply, err) {
  if (err.statusCode) return reply.status(err.statusCode).send({ success: false, message: err.message, code: err.code })
  throw err
}

export const adminAlertsRoutes = async function alertsAdminRoutes(fastify) {
  const view = [fastify.authenticate, fastify.requirePermission('alerts.view')]
  const manage = [fastify.authenticate, fastify.requirePermission('alerts.manage')]
  const svc = alertsService
  const uid = (r) => r.user?.id
  const guard = (fn) => async (request, reply) => {
    try { return { success: true, data: await fn(request) } } catch (e) { return send(reply, e) }
  }

  fastify.get('/', {
    preHandler: view,
    handler: async (request) => {
      const { type = '', severity = '', group = '', unread = '', search = '', page = 1, limit = 30 } = request.query || {}
      return { success: true, ...(await svc.list(uid(request), { type: String(type), severity: String(severity).toUpperCase(), group: String(group), unread: unread === 'true' || unread === '1', search: String(search), page, limit })) }
    },
  })
  fastify.get('/unread-count', { preHandler: view, handler: guard((r) => svc.unreadCount(uid(r))) })
  fastify.get('/summary', { preHandler: view, handler: guard(() => svc.summary()) })
  fastify.post('/read', { preHandler: view, handler: guard((r) => svc.markRead(uid(r), r.body?.ids)) })
  fastify.post('/read-all', { preHandler: view, handler: guard((r) => svc.markAllRead(uid(r), { type: String(r.body?.type || '') })) })
  fastify.get('/settings', { preHandler: view, handler: guard(() => svc.settings()) })
  fastify.put('/settings', { preHandler: manage, handler: guard((r) => svc.updateSettings(r.body?.changes)) })
}
