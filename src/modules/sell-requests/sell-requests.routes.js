/**
 * Sell & Exchange request routes.
 *
 *   /api/v1/sell-requests          customer app: catalogue, quote, submit, track, cancel
 *   /api/v1/manage/sell-requests   dashboard: platform admins (permission-gated) AND vendors (scope-gated)
 *
 * One manage surface; the actor (admin vs vendor) decides scope inside the service, so a vendor
 * can only see open requests and the ones assigned to them.
 *
 * @module modules/sell-requests/sell-requests.routes
 */

import { requireVendorScope, isPlatformUser } from '../../middlewares/vendor-scope.js'
import * as svc from './sell-requests.service.js'

const idParams = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
}

const wrap = (fn) => async (request, reply) => {
  try {
    return await fn(request, reply)
  } catch (err) {
    if (err instanceof svc.SellError) {
      return reply.code(err.statusCode).send({ success: false, code: err.code, message: err.message, ...err.details })
    }
    throw err
  }
}

const ok = (data) => ({ success: true, data })

// ── customer ────────────────────────────────────────────────────────────

export async function sellRequestsRoutes(fastify) {
  const auth = [fastify.authenticate]
  const customer = (request) => ({ kind: 'CUSTOMER', userId: request.user.id })

  fastify.get('/catalog', { preHandler: auth }, wrap(async () => ok(await svc.listModels())))

  fastify.post('/quote', { preHandler: auth }, wrap(async (request) => {
    const q = await svc.quote(request.body || {})
    return ok({ quote: q.value, condition: q.condition, base: q.base, deductions: q.deductions })
  }))

  fastify.post('/', { preHandler: auth }, wrap(async (request, reply) => {
    const created = await svc.createRequest(customer(request), { ...(request.body || {}), customer: undefined })
    return reply.code(201).send(ok(created))
  }))

  fastify.get('/mine', { preHandler: auth }, wrap(async (request) => svc.mine(request.user.id, request.query || {})))

  fastify.get('/:id', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => ok(await svc.getMine(request.user.id, request.params.id))))

  fastify.post('/:id/cancel', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => ok(await svc.cancel(customer(request), request.params.id, request.body?.reason))))
}

// ── dashboard (admin + vendor) ──────────────────────────────────────────

export async function sellRequestManageRoutes(fastify) {
  const actorOf = (request) => ({
    kind: isPlatformUser(request.user) ? 'ADMIN' : 'VENDOR',
    userId: request.user.id,
    vendorId: request.vendorId || null,
  })

  /** Platform users need `permission`; vendors pass if vendor scope resolved. */
  const guard = (permission) => async (request, reply) => {
    if (isPlatformUser(request.user)) {
      if (!request.permissions?.includes(permission)) {
        return reply.code(403).send({ success: false, code: 'PERMISSION_DENIED', message: `Forbidden — requires '${permission}' permission` })
      }
      return
    }
    if (!request.vendorId) return reply.code(403).send({ success: false, code: 'FORBIDDEN', message: 'Vendor access required' })
  }
  const platformOnly = (permission) => async (request, reply) => {
    if (!isPlatformUser(request.user) || !request.permissions?.includes(permission)) {
      return reply.code(403).send({ success: false, code: 'PERMISSION_DENIED', message: `Forbidden — requires '${permission}' permission` })
    }
  }
  /** Vendors only (offers are placed by a vendor on their own behalf). */
  const vendorOnly = async (request, reply) => {
    if (isPlatformUser(request.user) || !request.vendorId) {
      return reply.code(403).send({ success: false, code: 'FORBIDDEN', message: 'Only vendors can place offers' })
    }
  }
  const pre = (g) => [fastify.authenticate, requireVendorScope(), g]
  const params = { params: idParams }

  fastify.get('/stats', { preHandler: pre(guard('sell_requests.view')) }, wrap(async (request) => ok(await svc.stats(actorOf(request)))))

  fastify.get('/settings', { preHandler: pre(platformOnly('sell_requests.settings')) }, wrap(async () => ok(await svc.getSettingsForAdmin())))
  fastify.put('/settings', { preHandler: pre(platformOnly('sell_requests.settings')) }, wrap(async (request) => ok(await svc.updateSettings(actorOf(request), request.body || {}))))

  fastify.get('/models', { preHandler: pre(guard('sell_requests.view')) }, wrap(async (request) => ok(await svc.listModels({ includeInactive: isPlatformUser(request.user) }))))
  fastify.post('/models', { preHandler: pre(platformOnly('sell_requests.settings')) }, wrap(async (request, reply) => reply.code(201).send(ok(await svc.createModel(request.body || {})))))
  fastify.put('/models/:id', { preHandler: pre(platformOnly('sell_requests.settings')), schema: params }, wrap(async (request) => ok(await svc.updateModel(request.params.id, request.body || {}))))

  // Live valuation for the create wizard — same engine the customer app uses.
  fastify.post('/quote', { preHandler: pre(platformOnly('sell_requests.manage')) }, wrap(async (request) => {
    const q = await svc.quote(request.body || {})
    return ok({ quote: q.value, condition: q.condition, base: q.base, totalPct: q.totalPct, deductions: q.deductions })
  }))

  fastify.get('/', { preHandler: pre(guard('sell_requests.view')) }, wrap(async (request) => {
    const { status = 'all', q = '', category, condition, type, page = 1, limit = 14 } = request.query || {}
    return svc.listManage(actorOf(request), { status, q: String(q).slice(0, 100), category, condition, type, page, limit })
  }))

  fastify.get('/:id', { preHandler: pre(guard('sell_requests.view')), schema: params }, wrap(async (request) => ok(await svc.getManage(actorOf(request), request.params.id))))

  // Admin keys in a request on behalf of a walk-in / phone customer.
  fastify.post('/', { preHandler: pre(platformOnly('sell_requests.manage')) }, wrap(async (request, reply) =>
    reply.code(201).send(ok(await svc.createRequest(actorOf(request), request.body || {})))))

  const action = (name, fn) =>
    fastify.post(`/:id/${name}`, { preHandler: pre(platformOnly('sell_requests.manage')), schema: params },
      wrap(async (request) => ok(await fn(actorOf(request), request.params.id, request.body || {}))))

  action('approve', (a, id) => svc.approve(a, id))
  action('reject', (a, id, b) => svc.reject(a, id, b.reason ?? b.note))
  action('request-info', (a, id, b) => svc.requestInfo(a, id, b.message ?? b.note))
  action('assign-vendor', (a, id, b) => svc.assignVendor(a, id, b.vendorId))
  action('link-order', (a, id, b) => svc.linkOrder(a, id, b.orderNumber ?? b.orderId))
  action('complete', (a, id) => svc.complete(a, id))
  action('cancel', (a, id, b) => svc.cancel(a, id, b.reason ?? b.note))

  fastify.post('/:id/offers', { preHandler: pre(vendorOnly), schema: params }, wrap(async (request) =>
    ok(await svc.placeOffer(actorOf(request), request.params.id, request.body || {}))))
  fastify.delete('/:id/offers', { preHandler: pre(vendorOnly), schema: params }, wrap(async (request) =>
    ok(await svc.withdrawOffer(actorOf(request), request.params.id))))
}
