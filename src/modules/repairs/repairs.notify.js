/**
 * Repair notifications to the customer (in-app + push + socket). Fire-and-forget: a failure here
 * never fails or rolls back the state change. Call AFTER the transaction commits.
 */
import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'

let svc = null
async function notifications() {
  if (svc) return svc
  const { NotificationsService } = await import('../notifications/notifications.service.js')
  const { NotificationsRepository } = await import('../notifications/notifications.repository.js')
  svc = new NotificationsService(new NotificationsRepository(), null)
  return svc
}

const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`

const COPY = {
  ACCEPTED: (r) => ({ title: 'Repair request accepted', body: `${r.code} is accepted. We'll update you when your device is inspected.` }),
  REJECTED: (r, x) => ({ title: 'Repair request declined', body: `${r.code} could not be accepted${x.reason ? `: ${x.reason}` : '.'}` }),
  ESTIMATE_SENT: (r, x) => ({ title: 'Your repair estimate is ready', body: `${r.code}: estimate ${x.total != null ? inr(x.total) : ''}. Review and approve it to start the repair.` }),
  IN_REPAIR: (r) => ({ title: 'Repair started', body: `${r.code}: work has started on your device.` }),
  REPAIRED: (r) => ({ title: 'Your device is repaired', body: `${r.code}: repair and quality check are complete.` }),
  READY_FOR_DELIVERY: (r) => ({ title: 'Ready for delivery', body: `${r.code}: your device is ready${r.service_mode === 'PICKUP' ? ' to be delivered' : ' for pickup'}.` }),
  COMPLETED: (r) => ({ title: 'Repair completed', body: `${r.code} is complete.${r.warranty_until ? ` Warranty valid until ${r.warranty_until.toLocaleDateString('en-IN')}.` : ''}` }),
  FAILED: (r, x) => ({ title: 'We could not repair your device', body: `${r.code}: ${x.reason || 'the device could not be repaired'}. We'll arrange its return.` }),
  CANCELLED: (r) => ({ title: 'Repair request cancelled', body: `${r.code} was cancelled.` }),
}

export function notifyRepair(kind, requestId, extra = {}) {
  if (process.env.REPAIR_NO_NOTIFY) return
  setImmediate(async () => {
    try {
      const copy = COPY[kind]
      if (!copy) return
      const { rows } = await query('SELECT * FROM repair_requests WHERE id = $1', [requestId])
      const r = rows[0]
      if (!r?.user_id || extra.skipCustomer) return
      const data = { event: `repair:${kind.toLowerCase()}`, requestId: r.id, code: r.code, status: r.status, channel: r.channel }
      const msg = copy(r, extra)
      const n = await notifications()
      await n.sendNotification(r.user_id, { ...msg, type: 'REPAIR', data, app: 'customer' })
      try {
        const { getSocketEmitter } = await import('../../plugins/socket-emitter.js')
        getSocketEmitter()?.to(`user:${r.user_id}`).emit(data.event, { ...msg, ...data })
      } catch { /* realtime is optional */ }
    } catch (err) {
      logger.warn({ err: err.message, kind, requestId }, 'repair notification failed (non-critical)')
    }
  })
}
