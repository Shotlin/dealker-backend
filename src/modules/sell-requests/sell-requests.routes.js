/**
 * Sell requests and Exchange requests — two separate sections, one shared valuation engine.
 *
 *   SELL      customer sells an old device          /api/v1/sell-requests      /api/v1/manage/sell-requests
 *   EXCHANGE  customer buys new + trades the old    /api/v1/exchange-requests  /api/v1/manage/exchange-requests
 *
 * Each section only ever sees its own rows (the service scopes every query by `scopeKind`), has its
 * own number range (SELL-… / EXCH-…) and its own permissions (sell_requests.* / exchange_requests.*).
 * The manage surface is one set of endpoints per section; the actor (admin vs vendor) decides scope
 * inside the service, so a vendor can only see open requests and the ones assigned to them.
 *
 * @module modules/sell-requests/sell-requests.routes
 */

import { requireVendorScope, isPlatformUser } from '../../middlewares/vendor-scope.js'
import fs from 'node:fs'
import * as svc from './sell-requests.service.js'
import * as evidence from './evidence.service.js'
import * as qc from './request-qc.service.js'
import { evidencePath, verifyEvidence } from './evidence-storage.js'

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

const mediaIdParams = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' }, mediaId: { type: 'string', format: 'uuid' } },
  required: ['mediaId'],
}

/** Multipart upload → one result per file, so a bad file never discards the good ones. */
async function handleUpload(request, reply, actor) {
  if (!request.isMultipart()) return reply.code(415).send({ success: false, code: 'NOT_MULTIPART', message: 'Send the files as multipart/form-data' })
  const parts = request.files({ limits: { files: 10, fileSize: 600 * 1024 * 1024 } })
  const files = await evidence.uploadParts(actor, parts)
  if (!files.length) return reply.code(400).send({ success: false, code: 'NO_FILE', message: 'No file received' })
  const good = files.filter((f) => f.ok).length
  const status = good === files.length ? 201 : good === 0 ? files[0].status || 400 : 207
  return reply.code(status).send({ success: good > 0, data: { files } })
}

// ── customer ────────────────────────────────────────────────────────────

function customerRoutes(scopeKind) {
  return async function (fastify) {
    const auth = [fastify.authenticate]
    const customer = (request) => ({ kind: 'CUSTOMER', scopeKind, userId: request.user.id })

    fastify.get('/catalog', { preHandler: auth }, wrap(async () => ok(await svc.listModels())))

    fastify.post('/quote', { preHandler: auth }, wrap(async (request) => {
      const q = await svc.quote(request.body || {})
      return ok({ quote: q.value, condition: q.condition, base: q.base, deductions: q.deductions })
    }))

    fastify.post('/', { preHandler: auth }, wrap(async (request, reply) => {
      const created = await svc.createRequest(customer(request), { ...(request.body || {}), customer: undefined })
      return reply.code(201).send(ok(created))
    }))

    fastify.get('/mine', { preHandler: auth }, wrap(async (request) => svc.mine(request.user.id, scopeKind, request.query || {})))

    fastify.get('/:id', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => ok(await svc.getMine(request.user.id, request.params.id, scopeKind))))

    fastify.post('/:id/cancel', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => ok(await svc.cancel(customer(request), request.params.id, request.body?.reason))))

    // ── evidence: upload first (progress/retry per file), then attach ids to a request ──
    fastify.post('/media', { preHandler: auth }, wrap(async (request, reply) => handleUpload(request, reply, customer(request))))
    fastify.delete('/media/:mediaId', { preHandler: auth, schema: { params: mediaIdParams } }, wrap(async (request) => {
      await evidence.discardPending(customer(request), request.params.mediaId)
      return ok({ deleted: true })
    }))
    fastify.post('/:id/media', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => {
      const b = request.body || {}
      await evidence.attachToRequest(customer(request), request.params.id, b.mediaIds, b.stage || 'CUSTOMER_SUBMISSION')
      return ok(await svc.getMine(request.user.id, request.params.id, scopeKind))
    }))
    fastify.get('/media/:mediaId/link', { preHandler: auth, schema: { params: mediaIdParams } }, wrap(async (request) =>
      ok(await evidence.signedLinkFor(customer(request), request.params.mediaId, (rid) => svc.getMine(request.user.id, rid, scopeKind)))))
    fastify.post('/:id/qc/decision', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) =>
      ok(await qc.customerDecision(request.user.id, scopeKind, request.params.id, request.body?.decision))))
  }
}

export const sellRequestsRoutes = customerRoutes('SELL')
export const exchangeRequestsRoutes = customerRoutes('EXCHANGE')

// ── dashboard (admin + vendor) ──────────────────────────────────────────

