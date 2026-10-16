/**
 * Sell-your-phone negotiation: one chat thread per (request, buyer-vendor).
 *
 * The customer lists a phone, vendors offer, and the two sides talk before the customer accepts. Rules:
 *  - A thread belongs to one request and one vendor; the customer only ever sees buyers that offered or wrote.
 *  - Nobody can write to a closed request, or to a buyer whose offer was not the one accepted.
 *  - Until an offer is accepted, phone numbers cannot be shared in chat (contact details are released at acceptance).
 *  - Customers are shown to vendors as "Seller" — no name or number before acceptance.
 *
 * @module modules/sell-requests/sell-chat.service
 */
import { query } from '../../config/database.js'
import { SellError, tx } from './sell-requests.service.js'
import { notifySellEvent } from './sell-requests.notify.js'

const OPEN = ['PENDING', 'IN_PROGRESS']
const WRITABLE = ['PENDING', 'IN_PROGRESS', 'APPROVED']
const MAX_THREAD = 300
const PHONE_LIKE = /(?:\d[\s\-.]?){10,}/
const iso = (d) => (d ? new Date(d).toISOString() : null)
const num = (v) => (v == null ? null : Number(v))

function cleanBody(raw, { assigned }) {
  const body = String(raw ?? '').replace(/\s+\n/g, '\n').trim().slice(0, 1000)
  if (!body) throw new SellError('VALIDATION', 'Type a message first', 422)
  if (!assigned && PHONE_LIKE.test(body)) {
    throw new SellError('NO_CONTACT_DETAILS', 'For your safety, phone numbers can be shared only after an offer is accepted.', 422)
  }
  return body
}

/** Why this thread cannot take a new message (null = it can). */
function lockedReason(r, vendorId) {
  if (!WRITABLE.includes(r.status)) return 'This sale is closed.'
  if (r.assigned_vendor_id && r.assigned_vendor_id !== vendorId) return 'You accepted another buyer’s offer.'
  return null
}

const msg = (m, mine) => ({ id: Number(m.id), from: m.sender_role === mine ? 'ME' : 'OTHER', body: m.body, at: iso(m.created_at) })

async function ownRequest(userId, id, client = null) {
  const run = client ? client.query.bind(client) : query
  const { rows } = await run(`SELECT * FROM sell_requests WHERE id = $1 AND user_id = $2 AND kind = 'SELL'`, [id, userId])
  if (!rows[0]) throw new SellError('NOT_FOUND', 'Sell request not found', 404)
  return rows[0]
}

// ── customer ────────────────────────────────────────────────────────────

/** Every buyer the customer can talk to: those with an offer or a message, with the latest line and unread count. */
export async function customerThreads(userId, id) {
  const r = await ownRequest(userId, id)
  const { rows } = await query(
    `WITH talk AS (
        SELECT vendor_id FROM sell_request_offers WHERE request_id = $1 AND status <> 'WITHDRAWN'
        UNION SELECT vendor_id FROM sell_request_messages WHERE request_id = $1)
     SELECT t.vendor_id, COALESCE(s.shop_name, v.name) AS vendor_name, s.city, COALESCE(s.rating, 0) AS rating,
            o.id AS offer_id, o.amount AS offer_amount, o.status AS offer_status,
            lm.body AS last_body, lm.sender_role AS last_role, lm.created_at AS last_at,
            (SELECT COUNT(*)::int FROM sell_request_messages m WHERE m.request_id = $1 AND m.vendor_id = t.vendor_id
                AND m.sender_role = 'VENDOR' AND m.customer_read_at IS NULL) AS unread
       FROM talk t JOIN vendors v ON v.id = t.vendor_id
       LEFT JOIN LATERAL (SELECT MIN(name) AS shop_name, MIN(city) AS city, COALESCE(MAX(seller_rating), 0) AS rating
                            FROM shops WHERE vendor_id = t.vendor_id AND deleted_at IS NULL AND is_active) s ON TRUE
       LEFT JOIN sell_request_offers o ON o.request_id = $1 AND o.vendor_id = t.vendor_id AND o.status <> 'WITHDRAWN'
       LEFT JOIN LATERAL (SELECT body, sender_role, created_at FROM sell_request_messages
                           WHERE request_id = $1 AND vendor_id = t.vendor_id ORDER BY id DESC LIMIT 1) lm ON TRUE
      ORDER BY lm.created_at DESC NULLS LAST, o.amount DESC NULLS LAST`, [id])
  return {
    requestId: id,
    unread: rows.reduce((n, x) => n + x.unread, 0),
    threads: rows.map((x) => ({
      vendorId: x.vendor_id, vendorName: x.vendor_name, city: x.city || null, rating: Number(x.rating || 0),
      offerId: x.offer_id || null, offerAmount: num(x.offer_amount), offerStatus: x.offer_status || null,
      lastMessage: x.last_body || null, lastFrom: x.last_role ? (x.last_role === 'CUSTOMER' ? 'ME' : 'OTHER') : null, lastAt: iso(x.last_at),
      unread: x.unread, canReply: !lockedReason(r, x.vendor_id),
    })),
  }
}

