/**
 * Vendor abandoned carts.
 *
 * A vendor sees carts (B2C retail and B2B wholesale) that contain THEIR products and were left
 * idle, and may remind the customer about those products only. Rules enforced here, not in the app:
 *   - the vendor only ever receives their own lines; the customer's phone/email are never returned
 *     (reminders go out as an in-app + push notification through the platform);
 *   - only an OPEN episode whose items are still in the live cart can be nudged;
 *   - promotions opt-out is respected;
 *   - per-vendor cooldown + per-cart cap + a per-customer daily cap across ALL senders;
 *   - templates are server-rendered from a closed set (no free text, no invented urgency).
 *
 * @module modules/vendor-abandoned-carts/vendor-abandoned-carts.service
 */

import { query } from '../../config/database.js'
import { CartRepository } from '../cart/cart.repository.js'
import { NotificationsRepository } from '../notifications/notifications.repository.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import {
  ABANDONMENT_THRESHOLD_MS, CUSTOMER_DAILY_CAP, LOW_STOCK_THRESHOLD, VENDOR_MAX_PER_CART, VENDOR_REMINDER_COOLDOWN_MS, channelOf,
} from '../../constants/abandonedCart.js'
import { withTx } from '../ads/ads.shared.js'
import * as repo from './vendor-abandoned-carts.repository.js'
import { VENDOR_TEMPLATES, maskName, render, templatesFor } from './vendor-abandoned-carts.templates.js'

