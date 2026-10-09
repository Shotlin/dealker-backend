/**
 * Invoice routes.
 *   admin  → /api/v1/admin/invoices   (invoices.view / invoices.manage)
 *   vendor → /api/v1/vendor/invoices  (own listings only; cannot verify)
 *
 * @module modules/invoices/invoices.routes
 */

import fs from 'node:fs'
import { requireVendorScope } from '../../middlewares/vendor-scope.js'
import { InvoicesService } from './invoices.service.js'
import { resolveInvoicePath, MAX_INVOICE_BYTES } from './invoice-storage.js'
import { qcService } from '../qc/qc.routes.js'

export const invoicesService = new InvoicesService({ qc: qcService })

const FIELD_MAP = {
  invoice_number: 'invoiceNumber', invoice_date: 'invoiceDate', purchase_amount: 'purchaseAmount',
  gst_amount: 'gstAmount', supplier_name: 'supplierName', imei_serial: 'imeiSerial',
}

function send(reply, err) {
  if (err.statusCode) return reply.status(err.statusCode).send({ success: false, message: err.message, code: err.code })
  throw err
}

/** Read one multipart form: text fields + exactly one file. */
async function readForm(request) {
  const fields = {}
  let file = null
  for await (const part of request.parts({ limits: { files: 1, fileSize: MAX_INVOICE_BYTES } })) {
    if (part.type === 'file') {
      const chunks = []
      for await (const c of part.file) chunks.push(c)
      if (part.file.truncated) {
        const e = new Error('Invoice file is larger than 10 MB')
        e.statusCode = 413
        e.code = 'FILE_TOO_LARGE'
        throw e
      }
      file = { buffer: Buffer.concat(chunks), filename: part.filename, mime: part.mimetype }
    } else {
      fields[FIELD_MAP[part.fieldname] || part.fieldname] = String(part.value ?? '')
    }
  }
  return { fields, file }
}

async function streamFile(svc, request, reply, vendorId) {
  const info = await svc.fileInfo(request.params.id, vendorId)
  const abs = resolveInvoicePath(info.file_path)
  if (!fs.existsSync(abs)) return reply.status(410).send({ success: false, message: 'The invoice file is missing from storage', code: 'FILE_MISSING' })
  const disp = request.query?.download ? 'attachment' : 'inline'
  const safeName = info.file_name.replace(/[^\w.\- ]+/g, '_')
  return reply
    .header('Content-Type', info.mime_type)
    .header('Content-Disposition', `${disp}; filename="${safeName}"`)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
    .header('Cache-Control', 'private, no-store')
    .header('Cross-Origin-Resource-Policy', 'cross-origin')
    .send(fs.createReadStream(abs))
}

export const adminInvoicesRoutes = async function invoicesAdminRoutes(fastify) {
  const view = [fastify.authenticate, fastify.requirePermission('invoices.view')]
  const manage = [fastify.authenticate, fastify.requirePermission('invoices.manage')]
  const svc = invoicesService

  fastify.get('/stats', { preHandler: view, handler: async () => ({ success: true, data: await svc.stats() }) })

  fastify.get('/', {
    preHandler: view,
    handler: async (request) => {
      const { status = '', search = '', vendorId = '', page = 1, limit = 25 } = request.query || {}
      return { success: true, ...(await svc.list({ status: String(status), search: String(search), vendorId: vendorId || null, page, limit })) }
    },
  })

  fastify.get('/listing/:listingId', {
    preHandler: view,
    handler: async (request) => ({ success: true, ...(await svc.list({ listingId: request.params.listingId, limit: 100 })) }),
  })

  fastify.post('/listing/:listingId', {
    preHandler: manage,
    handler: async (request, reply) => {
      try {
        const { fields, file } = await readForm(request)
        const data = await svc.create(request.params.listingId, fields, file, { actorId: request.user?.id })
        return reply.status(201).send({ success: true, data })
      } catch (e) { return send(reply, e) }
    },
  })

  fastify.get('/:id', {
    preHandler: view,
    handler: async (request, reply) => {
      try { return { success: true, data: await svc.get(request.params.id) } } catch (e) { return send(reply, e) }
    },
  })

  fastify.get('/:id/file', {
    preHandler: view,
    handler: async (request, reply) => { try { return await streamFile(svc, request, reply, null) } catch (e) { return send(reply, e) } },
  })

  fastify.post('/:id/verify', {
    preHandler: manage,
    handler: async (request, reply) => {
      try { return { success: true, data: await svc.verify(request.params.id, request.user?.id) } } catch (e) { return send(reply, e) }
    },
  })

  fastify.post('/:id/reject', {
    preHandler: manage,
    schema: { body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', maxLength: 500 } } } },
    handler: async (request, reply) => {
      try { return { success: true, data: await svc.reject(request.params.id, request.body.reason, request.user?.id) } } catch (e) { return send(reply, e) }
    },
  })

  fastify.delete('/:id', {
    preHandler: manage,
    handler: async (request, reply) => {
      try { await svc.remove(request.params.id); return { success: true } } catch (e) { return send(reply, e) }
    },
  })
}

export const vendorInvoicesRoutes = async function invoicesVendorRoutes(fastify) {
  const pre = [fastify.authenticate, requireVendorScope({ requireVendor: true })]
  const svc = invoicesService

  fastify.get('/', {
    preHandler: pre,
    handler: async (request) => {
      const { status = '', search = '', page = 1, limit = 25 } = request.query || {}
      return { success: true, ...(await svc.list({ status: String(status), search: String(search), vendorId: request.vendorId, page, limit })) }
    },
  })

  fastify.get('/listing/:listingId', {
    preHandler: pre,
    handler: async (request) => ({ success: true, ...(await svc.list({ listingId: request.params.listingId, vendorId: request.vendorId, limit: 100 })) }),
  })

  fastify.post('/listing/:listingId', {
    preHandler: pre,
    handler: async (request, reply) => {
      try {
        const { fields, file } = await readForm(request)
        const data = await svc.create(request.params.listingId, fields, file, { vendorId: request.vendorId, actorId: request.user?.id })
        return reply.status(201).send({ success: true, data })
      } catch (e) { return send(reply, e) }
    },
  })

  fastify.get('/:id/file', {
    preHandler: pre,
    handler: async (request, reply) => { try { return await streamFile(svc, request, reply, request.vendorId) } catch (e) { return send(reply, e) } },
  })

  fastify.delete('/:id', {
    preHandler: pre,
    handler: async (request, reply) => {
      try { await svc.remove(request.params.id, request.vendorId); return { success: true } } catch (e) { return send(reply, e) }
    },
  })
}
