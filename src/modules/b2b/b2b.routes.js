import { b2b } from './b2b.service.js'
import { requireVendorScope } from '../../middlewares/vendor-scope.js'

const uuid = { type: 'string', format: 'uuid' }
const wrap = (fn) => async (req, reply) => {
  try { return await fn(req, reply) } catch (e) {
    if (e?.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ success: false, message: e.message, code: e.code })
    throw e
  }
}

const requirementBody = {
  type: 'object', required: ['productName', 'quantity', 'responseDeadline'],
  properties: {
    title: { type: 'string', maxLength: 200 }, productName: { type: 'string', minLength: 2, maxLength: 200 }, brand: { type: 'string', maxLength: 100 },
    categoryId: uuid, conditionPref: { enum: ['ANY', 'NEW', 'USED_OR_REFURBISHED'] }, quantity: { type: 'integer', minimum: 1, maximum: 100000 },
    targetPrice: { type: ['number', 'null'], minimum: 0 }, description: { type: 'string', maxLength: 3000 }, deliveryCity: { type: 'string', maxLength: 100 },
    deliveryPincode: { type: 'string', maxLength: 10 }, responseDeadline: { type: 'string' }, requiredBy: { type: 'string' },
  }, additionalProperties: false,
}
const quoteBody = {
  type: 'object', required: ['quantity', 'unitPrice'],
  properties: {
    quantity: { type: 'integer', minimum: 1 }, unitPrice: { type: 'number', minimum: 0 },
    condition: { enum: ['NEW', 'OPEN_BOX', 'REFURBISHED', 'USED_LIKE_NEW', 'USED_GOOD', 'USED_FAIR'] },
    deliveryDays: { type: 'integer', minimum: 0, maximum: 60 }, note: { type: 'string', maxLength: 1000 }, photos: { type: 'array', items: { type: 'string' }, maxItems: 6 },
  }, additionalProperties: false,
}

/** Vendor app — /api/v1/vendor/b2b (same mobile app as customers; vendor mode) */
export async function vendorB2bRoutes(fastify) {
  const pre = [fastify.authenticate, requireVendorScope({ requireVendor: true })]
  const actor = (req) => ({ userId: req.userId || req.user.id, vendorId: req.vendorId, label: 'Vendor' })

  fastify.get('/requirements', { preHandler: pre }, wrap(async (req) => ({ success: true, ...(await b2b.listForVendor(req.vendorId, req.query || {})) })))
  fastify.post('/requirements', { preHandler: pre, schema: { body: requirementBody } }, wrap(async (req, reply) =>
    reply.code(201).send({ success: true, data: await b2b.createRequirement(req.body, actor(req)) })))
  fastify.get('/requirements/:id', { preHandler: pre }, wrap(async (req) => ({ success: true, data: await b2b.detail(req.params.id, { vendorId: req.vendorId }) })))
  fastify.post('/requirements/:id/cancel', { preHandler: pre }, wrap(async (req) => { await b2b.cancelRequirement(req.params.id, actor(req), req.body?.reason); return { success: true } }))

  fastify.post('/requirements/:id/quote', { preHandler: pre, schema: { body: quoteBody } }, wrap(async (req) =>
    ({ success: true, data: await b2b.upsertQuote(req.params.id, req.vendorId, req.body, actor(req)) })))
  fastify.post('/quotes/:quoteId/withdraw', { preHandler: pre }, wrap(async (req) => { await b2b.withdrawQuote(req.params.quoteId, req.vendorId); return { success: true } }))

  fastify.post('/requirements/:id/award', {
    preHandler: pre,
    schema: { body: { type: 'object', required: ['selections'], properties: { selections: { type: 'array', minItems: 1, items: { type: 'object', required: ['quoteId', 'quantity'], properties: { quoteId: uuid, quantity: { type: 'integer', minimum: 1 } } } } } } },
  }, wrap(async (req) => ({ success: true, data: await b2b.award(req.params.id, req.body.selections, actor(req)) })))
  fastify.post('/requirements/:id/pay', { preHandler: pre }, wrap(async (req) => ({ success: true, data: await b2b.pay(req.params.id, req.body || {}, actor(req)) })))

  fastify.get('/orders', { preHandler: pre }, wrap(async (req) =>
    ({ success: true, ...(await b2b.listOrders({ vendorId: req.vendorId, role: req.query?.role === 'selling' ? 'selling' : 'buying', status: req.query?.status, page: req.query?.page })) })))
  fastify.post('/orders/:id/status', {
    preHandler: pre,
    schema: { body: { type: 'object', required: ['status'], properties: { status: { enum: ['PACKED', 'DISPATCHED', 'DELIVERED'] }, courierName: { type: 'string' }, awb: { type: 'string' }, trackingUrl: { type: 'string' } } } },
  }, wrap(async (req) => { await b2b.sellerUpdate(req.params.id, req.vendorId, req.body, actor(req)); return { success: true } }))
  fastify.post('/orders/:id/receive', {
    preHandler: pre,
    schema: { body: { type: 'object', properties: { receivedQuantity: { type: 'integer', minimum: 0 }, ok: { type: 'boolean' }, note: { type: 'string', maxLength: 1000 } } } },
  }, wrap(async (req) => { await b2b.receive(req.params.id, req.body || {}, actor(req)); return { success: true } }))
}

