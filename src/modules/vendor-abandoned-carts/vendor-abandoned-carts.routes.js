/**
 * Vendor abandoned-cart routes — /api/v1/manage/abandoned-carts (vendors only; admins use /admin/abandoned-carts).
 *
 * @module modules/vendor-abandoned-carts/vendor-abandoned-carts.routes
 */

import { isPlatformUser, requireVendorScope } from '../../middlewares/vendor-scope.js'
import * as svc from './vendor-abandoned-carts.service.js'

const idParams = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] }

export default async function vendorAbandonedCartsRoutes(fastify) {
  const vendorOnly = async (request, reply) => {
    if (!request.vendorId || isPlatformUser(request.user)) {
      return reply.code(403).send({ success: false, code: 'FORBIDDEN', message: 'Only vendors can do this' })
    }
  }
  const pre = [fastify.authenticate, requireVendorScope(), vendorOnly]
  const wrap = (fn) => async (request, reply) => {
    try {
      return await fn(request)
    } catch (err) {
      if (err instanceof svc.VendorCartError) {
        return reply.code(err.statusCode).send({ success: false, code: err.code, message: err.message, ...err.details })
      }
      throw err
    }
  }
  const ok = (data) => ({ success: true, data })
  const q = (r) => r.query || {}

  fastify.get('/summary', { preHandler: pre }, wrap(async (r) => ok(await svc.summary(r.vendorId, { channel: q(r).channel, days: q(r).days }))))
  fastify.get('/', { preHandler: pre }, wrap(async (r) => {
    const out = await svc.list(r.vendorId, { channel: q(r).channel, state: q(r).state, search: q(r).search, days: q(r).days, page: q(r).page, limit: q(r).limit })
    return { success: true, ...out }
  }))
  fastify.get('/:id', { preHandler: pre, schema: { params: idParams } }, wrap(async (r) => ok(await svc.detail(r.vendorId, r.params.id))))
  fastify.get('/:id/preview', {
    preHandler: pre,
    schema: { params: idParams, querystring: { type: 'object', required: ['templateKey'], properties: { templateKey: { type: 'string', maxLength: 30 }, productIds: { type: 'string', maxLength: 2000 } } } },
  }, wrap(async (r) => ok(await svc.preview(r.vendorId, r.params.id, {
    templateKey: q(r).templateKey,
    productIds: String(q(r).productIds || '').split(',').map((x) => x.trim()).filter(Boolean),
  }))))
  fastify.post('/:id/remind', {
    preHandler: pre,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      params: idParams,
      body: {
        type: 'object', required: ['templateKey'],
        properties: { templateKey: { type: 'string', maxLength: 30 }, productIds: { type: 'array', maxItems: 50, items: { type: 'string', format: 'uuid' } } },
      },
    },
  }, wrap(async (r) => ok(await svc.remind(r.vendorId, r.params.id, r.body, { userId: r.user.id, fastify }))))
}
