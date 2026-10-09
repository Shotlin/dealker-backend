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
import * as media from './repairs.media.js'
import * as svc from './repairs.service.js'

const idParams = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] }
const itemParams = { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, itemId: { type: 'string', format: 'uuid' } }, required: ['id', 'itemId'] }
const mediaParams = { type: 'object', properties: { mediaId: { type: 'string', format: 'uuid' } }, required: ['mediaId'] }
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
    const { enabled, b2cEnabled, b2bEnabled, diagnosticFee, maxB2cDevices, maxB2bDevices, maxImages, maxVideos, maxImageMb, maxVideoMb, estimateValidityDays, defaultWarrantyDays } = settings
    return ok({ settings: { enabled, b2cEnabled, b2bEnabled, diagnosticFee, maxB2cDevices, maxB2bDevices, maxImages, maxVideos, maxImageMb, maxVideoMb, estimateValidityDays, defaultWarrantyDays }, services })
  }))

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
  act('payments', platform('repairs.finance'), (a, id, b) => svc.recordPayment(a, id, b))
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
