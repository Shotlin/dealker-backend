import { query } from '../../config/database.js'
import { ORDER_NOTIFICATION_EVENT_KEYS } from './order-notification-settings.constants.js'

/**
 * Order-notification-settings repository — one row per lifecycle event
 * (migration 144). The full 10-row table is cached module-scoped, mirroring
 * `support-settings.repository.js`'s own singleton-cache pattern, except
 * here the cached value is the whole list keyed by event_key — every real
 * caller (the admin list page, the public event-flags endpoint, and
 * NotificationsService's own per-send lookup) wants either "all of them" or
 * "one of them by key", and a single cached Map serves both without a
 * second round trip.
 */

const CACHE_TTL_MS = 30_000

let cache = { value: undefined, expiresAt: 0 }

const COLUMNS = `event_key, title, message, notification_enabled, banner_enabled, image_url, updated_by, updated_at, created_at`

export class OrderNotificationSettingsRepository {
  /** Map<event_key, row>, served from cache when fresh. */
  async _getAllCached() {
    const now = Date.now()
    if (cache.value !== undefined && now < cache.expiresAt) {
      return cache.value
    }
    const { rows } = await query(`SELECT ${COLUMNS} FROM order_notification_settings`)
    const map = new Map(rows.map((row) => [row.event_key, row]))
    cache = { value: map, expiresAt: now + CACHE_TTL_MS }
    return map
  }

  /** All rows, in the canonical event order — never DB row order, which has no guaranteed meaning. */
  async listAll() {
    const map = await this._getAllCached()
    return ORDER_NOTIFICATION_EVENT_KEYS.map((key) => map.get(key) || null).filter(Boolean)
  }

  /** A single event's row, or null if the seed migration somehow never ran for it. */
  async getByEventKey(eventKey) {
    const map = await this._getAllCached()
    return map.get(eventKey) || null
  }

  async update(eventKey, data, updatedBy = null) {
    const fields = []
    const params = [eventKey]
    let idx = 2

    const updatable = ['title', 'message', 'notification_enabled', 'banner_enabled', 'image_url']
    for (const key of updatable) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        fields.push(`${key} = $${idx++}`)
        params.push(data[key])
      }
    }
    if (fields.length === 0) {
      return this.getByEventKey(eventKey)
    }

    fields.push(`updated_by = $${idx++}`)
    params.push(updatedBy)
    fields.push('updated_at = NOW()')

    const { rows } = await query(
      `UPDATE order_notification_settings SET ${fields.join(', ')} WHERE event_key = $1 RETURNING ${COLUMNS}`,
      params
    )
    this.invalidate()
    return rows[0] || null
  }

  invalidate() {
    cache = { value: undefined, expiresAt: 0 }
  }
}
