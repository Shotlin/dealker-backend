/**
 * Sell-request notifications — customer + vendor, in-app + push + socket.
 *
 * Fire-and-forget: a notification failure must never fail or roll back the state change that
 * triggered it, so every export swallows its own errors. Call these AFTER the transaction commits.
 * Vendor-facing pushes go to the vendor app only; customer pushes to the customer app.
 * Vendors never receive customer contact details here — only the device and request code.
 *
 * @module modules/sell-requests/sell-requests.notify
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

async function emit(userId, event, payload) {
  try {
    const { getSocketEmitter } = await import('../../plugins/socket-emitter.js')
    getSocketEmitter()?.to(`user:${userId}`).emit(event, payload)
  } catch (err) {
    logger.debug({ err: err.message }, 'sell-request realtime emit unavailable')
  }
}

async function send(userIds, app, { title, body, data }) {
  if (!userIds.length) return
  const n = await notifications()
  await Promise.allSettled(userIds.map(async (id) => {
    await n.sendNotification(id, { title, body, type: 'SELL_REQUEST', data, app })
    await emit(id, data.event, { title, body, ...data })
  }))
}

/** Active vendor-user ids for the given vendors. */
async function vendorUserIds(vendorIds) {
  if (!vendorIds.length) return []
  const { rows } = await query(
    `SELECT DISTINCT user_id FROM vendor_users WHERE vendor_id = ANY($1::uuid[]) AND is_active AND deleted_at IS NULL`,
    [vendorIds]
  )
  return rows.map((r) => r.user_id)
}

/** Exchange requests say "exchange"/"trade-in" where sell requests say "request". */
const forType = (r, m) => {
  if (r.type !== 'EXCHANGE') return m
  const fix = (t) => t.replace('Request', 'Exchange').replace('request', 'exchange').replace('New device to quote', 'New trade-in to quote')
    .replace('A buyer has been found', 'Trade-in value confirmed')
  return { ...m, title: fix(m.title), body: fix(m.body) }
}

const rupees = (n) => `₹${Number(n).toLocaleString('en-IN')}`
const MAX_BROADCAST_VENDORS = 500

/** Per-event copy. `c` = customer message, `v` = message to the vendor(s) named in `to`. */
const COPY = {
  SUBMITTED: { v: (r) => ({ to: 'ALL_ACTIVE', title: 'New device to quote', body: `${r.model_name} ${r.variant} (${r.condition.toLowerCase()}) — est. ${rupees(r.quote)}. Place your offer.` }) },
  VENDOR_ASSIGNED: {
    c: (r) => ({ title: 'A buyer has been found', body: `Your ${r.model_name} request ${r.code} has a buyer at ${rupees(r.final_price)}. We'll confirm shortly.` }),
    v: (r) => ({ to: 'ASSIGNED', title: 'Your offer was selected', body: `${r.code} · ${r.model_name} at ${rupees(r.final_price)}.` }),
  },
  OFFER_DECLINED: { v: (r) => ({ to: 'OFFERED', title: 'Offer not selected', body: `${r.code} · ${r.model_name} went to another vendor.` }) },
  APPROVED: {
    c: (r) => ({ title: 'Request approved', body: `${r.code} for your ${r.model_name} is approved at ${rupees(r.final_price ?? r.quote)}.` }),
    v: (r) => ({ to: 'ASSIGNED', title: 'Request approved', body: `${r.code} · ${r.model_name} is approved — proceed with collection.` }),
  },
  REJECTED: {
    c: (r, x) => ({ title: 'Request rejected', body: `${r.code} could not be accepted${x.reason ? `: ${x.reason}` : '.'}` }),
    v: (r) => ({ to: 'OFFERED', title: 'Request closed', body: `${r.code} · ${r.model_name} was rejected.` }),
  },
  INFO_REQUESTED: { c: (r, x) => ({ title: 'More details needed', body: `${r.code}: ${x.message}` }) },
  ORDER_LINKED: { c: (r) => ({ title: 'Trade-in linked to your order', body: `Your ${r.model_name} trade-in ${r.code} is linked to your new order.` }) },
  COMPLETED: {
    c: (r) => ({ title: 'Request completed', body: `${r.code} for your ${r.model_name} is complete. Thank you!` }),
    v: (r) => ({ to: 'ASSIGNED', title: 'Request completed', body: `${r.code} · ${r.model_name} is complete.` }),
  },
  CANCELLED: {
    c: (r) => ({ title: 'Request cancelled', body: `${r.code} for your ${r.model_name} was cancelled.` }),
    v: (r) => ({ to: 'OFFERED', title: 'Request cancelled', body: `${r.code} · ${r.model_name} was cancelled.` }),
  },
}

/**
 * @param {string} kind     key of COPY
 * @param {string} requestId
 * @param {object} [extra]  { reason, message, skipCustomer, declinedVendorIds }
 */
export function notifySellEvent(kind, requestId, extra = {}) {
  if (process.env.SELL_DEMO_SEED) return // the demo seed must not push to real devices
  setImmediate(async () => {
    try {
      const copy = COPY[kind]
      if (!copy) return
      const { rows } = await query('SELECT * FROM sell_requests WHERE id = $1', [requestId])
      const r = rows[0]
      if (!r) return
      const data = { event: `${r.kind === 'EXCHANGE' ? 'exchange_request' : 'sell_request'}:${kind.toLowerCase()}`, kind: r.kind, requestId: r.id, code: r.code, status: r.status }

      if (copy.c && r.user_id && !extra.skipCustomer) {
        await send([r.user_id], 'customer', { ...forType(r, copy.c(r, extra)), data })
      }
      if (copy.v) {
        const v = copy.v(r, extra)
        let vendorIds = []
        if (v.to === 'ASSIGNED') vendorIds = r.assigned_vendor_id ? [r.assigned_vendor_id] : []
        else if (v.to === 'OFFERED') {
          const { rows: o } = await query(
            `SELECT vendor_id FROM sell_request_offers WHERE request_id = $1 AND status <> 'WITHDRAWN'`, [requestId])
          vendorIds = o.map((x) => x.vendor_id).filter((id) => id !== r.assigned_vendor_id || kind !== 'OFFER_DECLINED')
          if (kind === 'OFFER_DECLINED') vendorIds = extra.declinedVendorIds || []
        } else if (v.to === 'ALL_ACTIVE') {
          const { rows: a } = await query(
            `SELECT id FROM vendors WHERE is_active AND status IN ('VERIFIED','ACTIVE') AND deleted_at IS NULL ORDER BY created_at LIMIT $1`,
            [MAX_BROADCAST_VENDORS])
          vendorIds = a.map((x) => x.id)
        }
        const vm = forType(r, v)
        await send(await vendorUserIds(vendorIds), 'vendor', { title: vm.title, body: vm.body, data })
      }
    } catch (err) {
      logger.warn({ err: err.message, kind, requestId }, 'sell-request notification failed (non-critical)')
    }
  })
}
