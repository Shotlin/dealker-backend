/**
 * Review moderation routes — /api/v1/admin/reviews.
 *   GET   /summary                         queue counts + settings      (reviews.view)
 *   PUT   /settings                        {autoPublish}                (reviews.moderate)
 *   GET   /:kind                           list (kind = product|vendor) (reviews.view)
 *   GET   /:kind/:id                       one review + its reports     (reviews.view)
 *   POST  /:kind/bulk                      {ids, action, note}          (reviews.moderate)
 *   POST  /:kind/:id/moderate              {action, note}               (reviews.moderate)
 *   PUT   /:kind/:id/reply                 {text}                       (reviews.moderate)
 *   PUT   /:kind/:id/flag                  {flagged, reason}            (reviews.moderate)
 *
 * @module modules/reviews/review-moderation.routes
 */

import { reviewModeration as svc } from './review-moderation.service.js'

function send(reply, err) {
  if (err.statusCode) return reply.status(err.statusCode).send({ success: false, message: err.message, code: err.code })
  throw err
}

export const adminReviewsRoutes = async function reviewModerationRoutes(fastify) {
  const view = [fastify.authenticate, fastify.requirePermission('reviews.view')]
  const moderate = [fastify.authenticate, fastify.requirePermission('reviews.moderate')]
  const guard = (fn) => async (request, reply) => {
    try { return { success: true, data: await fn(request) } } catch (e) { return send(reply, e) }
  }

  fastify.get('/summary', { preHandler: view, handler: guard(() => svc.summary()) })
  fastify.put('/settings', { preHandler: moderate, handler: guard((r) => svc.updateSettings({ autoPublish: r.body?.autoPublish })) })

  fastify.get('/:kind', {
    preHandler: view,
    handler: async (request, reply) => {
      try { return { success: true, ...(await svc.list(request.params.kind, request.query || {})) } } catch (e) { return send(reply, e) }
    },
  })
  fastify.get('/:kind/:id', { preHandler: view, handler: guard((r) => svc.get(r.params.kind, r.params.id)) })

  fastify.post('/:kind/bulk', {
    preHandler: moderate,
    handler: guard((r) => svc.bulk(r.params.kind, r.body?.ids, r.body?.action, { note: r.body?.note }, r.user?.id)),
  })
  fastify.post('/:kind/:id/moderate', {
    preHandler: moderate,
    handler: guard((r) => svc.moderate(r.params.kind, r.params.id, r.body?.action, { note: r.body?.note }, r.user?.id)),
  })
  fastify.put('/:kind/:id/reply', { preHandler: moderate, handler: guard((r) => svc.reply(r.params.kind, r.params.id, r.body?.text, r.user?.id)) })
  fastify.put('/:kind/:id/flag', {
    preHandler: moderate,
    handler: guard((r) => svc.flag(r.params.kind, r.params.id, { flagged: r.body?.flagged !== false, reason: r.body?.reason })),
  })
}
