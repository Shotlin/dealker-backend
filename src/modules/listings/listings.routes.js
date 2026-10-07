import { listingsService as svc } from './listings.service.js'
import { requireVendorScope } from '../../middlewares/vendor-scope.js'

const wrap = (fn) => async (req, reply) => {
  try { return await fn(req, reply) } catch (e) {
    if (e?.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ success: false, message: e.message, code: e.code })
    throw e
  }
}

const bodySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 3, maxLength: 200 }, brand: { type: 'string', maxLength: 100 },
    categoryId: { type: 'string', format: 'uuid' }, ownerVendorId: { type: 'string', format: 'uuid' }, description: { type: 'string', maxLength: 5000 },
    condition: { enum: ['NEW', 'OPEN_BOX', 'REFURBISHED', 'USED_LIKE_NEW', 'USED_GOOD', 'USED_FAIR'] },
    conditionNotes: { type: 'string', maxLength: 1000 }, usageDuration: { type: 'string', maxLength: 100 },
    warrantyInfo: { type: 'string', maxLength: 200 }, accessoriesIncluded: { type: 'string', maxLength: 300 },
    batteryHealth: { type: ['integer', 'null'], minimum: 1, maximum: 100 }, serialNumber: { type: 'string', maxLength: 100 },
    hasInvoice: { type: 'boolean' }, images: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    price: { type: 'number', minimum: 0 }, mrp: { type: ['number', 'null'], minimum: 0 }, stock: { type: 'integer', minimum: 0, maximum: 100000 },
    sku: { type: 'string', maxLength: 80 }, hsnCode: { type: 'string', maxLength: 20 }, gstRate: { type: ['number', 'null'] },
    specifications: { type: 'object' }, handlingTimeDays: { type: 'integer', minimum: 0, maximum: 30 }, returnPolicyDays: { type: 'integer', minimum: 0, maximum: 60 },
    codEligible: { type: 'boolean' }, nationwide: { type: 'boolean' }, localDelivery: { type: 'boolean' }, weightGrams: { type: ['integer', 'null'], minimum: 1 },
  },
  additionalProperties: false,
}

/** Admin: every listing (admin + vendor) — /api/v1/admin/listings */
export async function adminListingRoutes(fastify) {
  const pre = [fastify.authenticate, fastify.requireAdmin]
  const scope = (req) => ({ vendorId: null, actorId: req.userId || req.user.id })

  fastify.get('/', { preHandler: pre }, wrap(async (req) => ({ success: true, ...(await svc.list(scope(req), req.query || {})) })))
  fastify.get('/stats', { preHandler: pre }, wrap(async (req) => ({ success: true, data: await svc.stats(scope(req)) })))
  fastify.get('/vendors', { preHandler: pre }, wrap(async () => ({ success: true, data: await svc.vendorsFilter() })))
  fastify.get('/:id', { preHandler: pre }, wrap(async (req) => ({ success: true, data: await svc.detail(req.params.id, scope(req)) })))
  fastify.post('/', { preHandler: pre, schema: { body: bodySchema } }, wrap(async (req, reply) =>
    reply.code(201).send({ success: true, data: await svc.create(req.body, scope(req)) })))
  fastify.patch('/:id', { preHandler: pre, schema: { body: bodySchema } }, wrap(async (req) =>
    ({ success: true, data: await svc.update(req.params.id, req.body, scope(req)) })))
  fastify.post('/:id/approve', { preHandler: pre }, wrap(async (req) => ({ success: true, data: await svc.approve(req.params.id, scope(req).actorId) })))
  fastify.post('/:id/reject', { preHandler: pre, schema: { body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', maxLength: 500 } } } } },
    wrap(async (req) => ({ success: true, data: await svc.reject(req.params.id, req.body.reason, scope(req).actorId) })))
  fastify.patch('/:id/status', { preHandler: pre, schema: { body: { type: 'object', required: ['listingStatus'], properties: { listingStatus: { enum: ['ACTIVE', 'PAUSED'] } } } } },
    wrap(async (req) => ({ success: true, data: await svc.setStatus(req.params.id, req.body.listingStatus, scope(req)) })))
  fastify.delete('/:id', { preHandler: pre }, wrap(async (req) => { await svc.remove(req.params.id, scope(req)); return { success: true } }))
}

/** Vendor: own listings only — /api/v1/vendor/listings (always created as PENDING) */
export async function vendorListingRoutes(fastify) {
  const pre = [fastify.authenticate, requireVendorScope({ requireVendor: true })]
  const scope = (req) => ({ vendorId: req.vendorId, actorId: req.userId || req.user.id })

  fastify.get('/', { preHandler: pre }, wrap(async (req) => ({ success: true, ...(await svc.list(scope(req), req.query || {})) })))
  fastify.get('/stats', { preHandler: pre }, wrap(async (req) => ({ success: true, data: await svc.stats(scope(req)) })))
  fastify.get('/:id', { preHandler: pre }, wrap(async (req) => ({ success: true, data: await svc.detail(req.params.id, scope(req)) })))
  fastify.post('/', { preHandler: pre, schema: { body: bodySchema } }, wrap(async (req, reply) =>
    reply.code(201).send({ success: true, data: await svc.create(req.body, scope(req)) })))
  fastify.patch('/:id', { preHandler: pre, schema: { body: bodySchema } }, wrap(async (req) =>
    ({ success: true, data: await svc.update(req.params.id, req.body, scope(req)) })))
  fastify.patch('/:id/status', { preHandler: pre, schema: { body: { type: 'object', required: ['listingStatus'], properties: { listingStatus: { enum: ['ACTIVE', 'PAUSED'] } } } } },
    wrap(async (req) => ({ success: true, data: await svc.setStatus(req.params.id, req.body.listingStatus, scope(req)) })))
  fastify.delete('/:id', { preHandler: pre }, wrap(async (req) => { await svc.remove(req.params.id, scope(req)); return { success: true } }))
}