export class VendorCartError extends Error {
  constructor(code, message, statusCode = 400, details = {}) {
    super(message)
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

const cartRepository = new CartRepository()
const num = (v) => (v == null ? 0 : Number(v))
const CHANNELS = ['ALL', 'B2B', 'B2C']

const normChannel = (c) => {
  const v = String(c || 'ALL').toUpperCase()
  return CHANNELS.includes(v) ? v : 'ALL'
}

/** change vs the previous period, or null when there is nothing to compare with. */
const delta = (now, before) => (before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null)

export async function summary(vendorId, { channel, days = 30 } = {}) {
  const ch = normChannel(channel)
  const d = Math.min(90, Math.max(1, Number(days) || 30))
  const [cur, prev] = await Promise.all([
    repo.windowTotals(vendorId, { channel: ch, fromDays: d, toDays: 0 }),
    repo.windowTotals(vendorId, { channel: ch, fromDays: d * 2, toDays: d }),
  ])
  const rate = (t) => (t.carts > 0 ? t.ordered / t.carts : 0)
  return {
    days: d,
    channel: ch,
    idle_minutes: Math.round(ABANDONMENT_THRESHOLD_MS / 60000),
    carts: cur.carts,
    open_carts: cur.open_carts,
    pending_value: num(cur.pending_value),
    recovered_orders: cur.ordered,
    recovered_value: num(cur.ordered_value),
    ordered_after_reminder: cur.ordered_after_reminder,
    recovery_rate: Math.round(rate(cur) * 1000) / 1000,
    change: {
      carts: delta(cur.carts, prev.carts),
      pending_value: delta(num(cur.pending_value), num(prev.pending_value)),
      recovered_orders: delta(cur.ordered, prev.ordered),
      recovery_rate: delta(rate(cur), rate(prev)),
    },
  }
}

export async function list(vendorId, { channel, state, search, days = 30, page = 1, limit = 25 } = {}) {
  const lim = Math.min(100, Math.max(1, Number(limit) || 25))
  const pg = Math.max(1, Number(page) || 1)
  const { rows, total } = await repo.listEpisodes(vendorId, {
    channel: normChannel(channel), state: String(state || '').toUpperCase(), search: String(search || '').slice(0, 80),
    days, limit: lim, offset: (pg - 1) * lim,
  })
  return {
    data: rows.map((r) => ({
      id: r.id,
      channel: channelOf(r.price_mode),
      state: r.state,
      customer: maskName(r.customer_name),
      abandoned_at: r.abandoned_at,
      item_count: r.item_count,
      quantity: r.quantity,
      value: num(r.value),
      top_product: r.top_product,
      top_thumbnail: r.top_thumbnail,
      my_reminders: r.my_reminders,
      last_reminder_at: r.last_reminder_at,
    })),
    pagination: { page: pg, limit: lim, total },
  }
}

/** What the vendor may do about this episode right now. */
async function eligibility(vendorId, episode) {
  if (episode.status !== 'OPEN') {
    return { can_remind: false, reason: 'NOT_OPEN', message: 'This cart is no longer open — no reminder needed.' }
  }
  const prefs = episode.notification_preferences || {}
  if (prefs.promotions === false) {
    return { can_remind: false, reason: 'OPTED_OUT', message: 'This customer has turned off promotional notifications.' }
  }
  const mine = await repo.vendorReminders(vendorId, episode.id)
  if (mine.length >= VENDOR_MAX_PER_CART) {
    return { can_remind: false, reason: 'LIMIT_REACHED', message: `You have already sent ${VENDOR_MAX_PER_CART} reminders for this cart.` }
  }
  if (mine[0]) {
    const wait = VENDOR_REMINDER_COOLDOWN_MS - (Date.now() - new Date(mine[0].created_at).getTime())
    if (wait > 0) {
      return {
        can_remind: false, reason: 'COOLDOWN', next_allowed_at: new Date(Date.now() + wait).toISOString(),
        message: `You sent a reminder recently. You can send another in ${humanWait(wait)}.`,
      }
    }
  }
  if ((await repo.customerPushesLast24h(episode.user_id)) >= CUSTOMER_DAILY_CAP) {
    return { can_remind: false, reason: 'CUSTOMER_CAP', message: 'This customer has received several reminders today. Try again tomorrow.' }
  }
  return { can_remind: true }
}

function humanWait(ms) {
  const m = Math.ceil(ms / 60000)
  return m >= 90 ? `${Math.ceil(m / 60)} hours` : `${m} min`
}

const notFound = () => new VendorCartError('NOT_FOUND', 'Cart not found', 404)

export async function detail(vendorId, id) {
  const ep = await repo.findEpisode(vendorId, id)
  if (!ep) throw notFound()
  const [items, reminders, events, shop] = await Promise.all([
    repo.sliceItems(vendorId, id), repo.vendorReminders(vendorId, id), repo.publicEvents(id), repo.vendorName(vendorId),
  ])
  const elig = await eligibility(vendorId, ep)
  const lines = items.map((i) => ({
    product_id: i.product_id,
    name: i.product_name,
    thumbnail: i.product_thumbnail_url,
    unit: i.product_unit,
    quantity: i.quantity,
    unit_price: num(i.unit_price),
    list_price: num(i.list_price),
    line_total: num(i.line_total),
    stock: i.stock == null ? null : Number(i.stock),
  }))
  const slice = { customerName: ep.customer_name, vendorName: shop, items: items.map((i) => ({ productName: i.product_name, quantity: i.quantity, stock: i.stock == null ? null : Number(i.stock) })) }

  const timeline = [
    ...events.map((e) => ({ at: e.created_at, kind: e.event_type })),
    ...reminders.map((r) => ({ at: r.created_at, kind: 'MY_REMINDER', template: r.template_key })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at))

  return {
    id: ep.id,
    channel: channelOf(ep.price_mode),
    state: ep.state,
    customer: maskName(ep.customer_name),
    abandoned_at: ep.abandoned_at,
    total: lines.reduce((n, l) => n + l.line_total, 0),
    items: lines,
    timeline,
    reminder: {
      ...elig,
      sent: reminders.length,
      max: VENDOR_MAX_PER_CART,
      templates: templatesFor(slice, LOW_STOCK_THRESHOLD),
    },
  }
}

/**
 * Resolves what a reminder would contain: the episode, the vendor's chosen lines that are STILL in the
 * live cart, and the rendered template. Shared by preview and send so the preview is exactly what goes out.
 */
async function prepare(vendorId, id, { templateKey, productIds }, { closeIfStale = false } = {}) {
  const tpl = VENDOR_TEMPLATES[templateKey]
  if (!tpl) throw new VendorCartError('INVALID_TEMPLATE', 'Choose a message to send', 422)

  const ep = await repo.findEpisode(vendorId, id)
  if (!ep) throw notFound()

  let items = await repo.sliceItems(vendorId, id)
  if (Array.isArray(productIds) && productIds.length) {
    const wanted = new Set(productIds)
    items = items.filter((i) => wanted.has(i.product_id))
    if (!items.length) throw new VendorCartError('NOT_YOUR_PRODUCT', 'You can only remind about your own products in this cart', 403)
  }

  // The snapshot can be stale (the customer may have removed the item, or ordered through a path that
  // did not close the episode). Trust only the live cart.
  const live = await cartRepository.getCart(ep.user_id, ep.price_mode === 'wholesale' ? 'wholesale' : 'retail')
  const liveKeys = new Set(live.map((l) => `${l.productId}:${l.shopId}`))
  const stillThere = items.filter((i) => liveKeys.has(`${i.product_id}:${i.shop_id}`))
  if (!stillThere.length) {
    if (closeIfStale) {
      await query(`UPDATE abandoned_carts SET status = 'EXPIRED', expired_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'OPEN'`, [id])
      await query(`INSERT INTO abandoned_cart_events (abandoned_cart_id, event_type, actor_type, metadata) VALUES ($1,'EXPIRED','SYSTEM',$2)`, [id, JSON.stringify({ reason: 'CART_CHANGED' })])
    }
    throw new VendorCartError('CART_CHANGED', 'The customer has already changed or finished this cart — no reminder needed.', 409)
  }
  items = stillThere

  const shop = await repo.vendorName(vendorId)
  const slice = { customerName: ep.customer_name, vendorName: shop, items: items.map((i) => ({ productName: i.product_name, quantity: i.quantity, stock: i.stock == null ? null : Number(i.stock) })) }
  const chosen = templatesFor(slice, LOW_STOCK_THRESHOLD).find((t) => t.key === templateKey)
  if (!chosen.available) throw new VendorCartError('TEMPLATE_UNAVAILABLE', chosen.unavailableReason, 409)
  return { ep, items, chosen }
}

/** What the customer would receive for this template + product selection. */
export async function preview(vendorId, id, input) {
  const { items, chosen } = await prepare(vendorId, id, input)
  return { title: chosen.title, body: chosen.body, product_count: items.length }
}

/**
 * Send a reminder about [productIds] (default: all of this vendor's lines) using [templateKey].
 */
export async function remind(vendorId, id, input = {}, { userId, fastify }) {
  const { templateKey } = input
  const { ep, items, chosen } = await prepare(vendorId, id, input, { closeIfStale: true })

  const reminderId = await withTx(async (client) => {
    // One reminder at a time per (cart, vendor): the check and the reservation share a lock.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`vac:${id}:${vendorId}`])
    const fresh = (await client.query(`SELECT status FROM abandoned_carts WHERE id = $1`, [id])).rows[0]
    if (!fresh || fresh.status !== 'OPEN') throw new VendorCartError('NOT_OPEN', 'This cart is no longer open — no reminder needed.', 409)
    const elig = await eligibility(vendorId, { ...ep, status: 'OPEN' })
    if (!elig.can_remind) throw new VendorCartError(elig.reason, elig.message, elig.reason === 'COOLDOWN' ? 429 : 409, { next_allowed_at: elig.next_allowed_at })
    const { rows } = await client.query(
      `INSERT INTO abandoned_cart_vendor_reminders (abandoned_cart_id, vendor_id, template_key, product_ids, sent_by)
       VALUES ($1,$2,$3,$4::uuid[],$5) RETURNING id`, [id, vendorId, templateKey, items.map((i) => i.product_id), userId || null])
    return rows[0].id
  })

  try {
    const notif = await new NotificationsService(new NotificationsRepository(), fastify).sendNotification(ep.user_id, {
      title: chosen.title,
      body: chosen.body,
      type: 'abandoned_cart',
      data: { deepLink: '/cart', priceMode: ep.price_mode, vendorId, source: 'vendor' },
    })
    await query(`UPDATE abandoned_cart_vendor_reminders SET notification_id = $2 WHERE id = $1`, [reminderId, notif.id])
    await query(
      `INSERT INTO abandoned_cart_events (abandoned_cart_id, event_type, actor_type, actor_id, metadata) VALUES ($1,'VENDOR_REMINDER_SENT','VENDOR',$2,$3)`,
      [id, userId || null, JSON.stringify({ vendorId, template: templateKey, productIds: items.map((i) => i.product_id) })])
  } catch (err) {
    // Nothing reached the customer — give the vendor their slot back.
    await query(`DELETE FROM abandoned_cart_vendor_reminders WHERE id = $1`, [reminderId]).catch(() => {})
    throw new VendorCartError('SEND_FAILED', 'Could not send the reminder. Please try again.', 502)
  }

  fastify?.emitAbandonedCartUpdate?.({ userId: ep.user_id, abandonedCartId: id, status: 'VENDOR_REMINDER' })
  return detail(vendorId, id)
}

export { render }
