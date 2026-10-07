import { AdminAbandonedCartsController } from './abandoned-carts.controller.js'
import {
  listAbandonedCartsSchema,
  abandonedCartIdSchema,
  sendReminderSchema,
  issueCouponSchema,
  bulkReminderSchema,
  quickCouponSchema,
} from './abandoned-carts.schema.js'

const ctrl = new AdminAbandonedCartsController()

export default async function adminAbandonedCartsRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', { schema: listAbandonedCartsSchema }, ctrl.list.bind(ctrl))
  fastify.get('/summary', ctrl.getSummary.bind(ctrl))
  fastify.get('/presets', ctrl.getPresets.bind(ctrl))
  fastify.post('/bulk-notify', { schema: bulkReminderSchema }, ctrl.sendBulkReminder.bind(ctrl))
  fastify.get('/:id', { schema: abandonedCartIdSchema }, ctrl.getDetail.bind(ctrl))
  fastify.post('/:id/notify', { schema: sendReminderSchema }, ctrl.sendReminder.bind(ctrl))
  fastify.post('/:id/coupon', { schema: issueCouponSchema }, ctrl.issueCoupon.bind(ctrl))
  fastify.post('/:id/quick-coupon', { schema: quickCouponSchema }, ctrl.sendQuickCoupon.bind(ctrl))
}
