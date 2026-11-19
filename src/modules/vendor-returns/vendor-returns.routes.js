/**
 * Vendor returns routes — /api/v1/manage/returns (vendors only; the Dealkr team uses /admin/refund-requests).
 *
 * @module modules/vendor-returns/vendor-returns.routes
 */

import { isPlatformUser, requireVendorScope } from '../../middlewares/vendor-scope.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { NotificationsRepository } from '../notifications/notifications.repository.js'
import * as svc from './vendor-returns.service.js'

const uuid = { type: 'string', format: 'uuid' }
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } }

export default async function vendorReturnsRoutes(fastify) {
  svc.setNotifier(new NotificationsService(new NotificationsRepository(), fastify))
  const vendorOnly = async (request, reply) => {
    if (!request.vendorId || isPlatformUser(request.user)) {
      return reply.code(403).send({ success: false, code: 'FORBIDDEN', message: 'Only vendors can do this' })
    }
  }
  const pre = [fastify.authenticate, requireVendorScope(), vendorOnly]
  const wrap = (fn) => async (request, reply) => {
    try {
      return await fn(request)
    } catch (err) {
      if (err instanceof svc.VendorReturnError) {
        return reply.code(err.statusCode).send({ success: false, code: err.code, message: err.message, ...err.details })
      }
      if (err?.statusCode && err.statusCode < 500) {
        return reply.code(err.statusCode).send({ success: false, code: err.code, message: err.message })
      }
      throw err
    }
  }
  const ok = (data) => ({ success: true, data })
  const uid = (r) => r.userId || r.user.id

  fastify.get('/summary', { preHandler: pre }, wrap(async (r) => ok(await svc.summary(r.vendorId, uid(r)))))

  fastify.get('/', {
    preHandler: pre,
    schema: {
      tags: ['Vendor Returns'],
      querystring: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['open', 'needs_response', 'closed'] },
          search: { type: 'string', maxLength: 60 },
          sellerOrderId: uuid,
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
    },
  }, wrap(async (r) => {
    const out = await svc.list(r.vendorId, uid(r), r.query || {})
    return { success: true, ...out }
  }))

  fastify.get('/:id', { preHandler: pre, schema: { tags: ['Vendor Returns'], params: idParams } },
    wrap(async (r) => ok(await svc.detail(r.vendorId, uid(r), r.params.id))))

  fastify.post('/:id/respond', {
    preHandler: pre,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['Vendor Returns'],
      params: idParams,
      body: {
        type: 'object',
        required: ['stance', 'note'],
        additionalProperties: false,
        properties: {
          stance: { type: 'string', enum: ['AGREE', 'DISPUTE'] },
          note: { type: 'string', minLength: 3, maxLength: 1000 },
          evidence: {
            type: 'array',
            maxItems: 6,
            items: {
              type: 'object',
              required: ['url', 'kind'],
              additionalProperties: false,
              properties: {
                url: { type: 'string', format: 'uri', maxLength: 1000 },
                kind: { type: 'string', enum: ['IMAGE', 'VIDEO'] },
              },
            },
          },
        },
      },
    },
  }, wrap(async (r) => ok(await svc.respond(r.vendorId, uid(r), r.params.id, r.body))))

  fastify.post('/:id/decision', {
    preHandler: pre,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags: ['Vendor Returns'],
      params: idParams,
      body: {
        type: 'object', required: ['decision', 'reason'], additionalProperties: false,
        properties: { decision: { type: 'string', enum: ['APPROVE', 'REJECT'] }, reason: { type: 'string', minLength: 3, maxLength: 1000 } },
      },
    },
  }, wrap(async (r) => ok(await svc.decide(r.vendorId, uid(r), r.params.id, r.body, r.ip))))

  fastify.post('/:id/pickup', {
    preHandler: pre,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags: ['Vendor Returns'],
      params: idParams,
      body: {
        type: 'object', required: ['provider'], additionalProperties: false,
        properties: {
          provider: { type: 'string', enum: ['SHIPROCKET', 'PORTER', 'BLUEDART', 'SELF'] },
          awb: { type: 'string', maxLength: 80 },
          courierName: { type: 'string', maxLength: 80 },
          trackingUrl: { type: 'string', format: 'uri', maxLength: 500 },
          scheduledAt: { type: 'string', format: 'date-time' },
          note: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, wrap(async (r) => ok(await svc.savePickup(r.vendorId, uid(r), r.params.id, r.body, r.ip))))

  fastify.post('/:id/pickup/status', {
    preHandler: pre,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['Vendor Returns'],
      params: idParams,
      body: {
        type: 'object', required: ['status'], additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['PICKED_UP', 'IN_TRANSIT', 'RECEIVED', 'FAILED', 'CANCELLED'] },
          note: { type: 'string', maxLength: 300 },
        },
      },
    },
  }, wrap(async (r) => ok(await svc.setPickupStatus(r.vendorId, uid(r), r.params.id, r.body, r.ip))))

  /** Get-or-create the vendor's chat with Dealkr Support for this return; messages then flow through /support/tickets/:ticketId. */
  fastify.post('/:id/chat', {
    preHandler: pre,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags: ['Vendor Returns'],
      params: idParams,
      body: { type: 'object', additionalProperties: false, properties: { message: { type: 'string', minLength: 1, maxLength: 4000 } } },
    },
  }, wrap(async (r) => ok(await svc.openChat(r.vendorId, uid(r), r.params.id, r.body || {}))))
}
