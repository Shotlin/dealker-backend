/**
 * Vendor deal-entry routes — mounted at /api/v1/vendor/deals.
 * A vendor sees deals opened to vendors, picks its own live listings and waits for approval.
 */
import { requireVendorScope } from '../../middlewares/vendor-scope.js'
import { DealEntriesService } from './deal-entries.service.js'

export const dealEntriesService = new DealEntriesService()

const wrap = (fn) => async (req, reply) => {
  try { return await fn(req, reply) } catch (e) {
    if (e?.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ success: false, message: e.message, code: e.code })
    throw e
  }
}
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }

export async function vendorDealRoutes(fastify) {
  const pre = [fastify.authenticate, requireVendorScope({ requireVendor: true })]
  const svc = dealEntriesService

  fastify.get('/', { preHandler: pre }, wrap(async (req) => ({ success: true, data: await svc.listOpenForVendor(req.vendorId) })))
  fastify.get('/:id', { preHandler: pre, schema: { params: idParams } }, wrap(async (req) => ({ success: true, data: await svc.detailForVendor(req.params.id, req.vendorId) })))
  fastify.get('/:id/listings', { preHandler: pre, schema: { params: idParams } }, wrap(async (req) => ({ success: true, data: await svc.eligibleListings(req.params.id, req.vendorId) })))
  fastify.post('/:id/entries', {
    preHandler: pre,
    schema: { params: idParams, body: { type: 'object', required: ['listingIds'], properties: { listingIds: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: 100 } } } },
  }, wrap(async (req, reply) => reply.code(201).send({ success: true, data: await svc.apply(req.params.id, req.vendorId, req.body.listingIds) })))
  fastify.delete('/:id/entries/:entryId', {
    preHandler: pre,
    schema: { params: { type: 'object', required: ['id', 'entryId'], properties: { id: { type: 'string', format: 'uuid' }, entryId: { type: 'string', format: 'uuid' } } } },
  }, wrap(async (req) => ({ success: true, data: await svc.withdraw(req.params.id, req.params.entryId, req.vendorId) })))
}
