import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { logAdminActivity } from '../../utils/activityLogger.js'

const fail = (message, code, statusCode = 400) => Object.assign(new Error(message), { code, statusCode })
const money = (n) => Number(Number(n).toFixed(2))
const iso = (d) => (d ? new Date(d).toISOString() : null)

export const PICKUP_PROVIDERS = ['SHIPROCKET', 'PORTER', 'BLUEDART', 'SELF']
export const PICKUP_STATUSES = ['PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'RECEIVED', 'FAILED', 'CANCELLED']
export const QC_RESULTS = ['OK', 'MINOR_ISSUE', 'FAILED']

/** Parts shown on the QC report when the reviewer does not name their own. */
export const DEFAULT_QC_PARTS = [
  { key: 'screen', label: 'Screen' },
  { key: 'battery', label: 'Battery' },
  { key: 'camera', label: 'Camera' },
  { key: 'other', label: 'Other Parts' },
]

/** External courier vocabulary → return-pickup states. */
export function pickupStatusFromShipping(status) {
  switch (status) {
    case 'PICKUP_SCHEDULED': case 'ASSIGNED': case 'CREATED': return 'PICKUP_SCHEDULED'
    case 'PICKED_UP': return 'PICKED_UP'
    case 'IN_TRANSIT': case 'OUT_FOR_DELIVERY': return 'IN_TRANSIT'
    case 'DELIVERED': return 'RECEIVED' // delivered to the warehouse = received
    case 'FAILED': case 'RTO': return 'FAILED'
    case 'CANCELLED': return 'CANCELLED'
    default: return null
  }
}

export const serializePickup = (p, events = []) => (p ? {
  provider: p.provider, awb: p.awb, courier_name: p.courier_name, tracking_url: p.tracking_url,
  status: p.status, provider_status: p.provider_status, scheduled_at: iso(p.scheduled_at),
  picked_up_at: iso(p.picked_up_at), received_at: iso(p.received_at), note: p.note,
  events: events.map((e) => ({ status: e.status, note: e.note, at: iso(e.occurred_at) })),
} : null)

export const serializeQc = (q) => (q ? {
  checks: Array.isArray(q.checks) ? q.checks : [],
  summary: q.summary || null,
  original_price: money(q.original_price),
  revised_price: q.revised_price != null ? money(q.revised_price) : null,
  price_status: q.price_status,
  customer_message: q.customer_message || null,
  inspected_at: iso(q.inspected_at),
  responded_at: iso(q.responded_at),
} : null)

/**
 * Pickup + QC + policy around a refund request. Money is never moved here — `RefundRequestsService.approve`
 * still does that, using the accepted QC price when there is one.
 */
export class ReturnJourneyService {
  constructor({ notifier = null, shipping = null, support = null } = {}) {
    this.notifier = notifier
    this._shipping = shipping
    this._support = support
  }

  async #shipping() {
    if (!this._shipping) {
      const { ShippingService } = await import('../shipping/shipping.service.js')
      this._shipping = new ShippingService()
    }
    return this._shipping
  }

  async #support() {
    if (!this._support) this._support = (await import('../support/support.service.js')).supportService
    return this._support
  }

  async #request(id, shopId = null) {
    const { rows } = await query(
      `SELECT r.*, o.order_number FROM refund_requests r JOIN orders o ON o.id = r.order_id WHERE r.id = $1`, [id])
    const r = rows[0]
    if (!r) throw fail('Return request not found', 'NOT_FOUND', 404)
    if (shopId && r.shop_id && r.shop_id !== shopId) throw fail('This return belongs to a different shop', 'CROSS_SHOP_ACCESS_DENIED', 403)
    return r
  }

  async #open(id, shopId) {
    const r = await this.#request(id, shopId)
    if (!['PENDING', 'PROCESSING'].includes(r.status)) throw fail(`This return is already ${r.status.toLowerCase()}.`, 'RETURN_CLOSED', 409)
    return r
  }

  async #notify(r, title, body) {
    if (!this.notifier) return
    try {
      await this.notifier.sendNotification(r.customer_id, {
        title, body, type: 'ORDER_STATUS',
        data: { type: 'ORDER_STATUS', orderId: r.order_id, orderNumber: r.order_number, refundRequestId: r.id },
      })
    } catch (err) {
      logger.warn({ err: err?.message, id: r.id }, 'Return notification failed (non-blocking)')
    }
  }

  // ── Policy ────────────────────────────────────────────────────────────
  async getSettings() {
    const { rows } = await query(`SELECT window_days, free_pickup, policy_points, updated_at FROM return_settings WHERE id = 1`)
    const s = rows[0] || { window_days: 7, free_pickup: true, policy_points: [] }
    return { window_days: s.window_days, free_pickup: s.free_pickup, points: Array.isArray(s.policy_points) ? s.policy_points : [], updated_at: s.updated_at || null }
  }

  async updateSettings({ windowDays, freePickup, points }, actor) {
    const cur = await this.getSettings()
    const next = {
      window_days: windowDays ?? cur.window_days,
      free_pickup: freePickup ?? cur.free_pickup,
      points: points ?? cur.points,
    }
    await query(
      `UPDATE return_settings SET window_days = $1, free_pickup = $2, policy_points = $3::jsonb, updated_by = $4, updated_at = NOW() WHERE id = 1`,
      [next.window_days, next.free_pickup, JSON.stringify(next.points), actor?.userId || null])
    logAdminActivity(actor?.userId, 'UPDATE_RETURN_SETTINGS', 'return_settings', '1', cur, next, actor?.ip)
    return this.getSettings()
  }

  /** Throws when a customer tries to start a return after the window closed. */
  async assertInsideWindow(order) {
    if (!order?.delivered_at) return
    const { window_days: days } = await this.getSettings()
    const last = new Date(new Date(order.delivered_at).getTime() + days * 86400000)
    if (Date.now() > last.getTime()) {
      throw fail(`The ${days}-day return window for this order closed on ${last.toISOString().slice(0, 10)}.`, 'RETURN_WINDOW_CLOSED', 409)
    }
  }

  // ── Reads ─────────────────────────────────────────────────────────────
  async journey(refundRequestId) {
    const pickup = (await query(`SELECT * FROM refund_pickups WHERE refund_request_id = $1`, [refundRequestId])).rows[0] || null
    const events = pickup ? (await query(`SELECT * FROM refund_pickup_events WHERE pickup_id = $1 ORDER BY occurred_at, id`, [pickup.id])).rows : []
    const qc = (await query(`SELECT * FROM refund_qc WHERE refund_request_id = $1`, [refundRequestId])).rows[0] || null
    return { pickup: serializePickup(pickup, events), qc: serializeQc(qc), default_parts: DEFAULT_QC_PARTS }
  }

  async adminJourney(id, shopId) {
    await this.#request(id, shopId)
    return this.journey(id)
  }

  // ── Pickup ────────────────────────────────────────────────────────────
  async #event(pickupId, status, providerStatus = null, note = null) {
    await query(`INSERT INTO refund_pickup_events (pickup_id, status, provider_status, note) VALUES ($1,$2,$3,$4)`, [pickupId, status, providerStatus, note])
  }

  /** Record the reverse pickup booked in Shiprocket / Porter (or handled by the team). Approves the return for the customer. */
  async savePickup(id, input, actor) {
    const r = await this.#open(id, actor.shopId)
    if (!PICKUP_PROVIDERS.includes(input.provider)) throw fail('Choose Shiprocket, Porter, Blue Dart or Self', 'VALIDATION_ERROR')
    const prev = (await query(`SELECT * FROM refund_pickups WHERE refund_request_id = $1`, [id])).rows[0]
    const { rows: [p] } = await query(
      `INSERT INTO refund_pickups (refund_request_id, provider, awb, courier_name, tracking_url, scheduled_at, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (refund_request_id) DO UPDATE SET provider = EXCLUDED.provider, awb = EXCLUDED.awb, courier_name = EXCLUDED.courier_name,
         tracking_url = EXCLUDED.tracking_url, scheduled_at = EXCLUDED.scheduled_at, note = EXCLUDED.note, updated_at = NOW()
       RETURNING *`,
      [id, input.provider, input.awb || null, input.courierName || null, input.trackingUrl || null, input.scheduledAt || null, input.note || null, actor.userId])
    await query(`UPDATE refund_requests SET return_approved_at = COALESCE(return_approved_at, NOW()), updated_at = NOW() WHERE id = $1`, [id])
    await this.#event(p.id, prev ? 'UPDATED' : 'PICKUP_SCHEDULED', null, prev ? 'Pickup details updated' : 'Pickup arranged')
    logAdminActivity(actor.userId, 'SAVE_RETURN_PICKUP', 'refund_request', id, prev || null, p, actor.ip)
    if (!prev) await this.#notify(r, 'Return approved', `Pickup for return of order ${r.order_number} is being arranged.`)
    return this.journey(id)
  }

  async setPickupStatus(id, status, note, actor, { providerStatus = null, system = false } = {}) {
    if (!PICKUP_STATUSES.includes(status)) throw fail('Unknown pickup status', 'VALIDATION_ERROR')
    const r = system ? await this.#request(id) : await this.#open(id, actor.shopId)
    const { rows: [p] } = await query(`SELECT * FROM refund_pickups WHERE refund_request_id = $1`, [id])
    if (!p) throw fail('Arrange the pickup first', 'NO_PICKUP', 409)
    if (p.status === status) return this.journey(id)
    await query(
      `UPDATE refund_pickups SET status = $2, provider_status = COALESCE($3, provider_status),
              picked_up_at = CASE WHEN $2 IN ('PICKED_UP','IN_TRANSIT','RECEIVED') THEN COALESCE(picked_up_at, NOW()) ELSE picked_up_at END,
              received_at = CASE WHEN $2 = 'RECEIVED' THEN COALESCE(received_at, NOW()) ELSE received_at END,
              updated_at = NOW() WHERE id = $1`,
      [p.id, status, providerStatus])
    await this.#event(p.id, status, providerStatus, note || null)
    if (!system) logAdminActivity(actor.userId, 'SET_RETURN_PICKUP_STATUS', 'refund_request', id, { status: p.status }, { status }, actor.ip)
    const msg = { PICKED_UP: 'Your item has been picked up.', IN_TRANSIT: 'Your item is on its way to us.', RECEIVED: 'We received your item and will inspect it shortly.', FAILED: 'The pickup could not be completed. We will contact you.' }[status]
    if (msg) await this.#notify(r, 'Return update', `${msg} (Order ${r.order_number})`)
    return this.journey(id)
  }

  /** Pull the latest status from the courier by AWB (Shiprocket / Porter adapters). */
  async syncPickup(id, actor) {
    await this.#open(id, actor.shopId)
    const { rows: [p] } = await query(`SELECT * FROM refund_pickups WHERE refund_request_id = $1`, [id])
    if (!p) throw fail('Arrange the pickup first', 'NO_PICKUP', 409)
    if (!p.awb || p.provider === 'SELF') throw fail('Add the courier AWB number to sync tracking', 'NO_AWB', 409)
    const shipping = await this.#shipping()
    const tracked = await shipping.trackByAwb(p.provider, p.awb)
    const next = pickupStatusFromShipping(tracked?.status)
    if (!next) return this.journey(id)
    return this.setPickupStatus(id, next, 'Synced from courier', actor, { providerStatus: tracked.providerStatus })
  }

  /** Courier webhook for a reverse pickup. Returns true when the AWB belonged to a return. */
  async applyWebhook(provider, payload) {
    const awb = payload?.awb || payload?.awb_code || payload?.data?.awb
    if (!awb) return false
    const { rows: [p] } = await query(`SELECT refund_request_id FROM refund_pickups WHERE awb = $1 LIMIT 1`, [awb])
    if (!p) return false
    const shipping = await this.#shipping()
    const providerStatus = payload.current_status || payload.status
    const next = pickupStatusFromShipping(await shipping.mapProviderStatus(provider, providerStatus))
    if (next) await this.setPickupStatus(p.refund_request_id, next, payload.remark || payload.comment || null, null, { providerStatus, system: true }).catch((err) => logger.warn({ err: err?.message }, 'Return webhook update skipped'))
    return true
  }

  // ── QC report + price revision ────────────────────────────────────────
  async saveQc(id, input, actor) {
    const r = await this.#open(id, actor.shopId)
    const checks = (input.checks || []).map((c) => {
      if (!QC_RESULTS.includes(c.status)) throw fail('Each QC check must be OK, MINOR_ISSUE or FAILED', 'VALIDATION_ERROR')
      return { key: String(c.key || c.label).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40), label: String(c.label).slice(0, 60), status: c.status, note: c.note ? String(c.note).slice(0, 200) : undefined }
    })
    if (!checks.length) throw fail('Add at least one QC check', 'VALIDATION_ERROR')
    const original = money(r.computed_amount)
    let revised = input.revisedPrice == null || input.revisedPrice === '' ? null : money(input.revisedPrice)
    if (revised != null && (revised < 0 || revised > original)) throw fail(`The revised price must be between ₹0 and the original ₹${original}.`, 'INVALID_REVISED_PRICE')
    if (revised === original) revised = null
    const priceStatus = revised == null ? 'NONE' : 'PROPOSED'
    const prev = (await query(`SELECT * FROM refund_qc WHERE refund_request_id = $1`, [id])).rows[0]
    await query(
      `INSERT INTO refund_qc (refund_request_id, checks, summary, original_price, revised_price, price_status, inspected_by)
       VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7)
       ON CONFLICT (refund_request_id) DO UPDATE SET checks = EXCLUDED.checks, summary = EXCLUDED.summary, revised_price = EXCLUDED.revised_price,
         price_status = EXCLUDED.price_status, inspected_by = EXCLUDED.inspected_by, inspected_at = NOW(),
         customer_message = NULL, responded_at = NULL, updated_at = NOW()`,
      [id, JSON.stringify(checks), input.summary || null, original, revised, priceStatus, actor.userId])
    await query(`UPDATE refund_requests SET return_approved_at = COALESCE(return_approved_at, NOW()), updated_at = NOW() WHERE id = $1`, [id])
    logAdminActivity(actor.userId, 'SAVE_RETURN_QC', 'refund_request', id, prev || null, { checks, revised }, actor.ip)
    await this.#notify(r, revised == null ? 'Quality check done' : 'Price changed after quality check',
      revised == null ? `Your item for order ${r.order_number} passed the quality check.` : `The refund for order ${r.order_number} changed to ₹${revised}. Please confirm in the app.`)
    return this.journey(id)
  }

  async #customerReturn(id, userId) {
    const r = await this.#request(id)
    if (r.customer_id !== userId) throw fail('Return request not found', 'NOT_FOUND', 404)
    return r
  }

  async acceptPrice(id, userId) {
    const r = await this.#customerReturn(id, userId)
    const { rows: [q] } = await query(`SELECT * FROM refund_qc WHERE refund_request_id = $1`, [id])
    if (!q || !['PROPOSED', 'CLARIFICATION'].includes(q.price_status)) throw fail('There is no new price waiting for your answer.', 'NO_PRICE_PENDING', 409)
    if (!['PENDING', 'PROCESSING'].includes(r.status)) throw fail('This return is already closed.', 'RETURN_CLOSED', 409)
    await query(`UPDATE refund_qc SET price_status = 'ACCEPTED', responded_at = NOW(), updated_at = NOW() WHERE refund_request_id = $1`, [id])
    return true
  }

  async clarifyPrice(id, userId, message) {
    const r = await this.#customerReturn(id, userId)
    const { rows: [q] } = await query(`SELECT * FROM refund_qc WHERE refund_request_id = $1`, [id])
    if (!q || q.price_status !== 'PROPOSED') throw fail('There is no new price waiting for your answer.', 'NO_PRICE_PENDING', 409)
    const text = String(message || '').trim() || 'I would like to understand the new price.'
    await query(`UPDATE refund_qc SET price_status = 'CLARIFICATION', customer_message = $2, responded_at = NOW(), updated_at = NOW() WHERE refund_request_id = $1`, [id, text])
    // The question goes into the return's chat so the team answers in one place.
    try {
      const support = await this.#support()
      const { rows: [t] } = await query(`SELECT id FROM support_tickets WHERE refund_request_id = $1 ORDER BY created_at LIMIT 1`, [id])
      if (t) await support.addMessage(t.id, { body: text, sender: { type: 'CUSTOMER', id: userId } })
      else await support.create({ userId, subject: `Return ${r.order_number}: price question`, message: text, category: 'RETURN_REFUND', orderId: r.order_id, refundRequestId: id })
    } catch (err) {
      logger.warn({ err: err?.message, id }, 'Could not post the price question to chat (the request is still marked)')
    }
    return true
  }

  /** The amount a final approval must refund, or throws while the customer still owes an answer. */
  async approvalAmount(id) {
    const { rows: [q] } = await query(`SELECT * FROM refund_qc WHERE refund_request_id = $1`, [id])
    if (!q) return null
    if (q.price_status === 'PROPOSED' || q.price_status === 'CLARIFICATION') {
      throw fail(q.price_status === 'PROPOSED' ? 'Waiting for the customer to accept the revised price.' : 'The customer asked a question about the revised price — answer it in chat, then ask them to accept.', 'QC_PRICE_PENDING', 409)
    }
    return q.price_status === 'ACCEPTED' && q.revised_price != null ? money(q.revised_price) : null
  }
}
