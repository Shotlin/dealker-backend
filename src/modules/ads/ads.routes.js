/**
 * Sponsored-ads routes.
 *
 *   /api/v1/ads           shopper-facing: redeem an ad click (billing event)
 *   /api/v1/manage/ads    dashboard: platform admins (permission-gated) AND vendors (scope-gated)
 *
 * One manage surface; the actor decides scope inside the services, so a vendor can only ever
 * see and change their own campaigns and wallet.
 *
 * @module modules/ads/ads.routes
 */

import { requireVendorScope, isPlatformUser } from '../../middlewares/vendor-scope.js'
import { AdsError } from './ads.shared.js'
import * as manage from './ads-manage.service.js'
import * as billing from './ads-billing.service.js'

const idParams = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] }

const wrap = (fn) => async (request, reply) => {
  try {
    return await fn(request, reply)
  } catch (err) {
    if (err instanceof AdsError) {
      return reply.code(err.statusCode).send({ success: false, code: err.code, message: err.message, ...err.details })
    }
    throw err
  }
}

// ── shopper ─────────────────────────────────────────────────────────────

export async function adsPublicRoutes(fastify) {
  const tryAttachUser = async (request) => {
    try {
      if (typeof fastify.optionalAuth === 'function') await fastify.optionalAuth(request)
      else await request.jwtVerify()
    } catch { /* anonymous click */ }
  }

  /**
   * The customer app calls this when a shopper taps a sponsored card, then navigates to the
   * product regardless of the outcome — a failed/expired token must never block shopping.
   */
  fastify.post('/click', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', required: ['token'], properties: { token: { type: 'string', maxLength: 2000 } } } },
    preHandler: tryAttachUser,
  }, wrap(async (request) => {
    const r = await billing.registerClick({ token: request.body.token, userId: request.user?.id || null, ip: request.ip })
    // `charged` / `reason` are intentionally not returned: the shopper never needs the advertiser's cost.
    return { success: true, data: { product_id: r.productId } }
  }))
}

// ── dashboard (admin + vendor) ──────────────────────────────────────────