export async function customerThread(userId, id, vendorId) {
  const r = await ownRequest(userId, id)
  const { rows: v } = await query(
    `SELECT v.id, COALESCE(s.shop_name, v.name) AS name, s.city, COALESCE(s.rating, 0) AS rating
       FROM vendors v LEFT JOIN LATERAL (SELECT MIN(name) AS shop_name, MIN(city) AS city, COALESCE(MAX(seller_rating), 0) AS rating
                            FROM shops WHERE vendor_id = v.id AND deleted_at IS NULL AND is_active) s ON TRUE
      WHERE v.id = $1`, [vendorId])
  if (!v[0]) throw new SellError('NOT_FOUND', 'Buyer not found', 404)
  const { rows: o } = await query(`SELECT id, amount, status, note FROM sell_request_offers WHERE request_id = $1 AND vendor_id = $2 AND status <> 'WITHDRAWN'`, [id, vendorId])
  const { rows: m } = await query(`SELECT * FROM sell_request_messages WHERE request_id = $1 AND vendor_id = $2 ORDER BY id LIMIT $3`, [id, vendorId, MAX_THREAD])
  if (!o[0] && !m.length) throw new SellError('NOT_FOUND', 'No conversation with this buyer yet', 404)
  await query(`UPDATE sell_request_messages SET customer_read_at = NOW() WHERE request_id = $1 AND vendor_id = $2 AND sender_role = 'VENDOR' AND customer_read_at IS NULL`, [id, vendorId])
  const locked = lockedReason(r, vendorId)
  return {
    requestId: id, code: r.code,
    vendor: { id: v[0].id, name: v[0].name, city: v[0].city || null, rating: Number(v[0].rating || 0) },
    offer: o[0] ? { id: o[0].id, amount: num(o[0].amount), status: o[0].status, note: o[0].note || undefined } : null,
    canReply: !locked, lockedReason: locked,
    messages: m.map((x) => msg(x, 'CUSTOMER')),
  }
}

