/**
 * Vendor store settings (opening hours, pickup, auto-accept, alert contacts) and the support contact card.
 * Mounted at /api/v1/vendor/store. Scoped to the signed-in vendor; commission and payout terms are NOT editable here.
 *
 * @module modules/vendor-store/vendor-store.routes
 */

import { query } from '../../config/database.js'
import { requireVendorScope } from '../../middlewares/vendor-scope.js'

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

const defaultHours = () => Object.fromEntries(DAYS.map((d) => [d, { open: '09:00', close: '21:00', closed: d === 'sun' }]))

/** Stored as { days: { mon: {open, close, closed} … }, pickup: bool } — tolerate older / empty values. */
function readHours(raw) {
  const days = defaultHours()
  const src = raw && typeof raw === 'object' ? (raw.days && typeof raw.days === 'object' ? raw.days : raw) : {}
  for (const d of DAYS) {
    const v = src[d]
    if (v && typeof v === 'object') {
      days[d] = {
        open: HHMM.test(v.open) ? v.open : days[d].open,
        close: HHMM.test(v.close) ? v.close : days[d].close,
        closed: Boolean(v.closed),
      }
    }
  }
  return { days, pickup: raw && typeof raw === 'object' ? raw.pickup !== false : true }
}

const jsonText = (v) => {
  if (typeof v === 'string') return v.trim()
  if (v == null) return ''
  return String(v)
}

export const vendorStoreRoutes = async function vendorStoreRoutes(fastify) {
  const pre = [fastify.authenticate, requireVendorScope({ requireVendor: true })]

  fastify.get('/settings', {
    preHandler: pre,
    handler: async (request) => {
      const { rows } = await query(
        `SELECT auto_accept_orders, notification_email, notification_phone, operating_hours FROM vendor_settings WHERE vendor_id = $1`,
        [request.vendorId])
      const r = rows[0] || {}
      const hours = readHours(r.operating_hours)
      return {
        success: true,
        data: {
          autoAcceptOrders: Boolean(r.auto_accept_orders),
          notificationEmail: r.notification_email || '',
          notificationPhone: r.notification_phone || '',
          pickup: hours.pickup,
          days: hours.days,
        },
      }
    },
  })

  fastify.put('/settings', {
    preHandler: pre,
    schema: {
      body: {
        type: 'object',
        properties: {
          autoAcceptOrders: { type: 'boolean' },
          notificationEmail: { type: 'string', maxLength: 255 },
          notificationPhone: { type: 'string', maxLength: 20 },
          pickup: { type: 'boolean' },
          days: { type: 'object' },
        },
        additionalProperties: false,
      },
    },
    handler: async (request, reply) => {
      const b = request.body
      const email = (b.notificationEmail ?? '').trim()
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return reply.code(400).send({ success: false, code: 'VALIDATION', message: 'Enter a valid email address' })
      }
      const phone = (b.notificationPhone ?? '').trim()
      if (phone && !/^\+?[0-9 ]{7,15}$/.test(phone)) {
        return reply.code(400).send({ success: false, code: 'VALIDATION', message: 'Enter a valid phone number' })
      }
      const merged = readHours({ days: b.days || {}, pickup: b.pickup })
      for (const d of DAYS) {
        const v = merged.days[d]
        if (!v.closed && v.open >= v.close) {
          return reply.code(400).send({ success: false, code: 'VALIDATION', message: `Closing time must be after opening time (${d.toUpperCase()})` })
        }
      }
      await query(
        `INSERT INTO vendor_settings (vendor_id, auto_accept_orders, notification_email, notification_phone, operating_hours)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (vendor_id) DO UPDATE
           SET auto_accept_orders = EXCLUDED.auto_accept_orders,
               notification_email = EXCLUDED.notification_email,
               notification_phone = EXCLUDED.notification_phone,
               operating_hours = EXCLUDED.operating_hours,
               updated_at = NOW()`,
        [request.vendorId, Boolean(b.autoAcceptOrders), email || null, phone || null, JSON.stringify({ days: merged.days, pickup: merged.pickup })])
      return { success: true, data: { saved: true } }
    },
  })

  /** Support phone, email and opening hours (edited in Dashboard → Settings → Store Info). */
  fastify.get('/support-contact', {
    preHandler: [fastify.authenticate],
    handler: async () => {
      const { rows } = await query(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [['support_phone', 'support_email', 'support_hours']])
      const m = Object.fromEntries(rows.map((r) => [r.key, jsonText(r.value)]))
      return { success: true, data: { phone: m.support_phone || null, email: m.support_email || null, hours: m.support_hours || null } }
    },
  })
}
