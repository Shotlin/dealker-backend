/**
 * Repairs — B2C and B2B in one module.
 *
 *   /api/v1/repairs           customer app (own requests only)
 *   /api/v1/manage/repairs    dashboard (platform staff by permission) and service centres (assigned requests only)
 *   /api/v1/media/repair-evidence/:id   signed, expiring file links
 *
 * Permissions: repairs.view · repairs.manage · repairs.finance (payments/refunds) · repairs.settings.
 */
import fs from 'node:fs'
import { isPlatformUser, requireVendorScope } from '../../middlewares/vendor-scope.js'
import { evidencePath, verifyEvidence } from '../sell-requests/evidence-storage.js'
import * as admin from './repairs.admin.js'
import * as market from './repairs.market.js'
import * as media from './repairs.media.js'
import * as svc from './repairs.service.js'

const idParams = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] }
const itemParams = { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, itemId: { type: 'string', format: 'uuid' } }, required: ['id', 'itemId'] }
const mediaParams = { type: 'object', properties: { mediaId: { type: 'string', format: 'uuid' } }, required: ['mediaId'] }
const offerParams = { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, offerId: { type: 'string', format: 'uuid' } }, required: ['id', 'offerId'] }
const serviceParams = idParams
const ok = (data) => ({ success: true, data })

const wrap = (fn) => async (request, reply) => {
  try {
    return await fn(request, reply)
  } catch (err) {
    if (err instanceof svc.RepairError) return reply.code(err.statusCode).send({ success: false, code: err.code, message: err.message, ...err.details })
    throw err
  }
}

async function handleUpload(request, reply, actor) {
  if (!request.isMultipart()) return reply.code(415).send({ success: false, code: 'NOT_MULTIPART', message: 'Send the files as multipart/form-data' })
  const files = await media.uploadRepairParts(actor, request.files({ limits: { files: 10, fileSize: 600 * 1024 * 1024 } }))
  if (!files.length) return reply.code(400).send({ success: false, code: 'NO_FILE', message: 'No file received' })
  const good = files.filter((f) => f.ok).length
  return reply.code(good === files.length ? 201 : good === 0 ? files[0].status || 400 : 207).send({ success: good > 0, data: { files } })
}

// ── customer ────────────────────────────────────────────────────────────

export async function repairsCustomerRoutes(fastify) {
  const auth = [fastify.authenticate]
  const me = (request) => ({ kind: 'CUSTOMER', userId: request.user.id })

  /** What the app needs to render the booking form. */
  fastify.get('/config', { preHandler: auth }, wrap(async () => {
    const [settings, services] = await Promise.all([admin.readSettings(), admin.listServices()])
    const { enabled, b2cEnabled, b2bEnabled, diagnosticFee, maxB2cDevices, maxB2bDevices, maxImages, maxVideos, maxImageMb, maxVideoMb, estimateValidityDays, defaultWarrantyDays, marketplaceEnabled, searchRadiusKm, offerWindowHours } = settings
    return ok({
      settings: { enabled, b2cEnabled, b2bEnabled, diagnosticFee, maxB2cDevices, maxB2bDevices, maxImages, maxVideos, maxImageMb, maxVideoMb, estimateValidityDays, defaultWarrantyDays, marketplaceEnabled, searchRadiusKm, offerWindowHours },
      services, issues: market.ISSUES, deviceTypes: market.DEVICE_TYPES,
    })
  }))

  /** Brand tiles and model search for the booking form. */
  fastify.get('/catalogue/brands', { preHandler: auth }, wrap(async (request) => ok(await market.catalogueBrands(request.query || {}))))
  fastify.get('/catalogue/models', { preHandler: auth }, wrap(async (request) => ok(await market.catalogueModels(request.query || {}))))
  fastify.get('/devices/recent', { preHandler: auth }, wrap(async (request) => ok(await market.recentDevices(request.user.id))))

  // quotes from nearby repair shops
  fastify.get('/:id/offers', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => ok(await market.listOffers(me(request), request.params.id, request.query || {}))))
  fastify.post('/:id/offers/:offerId/select', { preHandler: auth, schema: { params: offerParams } }, wrap(async (request) => ok(await market.selectOffer(me(request), request.params.id, request.params.offerId, request.body || {}))))
  fastify.get('/:id/tracking', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => ok(await market.tracking(me(request), request.params.id))))
  fastify.post('/:id/rate', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => ok(await market.rate(me(request), request.params.id, request.body || {}))))

  fastify.post('/', { preHandler: auth }, wrap(async (request, reply) => reply.code(201).send(ok(await svc.createRequest(me(request), request.body || {})))))
  fastify.get('/mine', { preHandler: auth }, wrap(async (request) => {
    const { page, limit, tab } = request.query || {}
    return ok(await svc.list(me(request), { page, limit, tab }))
  }))
  fastify.get('/:id', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => ok(await svc.getMine(request.user.id, request.params.id))))
  fastify.post('/:id/cancel', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => ok(await svc.cancel(me(request), request.params.id, request.body?.reason))))
  fastify.post('/:id/approve-estimate', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => ok(await svc.approveEstimate(me(request), request.params.id, request.body || {}))))
  fastify.post('/:id/reject-estimate', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => ok(await svc.rejectEstimate(me(request), request.params.id, request.body?.reason))))
  fastify.post('/:id/reopen', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => ok(await svc.reopen(me(request), request.params.id, request.body || {}))))

  fastify.post('/media', { preHandler: auth }, wrap(async (request, reply) => handleUpload(request, reply, me(request))))
  fastify.delete('/media/:mediaId', { preHandler: auth, schema: { params: mediaParams } }, wrap(async (request) => { await media.discardRepairPending(me(request), request.params.mediaId); return ok({ deleted: true }) }))
  fastify.post('/:id/media', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => {
    const b = request.body || {}
    await media.attachRepairMedia(me(request), request.params.id, b.mediaIds, b.stage || 'CUSTOMER_SUBMISSION', b.itemId || null)
    return ok(await svc.getMine(request.user.id, request.params.id))
  }))
  fastify.get('/media/:mediaId/link', { preHandler: auth, schema: { params: mediaParams } }, wrap(async (request) =>
    ok(await media.repairLinkFor(me(request), request.params.mediaId, (rid) => svc.getMine(request.user.id, rid)))))
}

