import { NotificationsController } from './notifications.controller.js'
import { NotificationsService } from './notifications.service.js'
import { NotificationsRepository } from './notifications.repository.js'
import {
  getNotificationsSchema,
  markAsReadSchema,
  markAllAsReadSchema,
  markCampaignOpenedSchema,
  deleteNotificationSchema,
  getPreferencesSchema,
  updatePreferencesSchema,
  registerTokenSchema,
} from './notifications.schema.js'

/**
 * Notifications routes plugin
 * Prefix: /api/v1/notifications
 */
export default async function notificationsRoutes(fastify) {
  const repository = new NotificationsRepository()
  const service = new NotificationsService(repository, fastify)
  const controller = new NotificationsController(service)

  // GET / — Get notifications
  fastify.get('/', {
    schema: getNotificationsSchema,
    preHandler: [fastify.authenticate],
  }, controller.getNotifications.bind(controller))

  // PATCH /:id/read — Mark as read
  fastify.patch('/:id/read', {
    schema: markAsReadSchema,
    preHandler: [fastify.authenticate],
  }, controller.markAsRead.bind(controller))

  // PATCH /read-all — Mark all as read
  fastify.patch('/read-all', {
    schema: markAllAsReadSchema,
    preHandler: [fastify.authenticate],
  }, controller.markAllAsRead.bind(controller))

  // PATCH /campaigns/:campaignId/opened — Report a campaign push notification was opened
  fastify.patch('/campaigns/:campaignId/opened', {
    schema: markCampaignOpenedSchema,
    preHandler: [fastify.authenticate],
  }, controller.markCampaignOpened.bind(controller))

  // DELETE /:id — Delete notification
  fastify.delete('/:id', {
    schema: deleteNotificationSchema,
    preHandler: [fastify.authenticate],
  }, controller.deleteNotification.bind(controller))

  // GET /preferences — Get preferences
  fastify.get('/preferences', {
    schema: getPreferencesSchema,
    preHandler: [fastify.authenticate],
  }, controller.getPreferences.bind(controller))

  // PUT /preferences — Update preferences
  fastify.put('/preferences', {
    schema: updatePreferencesSchema,
    preHandler: [fastify.authenticate],
  }, controller.updatePreferences.bind(controller))

  // POST /tokens — Register token
  fastify.post('/tokens', {
    schema: registerTokenSchema,
    preHandler: [fastify.authenticate],
  }, controller.registerToken.bind(controller))
}