export async function customerSend(userId, id, vendorId, bodyRaw) {
  await tx(async (client) => {
    const r = await ownRequest(userId, id, client)
    const locked = lockedReason(r, vendorId)
    if (locked) throw new SellError('THREAD_CLOSED', locked, 409)
    const { rows: ok } = await client.query(
      `SELECT 1 FROM sell_request_offers WHERE request_id = $1 AND vendor_id = $2 AND status <> 'WITHDRAWN'
       UNION SELECT 1 FROM sell_request_messages WHERE request_id = $1 AND vendor_id = $2 LIMIT 1`, [id, vendorId])
    if (!ok[0]) throw new SellError('NOT_FOUND', 'That buyer has not made an offer or written to you yet', 404)
    const { rows: c } = await client.query('SELECT COUNT(*)::int AS n FROM sell_request_messages WHERE request_id = $1 AND vendor_id = $2', [id, vendorId])
    if (c[0].n >= MAX_THREAD) throw new SellError('THREAD_FULL', 'This conversation is full', 409)
    const body = cleanBody(bodyRaw, { assigned: r.assigned_vendor_id === vendorId })
    await client.query(
      `INSERT INTO sell_request_messages (request_id, vendor_id, sender_role, sender_user_id, body, customer_read_at) VALUES ($1,$2,'CUSTOMER',$3,$4,NOW())`,
      [id, vendorId, userId, body])
    return body
  }).then((body) => notifySellEvent('MESSAGE_FROM_CUSTOMER', id, { vendorId, preview: body, skipCustomer: true }))
  return customerThread(userId, id, vendorId)
}

// ── vendor ──────────────────────────────────────────────────────────────

async function vendorRequest(actor, id, client = null) {
  const run = client ? client.query.bind(client) : query
  const { rows: v } = await run(`SELECT 1 FROM vendors WHERE id = $1 AND is_active = TRUE AND status IN ('VERIFIED','ACTIVE') AND deleted_at IS NULL`, [actor.vendorId])
  if (!v[0]) throw new SellError('VENDOR_NOT_ACTIVE', 'Only verified, active vendors can chat with sellers', 403)
  const { rows } = await run(`SELECT * FROM sell_requests WHERE id = $1 AND kind = 'SELL'`, [id])
  const r = rows[0]
  if (!r) throw new SellError('NOT_FOUND', 'Sell request not found', 404)
  if (!OPEN.includes(r.status) && r.assigned_vendor_id !== actor.vendorId) throw new SellError('NOT_FOUND', 'Sell request not found', 404)
  return r
}

export async function vendorThread(actor, id) {
  const r = await vendorRequest(actor, id)
  const { rows: m } = await query(`SELECT * FROM sell_request_messages WHERE request_id = $1 AND vendor_id = $2 ORDER BY id LIMIT $3`, [id, actor.vendorId, MAX_THREAD])
  await query(`UPDATE sell_request_messages SET vendor_read_at = NOW() WHERE request_id = $1 AND vendor_id = $2 AND sender_role = 'CUSTOMER' AND vendor_read_at IS NULL`, [id, actor.vendorId])
  const locked = lockedReason(r, actor.vendorId)
  return { requestId: id, code: r.code, canReply: !locked, lockedReason: locked, messages: m.map((x) => msg(x, 'VENDOR')) }
}

export async function vendorSend(actor, id, bodyRaw) {
  const body = await tx(async (client) => {
    const r = await vendorRequest(actor, id, client)
    const locked = lockedReason(r, actor.vendorId)
    if (locked) throw new SellError('THREAD_CLOSED', locked, 409)
    if (!r.user_id) throw new SellError('INVALID_STATE', 'This request has no app customer to chat with', 409)
    const { rows: c } = await client.query('SELECT COUNT(*)::int AS n FROM sell_request_messages WHERE request_id = $1 AND vendor_id = $2', [id, actor.vendorId])
    if (c[0].n >= MAX_THREAD) throw new SellError('THREAD_FULL', 'This conversation is full', 409)
    const text = cleanBody(bodyRaw, { assigned: r.assigned_vendor_id === actor.vendorId })
    await client.query(
      `INSERT INTO sell_request_messages (request_id, vendor_id, sender_role, sender_user_id, body, vendor_read_at) VALUES ($1,$2,'VENDOR',$3,$4,NOW())`,
      [id, actor.vendorId, actor.userId || null, text])
    return text
  })
  notifySellEvent('MESSAGE_FROM_VENDOR', id, { vendorId: actor.vendorId, preview: body })
  return vendorThread(actor, id)
}
