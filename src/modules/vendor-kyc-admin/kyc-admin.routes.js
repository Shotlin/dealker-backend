import { kycAdmin } from './kyc-admin.service.js'

const wrap = (fn) => async (req, reply) => {
  try { return await fn(req, reply) } catch (e) {
    if (e?.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ success: false, message: e.message, code: e.code })
    throw e
  }
}

/** Admin vendor-KYC review — /api/v1/admin/vendor-kyc */
export default async function kycAdminRoutes(fastify) {
  const pre = [fastify.authenticate, fastify.requireAdmin]
  const me = (req) => req.userId || req.user.id
  const uuid = { type: 'string', format: 'uuid' }

  fastify.get('/summary', { preHandler: pre }, wrap(async () => ({ success: true, data: await kycAdmin.summary() })))
  fastify.get('/', { preHandler: pre }, wrap(async (req) => ({ success: true, ...(await kycAdmin.list(req.query || {})) })))
  fastify.get('/:vendorId', { preHandler: pre }, wrap(async (req) => ({ success: true, data: await kycAdmin.detail(req.params.vendorId) })))
  fastify.post('/:vendorId/review', {
    preHandler: pre,
    schema: { body: { type: 'object', required: ['action'], properties: {
      action: { enum: ['START_REVIEW', 'APPROVE', 'ACTIVATE', 'REQUEST_CORRECTION', 'REJECT', 'SUSPEND', 'REINSTATE'] },
      comments: { type: 'string', maxLength: 500 }, override: { type: 'boolean' } }, additionalProperties: false } },
  }, wrap(async (req) => ({ success: true, data: await kycAdmin.review(req.params.vendorId, req.body, me(req)) })))
  fastify.post('/:vendorId/documents/:docId/review', {
    preHandler: pre,
    schema: { body: { type: 'object', required: ['status'], properties: { status: { enum: ['VERIFIED', 'REJECTED', 'PENDING'] }, reason: { type: 'string', maxLength: 300 } }, additionalProperties: false },
      params: { type: 'object', properties: { vendorId: uuid, docId: uuid } } },
  }, wrap(async (req) => ({ success: true, data: await kycAdmin.reviewDocument(req.params.vendorId, req.params.docId, req.body, me(req)) })))
}
