import { success, error } from '../../utils/apiResponse.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { NotificationsRepository } from '../notifications/notifications.repository.js'
import { RefundRequestsService, toCustomerView, REASON_CODES } from './refund-requests.service.js'

const uuid = { type: 'string', format: 'uuid' }
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } }

const createSchema = {
  tags: ['Refund Requests'],
  summary: 'Customer: request a refund for a delivered order',
  body: {
    type: 'object',
    required: ['orderId', 'itemScope', 'description'],
    properties: {
      orderId: uuid,
      itemScope: { type: 'string', enum: ['ALL', 'SPECIFIC'] },
      description: { type: 'string', minLength: 3, maxLength: 1000 },
      productIds: { type: 'array', items: uuid, maxItems: 100 },
      reasonCode: { type: 'string', enum: REASON_CODES },
      evidence: {
        type: 'array',
        maxItems: 8,
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
}

export function sendRefundError(reply, err) {
  const status = err?.statusCode || 500
  if (status >= 500) throw err
  return reply.code(status).send(error(err.message, err.code || 'REFUND_ERROR'))
}

/**
 * Customer refund-request routes — mounted at /api/v1/refund-requests.
 * Every route is scoped to the authenticated caller; a customer can never
 * read, create for, or cancel another customer's request (404, not 403, so
 * the existence of someone else's order/request is never revealed).
 */
export default async function refundRequestRoutes(fastify) {
  const service = new RefundRequestsService({
    fastify,
    notifier: new NotificationsService(new NotificationsRepository(), fastify),
  })
  const auth = { preHandler: [fastify.authenticate] }
  const userId = (req) => req.userId || req.user.id

  fastify.post('/', { ...auth, schema: createSchema }, async (req, reply) => {
    try {
      const row = await service.create(req.body, { userId: userId(req), role: 'CUSTOMER', ip: req.ip })
      return reply.code(201).send(success(toCustomerView(row), 'Refund request submitted'))
    } catch (err) {
      return sendRefundError(reply, err)
    }
  })

  fastify.get('/order/:orderId', {
    ...auth,
    schema: { tags: ['Refund Requests'], params: { type: 'object', required: ['orderId'], properties: { orderId: uuid } } },
  }, async (req, reply) => {
    const view = await service.getForCustomerByOrder(req.params.orderId, userId(req))
    // `data: null` (not a 404) when none exists yet — the app treats that as "no request".
    return reply.code(200).send(success(view, view ? 'Refund request fetched' : 'No refund request for this order'))
  })

  // Return policy shown in the app (window days, free pickup, rules) — editable in the dashboard.
  fastify.get('/policy', auth, async (_req, reply) => reply.code(200).send(success(await service.journey.getSettings(), 'Return policy')))

  fastify.post('/:id/qc/accept', { ...auth, schema: { tags: ['Refund Requests'], params: idParams } }, async (req, reply) => {
    try {
      await service.journey.acceptPrice(req.params.id, userId(req))
      return reply.code(200).send(success(await service.customerView(req.params.id, userId(req)), 'New price accepted'))
    } catch (err) {
      return sendRefundError(reply, err)
    }
  })

  fastify.post('/:id/qc/clarify', {
    ...auth,
    schema: { tags: ['Refund Requests'], params: idParams, body: { type: 'object', properties: { message: { type: 'string', maxLength: 1000 } } } },
  }, async (req, reply) => {
    try {
      await service.journey.clarifyPrice(req.params.id, userId(req), req.body?.message)
      return reply.code(200).send(success(await service.customerView(req.params.id, userId(req)), 'Question sent'))
    } catch (err) {
      return sendRefundError(reply, err)
    }
  })

  fastify.post('/:id/cancel', {
    ...auth,
    schema: { tags: ['Refund Requests'], params: { type: 'object', required: ['id'], properties: { id: uuid } } },
  }, async (req, reply) => {
    try {
      const row = await service.cancel(req.params.id, { userId: userId(req), role: 'CUSTOMER', ip: req.ip })
      return reply.code(200).send(success(toCustomerView(row), 'Refund request cancelled'))
    } catch (err) {
      return sendRefundError(reply, err)
    }
  })
}
