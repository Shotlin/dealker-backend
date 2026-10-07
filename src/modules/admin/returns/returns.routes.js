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

  fastify.get('/', { schema: listReturnsSchema }, controller.list.bind(controller))
  fastify.post('/', { schema: createReturnSchema }, controller.create.bind(controller))
  fastify.get('/:id', { schema: returnIdSchema }, controller.getDetail.bind(controller))
  fastify.post('/:id/approve', { schema: resolveReturnSchema }, controller.approve.bind(controller))
  fastify.post('/:id/reject', { schema: resolveReturnSchema }, controller.reject.bind(controller))
  fastify.post('/:id/cancel', { schema: resolveReturnSchema }, controller.cancel.bind(controller))
}
