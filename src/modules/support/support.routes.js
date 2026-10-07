import { supportService as svc } from './support.service.js'

const uuid = { type: 'string', format: 'uuid' }
const STATUS = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REOPENED']
const PRIORITY = ['LOW', 'NORMAL', 'HIGH', 'URGENT']
const CATEGORY = ['GENERAL', 'ORDER', 'DELIVERY', 'RETURN_REFUND', 'PAYMENT', 'PRODUCT', 'ACCOUNT', 'SELLER']

const wrap = (fn) => async (req, reply) => {
  try {
    return await fn(req, reply)
  } catch (err) {
    const status = err?.statusCode
    if (status && status < 500) return reply.code(status).send({ success: false, message: err.message, code: err.code })
    throw err
  }
}

/** Admin / team inbox — mounted at /api/v1/admin/support */
export async function adminSupportRoutes(fastify) {
  const pre = [fastify.authenticate, fastify.requireAdmin]
  const me = (req) => req.userId || req.user.id

  fastify.get('/stats', { preHandler: pre }, wrap(async (req) => ({ success: true, data: await svc.stats(me(req)) })))
  fastify.get('/agents', { preHandler: pre }, wrap(async () => ({ success: true, data: await svc.agents() })))
  fastify.get('/canned-replies', { preHandler: pre }, wrap(async () => ({ success: true, data: await svc.canned() })))

  fastify.get('/tickets', { preHandler: pre }, wrap(async (req) => ({ success: true, ...(await svc.list(me(req), req.query || {})) })))

  fastify.post('/tickets/start', {
    preHandler: pre,
    schema: { body: { type: 'object', properties: { orderId: uuid, refundRequestId: uuid }, additionalProperties: false } },
  }, wrap(async (req) => ({ success: true, data: await svc.startFromContext({ ...req.body, actorId: me(req) }) })))

  fastify.get('/tickets/:id', { preHandler: pre, schema: { params: { type: 'object', properties: { id: uuid } } } },
    wrap(async (req) => ({ success: true, data: await svc.detail(req.params.id) })))

  fastify.post('/tickets/:id/read', { preHandler: pre }, wrap(async (req) => { await svc.markRead(req.params.id, 'agent'); return { success: true } }))

  fastify.post('/tickets/:id/messages', {
    preHandler: pre,
    schema: { body: { type: 'object', required: ['body'], properties: { body: { type: 'string', minLength: 1, maxLength: 4000 }, internal: { type: 'boolean' } }, additionalProperties: false } },
  }, wrap(async (req, reply) => reply.code(201).send({
    success: true,
    data: await svc.addMessage(req.params.id, { body: req.body.body, internal: req.body.internal, sender: { type: 'AGENT', id: me(req) } }),
  })))

  fastify.patch('/tickets/:id', {
    preHandler: pre,
    schema: { body: { type: 'object', properties: { status: { enum: STATUS }, priority: { enum: PRIORITY }, category: { enum: CATEGORY } }, additionalProperties: false } },
  }, wrap(async (req) => ({ success: true, data: await svc.update(req.params.id, req.body, me(req)) })))

  fastify.post('/tickets/:id/assign', {
    preHandler: pre,
    schema: { body: { type: 'object', required: ['assigneeId'], properties: { assigneeId: { anyOf: [uuid, { type: 'null' }] } }, additionalProperties: false } },
  }, wrap(async (req) => ({ success: true, data: await svc.assign(req.params.id, req.body.assigneeId, me(req)) })))
}

/** Customer-facing chat — mounted at /api/v1/support (mobile app + web) */
export async function customerSupportRoutes(fastify) {
  const pre = [fastify.authenticate]
  const me = (req) => req.userId || req.user.id

  fastify.get('/tickets', { preHandler: pre }, wrap(async (req) => ({ success: true, data: await svc.listMine(me(req)) })))

  fastify.post('/tickets', {
    preHandler: pre,
    schema: { body: { type: 'object', required: ['subject', 'message'], properties: {
      subject: { type: 'string', minLength: 3, maxLength: 200 }, message: { type: 'string', minLength: 1, maxLength: 4000 },
      category: { enum: CATEGORY }, orderId: uuid, refundRequestId: uuid }, additionalProperties: false } },
  }, wrap(async (req, reply) => {
    const data = await svc.create({ userId: me(req), ...req.body, channel: 'APP' })
    return reply.code(201).send({ success: true, data })
  }))

  fastify.get('/tickets/:id', { preHandler: pre }, wrap(async (req) => {
    const data = await svc.detail(req.params.id, { forCustomerId: me(req) })
    await svc.markRead(req.params.id, 'customer')
    return { success: true, data: { ticket: data.ticket, messages: data.messages } }
  }))

  fastify.post('/tickets/:id/messages', {
    preHandler: pre,
    schema: { body: { type: 'object', required: ['body'], properties: { body: { type: 'string', minLength: 1, maxLength: 4000 } }, additionalProperties: false } },
  }, wrap(async (req, reply) => reply.code(201).send({
    success: true, data: await svc.addMessage(req.params.id, { body: req.body.body, sender: { type: 'CUSTOMER', id: me(req) } }),
  })))
}
