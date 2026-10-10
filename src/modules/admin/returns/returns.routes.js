import { ReturnsController } from './returns.controller.js'
import { requireShopScope } from '../../../middlewares/shop-scope.js'
import { NotificationsService } from '../../notifications/notifications.service.js'
import { NotificationsRepository } from '../../notifications/notifications.repository.js'
import { RefundRequestsService } from '../../refund-requests/refund-requests.service.js'
import {
  listReturnsSchema,
  returnIdSchema,
  createReturnSchema,
  resolveReturnSchema,
} from './returns.schema.js'

/**
 * Returns / RMA routes plugin
 * Mounted at /api/v1/admin/returns (see admin.routes.js)
 *
 * Shop-scoped like every other store-facing admin module: a shop-staff JWT's
 * own shop (or an HQ user's optional X-Shop-Id) is resolved by
 * `requireShopScope()` and enforced by `RefundRequestsService` — a branch
 * only ever lists / reads / approves / rejects ITS OWN customers' requests.
 */
export default async function adminReturnsRoutes(fastify) {
  const service = new RefundRequestsService({
    fastify,
    notifier: new NotificationsService(new NotificationsRepository(), fastify),
  })
  const controller = new ReturnsController(service)

  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
    await requireShopScope({ requireShop: false })(request, reply)
  })

  const uuid = { type: 'string', format: 'uuid' }
  const idParams = { type: 'object', required: ['id'], properties: { id: uuid } }

  // Policy (window days, free pickup, rules shown to customers) — static path, registered before /:id.
  fastify.get('/settings/policy', { schema: { tags: ['Returns'] } }, controller.getPolicy.bind(controller))
  fastify.put('/settings/policy', {
    schema: {
      tags: ['Returns'],
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          windowDays: { type: 'integer', minimum: 1, maximum: 90 },
          freePickup: { type: 'boolean' },
          points: {
            type: 'array', maxItems: 12,
            items: { type: 'object', required: ['title', 'text'], additionalProperties: false, properties: { title: { type: 'string', minLength: 1, maxLength: 80 }, text: { type: 'string', minLength: 1, maxLength: 240 } } },
          },
        },
      },
    },
  }, controller.savePolicy.bind(controller))

  fastify.get('/', { schema: listReturnsSchema }, controller.list.bind(controller))
  fastify.post('/', { schema: createReturnSchema }, controller.create.bind(controller))
  fastify.get('/:id', { schema: returnIdSchema }, controller.getDetail.bind(controller))
  fastify.post('/:id/approve', { schema: resolveReturnSchema }, controller.approve.bind(controller))
  fastify.post('/:id/reject', { schema: resolveReturnSchema }, controller.reject.bind(controller))
  fastify.post('/:id/cancel', { schema: resolveReturnSchema }, controller.cancel.bind(controller))

  // Pickup / QC for one return
  fastify.get('/:id/journey', { schema: { tags: ['Returns'], params: idParams } }, controller.journey.bind(controller))
  fastify.put('/:id/pickup', {
    schema: {
      tags: ['Returns'], params: idParams,
      body: {
        type: 'object', required: ['provider'], additionalProperties: false,
        properties: {
          provider: { type: 'string', enum: ['SHIPROCKET', 'PORTER', 'BLUEDART', 'SELF'] },
          awb: { type: 'string', maxLength: 60 }, courierName: { type: 'string', maxLength: 120 },
          trackingUrl: { type: 'string', maxLength: 500 }, scheduledAt: { type: 'string', format: 'date-time' }, note: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, controller.savePickup.bind(controller))
  fastify.patch('/:id/pickup/status', {
    schema: {
      tags: ['Returns'], params: idParams,
      body: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'RECEIVED', 'FAILED', 'CANCELLED'] }, note: { type: 'string', maxLength: 300 } } },
    },
  }, controller.setPickupStatus.bind(controller))
  fastify.post('/:id/pickup/sync', { schema: { tags: ['Returns'], params: idParams } }, controller.syncPickup.bind(controller))
  fastify.put('/:id/qc', {
    schema: {
      tags: ['Returns'], params: idParams,
      body: {
        type: 'object', required: ['checks'], additionalProperties: false,
        properties: {
          checks: {
            type: 'array', minItems: 1, maxItems: 20,
            items: { type: 'object', required: ['label', 'status'], additionalProperties: false, properties: { key: { type: 'string', maxLength: 40 }, label: { type: 'string', minLength: 1, maxLength: 60 }, status: { type: 'string', enum: ['OK', 'MINOR_ISSUE', 'FAILED'] }, note: { type: 'string', maxLength: 200 } } },
          },
          summary: { type: 'string', maxLength: 500 },
          revisedPrice: { type: ['number', 'null'], minimum: 0 },
        },
      },
    },
  }, controller.saveQc.bind(controller))
}
