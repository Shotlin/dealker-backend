import { OrderNotificationSettingsRepository } from './order-notification-settings.repository.js'
import {
  ORDER_NOTIFICATION_EVENT_KEY_SET,
  ORDER_NOTIFICATION_EVENT_LABELS,
  interpolateOrderNotificationTemplate,
} from './order-notification-settings.constants.js'

const SAMPLE_DATA = { orderNumber: 'FC-KOL-20260928-0001', deliveryOtp: '4821' }

export class OrderNotificationSettingsService {
  constructor(repository = new OrderNotificationSettingsRepository(), notificationsService = null) {
    this.repository = repository
    // Injected lazily by the routes file (avoids a static import cycle —
    // notifications.service.js itself imports this module's repository to
    // do the same lookup on the live send path).
    this.notificationsService = notificationsService
  }

  async listAll() {
    const rows = await this.repository.listAll()
    return rows.map((row) => this._toView(row))
  }

  /**
   * `GET /notifications/event-flags`'s real shape — the endpoint the
   * mobile app's `order_notification_flags_provider.dart` has been calling
   * since it was built, against a route that never existed until now.
   * `{EVENT_KEY: {notification, banner}}` — a customer-facing client only
   * ever needs the two booleans, never the editable title/message text.
   */
  async getCustomerFlags() {
    const rows = await this.repository.listAll()
    const flags = {}
    for (const row of rows) {
      flags[row.event_key] = {
        notification: row.notification_enabled,
        banner: row.banner_enabled,
      }
    }
    return flags
  }

  async update(eventKey, { title, message, notificationEnabled, bannerEnabled, imageUrl } = {}, updatedBy = null) {
    this._assertKnownEvent(eventKey)

    const data = {}
    if (title !== undefined) {
      const trimmed = (title || '').trim()
      if (!trimmed) throw this._badRequest('Title cannot be empty', 'INVALID_TITLE')
      data.title = trimmed
    }
    if (message !== undefined) {
      const trimmed = (message || '').trim()
      if (!trimmed) throw this._badRequest('Message cannot be empty', 'INVALID_MESSAGE')
      data.message = trimmed
    }
    if (notificationEnabled !== undefined) data.notification_enabled = !!notificationEnabled
    if (bannerEnabled !== undefined) data.banner_enabled = !!bannerEnabled
    if (imageUrl !== undefined) data.image_url = imageUrl ? imageUrl.trim() : null

    const row = await this.repository.update(eventKey, data, updatedBy)
    if (!row) throw this._badRequest('Event not found', 'EVENT_NOT_FOUND', 404)
    return this._toView(row)
  }

  /**
   * Sends the CURRENT saved wording (whatever the admin is looking at,
   * including an unsaved edit if the caller passes one) to the calling
   * admin's own account, with sample order data — deliberately bypasses
   * the enabled/disabled gate (§NotificationsService#sendNotification)
   * entirely, since previewing a currently-OFF event is exactly why
   * someone would hit "Send test".
   */
  async sendTest(eventKey, adminUserId, override = {}) {
    this._assertKnownEvent(eventKey)
    if (!this.notificationsService) {
      throw this._badRequest('Notification service unavailable', 'NOTIFICATIONS_UNAVAILABLE', 503)
    }
    const row = await this.repository.getByEventKey(eventKey)
    const title = (override.title ?? row?.title ?? '').trim()
    const message = (override.message ?? row?.message ?? '').trim()
    if (!title || !message) {
      throw this._badRequest('Nothing to send — title and message are both empty', 'EMPTY_TEMPLATE')
    }

    const interpolatedTitle = interpolateOrderNotificationTemplate(title, SAMPLE_DATA)
    let interpolatedBody = interpolateOrderNotificationTemplate(message, SAMPLE_DATA)
    if (eventKey === 'PICKED_UP') {
      interpolatedBody += ` Your delivery OTP is ${SAMPLE_DATA.deliveryOtp} — share it with your delivery partner when they arrive.`
    }

    // type: 'general' (not 'ORDER_STATUS') deliberately skips
    // NotificationsService's own event-settings gate/override branch —
    // this call has already done the interpolation itself, using
    // whatever text was passed in, live-edit or saved.
    return this.notificationsService.sendNotification(adminUserId, {
      title: interpolatedTitle,
      body: interpolatedBody,
      type: 'general',
      data: { event: 'order_notification_test', eventKey },
    })
  }

  _toView(row) {
    return {
      eventKey: row.event_key,
      label: ORDER_NOTIFICATION_EVENT_LABELS[row.event_key] || row.event_key,
      title: row.title,
      message: row.message,
      notificationEnabled: row.notification_enabled,
      bannerEnabled: row.banner_enabled,
      imageUrl: row.image_url || null,
      updatedAt: row.updated_at,
    }
  }

  _assertKnownEvent(eventKey) {
    if (!ORDER_NOTIFICATION_EVENT_KEY_SET.has(eventKey)) {
      throw this._badRequest(`Unknown event key: ${eventKey}`, 'UNKNOWN_EVENT_KEY')
    }
  }

  _badRequest(message, code, statusCode = 400) {
    const err = new Error(message)
    err.statusCode = statusCode
    err.code = code
    return err
  }
}