function manageRoutes(scopeKind) {
  const P = scopeKind === 'SELL' ? 'sell_requests' : 'exchange_requests'
  const VIEW = `${P}.view`
  const MANAGE = `${P}.manage`

  return async function (fastify) {
    const actorOf = (request) => ({
      kind: isPlatformUser(request.user) ? 'ADMIN' : 'VENDOR',
      scopeKind,
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

    fastify.get('/stats', { preHandler: pre(guard(VIEW)) }, wrap(async (request) => ok(await svc.stats(actorOf(request)))))

    // Device catalogue is shared by both sections (readable here, edited under sell settings).
    fastify.get('/models', { preHandler: pre(guard(VIEW)) }, wrap(async (request) => ok(await svc.listModels({ includeInactive: isPlatformUser(request.user) }))))

    if (scopeKind === 'SELL') {
      // Valuation settings + catalogue editing are one shared place, owned by the sell section.
      fastify.get('/settings', { preHandler: pre(platformOnly('sell_requests.settings')) }, wrap(async () => ok(await svc.getSettingsForAdmin())))
      fastify.put('/settings', { preHandler: pre(platformOnly('sell_requests.settings')) }, wrap(async (request) => ok(await svc.updateSettings(actorOf(request), request.body || {}))))
      fastify.post('/models', { preHandler: pre(platformOnly('sell_requests.settings')) }, wrap(async (request, reply) => reply.code(201).send(ok(await svc.createModel(request.body || {})))))
      fastify.put('/models/:id', { preHandler: pre(platformOnly('sell_requests.settings')), schema: params }, wrap(async (request) => ok(await svc.updateModel(request.params.id, request.body || {}))))
    }

    // Live valuation for the create wizard — same engine the customer app uses.
    fastify.post('/quote', { preHandler: pre(platformOnly(MANAGE)) }, wrap(async (request) => {
      const q = await svc.quote(request.body || {})
      return ok({ quote: q.value, condition: q.condition, base: q.base, totalPct: q.totalPct, deductions: q.deductions })
    }))

    fastify.get('/', { preHandler: pre(guard(VIEW)) }, wrap(async (request) => {
      const { status = 'all', q = '', category, condition, type, page = 1, limit = 14 } = request.query || {}
      return svc.listManage(actorOf(request), { status, q: String(q).slice(0, 100), category, condition, type, page, limit })
    }))

    fastify.get('/:id', { preHandler: pre(guard(VIEW)), schema: params }, wrap(async (request) => ok(await svc.getManage(actorOf(request), request.params.id))))

    // Admin keys in a request on behalf of a walk-in / phone customer.
    fastify.post('/', { preHandler: pre(platformOnly(MANAGE)) }, wrap(async (request, reply) =>
      reply.code(201).send(ok(await svc.createRequest(actorOf(request), request.body || {})))))

    const action = (name, fn) =>
      fastify.post(`/:id/${name}`, { preHandler: pre(platformOnly(MANAGE)), schema: params },
        wrap(async (request) => ok(await fn(actorOf(request), request.params.id, request.body || {}))))

    action('approve', (a, id) => svc.approve(a, id))
    action('reject', (a, id, b) => svc.reject(a, id, b.reason ?? b.note))
    action('request-info', (a, id, b) => svc.requestInfo(a, id, b.message ?? b.note))
    action('assign-vendor', (a, id, b) => svc.assignVendor(a, id, b.vendorId))
    if (scopeKind === 'EXCHANGE') action('link-order', (a, id, b) => svc.linkOrder(a, id, b.orderNumber ?? b.orderId))
    action('complete', (a, id) => svc.complete(a, id))
    action('cancel', (a, id, b) => svc.cancel(a, id, b.reason ?? b.note))

    // ── evidence & request-level QC ──
    const QC = `${P}.qc`
    /** Platform staff need manage or qc; vendors pass when vendor scope resolved (the service limits them to assigned requests). */
    const uploader = async (request, reply) => {
      if (isPlatformUser(request.user)) {
        if (!request.permissions?.includes(MANAGE) && !request.permissions?.includes(QC)) {
          return reply.code(403).send({ success: false, code: 'PERMISSION_DENIED', message: `Forbidden — requires '${MANAGE}' or '${QC}' permission` })
        }
        return
      }
      if (!request.vendorId) return reply.code(403).send({ success: false, code: 'FORBIDDEN', message: 'Vendor access required' })
    }
    const qcGuard = async (request, reply) => {
      if (!isPlatformUser(request.user) || !(request.permissions?.includes(QC) || request.permissions?.includes(MANAGE))) {
        return reply.code(403).send({ success: false, code: 'PERMISSION_DENIED', message: `Forbidden — requires '${QC}' permission` })
      }
    }
    const qcAction = (name, fn) =>
      fastify.post(`/:id/qc/${name}`, { preHandler: pre(qcGuard), schema: params },
        wrap(async (request) => ok(await fn(actorOf(request), request.params.id, request.body || {}))))

    fastify.post('/media', { preHandler: pre(uploader) }, wrap(async (request, reply) => handleUpload(request, reply, actorOf(request))))
    fastify.delete('/media/:mediaId', { preHandler: pre(uploader), schema: { params: mediaIdParams } }, wrap(async (request) => {
      await evidence.discardPending(actorOf(request), request.params.mediaId)
      return ok({ deleted: true })
    }))
    fastify.post('/:id/media', { preHandler: pre(uploader), schema: params }, wrap(async (request) => {
      const b = request.body || {}
      await evidence.attachToRequest(actorOf(request), request.params.id, b.mediaIds, b.stage || 'TECHNICIAN_QC')
      return ok(await svc.getManage(actorOf(request), request.params.id))
    }))
    fastify.get('/media/:mediaId/link', { preHandler: pre(guard(VIEW)), schema: { params: mediaIdParams } }, wrap(async (request) => {
      const actor = actorOf(request)
      return ok(await evidence.signedLinkFor(actor, request.params.mediaId, (rid) => svc.fetchOne(actor, rid)))
    }))
    fastify.post('/media/:mediaId/verify', { preHandler: pre(qcGuard), schema: { params: mediaIdParams } }, wrap(async (request) =>
      ok(await evidence.verifyMedia(actorOf(request), request.params.mediaId, request.body?.status, request.body?.note))))

    fastify.get('/:id/qc', { preHandler: pre(guard(VIEW)), schema: params }, wrap(async (request) => {
      const actor = actorOf(request)
      await svc.fetchOne(actor, request.params.id) // visibility check
      return ok(actor.kind === 'VENDOR' ? { status: (await qc.getQc(request.params.id)).status } : await qc.getQc(request.params.id))
    }))
    qcAction('start', (a, id, b) => qc.startInspection(a, id, { inspectorId: b.inspectorId }))
    qcAction('inspection', (a, id, b) => qc.submitInspection(a, id, b))
    qcAction('decision', (a, id, b) => qc.decide(a, id, { result: b.result, note: b.note, finalValuation: b.finalValuation }))
    qcAction('reopen', (a, id, b) => qc.reopen(a, id, b.reason ?? b.note))

    fastify.post('/:id/offers', { preHandler: pre(vendorOnly), schema: params }, wrap(async (request) =>
      ok(await svc.placeOffer(actorOf(request), request.params.id, request.body || {}))))
    fastify.delete('/:id/offers', { preHandler: pre(vendorOnly), schema: params }, wrap(async (request) =>
      ok(await svc.withdrawOffer(actorOf(request), request.params.id))))
  }
}

export const sellRequestManageRoutes = manageRoutes('SELL')
export const exchangeRequestManageRoutes = manageRoutes('EXCHANGE')

/**
 * Signed, expiring read access to one evidence file (supports Range, so videos can seek).
 * No bearer token: <img>/<video> cannot send one. The link is only ever minted after the normal
 * request-visibility check, is bound to one file id and expires after 30 minutes.
 */
export async function sellEvidenceFileRoutes(fastify) {
  fastify.get('/sell-evidence/:id', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params
    const { exp, sig } = request.query || {}
    if (!verifyEvidence(id, exp, sig)) return reply.code(403).send({ success: false, code: 'LINK_INVALID', message: 'This link is invalid or has expired' })
    const m = await evidence.getStoredMedia(id)
    if (!m) return reply.code(404).send({ success: false, code: 'NOT_FOUND', message: 'File not found' })

    let stat
    try { stat = await fs.promises.stat(evidencePath(m.storage_key)) } catch {
      request.log.error({ mediaId: id }, 'evidence file missing from storage')
      return reply.code(404).send({ success: false, code: 'FILE_MISSING', message: 'File not found' })
    }
    reply
      .header('Content-Type', m.mime_type)
      .header('Accept-Ranges', 'bytes')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .header('Cache-Control', 'private, max-age=300')
      .header('Content-Disposition', 'inline')

    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range || ''))
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]))
      let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1
      end = Math.min(end, stat.size - 1)
      if (start > end || start >= stat.size) return reply.code(416).header('Content-Range', `bytes */${stat.size}`).send()
      return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${stat.size}`).header('Content-Length', end - start + 1)
        .send(fs.createReadStream(evidencePath(m.storage_key), { start, end }))
    }
    return reply.header('Content-Length', stat.size).send(fs.createReadStream(evidencePath(m.storage_key)))
  })
}
