import { refundCaseService as svc } from './refund-case.service.js'

const uuid = { type: 'string', format: 'uuid' }
const SIDE = ['CUSTOMER', 'SELLER', 'COURIER', 'TEAM']
const KIND = ['IMAGE', 'VIDEO', 'AUDIO', 'INVOICE', 'DOCUMENT']
const idParams = { type: 'object', properties: { id: uuid } }

const wrap = (fn) => async (req, reply) => {
  try {
    return await fn(req, reply)
  } catch (err) {
    const status = err?.statusCode
    if (status && status < 500) return reply.code(status).send({ success: false, message: err.message, code: err.code })
    throw err
  }
}

/**
 * Staff-only investigation around a refund request.
 * Mounted at /api/v1/admin/refund-requests — every route is /:id/case/…
 */
export default async function refundCaseRoutes(fastify) {
  const pre = [fastify.authenticate, fastify.requireAdmin]
  const me = (req) => req.userId || req.user.id
  const ok = (data) => ({ success: true, data })

  fastify.get('/:id/case', { preHandler: pre, schema: { params: idParams } }, wrap(async (req) => ok(await svc.get(req.params.id))))

  fastify.post('/:id/case/start', {
    preHandler: pre,
    schema: { params: idParams, body: { type: 'object', properties: { ownerId: uuid, dueInDays: { type: 'integer', minimum: 1, maximum: 30 }, note: { type: 'string', maxLength: 500 } }, additionalProperties: false } },
  }, wrap(async (req) => { await svc.start(req.params.id, req.body || {}, me(req)); return ok(await svc.get(req.params.id)) }))

  fastify.patch('/:id/case', {
    preHandler: pre,
    schema: {
      params: idParams,
      body: { type: 'object', additionalProperties: false, properties: {
        status: { enum: ['OPEN', 'WAITING_CUSTOMER', 'WAITING_SELLER', 'READY_TO_DECIDE'] },
        ownerId: { anyOf: [uuid, { type: 'null' }] },
        dueAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
        findings: { type: 'string', maxLength: 4000 },
        verdict: { anyOf: [{ enum: ['CUSTOMER_RIGHT', 'SELLER_RIGHT', 'PARTLY_BOTH'] }, { type: 'null' }] },
      } },
    },
  }, wrap(async (req) => { await svc.update(req.params.id, req.body, me(req)); return ok(await svc.get(req.params.id)) }))

  fastify.post('/:id/case/notes', {
    preHandler: pre,
    schema: { params: idParams, body: { type: 'object', required: ['body'], properties: { body: { type: 'string', minLength: 1, maxLength: 2000 }, party: { enum: SIDE } }, additionalProperties: false } },
  }, wrap(async (req, reply) => { await svc.addNote(req.params.id, req.body, me(req)); return reply.code(201).send(ok(await svc.get(req.params.id))) }))

  fastify.post('/:id/case/calls', {
    preHandler: pre,
    schema: { params: idParams, body: { type: 'object', required: ['party', 'summary'], additionalProperties: false, properties: {
      party: { enum: ['CUSTOMER', 'SELLER', 'COURIER'] }, direction: { enum: ['OUTGOING', 'INCOMING'] }, outcome: { enum: ['SPOKE', 'NO_ANSWER'] },
      person: { type: 'string', maxLength: 120 }, summary: { type: 'string', minLength: 3, maxLength: 3000 }, minutes: { type: 'integer', minimum: 0, maximum: 600 },
      recordingUrl: { type: 'string', maxLength: 1000 } } } },
  }, wrap(async (req, reply) => { await svc.logCall(req.params.id, req.body, me(req)); return reply.code(201).send(ok(await svc.get(req.params.id))) }))

  fastify.post('/:id/case/evidence', {
    preHandler: pre,
    schema: { params: idParams, body: { type: 'object', required: ['side', 'kind', 'url', 'title'], additionalProperties: false, properties: {
      side: { enum: SIDE }, kind: { enum: KIND }, url: { type: 'string', minLength: 4, maxLength: 1000 }, title: { type: 'string', minLength: 2, maxLength: 200 }, note: { type: 'string', maxLength: 1000 } } } },
  }, wrap(async (req, reply) => { await svc.addEvidence(req.params.id, req.body, me(req)); return reply.code(201).send(ok(await svc.get(req.params.id))) }))

  fastify.patch('/:id/case/evidence/:evidenceId', {
    preHandler: pre,
    schema: { params: { type: 'object', properties: { id: uuid, evidenceId: uuid } }, body: { type: 'object', required: ['review'], additionalProperties: false, properties: {
      review: { enum: ['UNREVIEWED', 'SUPPORTS_CUSTOMER', 'SUPPORTS_SELLER', 'NOT_USEFUL'] }, note: { type: 'string', maxLength: 500 } } } },
  }, wrap(async (req) => { await svc.reviewEvidence(req.params.id, req.params.evidenceId, req.body, me(req)); return ok(await svc.get(req.params.id)) }))

  fastify.delete('/:id/case/evidence/:evidenceId', {
    preHandler: pre,
    schema: { params: { type: 'object', properties: { id: uuid, evidenceId: uuid } } },
  }, wrap(async (req) => { await svc.removeEvidence(req.params.id, req.params.evidenceId, me(req)); return ok(await svc.get(req.params.id)) }))

  fastify.put('/:id/case/checks/:key', {
    preHandler: pre,
    schema: { params: { type: 'object', properties: { id: uuid, key: { type: 'string' } } }, body: { type: 'object', required: ['done'], additionalProperties: false, properties: { done: { type: 'boolean' }, note: { type: 'string', maxLength: 500 } } } },
  }, wrap(async (req) => { await svc.setCheck(req.params.id, req.params.key, req.body, me(req)); return ok(await svc.get(req.params.id)) }))
}
