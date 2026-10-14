/**
 * Vendor KYC files — mounted under /api/v1/vendor-kyc next to the existing KYC routes.
 *   POST /:vendorId/files                      upload one document file (multipart, field `file`)
 *   POST /:vendorId/documents                  attach an uploaded file as a document of a given type
 *   POST /:vendorId/submit-review              send the application for review (onboarding / correction only)
 *   GET  /:vendorId/documents/:docId/link      fresh signed link to view the vendor's own document
 *   GET  /file/:docId?exp&sig                  the file itself (signed link, no bearer token)
 * The vendor acted on is always the caller's own (request.vendorId), never the id in the URL.
 */
import fs from 'node:fs'

import { requireVendorScope } from '../../middlewares/vendor-scope.js'
import { requirePermission } from '../../middlewares/permission-check.js'
import {
  DOC_TYPES, attachDocument, linkFor, loadDocForRead, saveDocumentFile, submitForReview, verifyDoc,
} from './vendor-kyc-files.service.js'

const wrap = (fn) => async (req, reply) => {
  try { return await fn(req, reply) } catch (e) {
    if (e?.statusCode && e.statusCode < 500) {
      // 409/422 rather than 401/403: the global handler remaps thrown 401/403 from non-Fastify errors to 502.
      return reply.code(e.statusCode).send({ success: false, code: e.code, message: e.message, ...(e.missing ? { missing: e.missing } : {}) })
    }
    throw e
  }
}

export async function vendorKycFilesRoutes(fastify) {
  const pre = () => [fastify.authenticate, requirePermission('vendors.update'), requireVendorScope({ allowOnboarding: true })]

  fastify.post('/:vendorId/files', { preHandler: pre(), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, wrap(async (req, reply) => {
    // An empty upload can leave the multipart parser waiting; answer with a clean error instead of hanging.
    const part = await Promise.race([
      req.file({ limits: { files: 1, fileSize: 9 * 1024 * 1024 } }),
      new Promise((resolve) => setTimeout(() => resolve(null), 15000)),
    ])
    if (!part) return reply.code(400).send({ success: false, code: 'NO_FILE', message: 'No file received' })
    return reply.code(201).send({ success: true, data: await saveDocumentFile(req.vendorId, part) })
  }))

  fastify.post('/:vendorId/documents', {
    preHandler: pre(),
    schema: { body: { type: 'object', required: ['document_type', 'file_key'], additionalProperties: false, properties: {
      document_type: { type: 'string', enum: DOC_TYPES }, document_number: { type: ['string', 'null'], maxLength: 100 }, file_key: { type: 'string', maxLength: 255 },
    } } },
  }, wrap(async (req, reply) => reply.code(201).send({ success: true, data: await attachDocument(req.vendorId, req.body) })))

  fastify.post('/:vendorId/submit-review', { preHandler: pre() }, wrap(async (req) => ({ success: true, data: await submitForReview(req.vendorId) })))

  fastify.get('/:vendorId/documents/:docId/link', { preHandler: pre(), schema: { params: { type: 'object', properties: { docId: { type: 'string', format: 'uuid' } }, required: ['docId'] } } },
    wrap(async (req) => ({ success: true, data: await linkFor(req.vendorId, req.params.docId) })))

  fastify.get('/file/:docId', { schema: { params: { type: 'object', properties: { docId: { type: 'string', format: 'uuid' } }, required: ['docId'] } } }, async (req, reply) => {
    const { exp, sig } = req.query || {}
    if (!verifyDoc(req.params.docId, exp, sig)) return reply.code(403).send({ success: false, code: 'LINK_INVALID', message: 'This link is invalid or has expired' })
    const d = await loadDocForRead(req.params.docId)
    if (!d) return reply.code(404).send({ success: false, code: 'NOT_FOUND', message: 'File not found' })
    let stat
    try { stat = await fs.promises.stat(d.abs) } catch { return reply.code(404).send({ success: false, code: 'FILE_MISSING', message: 'File not found' }) }
    return reply
      .header('Content-Type', d.mime).header('Content-Length', stat.size)
      .header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cross-Origin-Resource-Policy', 'cross-origin').header('Cache-Control', 'private, max-age=300').header('Content-Disposition', 'inline')
      .send(fs.createReadStream(d.abs))
  })
}
