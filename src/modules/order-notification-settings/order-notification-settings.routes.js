import { OrderNotificationSettingsController } from './order-notification-settings.controller.js'
import { OrderNotificationSettingsService } from './order-notification-settings.service.js'
import { OrderNotificationSettingsRepository } from './order-notification-settings.repository.js'
import {
  listSettingsSchema,
  getCustomerFlagsSchema,
  updateSettingSchema,
  sendTestSchema,
} from './order-notification-settings.schema.js'

/**
 * Admin routes.
 * Prefix: /api/v1/admin/order-notification-settings
 *
 *   GET  /             — all 10 events, current title/message/enabled state
 *   PUT  /:eventKey     — edit one event
 *   POST /:eventKey/test — send yourself a real test push with sample data
 */
export async function adminOrderNotificationSettingsRoutes(fastify) {
  // NotificationsService needs the real fastify instance for its Socket.IO
  // emit — built here rather than imported eagerly to avoid a static
  // import cycle with notifications.service.js, which imports this
  // module's repository for its own live-send gate/override lookup.
  const { NotificationsRepository } = await import('../notifications/notifications.repository.js')
  const { NotificationsService } = await import('../notifications/notifications.service.js')
  const notificationsService = new NotificationsService(new NotificationsRepository(), fastify)

  const service = new OrderNotificationSettingsService(new OrderNotificationSettingsRepository(), notificationsService)
  const controller = new OrderNotificationSettingsController(service)
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/', { schema: listSettingsSchema, preHandler: adminAuth }, controller.listAll)
  fastify.put('/:eventKey', { schema: updateSettingSchema, preHandler: adminAuth }, controller.update)
  fastify.post('/:eventKey/test', { schema: sendTestSchema, preHandler: adminAuth }, controller.sendTest)
}

/**
 * Customer-facing route, mounted alongside the existing notifications
 * module under the same /api/v1/notifications prefix.
 *
 *   GET /event-flags — the endpoint mobile's order_notification_flags_provider.dart
 *   has called since it was built, against a route that never existed
 *   until this module.
 */
export async function orderNotificationEventFlagsRoutes(fastify) {
  const service = new OrderNotificationSettingsService()
  const controller = new OrderNotificationSettingsController(service)

  fastify.get('/event-flags', {
    schema: getCustomerFlagsSchema,
    preHandler: [fastify.authenticate],
  }, controller.getCustomerFlags)
}
