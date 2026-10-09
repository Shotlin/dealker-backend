/**
 * Sales documents (tax invoices, credit/debit notes) — B2C and B2B.
 *
 *   /api/v1/sales-invoices         customer app: own documents
 *   /api/v1/manage/sales-invoices  dashboard (platform staff by permission) and vendors (documents they issued)
 *
 * Permissions: sales_invoices.view · .issue · .credit · .export · .settings
 */
import { isPlatformUser, requireVendorScope } from '../../middlewares/vendor-scope.js'
import * as svc from './sales-invoices.service.js'

const idParams = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] }
const ok = (data) => ({ success: true, data })

const wrap = (fn) => async (request, reply) => {
  try {
    return await fn(request, reply)
  } catch (err) {
    if (err instanceof svc.InvoiceError) return reply.code(err.statusCode).send({ success: false, code: err.code, message: err.message, ...err.details })
    throw err
  }
}

const sendPdf = (reply, { buffer, filename }, download) =>
  reply.header('Content-Type', 'application/pdf').header('Content-Length', buffer.length).header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', "default-src 'none'; sandbox").header('Cache-Control', 'private, no-store')
    .header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename}"`).send(buffer)

export async function salesInvoicesCustomerRoutes(fastify) {
  const auth = [fastify.authenticate]
  const me = (request) => ({ kind: 'CUSTOMER', userId: request.user.id })
  fastify.get('/', { preHandler: auth }, wrap(async (request) => ok(await svc.list(me(request), request.query || {}))))
  fastify.get('/:id', { preHandler: auth, schema: { params: idParams } }, wrap(async (request) => ok(await svc.get(me(request), request.params.id))))
  fastify.get('/:id/pdf', { preHandler: auth, schema: { params: idParams } }, wrap(async (request, reply) =>
    sendPdf(reply, await svc.pdf(me(request), request.params.id, { download: request.query?.download === '1' }), request.query?.download === '1')))
}

export async function salesInvoicesManageRoutes(fastify) {
  const actorOf = (request) => ({ kind: isPlatformUser(request.user) ? 'ADMIN' : 'VENDOR', userId: request.user.id, vendorId: request.vendorId || null })
  const deny = (reply, permission) => reply.code(403).send({ success: false, code: 'PERMISSION_DENIED', message: `Forbidden — requires '${permission}' permission` })
  /** Platform users need the permission; vendors may read their own documents only. */
  const guard = (permission, { vendors = false } = {}) => async (request, reply) => {
    if (isPlatformUser(request.user)) return request.permissions?.includes(permission) ? undefined : deny(reply, permission)
    if (!vendors) return deny(reply, permission)
    if (!request.vendorId) return reply.code(403).send({ success: false, code: 'FORBIDDEN', message: 'Vendor access required' })
  }
  const pre = (g) => [fastify.authenticate, requireVendorScope(), g]
  const view = guard('sales_invoices.view', { vendors: true })

  fastify.get('/', { preHandler: pre(view) }, wrap(async (request) => ok(await svc.list(actorOf(request), request.query || {}))))
  fastify.get('/export', { preHandler: pre(guard('sales_invoices.export', { vendors: true })) }, wrap(async (request, reply) => {
    const out = await svc.exportCsv(actorOf(request), request.query || {})
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="sales-documents.csv"')
      .header('X-Row-Count', out.count).header('X-Truncated', String(out.truncated)).send(out.csv)
  }))
  fastify.get('/settings', { preHandler: pre(guard('sales_invoices.settings')) }, wrap(async () => ok(svc.serializeSettings(await svc.getSettings()))))
  fastify.put('/settings', { preHandler: pre(guard('sales_invoices.settings')) }, wrap(async (request) => ok(await svc.updateSettings(actorOf(request), request.body || {}))))
  fastify.get('/for/:type/:id', { preHandler: pre(view), schema: { params: { type: 'object', properties: { type: { type: 'string', enum: ['repair', 'order'] }, id: { type: 'string', format: 'uuid' } }, required: ['type', 'id'] } } },
    wrap(async (request) => ok(await svc.forSource(actorOf(request), request.params.type === 'repair' ? 'REPAIR' : 'SELLER_ORDER', request.params.id))))
  fastify.get('/:id', { preHandler: pre(view), schema: { params: idParams } }, wrap(async (request) => ok(await svc.get(actorOf(request), request.params.id))))
  fastify.get('/:id/pdf', { preHandler: pre(view), schema: { params: idParams } }, wrap(async (request, reply) =>
    sendPdf(reply, await svc.pdf(actorOf(request), request.params.id, { download: request.query?.download === '1' }), request.query?.download === '1')))

  const issue = guard('sales_invoices.issue')
  fastify.post('/issue/repair/:id', { preHandler: pre(issue), schema: { params: idParams } }, wrap(async (request, reply) => {
    const d = await svc.issueForRepair(request.params.id, actorOf(request))
    return reply.code(d.existing ? 200 : 201).send(ok(await svc.get(actorOf(request), d.id)))
  }))
  fastify.post('/issue/order/:id', { preHandler: pre(issue), schema: { params: idParams } }, wrap(async (request, reply) => {
    const d = await svc.issueForSellerOrder(request.params.id, actorOf(request))
    return reply.code(d.existing ? 200 : 201).send(ok(await svc.get(actorOf(request), d.id)))
  }))
  fastify.post('/', { preHandler: pre(issue) }, wrap(async (request, reply) => {
    const d = await svc.issueManual(actorOf(request), request.body || {})
    return reply.code(201).send(ok(await svc.get(actorOf(request), d.id)))
  }))
  fastify.post('/:id/credit-notes', { preHandler: pre(guard('sales_invoices.credit')), schema: { params: idParams } }, wrap(async (request, reply) => {
    const d = await svc.issueCreditNote(actorOf(request), request.params.id, request.body || {})
    return reply.code(201).send(ok(await svc.get(actorOf(request), d.id)))
  }))
  fastify.post('/:id/debit-notes', { preHandler: pre(guard('sales_invoices.credit')), schema: { params: idParams } }, wrap(async (request, reply) => {
    const d = await svc.issueDebitNote(actorOf(request), request.params.id, request.body || {})
    return reply.code(201).send(ok(await svc.get(actorOf(request), d.id)))
  }))
}
