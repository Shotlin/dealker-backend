import { sendPush } from '../../utils/pushNotification.js'
import { logger } from '../../config/logger.js'

/**
 * Notifications service — business logic for notifications
 */
export class NotificationsService {
  constructor(repository, fastify) {
    this.repository = repository
    this.fastify = fastify
  }

  async getNotifications(userId, { page, limit, unreadOnly }) {
    const offset = (page - 1) * limit
    return await this.repository.getNotifications(userId, { offset, limit, unreadOnly })
  }

  async markAsRead(userId, notificationId) {
    const notification = await this.repository.getNotificationById(notificationId)
    if (!notification) {
      throw new Error('Notification not found')
    }

    if (notification.user_id !== userId) {
      throw new Error('Not authorized to modify this notification')
    }

    return await this.repository.markAsRead(notificationId)
  }

  async markAllAsRead(userId) {
    return await this.repository.markAllAsRead(userId)
  }

  // Called by the app the moment a user taps/opens a push notification —
  // not tied to a specific in-app notification row id (the push payload
  // only carries the campaign id, since the same FCM payload goes to every
  // recipient). Idempotent: a repeat tap on an already-opened campaign is a
  // no-op at the repository level, so a campaign's opened_count only ever
  // counts each user once, however many times they tap.
  async markCampaignOpened(userId, campaignId) {
    return await this.repository.markCampaignOpened(userId, campaignId)
  }

  async deleteNotification(userId, notificationId) {
    const notification = await this.repository.getNotificationById(notificationId)
    if (!notification) {
      throw new Error('Notification not found')
    }

    if (notification.user_id !== userId) {
      throw new Error('Not authorized to delete this notification')
    }

    return await this.repository.deleteNotification(notificationId)
  }

  async getPreferences(userId) {
    return await this.repository.getPreferences(userId)
  }

  async updatePreferences(userId, preferences) {
    return await this.repository.updatePreferences(userId, preferences)
  }

  async registerToken(userId, token, platform, app = 'customer') {
    return await this.repository.registerToken(userId, token, platform, app)
  }

  /**
   * Send notification — creates in-app + sends push + emits Socket.IO
   * Called by other modules (orders, delivery, etc.)
   */
  // `channelId`/`sound` are optional overrides for the Android notification
  // channel + sound a push renders with — every caller that omits them gets
  // the existing shared default (`sendPush`'s own fallback), so this stays
  // backward-compatible for every notification type except the ones that
  // deliberately opt into a louder, distinct alert (currently only
  // ProcurementNotifier.requestPublished — see its own comment).
  // `app` picks which FreshCuts app's device(s) get the PUSH: 'customer'
  // (default — every existing caller is customer-facing), 'vendor' for the
  // vendor app. The in-app row and Socket.IO emit are per-user and unchanged.
  async sendNotification(userId, { title, body, type = 'general', data = {}, channelId, sound, app = 'customer' }) {
    // Order-lifecycle events (customer-order-event.helper.js's output,
    // type:'ORDER_STATUS' + data.timelineType) go through the admin-
    // configurable settings (migration 144) before anything else happens:
    // an admin edit overrides the title/body actually sent, and turning
    // the event off suppresses the whole send (in-app row + socket + push)
    // — not just the push — matching the dashboard's single "Enabled"
    // toggle semantics. A missing settings row (shouldn't happen once the
    // migration has run, but defensive) falls through to whatever the
    // caller already built, unchanged.
    if (type === 'ORDER_STATUS' && data?.timelineType) {
      try {
        const { OrderNotificationSettingsRepository } = await import(
          '../order-notification-settings/order-notification-settings.repository.js'
        )
        const { interpolateOrderNotificationTemplate } = await import(
          '../order-notification-settings/order-notification-settings.constants.js'
        )
        const settings = await new OrderNotificationSettingsRepository().getByEventKey(data.timelineType)
        if (settings) {
          if (settings.notification_enabled === false) {
            logger.debug({ userId, timelineType: data.timelineType }, 'Order notification suppressed — event turned off in settings')
            return null
          }
          title = interpolateOrderNotificationTemplate(settings.title, data)
          body = interpolateOrderNotificationTemplate(settings.message, data)
          // PICKED_UP's delivery OTP suffix is appended mechanically, never
          // exposed as admin-editable template text — a real, sensitive
          // one-time code should never live inside free-text an admin
          // could accidentally mistype or drop.
          if (data.timelineType === 'PICKED_UP' && data.deliveryOtp) {
            body += ` Your delivery OTP is ${data.deliveryOtp} — share it with your delivery partner when they arrive.`
          }
        }
      } catch (err) {
        logger.error({ err, userId, timelineType: data.timelineType }, 'Order notification settings lookup failed — sending with the caller-supplied default')
      }
    }

    // 1. Create in-app notification
    const notification = await this.repository.createNotification(userId, {
      title, body, type, data,
    })

    // 2. Emit via Socket.IO for real-time
    try {
      if (this.fastify?.emitNotification) {
        this.fastify.emitNotification(userId, notification)
      }
    } catch (err) {
      logger.error({ err, userId }, 'Socket.IO notification emit failed')
    }

    // 3. Send push notification via FCM
    try {
      const tokens = await this.repository.getFcmTokens(userId, app)
      if (tokens.length > 0) {
        const tokenStrings = tokens.map(t => t.token)
        const pushOptions = { title, body, data: { ...data, notificationId: notification.id } }
        if (channelId) pushOptions.channelId = channelId
        if (sound) pushOptions.sound = sound
        for (const token of tokenStrings) {
          await sendPush(token, pushOptions)
        }
      }
    } catch (err) {
      logger.error({ err, userId }, 'FCM push notification failed')
    }

    return notification
  }

  // Alias for backward compatibility
  async createNotification(userId, opts) {
    return this.sendNotification(userId, opts)
  }
}