// ── dashboard (platform staff + service centres) ────────────────────────

export async function repairsManageRoutes(fastify) {
  const actorOf = (request) => ({ kind: isPlatformUser(request.user) ? 'ADMIN' : 'VENDOR', userId: request.user.id, vendorId: request.vendorId || null })
  const deny = (reply, permission) => reply.code(403).send({ success: false, code: 'PERMISSION_DENIED', message: `Forbidden — requires '${permission}' permission` })

  /** Platform users need `permission`; service centres pass when vendor scope resolved (the service limits them to assigned requests). */
  const staffGuard = (permission, { vendors = true } = {}) => async (request, reply) => {
    if (isPlatformUser(request.user)) return request.permissions?.includes(permission) ? undefined : deny(reply, permission)
    if (!vendors) return deny(reply, permission)
    if (!request.vendorId) return reply.code(403).send({ success: false, code: 'FORBIDDEN', message: 'Service centre access required' })
  }
  const platform = (permission) => staffGuard(permission, { vendors: false })
  const pre = (g) => [fastify.authenticate, requireVendorScope(), g]
  const view = staffGuard('repairs.view')
  const doStaff = staffGuard('repairs.manage')
  const doPlatform = platform('repairs.manage')

  fastify.get('/stats', { preHandler: pre(view) }, wrap(async (request) => ok(await svc.stats(actorOf(request)))))
  fastify.get('/', { preHandler: pre(view) }, wrap(async (request) => ok(await svc.list(actorOf(request), request.query || {}))))
  fastify.get('/:id', { preHandler: pre(view), schema: { params: idParams } }, wrap(async (request) => ok(await svc.getManage(actorOf(request), request.params.id))))
  fastify.post('/', { preHandler: pre(doPlatform) }, wrap(async (request, reply) => reply.code(201).send(ok(await svc.createRequest(actorOf(request), request.body || {})))))

  const act = (name, guard, fn) => fastify.post(`/:id/${name}`, { preHandler: pre(guard), schema: { params: idParams } },
    wrap(async (request) => ok(await fn(actorOf(request), request.params.id, request.body || {}))))
  act('accept', doPlatform, (a, id, b) => svc.accept(a, id, b))
  act('reject', doPlatform, (a, id, b) => svc.reject(a, id, b.reason))
  act('assign', doPlatform, (a, id, b) => svc.assign(a, id, b))
  act('cancel', doPlatform, (a, id, b) => svc.cancel(a, id, b.reason))
  act('approve-estimate', doPlatform, (a, id, b) => svc.approveEstimate(a, id, b))
  act('reject-estimate', doPlatform, (a, id, b) => svc.rejectEstimate(a, id, b.reason))
  act('reopen', doPlatform, (a, id, b) => svc.reopen(a, id, b))
  act('receive', doStaff, (a, id) => svc.receiveDevice(a, id))
  act('quotes', doStaff, (a, id, b) => svc.createQuote(a, id, b))
  act('start', doStaff, (a, id) => svc.startRepair(a, id))
  act('send-to-qc', doStaff, (a, id) => svc.sendToQc(a, id))
  act('qc', doStaff, (a, id, b) => svc.finalQc(a, id, b))
  act('fail', doStaff, (a, id, b) => svc.markFailed(a, id, b.reason))
  act('ready', doStaff, (a, id) => svc.markReady(a, id))
  act('deliver', doStaff, (a, id, b) => svc.deliver(a, id, b))
  act('payments', staffGuard('repairs.finance'), (a, id, b) => svc.recordPayment(a, id, b))
  fastify.post('/:id/items/:itemId/diagnosis', { preHandler: pre(doStaff), schema: { params: itemParams } },
    wrap(async (request) => ok(await svc.setDiagnosis(actorOf(request), request.params.id, request.params.itemId, request.body || {}))))

  // evidence
  fastify.post('/media', { preHandler: pre(doStaff) }, wrap(async (request, reply) => handleUpload(request, reply, actorOf(request))))
  fastify.delete('/media/:mediaId', { preHandler: pre(doStaff), schema: { params: mediaParams } }, wrap(async (request) => { await media.discardRepairPending(actorOf(request), request.params.mediaId); return ok({ deleted: true }) }))
  fastify.post('/:id/media', { preHandler: pre(doStaff), schema: { params: idParams } }, wrap(async (request) => {
    const b = request.body || {}
    await media.attachRepairMedia(actorOf(request), request.params.id, b.mediaIds, b.stage || 'INTAKE', b.itemId || null)
    return ok(await svc.getManage(actorOf(request), request.params.id))
  }))
  fastify.get('/media/:mediaId/link', { preHandler: pre(view), schema: { params: mediaParams } }, wrap(async (request) => {
    const actor = actorOf(request)
    return ok(await media.repairLinkFor(actor, request.params.mediaId, (rid) => svc.getManage(actor, rid)))
  }))

  // marketplace: price list, incoming requests, quotes, logistics
  const incoming = '/market/incoming/:id'
  fastify.get('/market/incoming', { preHandler: pre(view) }, wrap(async (request) => ok(await market.listIncoming(actorOf(request), request.query || {}))))
  fastify.get(incoming, { preHandler: pre(view), schema: { params: idParams } }, wrap(async (request) => ok(await market.getIncoming(actorOf(request), request.params.id))))
  fastify.get(`${incoming}/media/:mediaId/link`, { preHandler: pre(view), schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, mediaId: { type: 'string', format: 'uuid' } }, required: ['id', 'mediaId'] } } }, wrap(async (request) => {
    const actor = actorOf(request)
    await market.vendorCanOpenMedia(actor, request.params.id)
    return ok(await media.repairLinkFor(actor, request.params.mediaId, async (rid) => { if (rid !== request.params.id) throw new svc.RepairError('NOT_FOUND', 'Evidence not found', 404) }))
  }))
  fastify.post(`${incoming}/offer`, { preHandler: pre(doStaff), schema: { params: idParams } }, wrap(async (request, reply) => reply.code(201).send(ok(await market.placeOffer(actorOf(request), request.params.id, request.body || {})))))
  fastify.delete(`${incoming}/offer`, { preHandler: pre(doStaff), schema: { params: idParams } }, wrap(async (request) => ok(await market.withdrawOffer(actorOf(request), request.params.id, request.query?.vendorId))))
  fastify.get('/market/services', { preHandler: pre(view) }, wrap(async (request) => ok(await market.listServices(actorOf(request), request.query || {}))))
  fastify.post('/market/services', { preHandler: pre(doStaff) }, wrap(async (request, reply) => reply.code(201).send(ok(await market.createService(actorOf(request), request.body || {})))))
  fastify.post('/market/services/bulk', { preHandler: pre(doStaff) }, wrap(async (request, reply) => reply.code(201).send(ok(await market.saveServices(actorOf(request), request.body || {})))))
  fastify.put('/market/services/:id', { preHandler: pre(doStaff), schema: { params: serviceParams } }, wrap(async (request) => ok(await market.updateService(actorOf(request), request.params.id, request.body || {}))))
  fastify.delete('/market/services/:id', { preHandler: pre(doStaff), schema: { params: serviceParams } }, wrap(async (request) => ok(await market.deleteService(actorOf(request), request.params.id))))
  fastify.get('/:id/offers', { preHandler: pre(platform('repairs.view')), schema: { params: idParams } }, wrap(async (request) => ok(await market.listOffers(actorOf(request), request.params.id, request.query || {}))))
  fastify.get('/:id/tracking', { preHandler: pre(view), schema: { params: idParams } }, wrap(async (request) => ok(await market.tracking(actorOf(request), request.params.id))))
  act('schedule-pickup', doStaff, (a, id, b) => market.schedulePickup(a, id, b))
  act('picked-up', doStaff, (a, id, b) => market.markPickedUp(a, id, b))
  act('out-for-delivery', doStaff, (a, id, b) => market.markOutForDelivery(a, id, b))
  fastify.get('/market/profile', { preHandler: pre(view) }, wrap(async (request) => ok(await market.getProfile(actorOf(request), request.query?.vendorId))))
  fastify.put('/market/profile', { preHandler: pre(doStaff) }, wrap(async (request) => ok(await market.setProfile(actorOf(request), request.body || {}))))
  fastify.get(`${incoming}/suggested-quote`, { preHandler: pre(view), schema: { params: idParams } }, wrap(async (request) => ok(await market.suggestedQuote(actorOf(request), request.params.id, request.query?.vendorId))))
  act('update', doStaff, (a, id, b) => market.addRepairUpdate(a, id, b))
  act('confirm-price', doStaff, (a, id) => market.confirmPrice(a, id))
  act('generate-offers', doPlatform, async (a, id) => { await market.generateOffers(id); return svc.getManage(a, id) })

  // configuration
  const cfg = platform('repairs.settings')
  fastify.get('/config/settings', { preHandler: pre(platform('repairs.view')) }, wrap(async () => ok(await admin.readSettings())))
  fastify.put('/config/settings', { preHandler: pre(cfg) }, wrap(async (request) => ok(await admin.updateSettings(actorOf(request), request.body || {}))))
  fastify.get('/config/services', { preHandler: pre(view) }, wrap(async (request) => ok(await admin.listServices({ includeInactive: isPlatformUser(request.user) }))))
  fastify.post('/config/services', { preHandler: pre(cfg) }, wrap(async (request, reply) => reply.code(201).send(ok(await admin.createService(request.body || {})))))
  fastify.put('/config/services/:id', { preHandler: pre(cfg), schema: { params: idParams } }, wrap(async (request) => ok(await admin.updateService(request.params.id, request.body || {}))))
  fastify.get('/config/terms', { preHandler: pre(platform('repairs.view')) }, wrap(async () => ok(await admin.listTerms())))
  fastify.put('/config/terms', { preHandler: pre(cfg) }, wrap(async (request) => ok(await admin.upsertTerms(actorOf(request), request.body || {}))))
}