export async function adsManageRoutes(fastify) {
  const actorOf = (request) => ({
    kind: isPlatformUser(request.user) ? 'ADMIN' : 'VENDOR',
    userId: request.user.id,
    vendorId: request.vendorId || null,
  })
  const deny = (reply, permission) =>
    reply.code(403).send({ success: false, code: 'PERMISSION_DENIED', message: `Forbidden — requires '${permission}' permission` })

  /** Platform users need `permission`; vendors pass if vendor scope resolved. */
  const guard = (permission) => async (request, reply) => {
    if (isPlatformUser(request.user)) {
      if (!request.permissions?.includes(permission)) return deny(reply, permission)
      return
    }
    if (!request.vendorId) return reply.code(403).send({ success: false, code: 'FORBIDDEN', message: 'Vendor access required' })
  }
  const platformOnly = (permission) => async (request, reply) => {
    if (!isPlatformUser(request.user) || !request.permissions?.includes(permission)) return deny(reply, permission)
  }
  const vendorOnly = async (request, reply) => {
    if (isPlatformUser(request.user) || !request.vendorId) {
      return reply.code(403).send({ success: false, code: 'FORBIDDEN', message: 'Only vendors can do this' })
    }
  }
  const pre = (g) => [fastify.authenticate, requireVendorScope(), g]
  const q = (request) => request.query || {}
  const ok = (data) => ({ success: true, data })

  /** Wallet target: the vendor themself, or `?vendorId=` for platform users. */
  const walletVendor = (request) => {
    const a = actorOf(request)
    const vid = a.kind === 'ADMIN' ? (q(request).vendorId || request.body?.vendorId || a.vendorId) : a.vendorId
    if (!vid) throw new AdsError('VALIDATION', 'Choose a vendor', 422)
    return vid
  }

  // rules & settings
  fastify.get('/rules', { preHandler: pre(guard('ads.view')) }, wrap(async () => ok(await manage.rules())))
  fastify.get('/settings', { preHandler: pre(platformOnly('ads.settings')) }, wrap(async () => ok(await manage.getSettingsForAdmin())))
  fastify.put('/settings', { preHandler: pre(platformOnly('ads.settings')) }, wrap(async (request) => ok(await manage.updateSettings(actorOf(request), request.body || {}))))

  // overview & research
  fastify.get('/overview', { preHandler: pre(guard('ads.view')) }, wrap(async (request) =>
    ok(await manage.overview(actorOf(request), { days: q(request).days, vendorId: q(request).vendorId || null }))))
  fastify.get('/estimate', { preHandler: pre(guard('ads.manage')) }, wrap(async (request) =>
    ok(await manage.estimate(actorOf(request), { keyword: String(q(request).keyword || '').slice(0, 80), matchType: q(request).matchType }))))
  fastify.get('/products', { preHandler: pre(guard('ads.manage')) }, wrap(async (request) =>
    ok(await manage.searchProducts(actorOf(request), { q: String(q(request).q || '').slice(0, 100), vendorId: q(request).vendorId || null }))))

  // wallet & billing
  fastify.get('/wallet', { preHandler: pre(guard('ads.view')) }, wrap(async (request) => ok(await billing.getWallet(walletVendor(request)))))
  fastify.get('/wallet/statement', { preHandler: pre(guard('ads.view')) }, wrap(async (request) =>
    billing.statement(walletVendor(request), {
      page: Math.max(1, Number(q(request).page) || 1), limit: Math.min(100, Number(q(request).limit) || 25), entryType: String(q(request).entryType || ''),
    })))
  fastify.post('/wallet/topup', {
    preHandler: pre(vendorOnly),
    schema: { body: { type: 'object', required: ['amount'], properties: { amount: { type: 'number' }, idempotencyKey: { type: 'string', maxLength: 60 } } } },
  }, wrap(async (request) => ok(await billing.topUpFromSettlement(request.vendorId, actorOf(request), request.body))))
  fastify.post('/wallet/withdraw', {
    preHandler: pre(vendorOnly),
    schema: { body: { type: 'object', required: ['amount'], properties: { amount: { type: 'number' } } } },
  }, wrap(async (request) => ok(await billing.withdrawToSettlement(request.vendorId, actorOf(request), request.body))))
  fastify.get('/wallets', { preHandler: pre(platformOnly('ads.billing')) }, wrap(async (request) =>
    manage.vendorWallets({
      q: String(q(request).q || '').slice(0, 100), page: Math.max(1, Number(q(request).page) || 1), limit: Math.min(100, Number(q(request).limit) || 20),
    })))
  fastify.post('/wallet/credit', {
    preHandler: pre(platformOnly('ads.billing')),
    schema: { body: { type: 'object', required: ['vendorId', 'amount', 'reason'], properties: {
      vendorId: { type: 'string', format: 'uuid' }, amount: { type: 'number' }, kind: { type: 'string', enum: ['TOPUP_ADMIN', 'PROMO_CREDIT', 'ADJUSTMENT'] },
      reason: { type: 'string', maxLength: 300 }, idempotencyKey: { type: 'string', maxLength: 60 },
    } } },
  }, wrap(async (request) => ok(await billing.adminCredit(request.body.vendorId, actorOf(request), request.body))))
  fastify.post('/clicks/:id/refund', {
    preHandler: pre(platformOnly('ads.billing')), schema: { params: idParams },
  }, wrap(async (request) => ok(await billing.refundClick(actorOf(request), request.params.id, request.body?.reason))))

  // campaigns
  fastify.get('/', { preHandler: pre(guard('ads.view')) }, wrap(async (request) => {
    const r = await manage.listCampaigns(actorOf(request), {
      status: String(q(request).status || ''), q: String(q(request).q || '').slice(0, 100), vendorId: q(request).vendorId || null,
      page: Math.max(1, Number(q(request).page) || 1), limit: Math.min(100, Number(q(request).limit) || 20),
    })
    return { success: true, ...r }
  }))
  fastify.post('/', { preHandler: pre(guard('ads.manage')) }, wrap(async (request) => ok(await manage.createCampaign(actorOf(request), request.body || {}))))
  fastify.get('/:id', { preHandler: pre(guard('ads.view')), schema: { params: idParams } }, wrap(async (request) => ok(await manage.getCampaign(actorOf(request), request.params.id))))
  fastify.put('/:id', { preHandler: pre(guard('ads.manage')), schema: { params: idParams } }, wrap(async (request) => ok(await manage.updateCampaign(actorOf(request), request.params.id, request.body || {}))))
  fastify.get('/:id/report', { preHandler: pre(guard('ads.view')), schema: { params: idParams } }, wrap(async (request) =>
    ok(await manage.campaignReport(actorOf(request), request.params.id, { days: q(request).days }))))
  fastify.get('/:id/clicks', { preHandler: pre(guard('ads.view')), schema: { params: idParams } }, wrap(async (request) =>
    ok(await manage.recentClicks(actorOf(request), request.params.id, { limit: Number(q(request).limit) || 50 }))))

  // products & keywords
  const sub = { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, productId: { type: 'string', format: 'uuid' } }, required: ['id', 'productId'] } }
  fastify.post('/:id/products', { preHandler: pre(guard('ads.manage')), schema: { params: idParams } }, wrap(async (request) =>
    ok(await manage.addProducts(actorOf(request), request.params.id, request.body || {}))))
  fastify.patch('/:id/products/:productId', { preHandler: pre(guard('ads.manage')), schema: sub }, wrap(async (request) =>
    ok(await manage.updateProduct(actorOf(request), request.params.id, request.params.productId, request.body || {}))))
  fastify.delete('/:id/products/:productId', { preHandler: pre(guard('ads.manage')), schema: sub }, wrap(async (request) =>
    ok(await manage.removeProduct(actorOf(request), request.params.id, request.params.productId))))

  const kwSub = { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, keywordId: { type: 'string', format: 'uuid' } }, required: ['id', 'keywordId'] } }
  fastify.post('/:id/keywords', { preHandler: pre(guard('ads.manage')), schema: { params: idParams } }, wrap(async (request) =>
    ok(await manage.addKeywords(actorOf(request), request.params.id, request.body || {}))))
  fastify.patch('/:id/keywords/:keywordId', { preHandler: pre(guard('ads.manage')), schema: kwSub }, wrap(async (request) =>
    ok(await manage.updateKeyword(actorOf(request), request.params.id, request.params.keywordId, request.body || {}))))
  fastify.delete('/:id/keywords/:keywordId', { preHandler: pre(guard('ads.manage')), schema: kwSub }, wrap(async (request) =>
    ok(await manage.removeKeyword(actorOf(request), request.params.id, request.params.keywordId))))

  // lifecycle
  const action = (name, permission, fn, { platform = false } = {}) =>
    fastify.post(`/:id/${name}`, { preHandler: pre(platform ? platformOnly(permission) : guard(permission)), schema: { params: idParams } },
      wrap(async (request) => ok(await fn(actorOf(request), request.params.id, request.body || {}))))
  action('submit', 'ads.manage', (a, id) => manage.submit(a, id))
  action('pause', 'ads.manage', (a, id) => manage.pause(a, id))
  action('resume', 'ads.manage', (a, id) => manage.resume(a, id))
  action('end', 'ads.manage', (a, id) => manage.end(a, id))
  action('approve', 'ads.moderate', (a, id) => manage.approve(a, id), { platform: true })
  action('reject', 'ads.moderate', (a, id, body) => manage.reject(a, id, body.reason), { platform: true })
  action('suspend', 'ads.moderate', (a, id, body) => manage.suspend(a, id, body.reason), { platform: true })
  action('unsuspend', 'ads.moderate', (a, id) => manage.unsuspend(a, id), { platform: true })
}