/** Admin dashboard — /api/v1/admin/b2b */
export async function adminB2bRoutes(fastify) {
  const pre = [fastify.authenticate, fastify.requireAdmin]
  const actor = (req) => ({ userId: req.userId || req.user.id, isAdmin: true, label: 'Dealker admin' })

  fastify.get('/stats', { preHandler: pre }, wrap(async () => ({ success: true, data: await b2b.stats() })))
  fastify.get('/requirements', { preHandler: pre }, wrap(async (req) => ({ success: true, ...(await b2b.adminRequirements(req.query || {})) })))
  fastify.get('/requirements/:id', { preHandler: pre }, wrap(async (req) => ({ success: true, data: await b2b.detail(req.params.id, { isAdmin: true }) })))
  fastify.post('/requirements/:id/cancel', { preHandler: pre }, wrap(async (req) => { await b2b.cancelRequirement(req.params.id, actor(req), req.body?.reason); return { success: true } }))
  fastify.get('/orders', { preHandler: pre }, wrap(async (req) => ({ success: true, ...(await b2b.listOrders({ ...(req.query || {}) })) })))
  fastify.get('/vendors', { preHandler: pre }, wrap(async () => ({ success: true, data: await b2b.vendorOptions() })))

  // ── Admin acts on behalf of vendors ───────────────────────────────────
  fastify.post('/requirements', {
    preHandler: pre,
    schema: { body: { ...requirementBody, properties: { ...requirementBody.properties, buyerVendorId: { anyOf: [uuid, { type: 'null' }] } } } },
  }, wrap(async (req, reply) => {
    const { buyerVendorId = null, ...input } = req.body
    return reply.code(201).send({ success: true, data: await b2b.createRequirement(input, { ...actor(req), vendorId: buyerVendorId }) })
  }))
  fastify.post('/requirements/:id/quote', {
    preHandler: pre,
    schema: { body: { ...quoteBody, required: ['sellerVendorId', 'quantity', 'unitPrice'], properties: { ...quoteBody.properties, sellerVendorId: uuid } } },
  }, wrap(async (req) => {
    const { sellerVendorId, ...input } = req.body
    return { success: true, data: await b2b.upsertQuote(req.params.id, sellerVendorId, input, actor(req)) }
  }))
  fastify.post('/quotes/:quoteId/withdraw', { preHandler: pre }, wrap(async (req) => { await b2b.withdrawQuote(req.params.quoteId, null, true); return { success: true } }))
  fastify.post('/requirements/:id/award', {
    preHandler: pre,
    schema: { body: { type: 'object', required: ['selections'], properties: { selections: { type: 'array', minItems: 1, items: { type: 'object', required: ['quoteId', 'quantity'], properties: { quoteId: uuid, quantity: { type: 'integer', minimum: 1 } } } } } } },
  }, wrap(async (req) => ({ success: true, data: await b2b.award(req.params.id, req.body.selections, actor(req)) })))
  fastify.post('/requirements/:id/pay', { preHandler: pre }, wrap(async (req) => ({ success: true, data: await b2b.pay(req.params.id, req.body || {}, actor(req)) })))
  fastify.post('/orders/:id/status', {
    preHandler: pre,
    schema: { body: { type: 'object', required: ['status'], properties: { status: { enum: ['PACKED', 'DISPATCHED', 'DELIVERED'] }, courierName: { type: 'string' }, awb: { type: 'string' }, trackingUrl: { type: 'string' } } } },
  }, wrap(async (req) => { await b2b.sellerUpdate(req.params.id, null, req.body, actor(req)); return { success: true } }))
  fastify.post('/orders/:id/receive', {
    preHandler: pre,
    schema: { body: { type: 'object', properties: { receivedQuantity: { type: 'integer', minimum: 0 }, ok: { type: 'boolean' }, note: { type: 'string', maxLength: 1000 } } } },
  }, wrap(async (req) => { await b2b.receive(req.params.id, req.body || {}, actor(req)); return { success: true } }))
  fastify.post('/orders/:id/resolve', {
    preHandler: pre,
    schema: { body: { type: 'object', required: ['decision'], properties: { decision: { enum: ['RELEASE', 'REFUND', 'PARTIAL'] }, releaseQuantity: { type: 'integer', minimum: 1 }, note: { type: 'string', maxLength: 500 } } } },
  }, wrap(async (req) => { await b2b.resolveDispute(req.params.id, req.body, actor(req)); return { success: true } }))
  fastify.get('/settings', { preHandler: pre }, wrap(async () => ({ success: true, data: await b2b.getSettings() })))
  fastify.put('/settings', { preHandler: pre, schema: { body: { type: 'object', required: ['defaultPercent'], properties: { defaultPercent: { type: 'number' } } } } },
    wrap(async (req) => { await b2b.setDefaultCommission(Number(req.body.defaultPercent)); return { success: true, data: await b2b.getSettings() } }))
  fastify.put('/vendors/:vendorId/commission', { preHandler: pre, schema: { body: { type: 'object', required: ['percent'], properties: { percent: { type: ['number', 'null'] } } } } },
    wrap(async (req) => { await b2b.setVendorCommission(req.params.vendorId, req.body.percent); return { success: true, data: await b2b.getSettings() } }))
}
