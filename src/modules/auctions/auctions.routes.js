/**
 * Auction routes.
 *
 *   /api/v1/auctions          customer app: browse, register, bid, buy-now, watch, checkout
 *   /api/v1/manage/auctions   dashboard: platform admins (permission-gated) AND vendors (scope-gated)
 *
 * The manage surface is ONE set of endpoints; the actor (admin vs vendor) decides
 * scope inside the service so a vendor can never read or change another seller's auction.
 *
 * @module modules/auctions/auctions.routes
 */

import { requireVendorScope, isPlatformUser } from '../../middlewares/vendor-scope.js'
import { AuctionError, getSettings } from './auction.shared.js'
import * as bidding from './auction-bidding.service.js'
import * as admin from './auction-admin.service.js'
import { checkout } from './auction-checkout.service.js'

const idParams = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
}

/** Convert AuctionError → structured JSON; everything else bubbles to the global handler. */
const wrap = (fn) => async (request, reply) => {
  try {
    return await fn(request, reply)
  } catch (err) {
    if (err instanceof AuctionError) {
      return reply.code(err.statusCode).send({ success: false, code: err.code, message: err.message, ...err.details })
    }
    throw err
  }
}

const clientCtx = (request) => ({
  ip: request.ip,
  userAgent: String(request.headers['user-agent'] || '').slice(0, 300),
})

// ── customer ────────────────────────────────────────────────────────────

export async function auctionsRoutes(fastify) {
  const auth = [fastify.authenticate]
  // Browsing live auctions is open to guests (home page); a token, when sent, is still fully validated.
  const optionalAuth = [async (request, reply) => {
    if (request.headers.authorization || request.cookies?.accessToken) return fastify.authenticate(request, reply)
  }]

  fastify.get('/info', { preHandler: auth }, wrap(async () => {
    const s = await getSettings()
    return {
      success: true,
      data: {
        enabled: s.enabled, consent_text: s.consent_text, consent_text_version: s.consent_text_version,
        anti_snipe_window_sec: s.anti_snipe_window_sec, anti_snipe_extend_sec: s.anti_snipe_extend_sec,
        payment_window_hours: s.payment_window_hours,
      },
    }
  }))

  fastify.get('/', { preHandler: optionalAuth }, wrap(async (request) => {
    const { tab = 'live', q = '', categoryId = null, page = 1, limit = 20 } = request.query || {}
    return bidding.listPublic(request.user?.id ?? null, {
      tab, q: String(q).slice(0, 100), categoryId, page: Math.max(1, Number(page)), limit: Math.min(50, Number(limit) || 20),
    })
  }))

  fastify.get('/mine', { preHandler: auth }, wrap(async (request) => {
    const { tab = 'active', page = 1, limit = 20 } = request.query || {}
    return bidding.mine(request.user.id, { tab, page: Math.max(1, Number(page)), limit: Math.min(50, Number(limit) || 20) })
  }))

  fastify.get('/:id', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => ({
    success: true, data: await bidding.getPublic(request.user.id, request.params.id),
  })))

  fastify.get('/:id/bids', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => ({
    success: true, data: await bidding.listBids(request.user.id, request.params.id, { limit: Number(request.query?.limit) || 50 }),
  })))

  fastify.post('/:id/register', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => ({
    success: true, data: await bidding.register(request.user.id, request.params.id, { consent: request.body?.consent === true, ip: request.ip }),
  })))

  fastify.post('/:id/bids', {
    preHandler: auth,
    schema: { params: idParams, body: { type: 'object', required: ['maxAmount'], properties: { maxAmount: { type: 'number', exclusiveMinimum: 0 } } } },
  }, wrap(async (request) => ({
    success: true, data: await bidding.placeBid(request.user.id, request.params.id, { maxAmount: request.body.maxAmount, ...clientCtx(request) }),
  })))

  fastify.post('/:id/buy-now', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => ({
    success: true, data: await bidding.buyNow(request.user.id, request.params.id, clientCtx(request)),
  })))

  fastify.post('/:id/watch', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => ({
    success: true, data: await bidding.watch(request.user.id, request.params.id),
  })))

  fastify.delete('/:id/watch', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => ({
    success: true, data: await bidding.unwatch(request.user.id, request.params.id),
  })))

  fastify.post('/:id/checkout', {
    preHandler: auth,
    schema: { params: idParams, body: { type: 'object', required: ['addressId'], properties: {
      addressId: { type: 'string', format: 'uuid' }, paymentMethod: { type: 'string', enum: ['WALLET', 'ONLINE'] }, notes: { type: 'string', maxLength: 500 },
    } } },
  }, wrap(async (request) => ({
    success: true, data: await checkout(request.user.id, request.params.id, request.body),
  })))
}

// ── dashboard (admin + vendor) ──────────────────────────────────────────

