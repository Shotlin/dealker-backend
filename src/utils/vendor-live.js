/**
 * Live pings for the vendor app.
 *
 * The vendor app keeps one Socket.IO connection and refetches whatever list is on screen when it hears
 * `vendor:refresh`, so a new order / repair request / chat message shows up the moment it exists instead of
 * after the next manual refresh. Optionally also records an in-app notification + push (vendor app only).
 *
 * Fire-and-forget: it runs after the caller's transaction committed and never throws.
 *
 * @module utils/vendor-live
 */
import { query } from '../config/database.js'
import { logger } from '../config/logger.js'

let svc = null
async function notifications() {
  if (svc) return svc
  const { NotificationsService } = await import('../modules/notifications/notifications.service.js')
  const { NotificationsRepository } = await import('../modules/notifications/notifications.repository.js')
  svc = new NotificationsService(new NotificationsRepository(), null)
  return svc
}

/** Active login users of the given vendors. */
export async function vendorUserIds(vendorIds) {
  const ids = [...new Set((vendorIds || []).filter(Boolean))]
  if (!ids.length) return []
  const { rows } = await query(
    `SELECT DISTINCT user_id FROM vendor_users WHERE vendor_id = ANY($1::uuid[]) AND is_active AND deleted_at IS NULL`, [ids])
  return rows.map((r) => r.user_id)
}

/**
 * @param {string[]} vendorIds
 * @param {{kind: string, title?: string, body?: string, data?: object, push?: boolean}} evt
 *   kind: 'order' | 'repair' | 'sell' | 'chat' | ... — the app uses it to decide what to refetch.
 */
export function pingVendors(vendorIds, { kind, title, body, data = {}, push = false } = {}) {
  setImmediate(async () => {
    try {
      const userIds = await vendorUserIds(vendorIds)
      if (!userIds.length) return
      const { getSocketEmitter } = await import('../plugins/socket-emitter.js')
      const emitter = getSocketEmitter()
      const payload = { kind, title, body, ...data, at: Date.now() }
      for (const id of userIds) emitter.to(`user:${id}`).emit('vendor:refresh', payload)
      if (push && title) {
        const n = await notifications()
        await Promise.allSettled(userIds.map((id) => n.sendNotification(id, {
          title, body: body || '', type: `VENDOR_${String(kind || 'update').toUpperCase()}`, data: { kind, ...data }, app: 'vendor',
        })))
      }
    } catch (err) {
      logger.debug({ err: err.message, kind }, 'vendor live ping failed (non-critical)')
    }
  })
}

/** Ping every vendor that has an active repair price list (the pool that can see new repair requests). */
export function pingRepairVendors(evt) {
  setImmediate(async () => {
    try {
      const { rows } = await query(`SELECT DISTINCT vendor_id FROM repair_vendor_services WHERE is_active`)
      pingVendors(rows.map((r) => r.vendor_id), { kind: 'repair', ...evt })
    } catch (err) {
      logger.debug({ err: err.message }, 'repair vendor ping failed (non-critical)')
    }
  })
}