// ── signed file access ──────────────────────────────────────────────────

export async function repairEvidenceFileRoutes(fastify) {
  fastify.get('/repair-evidence/:id', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params
    const { exp, sig } = request.query || {}
    if (!verifyEvidence(id, exp, sig)) return reply.code(403).send({ success: false, code: 'LINK_INVALID', message: 'This link is invalid or has expired' })
    const m = await media.getStoredRepairMedia(id)
    if (!m) return reply.code(404).send({ success: false, code: 'NOT_FOUND', message: 'File not found' })
    const abs = evidencePath(m.storage_key)
    let stat
    try { stat = await fs.promises.stat(abs) } catch { return reply.code(404).send({ success: false, code: 'FILE_MISSING', message: 'File not found' }) }
    reply.header('Content-Type', m.mime_type).header('Accept-Ranges', 'bytes').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox").header('Cross-Origin-Resource-Policy', 'cross-origin')
      .header('Cache-Control', 'private, max-age=300').header('Content-Disposition', 'inline')
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range || ''))
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]))
      const end = Math.min(range[1] && range[2] ? Number(range[2]) : stat.size - 1, stat.size - 1)
      if (start > end || start >= stat.size) return reply.code(416).header('Content-Range', `bytes */${stat.size}`).send()
      return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${stat.size}`).header('Content-Length', end - start + 1).send(fs.createReadStream(abs, { start, end }))
    }
    return reply.header('Content-Length', stat.size).send(fs.createReadStream(abs))
  })
}