export async function auctionManageRoutes(fastify) {
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
    if (!request.vendorId) {
      return reply.code(403).send({ success: false, code: 'FORBIDDEN', message: 'Vendor access required' })
    }
  }
  /** Platform-only (vendors are refused even with a vendor scope). */
  const platformOnly = (permission) => async (request, reply) => {
    if (!isPlatformUser(request.user) || !request.permissions?.includes(permission)) {
      return reply.code(403).send({ success: false, code: 'PERMISSION_DENIED', message: `Forbidden — requires '${permission}' permission` })
    }
  }
  const pre = (g) => [fastify.authenticate, requireVendorScope(), g]
  const params = { params: idParams }

  fastify.get('/rules', { preHandler: pre(guard('auctions.view')) }, wrap(async () => {
    const s = await getSettings()
    return { success: true, data: {
      enabled: s.enabled, min_registration_fee: Number(s.min_registration_fee), max_registration_fee: Number(s.max_registration_fee),
      fee_max_pct_of_start_price: Number(s.fee_max_pct_of_start_price), increment_tiers: s.increment_tiers,
      min_duration_minutes: s.min_duration_minutes, max_duration_days: s.max_duration_days,
      anti_snipe_window_sec: s.anti_snipe_window_sec, anti_snipe_extend_sec: s.anti_snipe_extend_sec, max_extensions: s.max_extensions,
      payment_window_hours: s.payment_window_hours, vendor_fee_share_pct: Number(s.vendor_fee_share_pct),
      loser_fee_refund_pct: Number(s.loser_fee_refund_pct), vendor_auctions_require_approval: s.vendor_auctions_require_approval,
    } }
  }))

  fastify.get('/settings', { preHandler: pre(platformOnly('auctions.settings')) }, wrap(async () => ({
    success: true, data: await admin.getSettingsForAdmin(),
  })))
  fastify.put('/settings', { preHandler: pre(platformOnly('auctions.settings')) }, wrap(async (request) => ({
    success: true, data: await admin.updateSettings(actorOf(request), request.body || {}),
  })))

  fastify.get('/stats', { preHandler: pre(guard('auctions.view')) }, wrap(async (request) => ({
    success: true, data: await admin.stats(actorOf(request)),
  })))
  fastify.get('/attention', { preHandler: pre(guard('auctions.view')) }, wrap(async (request) => ({
    success: true, data: await admin.attentionQueue(actorOf(request)),
  })))
  fastify.get('/products', { preHandler: pre(guard('auctions.manage')) }, wrap(async (request) => ({
    success: true, data: await admin.searchProducts(actorOf(request), { q: String(request.query?.q || '').slice(0, 100) }),
  })))
  fastify.get('/risk', { preHandler: pre(platformOnly('auctions.moderate')) }, wrap(async () => ({
    success: true, data: await admin.riskOverview(),
  })))
  fastify.post('/bidders/:userId/block', { preHandler: pre(platformOnly('auctions.moderate')) }, wrap(async (request) => ({
    success: true, data: await admin.blockBidder(actorOf(request), request.params.userId, request.body?.reason),
  })))
  fastify.post('/bidders/:userId/unblock', { preHandler: pre(platformOnly('auctions.moderate')) }, wrap(async (request) => ({
    success: true, data: await admin.unblockBidder(actorOf(request), request.params.userId),
  })))

  fastify.get('/', { preHandler: pre(guard('auctions.view')) }, wrap(async (request) => {
    const { status = '', q = '', ownerType = '', audience = '', page = 1, limit = 20 } = request.query || {}
    return admin.listManage(actorOf(request), {
      status, q: String(q).slice(0, 100), ownerType, audience: String(audience).toUpperCase(), page: Math.max(1, Number(page)), limit: Math.min(100, Number(limit) || 20),
    })
  }))
  fastify.get('/orders', { preHandler: pre(guard('auctions.view')) }, wrap(async (request) => {
    const { audience = '', status = '', q = '', page = 1, limit = 20 } = request.query || {}
    return admin.listOrders(actorOf(request), { audience: String(audience).toUpperCase(), status: String(status), q: String(q).slice(0, 100), page: Math.max(1, Number(page)), limit: Math.min(100, Number(limit) || 20) })
  }))
  fastify.get('/:id', { preHandler: pre(guard('auctions.view')), schema: params }, wrap(async (request) => ({
    success: true, data: await admin.getManage(actorOf(request), request.params.id),
  })))
  fastify.post('/', { preHandler: pre(guard('auctions.manage')) }, wrap(async (request) => ({
    success: true, data: await admin.createAuction(actorOf(request), request.body || {}),
  })))
  fastify.put('/:id', { preHandler: pre(guard('auctions.manage')), schema: params }, wrap(async (request) => ({
    success: true, data: await admin.updateAuction(actorOf(request), request.params.id, request.body || {}),
  })))

  const action = (name, permission, fn, { platform = false } = {}) =>
    fastify.post(`/:id/${name}`, { preHandler: pre(platform ? platformOnly(permission) : guard(permission)), schema: params },
      wrap(async (request) => ({ success: true, data: await fn(actorOf(request), request.params.id, request.body || {}) })))

  action('submit', 'auctions.manage', (a, id) => admin.submitAuction(a, id))
  action('cancel', 'auctions.manage', (a, id, body) => admin.cancel(a, id, body.reason))
  action('relist', 'auctions.manage', (a, id, body) => admin.relist(a, id, body))
  action('approve', 'auctions.moderate', (a, id) => admin.approveAuction(a, id), { platform: true })
  action('reject', 'auctions.moderate', (a, id, body) => admin.rejectAuction(a, id, body.reason), { platform: true })
  action('start-now', 'auctions.moderate', (a, id) => admin.startNow(a, id), { platform: true })
  action('pause', 'auctions.moderate', (a, id) => admin.pauseAuction(a, id), { platform: true })
  action('resume', 'auctions.moderate', (a, id) => admin.resumeAuction(a, id), { platform: true })
  action('extend', 'auctions.moderate', (a, id, body) => admin.extendAuction(a, id, body.minutes), { platform: true })
  action('end-now', 'auctions.moderate', (a, id) => admin.endNow(a, id), { platform: true })
}
