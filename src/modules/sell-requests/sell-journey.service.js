/**
 * Sell-your-phone journey (customer → verified vendors only; never customer-to-customer).
 *
 *   verify IMEI → estimate → list → vendors offer (time-boxed) → customer accepts one offer
 *   → vendor funds the purchase (held by the platform) → pickup / drop-off (courier status, no live map)
 *   → vendor inspects (request QC) → final price (customer decides if it dropped) → payout to the customer
 *
 * Invariants
 *  - Every state change takes the request row lock and checks the current `stage`; there is no way to skip a step.
 *  - Money is append-only in `sell_payments` (idempotent per request + key). The customer is paid only from funds the
 *    vendor already put in (when `require_vendor_funding`), never more than the accepted offer.
 *  - Payout details are encrypted at rest and only ever returned masked.
 *  - A vendor sees and acts on its own accepted requests only; the customer's phone and address reach the vendor
 *    after acceptance (existing masking in sell-requests.service still applies before that).
 *  - No live location: pickup progress is courier status events plus an optional tracking link.
 *
 * @module modules/sell-requests/sell-journey.service
 */
import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { decryptSecret, encryptSecret } from '../../utils/encryption.js'
import { haversineKm } from '../../utils/distance.js'
import { SellError, addEvent, getSettings, lock, tx } from './sell-requests.service.js'
import { isValidImei } from './valuation.js'
import { notifySellEvent } from './sell-requests.notify.js'

const num = (v) => (v == null ? null : Number(v))
const text = (v, max) => String(v ?? '').trim().slice(0, max)
const money = (n) => Math.round(Number(n) * 100) / 100
const iso = (d) => (d ? new Date(d).toISOString() : null)
/** node-pg returns DATE columns as local-midnight Date objects; format them back as YYYY-MM-DD. */
const ymd = (d) => {
  if (d == null) return null
  if (typeof d === 'string') return d.slice(0, 10)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export const PICKUP_PROVIDERS = ['SHIPROCKET', 'PORTER', 'BLUEDART', 'SELF']
export const PICKUP_STATUSES = ['PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'RECEIVED', 'FAILED', 'CANCELLED']
export const PICKUP_WINDOWS = ['9 AM - 12 PM', '12 PM - 3 PM', '3 PM - 6 PM', '6 PM - 8 PM']
const FUNDING_METHODS = ['UPI', 'BANK', 'CARD', 'CASH', 'RAZORPAY']
const UPI_RE = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/
const CLOSED = ['REJECTED', 'CANCELLED', 'COMPLETED']

/** Rounded to the nearest ₹100 like every other quote. */
const round100 = (n) => Math.round(Number(n) / 100) * 100

/** Estimate band around the system's own valuation. Pure. */
export function estimateRange(value, spreadPct) {
  const s = Math.max(0, Number(spreadPct) || 0) / 100
  return { min: round100(value * (1 - s / 2)), max: round100(value * (1 + s / 2)) }
}

// ── 1 · IMEI verification ───────────────────────────────────────────────

/**
 * Eligibility checks we can honestly run. There is no public API for the government CEIR/KYM database
 * (OTP form / SMS only), so that check is part of the physical inspection and is reported as INFO — never as "passed".
 */
export async function verifyImei(userId, { imei, modelId } = {}) {
  const v = String(imei ?? '').replace(/\s+/g, '')
  const checks = []
  const add = (key, label, status, message) => checks.push({ key, label, status, message })

  const format = isValidImei(v)
  add('FORMAT', 'Valid IMEI', format ? 'PASS' : 'FAIL', format ? undefined : 'An IMEI is 15 digits. Dial *#06# to see it.')
  if (format) {
    const { rows: blocked } = await query('SELECT 1 FROM sell_imei_blocklist WHERE imei = $1', [v])
    add('BLOCKLIST', 'Not on our blocked list', blocked[0] ? 'FAIL' : 'PASS', blocked[0] ? 'This device cannot be sold on Dealker.' : undefined)

    const { rows: live } = await query(
      `SELECT id, user_id, code FROM sell_requests WHERE imei = $1 AND status IN ('PENDING','IN_PROGRESS','APPROVED') LIMIT 1`, [v])
    const mine = live[0] && live[0].user_id === userId
    add('NO_LIVE_REQUEST', 'Not already listed', live[0] ? 'FAIL' : 'PASS',
      live[0] ? (mine ? `You already have a live request for this phone (${live[0].code}).` : 'A live request already exists for this phone.') : undefined)

    const { rows: sold } = await query(
      `SELECT 1 FROM sell_requests WHERE imei = $1 AND status = 'COMPLETED' AND user_id IS DISTINCT FROM $2 LIMIT 1`, [v, userId])
    if (sold[0]) add('SOLD_BEFORE', 'Sold on Dealker before', 'WARN', 'This phone was sold on Dealker earlier by another account. The buyer will confirm ownership at inspection.')

    add('CEIR', 'Government (CEIR) check', 'INFO', 'The buyer checks the IMEI against the national CEIR database when the phone is inspected.')
  }
  const eligible = checks.every((c) => c.status !== 'FAIL')
  const { rows } = await query(
    `INSERT INTO sell_imei_checks (user_id, imei, model_id, eligible, checks) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [userId, v.slice(0, 15), modelId && /^[0-9a-f-]{36}$/i.test(modelId) ? modelId : null, eligible, JSON.stringify(checks)])
  return { checkId: rows[0].id, imei: v, eligible, checks }
}

/** Is there a recent, passing check by this user for this IMEI? */
export async function findPassingCheck(client, userId, imei, checkId) {
  if (!checkId || !/^[0-9a-f-]{36}$/i.test(String(checkId))) return null
  const { rows } = await client.query(
    `SELECT id FROM sell_imei_checks WHERE id = $1 AND user_id = $2 AND imei = $3 AND eligible AND created_at > NOW() - INTERVAL '24 hours'`, [checkId, userId, imei])
  return rows[0] || null
}

export async function assertNotBlocked(imei, client = null) {
  const run = client ? client.query.bind(client) : query
  const { rows } = await run('SELECT 1 FROM sell_imei_blocklist WHERE imei = $1', [imei])
  if (rows[0]) throw new SellError('IMEI_BLOCKED', 'This device cannot be sold on Dealker', 403)
}

// ── Blocklist (dashboard) ───────────────────────────────────────────────
export async function listBlocklist({ q = '', page = 1, limit = 25 } = {}) {
  const lim = Math.min(100, Math.max(1, Number(limit) || 25))
  const off = (Math.max(1, Number(page) || 1) - 1) * lim
  const params = []
  let where = ''
  if (q) { params.push(`%${String(q).replace(/\D/g, '')}%`); where = 'WHERE b.imei LIKE $1' }
  const { rows } = await query(
    `SELECT b.*, u.name AS created_by_name, COUNT(*) OVER() AS total FROM sell_imei_blocklist b LEFT JOIN users u ON u.id = b.created_by ${where}
      ORDER BY b.created_at DESC LIMIT ${lim} OFFSET ${off}`, params)
  return { items: rows.map((r) => ({ imei: r.imei, reason: r.reason, source: r.source, createdBy: r.created_by_name, createdAt: iso(r.created_at) })), total: Number(rows[0]?.total || 0) }
}

export async function addToBlocklist(actor, { imei, reason, source = 'MANUAL' } = {}) {
  if (!isValidImei(imei)) throw new SellError('INVALID_IMEI', 'IMEI must be 15 digits and pass the checksum', 422)
  const why = text(reason, 300)
  if (!why) throw new SellError('VALIDATION', 'A reason is required', 422)
  if (!['MANUAL', 'POLICE', 'CEIR', 'CUSTOMER_DISPUTE', 'PROVIDER'].includes(source)) throw new SellError('VALIDATION', 'Unknown source', 422)
  await query(`INSERT INTO sell_imei_blocklist (imei, reason, source, created_by) VALUES ($1,$2,$3,$4)
               ON CONFLICT (imei) DO UPDATE SET reason = EXCLUDED.reason, source = EXCLUDED.source`, [imei, why, source, actor.userId])
  return { imei, reason: why, source }
}

export async function removeFromBlocklist(imei) {
  const { rowCount } = await query('DELETE FROM sell_imei_blocklist WHERE imei = $1', [imei])
  if (!rowCount) throw new SellError('NOT_FOUND', 'That IMEI is not on the blocklist', 404)
  return { removed: true }
}

// ── 2 · Estimate ────────────────────────────────────────────────────────

/** Verified, active vendors that could bid (with a live shop; same city when known). */
export async function countNearbyVendors({ city = null, pincode = null } = {}) {
  const { rows } = await query(
    `SELECT COUNT(DISTINCT v.id)::int AS n FROM vendors v JOIN shops s ON s.vendor_id = v.id AND s.deleted_at IS NULL AND s.is_active
      WHERE v.is_active AND v.deleted_at IS NULL AND v.status IN ('VERIFIED','ACTIVE')
        AND ($1::text IS NULL OR lower(s.city) = lower($1) OR $2::text = ANY(s.serviceable_pincodes) OR s.pincode = $2)`,
    [city, pincode])
  return rows[0].n
}

// ── Offers ──────────────────────────────────────────────────────────────

const offerOpen = (r) => !r.offers_close_at || new Date(r.offers_close_at).getTime() > Date.now()

/** What the customer compares. Vendor names are shown; amounts are the vendors' own. */
export async function listOffersForCustomer(userId, id) {
  const { rows: rq } = await query('SELECT * FROM sell_requests WHERE id = $1 AND user_id = $2 AND kind = $3', [id, userId, 'SELL'])
  const r = rq[0]
  if (!r) throw new SellError('NOT_FOUND', 'Sell request not found', 404)
  const { rows } = await query(
    `SELECT o.*, v.name AS vendor_name, s.city, s.rating, s.shop_name, s.address
       FROM sell_request_offers o JOIN vendors v ON v.id = o.vendor_id
       LEFT JOIN LATERAL (SELECT MIN(name) AS shop_name, MIN(city) AS city, COALESCE(MAX(seller_rating), 0) AS rating,
                                 MIN(concat_ws(', ', address_line1, city, pincode)) AS address
                            FROM shops WHERE vendor_id = o.vendor_id AND deleted_at IS NULL AND is_active) s ON TRUE
      WHERE o.request_id = $1 AND o.status IN ('OPEN', 'ACCEPTED') ORDER BY o.amount DESC, o.created_at`, [id])
  const open = offerOpen(r)
  const best = rows.length ? Math.max(...rows.map((o) => Number(o.amount))) : null
  return {
    requestId: id, code: r.code, status: r.status, stage: r.stage,
    estimate: { min: num(r.estimate_min), max: num(r.estimate_max), quote: num(r.quote) },
    offersCloseAt: iso(r.offers_close_at), open: open && !r.assigned_vendor_id, refreshesLeft: await refreshesLeft(r),
    best,
    offers: rows.map((o) => ({
      id: o.id, vendorId: o.vendor_id, vendorName: o.shop_name || o.vendor_name, city: o.city || null, rating: Number(o.rating || 0),
      distanceKm: num(o.distance_km), amount: num(o.amount), note: o.note || undefined, status: o.status,
      best: Number(o.amount) === best && rows.length > 1, address: o.status === 'ACCEPTED' ? o.address : undefined,
      updatedAt: iso(o.updated_at),
    })),
  }
}

async function refreshesLeft(r) {
  const s = await getSettings()
  return Math.max(0, s.max_offer_refreshes - r.offer_refreshes)
}

/** Reopen the offer window ("refresh nearby offers"). */
export const refreshOffers = (userId, id) => tx(async (client) => {
  const actor = { kind: 'CUSTOMER', scopeKind: 'SELL', userId }
  const r = await lock(client, id, actor)
  if (r.user_id !== userId) throw new SellError('NOT_FOUND', 'Sell request not found', 404)
  if (!['PENDING', 'IN_PROGRESS'].includes(r.status) || r.assigned_vendor_id) throw new SellError('INVALID_STATE', 'Offers can only be refreshed before you accept one', 409)
  const s = await getSettings(client)
  if (r.offer_refreshes >= s.max_offer_refreshes) throw new SellError('REFRESH_LIMIT', 'You have used all your offer refreshes for this request', 409)
  await client.query(`UPDATE sell_requests SET offers_close_at = NOW() + ($2 || ' minutes')::interval, offer_refreshes = offer_refreshes + 1, updated_at = NOW() WHERE id = $1`, [id, String(s.offer_window_minutes)])
  await addEvent(client, id, 'OFFERS_REFRESHED', 'Nearby offers refreshed', actor)
}).then(() => { notifySellEvent('OFFERS_REFRESHED', id, { skipCustomer: true }); return listOffersForCustomer(userId, id) })

/** The customer picks one vendor's offer. Everyone else's offer is declined; the vendor is asked to fund the purchase. */
export const acceptOffer = (userId, id, offerId) => tx(async (client) => {
  const actor = { kind: 'CUSTOMER', scopeKind: 'SELL', userId }
  const r = await lock(client, id, actor)
  if (r.user_id !== userId) throw new SellError('NOT_FOUND', 'Sell request not found', 404)
  if (!['PENDING', 'IN_PROGRESS'].includes(r.status) || r.assigned_vendor_id) throw new SellError('INVALID_STATE', 'An offer was already accepted or this request is closed', 409)
  if (!offerOpen(r)) throw new SellError('OFFERS_CLOSED', 'These offers have expired — refresh to get new ones', 409)
  const { rows } = await client.query(
    `SELECT o.*, v.name AS vendor_name, (v.is_active AND v.deleted_at IS NULL AND v.status IN ('VERIFIED','ACTIVE')) AS live
       FROM sell_request_offers o JOIN vendors v ON v.id = o.vendor_id WHERE o.id = $1 AND o.request_id = $2 FOR UPDATE OF o`, [offerId, id])
  const o = rows[0]
  if (!o) throw new SellError('OFFER_NOT_FOUND', 'Offer not found', 404)
  if (o.status !== 'OPEN') throw new SellError('OFFER_UNAVAILABLE', 'That offer is no longer available', 409)
  if (!o.live) throw new SellError('OFFER_UNAVAILABLE', 'That buyer is not available right now', 409)
  const s = await getSettings(client)
  const declined = await client.query(`SELECT vendor_id FROM sell_request_offers WHERE request_id = $1 AND vendor_id <> $2 AND status = 'OPEN'`, [id, o.vendor_id])
  await client.query(`UPDATE sell_request_offers SET status = CASE WHEN id = $2 THEN 'ACCEPTED' ELSE 'DECLINED' END, updated_at = NOW() WHERE request_id = $1 AND status IN ('OPEN','ACCEPTED')`, [id, offerId])
  await client.query(
    `UPDATE sell_requests SET assigned_vendor_id = $2, final_price = $3, status = 'IN_PROGRESS', accepted_offer_id = $4, accepted_at = NOW(),
            stage = 'OFFER_ACCEPTED', vendor_payment_status = $5, updated_at = NOW() WHERE id = $1`,
    [id, o.vendor_id, o.amount, offerId, s.require_vendor_funding ? 'PENDING' : 'NONE'])
  await addEvent(client, id, 'OFFER_ACCEPTED', `Offer accepted — ${o.vendor_name}`, actor, { vendorId: o.vendor_id, amount: num(o.amount) })
  return declined.rows.map((x) => x.vendor_id)
}).then((declinedVendorIds) => {
  notifySellEvent('OFFER_ACCEPTED', id, { skipCustomer: true })
  if (declinedVendorIds.length) notifySellEvent('OFFER_DECLINED', id, { declinedVendorIds })
  return getJourney(userId, id)
})

// ── 3 · Pickup / drop-off booking ───────────────────────────────────────

export const bookFulfilment = (userId, id, input = {}) => tx(async (client) => {
  const actor = { kind: 'CUSTOMER', scopeKind: 'SELL', userId }
  const r = await lock(client, id, actor)
  if (r.user_id !== userId) throw new SellError('NOT_FOUND', 'Sell request not found', 404)
  if (!['OFFER_ACCEPTED', 'PICKUP_REQUESTED'].includes(r.stage) || CLOSED.includes(r.status)) {
    throw new SellError('INVALID_STATE', r.stage === 'LISTED' ? 'Accept an offer first' : 'The pickup is already scheduled — contact support to change it', 409)
  }
  const s = await getSettings(client)
  const mode = input.fulfilment
  if (!['PICKUP', 'DROP_OFF'].includes(mode)) throw new SellError('VALIDATION', 'Choose pickup or drop-off', 422)
  if (mode === 'PICKUP' && !s.pickup_enabled) throw new SellError('FULFILMENT_UNAVAILABLE', 'Pickup is not available right now', 409)
  if (mode === 'DROP_OFF' && !s.dropoff_enabled) throw new SellError('FULFILMENT_UNAVAILABLE', 'Drop-off is not available right now', 409)

  let address = null, pincode = null, lat = null, lng = null, date = null, win = null
  if (input.date) {
    const d = new Date(`${String(input.date).slice(0, 10)}T00:00:00`)
    const today = new Date(); today.setHours(0, 0, 0, 0)
    if (Number.isNaN(d.getTime()) || d < today) throw new SellError('VALIDATION', 'Choose today or a later date', 422)
    if (d.getTime() - today.getTime() > 14 * 86400_000) throw new SellError('VALIDATION', 'Choose a date within the next 14 days', 422)
    date = String(input.date).slice(0, 10)
  }
  if (mode === 'PICKUP') {
    if (!date) throw new SellError('VALIDATION', 'Choose a pickup date', 422)
    if (!PICKUP_WINDOWS.includes(input.window)) throw new SellError('VALIDATION', 'Choose a pickup time window', 422)
    win = input.window
    if (input.addressId) {
      const { rows } = await client.query('SELECT * FROM addresses WHERE id = $1 AND user_id = $2', [input.addressId, userId])
      if (!rows[0]) throw new SellError('VALIDATION', 'Choose one of your saved addresses', 422)
      const a = rows[0]
      address = [a.address_line1, a.address_line2, a.landmark, a.city, a.state, a.pincode].filter(Boolean).join(', ')
      pincode = a.pincode; lat = a.lat != null ? Number(a.lat) : null; lng = a.lng != null ? Number(a.lng) : null
    } else {
      address = text(input.address, 400)
      pincode = /^\d{6}$/.test(text(input.pincode, 10)) ? text(input.pincode, 10) : null
    }
    if (address.length < 10) throw new SellError('VALIDATION', 'Enter the full pickup address', 422)
    if (!pincode) throw new SellError('VALIDATION', 'Enter a 6-digit pincode', 422)
  }
  await client.query(
    `UPDATE sell_requests SET fulfilment = $2, pickup_address = $3, pickup_pincode = $4, pickup_lat = COALESCE($5, pickup_lat), pickup_lng = COALESCE($6, pickup_lng),
            pickup_date = $7, pickup_window = $8, pickup_note = $9, stage = 'PICKUP_REQUESTED', updated_at = NOW() WHERE id = $1`,
    [id, mode, address, pincode, lat, lng, date, win, text(input.note, 300) || null])
  await addEvent(client, id, 'FULFILMENT_BOOKED', mode === 'PICKUP' ? 'Pickup requested' : 'Drop-off chosen', actor, { mode, date, window: win })
}).then(() => { notifySellEvent('FULFILMENT_BOOKED', id, { skipCustomer: true }); return getJourney(userId, id) })

// ── 4 · Vendor funding (held by the platform) ───────────────────────────

const assignedVendorOnly = (actor, r) => {
  if (actor.kind === 'VENDOR' && (!actor.vendorId || r.assigned_vendor_id !== actor.vendorId)) throw new SellError('NOT_FOUND', 'Sell request not found', 404)
}

/** The buyer says it has paid the accepted amount. Finance confirms it before the customer's phone moves. */
export const submitVendorFunding = (actor, id, input = {}) => tx(async (client) => {
  const r = await lock(client, id, actor)
  assignedVendorOnly(actor, r)
  if (r.vendor_payment_status === 'NONE' && !r.assigned_vendor_id) throw new SellError('INVALID_STATE', 'No offer has been accepted yet', 409)
  if (!['PENDING', 'SUBMITTED'].includes(r.vendor_payment_status)) throw new SellError('INVALID_STATE', 'Payment for this request is already settled', 409)
  const method = input.method
  if (!FUNDING_METHODS.includes(method)) throw new SellError('VALIDATION', 'Unknown payment method', 422)
  const key = text(input.idempotencyKey, 80)
  if (key.length < 8) throw new SellError('VALIDATION', 'idempotencyKey (8–80 characters) is required', 422)
  const amount = money(r.final_price)
  if (input.amount != null && money(input.amount) !== amount) throw new SellError('AMOUNT_MISMATCH', `Pay exactly ₹${amount}`, 422, { expected: amount })
  const reference = text(input.reference, 80)
  if (!reference) throw new SellError('VALIDATION', 'Enter the payment reference (UTR / transaction id)', 422)
  const { rows: dup } = await client.query('SELECT 1 FROM sell_payments WHERE request_id = $1 AND idempotency_key = $2', [id, key])
  if (dup[0]) return { duplicate: true }
  await client.query(`INSERT INTO sell_payments (request_id, kind, method, amount, status, reference, idempotency_key, actor_id, actor_role)
                      VALUES ($1,'VENDOR_FUNDING',$2,$3,'SUBMITTED',$4,$5,$6,$7)`, [id, method, amount, reference, key, actor.userId, actor.kind])
  await client.query(`UPDATE sell_requests SET vendor_payment_status = 'SUBMITTED', updated_at = NOW() WHERE id = $1`, [id])
  await addEvent(client, id, 'VENDOR_PAYMENT_SUBMITTED', 'Buyer submitted payment', actor, { method, amount })
  return { duplicate: false }
}).then(() => getManageJourney(actor, id))

/** Finance confirms the money has arrived (or records it directly). The purchase amount is now held. */
export const confirmVendorFunding = (actor, id, input = {}) => tx(async (client) => {
  const r = await lock(client, id, actor)
  if (!r.assigned_vendor_id) throw new SellError('INVALID_STATE', 'No offer has been accepted yet', 409)
  if (!['PENDING', 'SUBMITTED'].includes(r.vendor_payment_status)) throw new SellError('INVALID_STATE', 'Payment for this request is already settled', 409)
  const amount = money(r.final_price)
  const { rows: sub } = await client.query(`SELECT * FROM sell_payments WHERE request_id = $1 AND kind = 'VENDOR_FUNDING' AND status = 'SUBMITTED' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [id])
  if (sub[0]) {
    await client.query(`UPDATE sell_payments SET status = 'CONFIRMED', reference = COALESCE(NULLIF($2,''), reference), updated_at = NOW() WHERE id = $1`, [sub[0].id, text(input.reference, 80)])
  } else {
    const method = input.method
    if (!FUNDING_METHODS.includes(method)) throw new SellError('VALIDATION', 'Unknown payment method', 422)
    const key = text(input.idempotencyKey, 80)
    if (key.length < 8) throw new SellError('VALIDATION', 'idempotencyKey (8–80 characters) is required', 422)
    if (!text(input.reference, 80)) throw new SellError('VALIDATION', 'A payment reference is required', 422)
    await client.query(`INSERT INTO sell_payments (request_id, kind, method, amount, status, reference, idempotency_key, actor_id, actor_role)
                        VALUES ($1,'VENDOR_FUNDING',$2,$3,'CONFIRMED',$4,$5,$6,$7) ON CONFLICT (request_id, idempotency_key) DO NOTHING`,
      [id, method, amount, text(input.reference, 80), key, actor.userId, actor.kind])
  }
  await client.query(`UPDATE sell_requests SET vendor_payment_status = 'HELD', vendor_held_amount = $2, updated_at = NOW() WHERE id = $1`, [id, amount])
  await addEvent(client, id, 'VENDOR_FUNDED', 'Buyer payment received and held', actor, { amount })
}).then(() => { notifySellEvent('VENDOR_FUNDED', id); return getManageJourney(actor, id) })

const fundedOrNotRequired = async (client, r) => {
  const s = await getSettings(client)
  return !s.require_vendor_funding || r.vendor_payment_status === 'HELD'
}

// ── 5 · Pickup by courier ───────────────────────────────────────────────

/** External courier vocabulary → pickup states (same mapping as return pickups). */
export function pickupStatusFromShipping(status) {
  switch (status) {
    case 'PICKUP_SCHEDULED': case 'ASSIGNED': case 'CREATED': return 'PICKUP_SCHEDULED'
    case 'PICKED_UP': return 'PICKED_UP'
    case 'IN_TRANSIT': case 'OUT_FOR_DELIVERY': return 'IN_TRANSIT'
    case 'DELIVERED': return 'RECEIVED'
    case 'FAILED': case 'RTO': return 'FAILED'
    case 'CANCELLED': return 'CANCELLED'
    default: return null
  }
}

/** Book the courier (Shiprocket / Porter / Blue Dart) or the buyer's own team. Blocked until the buyer has paid. */
export const savePickup = (actor, id, input = {}) => tx(async (client) => {
  const r = await lock(client, id, actor)
  assignedVendorOnly(actor, r)
  if (r.fulfilment !== 'PICKUP' || !['PICKUP_REQUESTED', 'PICKUP_SCHEDULED'].includes(r.stage)) throw new SellError('INVALID_STATE', 'This request is not waiting for a pickup to be arranged', 409)
  if (!(await fundedOrNotRequired(client, r))) throw new SellError('VENDOR_NOT_FUNDED', 'The buyer must pay before the pickup is arranged', 409)
  if (!PICKUP_PROVIDERS.includes(input.provider)) throw new SellError('VALIDATION', 'Choose Shiprocket, Porter, Blue Dart or Self', 422)
  let url = null
  if (input.trackingUrl) { try { const u = new URL(input.trackingUrl); if (!['http:', 'https:'].includes(u.protocol)) throw new Error('x'); url = u.toString() } catch { throw new SellError('VALIDATION', 'Tracking link must be a web address', 422) } }
  const when = input.scheduledAt ? new Date(input.scheduledAt) : null
  if (when && Number.isNaN(when.getTime())) throw new SellError('VALIDATION', 'Pickup time is invalid', 422)
  const prev = (await client.query('SELECT id FROM sell_pickups WHERE request_id = $1', [id])).rows[0]
  const { rows: [p] } = await client.query(
    `INSERT INTO sell_pickups (request_id, provider, awb, courier_name, tracking_url, scheduled_at, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (request_id) DO UPDATE SET provider = EXCLUDED.provider, awb = EXCLUDED.awb, courier_name = EXCLUDED.courier_name,
       tracking_url = EXCLUDED.tracking_url, scheduled_at = EXCLUDED.scheduled_at, note = EXCLUDED.note, status = 'PICKUP_SCHEDULED', updated_at = NOW()
     RETURNING *`,
    [id, input.provider, text(input.awb, 60) || null, text(input.courierName, 120) || null, url, when, text(input.note, 300) || null, actor.userId])
  await client.query(`INSERT INTO sell_pickup_events (pickup_id, status, note) VALUES ($1,'PICKUP_SCHEDULED',$2)`, [p.id, prev ? 'Pickup details updated' : 'Pickup arranged'])
  await client.query(`UPDATE sell_requests SET stage = 'PICKUP_SCHEDULED', updated_at = NOW() WHERE id = $1`, [id])
  await addEvent(client, id, 'PICKUP_SCHEDULED', prev ? 'Pickup updated' : 'Pickup scheduled', actor, { provider: input.provider })
  return !prev
}).then((first) => { if (first) notifySellEvent('PICKUP_SCHEDULED', id); return getManageJourney(actor, id) })

const STAGE_OF = { PICKED_UP: 'PICKED_UP', IN_TRANSIT: 'IN_TRANSIT', RECEIVED: 'RECEIVED' }
const STAGE_ORDER = ['LISTED', 'OFFER_ACCEPTED', 'PICKUP_REQUESTED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING', 'FINAL_PRICE', 'PAYOUT_PENDING', 'PAID']
const before = (stage, other) => STAGE_ORDER.indexOf(stage) < STAGE_ORDER.indexOf(other)

export async function setPickupStatus(actor, id, status, { note = null, providerStatus = null, system = false } = {}) {
  if (!PICKUP_STATUSES.includes(status)) throw new SellError('VALIDATION', 'Unknown pickup status', 422)
  const out = await tx(async (client) => {
    const r = await lock(client, id, system ? { kind: 'ADMIN', scopeKind: 'SELL' } : actor)
    if (!system) assignedVendorOnly(actor, r)
    const { rows: [p] } = await client.query('SELECT * FROM sell_pickups WHERE request_id = $1 FOR UPDATE', [id])
    if (!p) throw new SellError('NO_PICKUP', 'Arrange the pickup first', 409)
    if (p.status === status) return { changed: false }
    if (CLOSED.includes(r.status)) throw new SellError('INVALID_STATE', 'This request is closed', 409)
    await client.query(
      `UPDATE sell_pickups SET status = $2, provider_status = COALESCE($3, provider_status),
              picked_up_at = CASE WHEN $2 IN ('PICKED_UP','IN_TRANSIT','RECEIVED') THEN COALESCE(picked_up_at, NOW()) ELSE picked_up_at END,
              received_at = CASE WHEN $2 = 'RECEIVED' THEN COALESCE(received_at, NOW()) ELSE received_at END, updated_at = NOW() WHERE id = $1`,
      [p.id, status, providerStatus])
    await client.query('INSERT INTO sell_pickup_events (pickup_id, status, provider_status, note) VALUES ($1,$2,$3,$4)', [p.id, status, providerStatus, note])
    const stage = STAGE_OF[status]
    if (stage && before(r.stage, stage)) {
      await client.query('UPDATE sell_requests SET stage = $2, updated_at = NOW() WHERE id = $1', [id, stage])
      await addEvent(client, id, stage, { PICKED_UP: 'Device picked up', IN_TRANSIT: 'Device in transit', RECEIVED: 'Device received by the buyer' }[stage], system ? null : actor, { providerStatus })
    } else if (status === 'FAILED') {
      await addEvent(client, id, 'PICKUP_FAILED', 'Pickup could not be completed', system ? null : actor, { providerStatus })
    }
    return { changed: true, stage }
  })
  if (out.changed && out.stage) notifySellEvent(out.stage, id)
  return system ? true : getManageJourney(actor, id)
}

export async function syncPickup(actor, id, shipping) {
  const { rows: [p] } = await query('SELECT * FROM sell_pickups WHERE request_id = $1', [id])
  if (!p) throw new SellError('NO_PICKUP', 'Arrange the pickup first', 409)
  await getManageJourney(actor, id)   // visibility check
  if (!p.awb || p.provider === 'SELF') throw new SellError('NO_AWB', 'Add the courier AWB number to sync tracking', 409)
  const tracked = await shipping.trackByAwb(p.provider, p.awb)
  const next = pickupStatusFromShipping(tracked?.status)
  if (!next) return getManageJourney(actor, id)
  return setPickupStatus(actor, id, next, { note: 'Synced from courier', providerStatus: tracked.providerStatus })
}

/** Courier webhook. Returns true when the AWB belonged to a sell pickup. */
export async function applyWebhook(provider, payload, shipping) {
  const awb = payload?.awb || payload?.awb_code || payload?.data?.awb
  if (!awb) return false
  const { rows: [p] } = await query('SELECT request_id FROM sell_pickups WHERE awb = $1 LIMIT 1', [awb])
  if (!p) return false
  const providerStatus = payload.current_status || payload.status
  const next = pickupStatusFromShipping(await shipping.mapProviderStatus(provider, providerStatus))
  if (next) await setPickupStatus(null, p.request_id, next, { note: payload.remark || payload.comment || null, providerStatus, system: true }).catch((err) => logger.warn({ err: err?.message }, 'sell pickup webhook update skipped'))
  return true
}

/** The buyer has the phone in hand (drop-off at the shop, or a self pickup). Needs the buyer's payment first. */
export const markReceived = (actor, id) => tx(async (client) => {
  const r = await lock(client, id, actor)
  assignedVendorOnly(actor, r)
  if (!r.fulfilment || !['PICKUP_REQUESTED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT'].includes(r.stage)) throw new SellError('INVALID_STATE', 'This request is not waiting for the phone to arrive', 409)
  if (!(await fundedOrNotRequired(client, r))) throw new SellError('VENDOR_NOT_FUNDED', 'The buyer must pay before the phone is received', 409)
  const { rows: [p] } = await client.query('SELECT * FROM sell_pickups WHERE request_id = $1 FOR UPDATE', [id])
  if (p && p.status !== 'RECEIVED') {
    await client.query(`UPDATE sell_pickups SET status = 'RECEIVED', picked_up_at = COALESCE(picked_up_at, NOW()), received_at = NOW(), updated_at = NOW() WHERE id = $1`, [p.id])
    await client.query(`INSERT INTO sell_pickup_events (pickup_id, status, note) VALUES ($1,'RECEIVED','Marked received by the buyer')`, [p.id])
  }
  await client.query(`UPDATE sell_requests SET stage = 'RECEIVED', updated_at = NOW() WHERE id = $1`, [id])
  await addEvent(client, id, 'RECEIVED', r.fulfilment === 'DROP_OFF' ? 'Device received at the store' : 'Device received by the buyer', actor)
}).then(() => { notifySellEvent('RECEIVED', id); return getManageJourney(actor, id) })

// ── 6 · Inspection → final price (driven by request QC) ─────────────────

/**
 * Re-derive the stage from the QC row after any QC action. Idempotent, so routes can call it after every QC step.
 *  - inspection started/submitted      → INSPECTING
 *  - PASSED at the accepted amount      → customer decision recorded automatically, → PAYOUT_PENDING
 *  - PASSED below the accepted amount   → FINAL_PRICE (the customer decides)
 *  - customer ACCEPTED                  → status APPROVED, PAYOUT_PENDING
 *  - FAILED                             → device goes back (RETURNING) and the buyer's money is released
 */
export async function afterQc(id) {
  const out = await tx(async (client) => {
    const { rows } = await client.query('SELECT * FROM sell_requests WHERE id = $1 FOR UPDATE', [id])
    const r = rows[0]
    if (!r || r.kind !== 'SELL' || !r.assigned_vendor_id || CLOSED.includes(r.status)) return null
    const { rows: [q] } = await client.query('SELECT * FROM sell_request_qc WHERE request_id = $1 FOR UPDATE', [id])
    if (!q) return null
    let notify = null
    if (['INSPECTION_PENDING', 'INSPECTION_COMPLETE', 'RECHECK'].includes(q.status) && ['RECEIVED', 'INSPECTING', 'FINAL_PRICE'].includes(r.stage)) {
      if (r.stage !== 'INSPECTING') {
        await client.query(`UPDATE sell_requests SET stage = 'INSPECTING', updated_at = NOW() WHERE id = $1`, [id])
        await addEvent(client, id, 'INSPECTING', 'Inspection in progress', null)
      }
    } else if (q.status === 'PASSED') {
      const accepted = money(r.final_price), valuation = money(q.final_valuation ?? accepted)
      let decision = q.customer_decision
      if (decision === 'PENDING' && valuation >= accepted) {
        await client.query(`UPDATE sell_request_qc SET customer_decision = 'ACCEPTED', customer_decided_at = NOW(), final_valuation = $2, updated_at = NOW() WHERE request_id = $1`, [id, accepted])
        await client.query(`INSERT INTO sell_request_qc_events (request_id, from_status, to_status, action, note, actor_role) VALUES ($1,'PASSED','PASSED','CUSTOMER_ACCEPTED','Price unchanged — accepted automatically','SYSTEM')`, [id])
        decision = 'ACCEPTED'
      }
      if (decision === 'ACCEPTED' && !['PAYOUT_PENDING', 'PAID'].includes(r.stage)) {
        const amount = money(Math.min(accepted, valuation))
        await client.query(`UPDATE sell_requests SET stage = 'PAYOUT_PENDING', status = 'APPROVED', final_price = $2, payout_amount = $2, decided_at = NOW(), updated_at = NOW() WHERE id = $1`, [id, amount])
        await addEvent(client, id, 'FINAL_PRICE_APPROVED', 'Final price approved', null, { amount })
        notify = 'FINAL_PRICE_APPROVED'
      } else if (decision === 'PENDING' && r.stage !== 'FINAL_PRICE') {
        await client.query(`UPDATE sell_requests SET stage = 'FINAL_PRICE', updated_at = NOW() WHERE id = $1`, [id])
        await addEvent(client, id, 'FINAL_PRICE_PROPOSED', 'Price revised after inspection', null, { amount: valuation })
        notify = 'PRICE_REVISED'
      }
    } else if (q.status === 'FAILED' && !['RETURNING', 'CLOSED'].includes(r.stage)) {
      await client.query(`UPDATE sell_requests SET stage = 'RETURNING', updated_at = NOW() WHERE id = $1`, [id])
      await addEvent(client, id, 'RETURNING', 'Inspection failed — device will be returned', null)
      await releaseHeld(client, r, 'Inspection failed')
    }
    return notify
  })
  if (out) notifySellEvent(out, id)
  // A customer who already chose a payout method gets paid as soon as the price is final.
  await releasePayout(null, id, { system: true }).catch(() => {})
  return true
}

/** Hand the buyer's held money back (one refund row, finance marks it paid). */
async function releaseHeld(client, r, why) {
  if (r.vendor_payment_status !== 'HELD' || Number(r.vendor_held_amount) <= 0) return
  await client.query(`INSERT INTO sell_payments (request_id, kind, method, amount, status, note, idempotency_key, actor_role) VALUES ($1,'VENDOR_REFUND','BANK',$2,'PROCESSING',$3,$4,'SYSTEM')
                      ON CONFLICT (request_id, idempotency_key) DO NOTHING`, [r.id, r.vendor_held_amount, text(why, 300), `refund-${r.id}-${Date.now()}`])
  await client.query(`UPDATE sell_requests SET vendor_payment_status = 'REFUNDING', updated_at = NOW() WHERE id = $1`, [r.id])
  await addEvent(client, r.id, 'VENDOR_REFUND', `Buyer's payment of ₹${r.vendor_held_amount} is being returned`, null, { why })
}

/** Called after a request is cancelled or rejected. Returns the buyer's money and routes the device home if it was collected. */
export async function onClosed(id) {
  await tx(async (client) => {
    const { rows } = await client.query('SELECT * FROM sell_requests WHERE id = $1 FOR UPDATE', [id])
    const r = rows[0]
    if (!r || !['CANCELLED', 'REJECTED'].includes(r.status)) return
    const withDevice = ['PICKED_UP', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING', 'FINAL_PRICE', 'PAYOUT_PENDING'].includes(r.stage)
    await releaseHeld(client, r, r.status === 'REJECTED' ? 'Request rejected' : 'Request cancelled')
    await client.query(`UPDATE sell_requests SET stage = $2, payout_status = CASE WHEN payout_status IN ('PENDING','PROCESSING') THEN 'NONE' ELSE payout_status END, updated_at = NOW() WHERE id = $1`, [id, withDevice ? 'RETURNING' : 'CLOSED'])
    if (withDevice) await addEvent(client, id, 'RETURNING', 'The device will be returned to you', null)
  })
}

/** The buyer confirms the phone is back with the customer (closes a RETURNING request). */
export const markReturned = (actor, id) => tx(async (client) => {
  const r = await lock(client, id, actor)
  assignedVendorOnly(actor, r)
  if (r.stage !== 'RETURNING') throw new SellError('INVALID_STATE', 'This request is not waiting for a return', 409)
  await client.query(`UPDATE sell_requests SET stage = 'CLOSED', updated_at = NOW() WHERE id = $1`, [id])
  await addEvent(client, id, 'RETURNED', 'Device returned to the customer', actor)
}).then(() => getManageJourney(actor, id))

// ── 7 · Payout to the customer ──────────────────────────────────────────

export async function payoutOptions(userId, amount) {
  const s = await getSettings()
  let wallet = false, room = null
  if (s.payout_wallet_enabled && amount > 0) {
    const { rows: [w] } = await query('SELECT balance FROM wallets WHERE user_id = $1', [userId])
    const { WalletSettingsService } = await import('../wallet-settings/wallet-settings.service.js')
    const cap = (await new WalletSettingsService().getConfig()).maxWalletBalance
    room = Math.max(0, cap - Number(w?.balance || 0))
    wallet = amount <= room
  }
  return [
    { method: 'UPI', enabled: s.payout_upi_enabled, label: 'UPI', hint: 'Sent to your UPI ID after approval' },
    { method: 'BANK', enabled: s.payout_bank_enabled, label: 'Bank transfer', hint: 'IMPS / NEFT to your bank account' },
    { method: 'WALLET', enabled: wallet, label: 'Dealker wallet', hint: wallet ? 'Instant' : `Wallet can only hold ₹${room ?? 0} more`, instant: true },
  ]
}

const maskUpi = (u) => { const [n, h] = u.split('@'); return `${n.slice(0, 2)}${'•'.repeat(Math.max(2, n.length - 2))}@${h}` }

/** The customer says where the money should go. Triggers the payout straight away when the price is final. */
export async function choosePayout(userId, id, input = {}) {
  const method = input.method
  if (!['UPI', 'BANK', 'WALLET'].includes(method)) throw new SellError('VALIDATION', 'Choose UPI, bank transfer or wallet', 422)
  let details = null, display = null
  if (method === 'UPI') {
    const upi = text(input.upiId, 80)
    if (!UPI_RE.test(upi)) throw new SellError('VALIDATION', 'Enter a valid UPI ID, like name@bank', 422)
    details = { upiId: upi }; display = `UPI · ${maskUpi(upi)}`
  } else if (method === 'BANK') {
    const b = input.bank || {}
    const holder = text(b.holderName, 80), acc = String(b.accountNumber ?? '').replace(/\s+/g, ''), ifsc = text(b.ifsc, 11).toUpperCase()
    if (holder.length < 2) throw new SellError('VALIDATION', 'Enter the account holder name', 422)
    if (!/^\d{9,18}$/.test(acc)) throw new SellError('VALIDATION', 'Account number must be 9–18 digits', 422)
    if (!IFSC_RE.test(ifsc)) throw new SellError('VALIDATION', 'Enter a valid IFSC code', 422)
    if (input.confirmAccountNumber != null && String(input.confirmAccountNumber).replace(/\s+/g, '') !== acc) throw new SellError('VALIDATION', 'Account numbers do not match', 422)
    details = { holderName: holder, accountNumber: acc, ifsc }; display = `Bank ••${acc.slice(-4)} · ${ifsc}`
  } else display = 'Dealker wallet'

  await tx(async (client) => {
    const actor = { kind: 'CUSTOMER', scopeKind: 'SELL', userId }
    const r = await lock(client, id, actor)
    if (r.user_id !== userId) throw new SellError('NOT_FOUND', 'Sell request not found', 404)
    if (r.stage !== 'PAYOUT_PENDING' || r.payout_status === 'PAID') throw new SellError('INVALID_STATE', 'Your payout can be set once the final price is approved', 409)
    if (r.payout_status === 'PROCESSING') throw new SellError('INVALID_STATE', 'Your payout is already being processed', 409)
    const opts = await payoutOptions(userId, Number(r.payout_amount))
    const opt = opts.find((o) => o.method === method)
    if (!opt?.enabled) throw new SellError('PAYOUT_UNAVAILABLE', `${opt?.label || method} is not available for this payout`, 409)
    await client.query(`UPDATE sell_requests SET payout_method = $2, payout_details = $3, payout_display = $4, payout_status = 'PENDING', updated_at = NOW() WHERE id = $1`,
      [id, method, details ? encryptSecret(JSON.stringify(details)) : null, display])
    await addEvent(client, id, 'PAYOUT_METHOD', `Payout method chosen: ${display}`, actor)
  })
  await releasePayout(null, id, { system: true })
  return getJourney(userId, id)
}

/** Pay the customer. Wallet is instant; UPI / bank enter the finance queue (RazorpayX plugs in here later). */
export async function releasePayout(actor, id, { system = false } = {}) {
  let walletCredit = null
  const state = await tx(async (client) => {
    const { rows } = await client.query('SELECT * FROM sell_requests WHERE id = $1 FOR UPDATE', [id])
    const r = rows[0]
    if (!r || r.kind !== 'SELL') throw new SellError('NOT_FOUND', 'Sell request not found', 404)
    if (r.stage !== 'PAYOUT_PENDING' || r.payout_status !== 'PENDING' || !r.payout_method) return null
    if (!(await fundedOrNotRequired(client, r))) throw new SellError('VENDOR_NOT_FUNDED', 'The buyer’s payment has not been confirmed', 409)
    const amount = money(r.payout_amount)
    if (amount <= 0 || (r.vendor_payment_status === 'HELD' && amount > money(r.vendor_held_amount))) throw new SellError('AMOUNT_MISMATCH', 'The payout is more than the amount held', 409)
    if (r.payout_method === 'WALLET') walletCredit = { userId: r.user_id, amount, code: r.code, requestId: r.id }
    else {
      await client.query(`INSERT INTO sell_payments (request_id, kind, method, amount, status, idempotency_key, actor_id, actor_role) VALUES ($1,'CUSTOMER_PAYOUT',$2,$3,'PROCESSING',$4,$5,$6)
                          ON CONFLICT (request_id, idempotency_key) DO NOTHING`, [id, r.payout_method, amount, `payout-${id}`, actor?.userId || null, actor?.kind || 'SYSTEM'])
      await client.query(`UPDATE sell_requests SET payout_status = 'PROCESSING', updated_at = NOW() WHERE id = $1`, [id])
      await addEvent(client, id, 'PAYOUT_PROCESSING', 'Payment is being processed', actor, { method: r.payout_method, amount })
    }
    return { method: r.payout_method }
  })
  if (!state) return false
  if (walletCredit) {
    const { WalletService } = await import('../wallet/wallet.service.js')
    const { WalletRepository } = await import('../wallet/wallet.repository.js')
    const res = await new WalletService(new WalletRepository()).addMoney(walletCredit.userId, {
      amount: walletCredit.amount, description: `Sale of your phone (${walletCredit.code})`, referenceId: `sell-${walletCredit.requestId}`, subType: 'SELL_PAYOUT', sourceId: walletCredit.requestId })
    if (!res?.success) {
      // Leave the request payable: the customer can pick UPI / bank instead.
      await tx(async (client) => {
        await client.query(`UPDATE sell_requests SET payout_status = 'NONE', payout_method = NULL, payout_display = NULL, updated_at = NOW() WHERE id = $1`, [id])
        await addEvent(client, id, 'PAYOUT_FAILED', 'Wallet credit failed — choose another payout method', actor)
      })
      throw new SellError('WALLET_CREDIT_FAILED', 'The wallet could not be credited. Choose UPI or bank transfer.', 409)
    }
    await finishPayout(id, { method: 'WALLET', reference: `wallet-${walletCredit.requestId}`, actor })
    return true
  }
  notifySellEvent('PAYOUT_PROCESSING', id)
  return true
}

/** Finance marks a UPI / bank payout as sent (with the bank's reference). */
export async function markPayoutPaid(actor, id, { reference } = {}) {
  const ref = text(reference, 80)
  if (ref.length < 6) throw new SellError('VALIDATION', 'Enter the UTR / transaction reference', 422)
  const { rows: [r] } = await query('SELECT payout_status, kind FROM sell_requests WHERE id = $1', [id])
  if (!r || r.kind !== 'SELL') throw new SellError('NOT_FOUND', 'Sell request not found', 404)
  if (r.payout_status !== 'PROCESSING') throw new SellError('INVALID_STATE', 'There is no payout waiting to be marked as paid', 409)
  await finishPayout(id, { reference: ref, actor })
  return getManageJourney(actor, id)
}

export const failPayout = (actor, id, reason) => tx(async (client) => {
  const n = text(reason, 300)
  if (!n) throw new SellError('VALIDATION', 'A reason is required', 422)
  const r = await lock(client, id, actor)
  if (r.payout_status !== 'PROCESSING') throw new SellError('INVALID_STATE', 'There is no payout in progress', 409)
  await client.query(`UPDATE sell_payments SET status = 'FAILED', note = $2, updated_at = NOW() WHERE request_id = $1 AND kind = 'CUSTOMER_PAYOUT' AND status = 'PROCESSING'`, [id, n])
  await client.query(`UPDATE sell_requests SET payout_status = 'PENDING', payout_method = NULL, payout_details = NULL, payout_display = NULL, updated_at = NOW() WHERE id = $1`, [id])
  await addEvent(client, id, 'PAYOUT_FAILED', 'Payout failed — please check your payment details', actor, { reason: n })
}).then(() => { notifySellEvent('PAYOUT_FAILED', id); return getManageJourney(actor, id) })

async function finishPayout(id, { method = null, reference, actor }) {
  await tx(async (client) => {
    const { rows } = await client.query('SELECT * FROM sell_requests WHERE id = $1 FOR UPDATE', [id])
    const r = rows[0]
    if (r.payout_status === 'PAID') return
    const amount = money(r.payout_amount)
    const m = method || r.payout_method
    const { rowCount } = await client.query(
      `UPDATE sell_payments SET status = 'PAID', reference = $2, actor_id = COALESCE($3, actor_id), updated_at = NOW() WHERE request_id = $1 AND kind = 'CUSTOMER_PAYOUT' AND status = 'PROCESSING'`,
      [id, reference, actor?.userId || null])
    if (!rowCount) {
      await client.query(`INSERT INTO sell_payments (request_id, kind, method, amount, status, reference, idempotency_key, actor_id, actor_role) VALUES ($1,'CUSTOMER_PAYOUT',$2,$3,'PAID',$4,$5,$6,$7)
                          ON CONFLICT (request_id, idempotency_key) DO NOTHING`, [id, m, amount, reference, `payout-${id}`, actor?.userId || null, actor?.kind || 'SYSTEM'])
    }
    // Whatever the buyer paid beyond the final price goes back to the buyer.
    const held = money(r.vendor_held_amount), extra = money(held - amount)
    let vstatus = r.vendor_payment_status
    if (r.vendor_payment_status === 'HELD') {
      if (extra > 0) {
        await client.query(`INSERT INTO sell_payments (request_id, kind, method, amount, status, note, idempotency_key, actor_role) VALUES ($1,'VENDOR_REFUND','BANK',$2,'PROCESSING','Price dropped after inspection',$3,'SYSTEM')
                            ON CONFLICT (request_id, idempotency_key) DO NOTHING`, [id, extra, `refund-diff-${id}`])
        vstatus = 'REFUNDING'
      } else vstatus = 'NONE'
    }
    await client.query(
      `UPDATE sell_requests SET payout_status = 'PAID', payout_reference = $2, payout_at = NOW(), stage = 'PAID', status = 'COMPLETED', vendor_payment_status = $3, vendor_held_amount = 0, updated_at = NOW() WHERE id = $1`,
      [id, reference, vstatus])
    await addEvent(client, id, 'PAYOUT_PAID', 'Payment sent', actor, { amount, method: m })
    await addEvent(client, id, 'COMPLETED', 'Completed', actor)
  })
  notifySellEvent('PAYOUT_PAID', id)
}

/** Finance marks the buyer's refund as returned. */
export const markVendorRefunded = (actor, id, { reference } = {}) => tx(async (client) => {
  const ref = text(reference, 80)
  if (ref.length < 6) throw new SellError('VALIDATION', 'Enter the refund reference', 422)
  const r = await lock(client, id, actor)
  if (r.vendor_payment_status !== 'REFUNDING') throw new SellError('INVALID_STATE', 'There is no refund waiting', 409)
  await client.query(`UPDATE sell_payments SET status = 'PAID', reference = $2, actor_id = $3, updated_at = NOW() WHERE request_id = $1 AND kind = 'VENDOR_REFUND' AND status = 'PROCESSING'`, [id, ref, actor.userId])
  await client.query(`UPDATE sell_requests SET vendor_payment_status = 'REFUNDED', updated_at = NOW() WHERE id = $1`, [id])
  await addEvent(client, id, 'VENDOR_REFUNDED', 'Buyer refunded', actor, { reference: ref })
}).then(() => getManageJourney(actor, id))

// ── Views ───────────────────────────────────────────────────────────────

const CUSTOMER_STEPS = {
  PICKUP: [
    ['Offer Accepted', 'OFFER_ACCEPTED'], ['Pickup Scheduled', 'PICKUP_SCHEDULED'], ['Device Picked Up', 'PICKED_UP'], ['In Transit', 'IN_TRANSIT'],
    ['Received by Buyer', 'RECEIVED'], ['Inspection', 'INSPECTING'], ['Final Price Approved', 'FINAL_PRICE_APPROVED'], ['Payment Sent', 'PAYOUT_PAID'],
  ],
  DROP_OFF: [
    ['Offer Accepted', 'OFFER_ACCEPTED'], ['Drop-off Chosen', 'FULFILMENT_BOOKED'], ['Received at Store', 'RECEIVED'], ['Inspection', 'INSPECTING'],
    ['Final Price Approved', 'FINAL_PRICE_APPROVED'], ['Payment Sent', 'PAYOUT_PAID'],
  ],
}
const BEFORE_CHOICE = [['Request Listed', 'SUBMITTED'], ['Offers Received', 'QUOTE_RECEIVED'], ['Offer Accepted', 'OFFER_ACCEPTED']]

/** The one thing the customer (or app) should do next. */
function nextAction(r, qc, pickup) {
  if (['CANCELLED', 'REJECTED'].includes(r.status)) return r.stage === 'RETURNING' ? 'DEVICE_RETURNING' : 'CLOSED'
  if (r.stage === 'LISTED') return offerOpen(r) ? 'WAIT_FOR_OFFERS' : 'REFRESH_OFFERS'
  if (r.stage === 'OFFER_ACCEPTED') return 'CHOOSE_FULFILMENT'
  if (['PICKUP_REQUESTED', 'PICKUP_SCHEDULED'].includes(r.stage)) {
    if (r.vendor_payment_status === 'PENDING' || r.vendor_payment_status === 'SUBMITTED') return 'WAIT_FOR_BUYER_PAYMENT'
    return r.stage === 'PICKUP_REQUESTED' ? (r.fulfilment === 'DROP_OFF' ? 'DROP_OFF_DEVICE' : 'WAIT_FOR_PICKUP_SLOT') : 'WAIT_FOR_PICKUP'
  }
  if (['PICKED_UP', 'IN_TRANSIT'].includes(r.stage)) return 'WAIT_FOR_DELIVERY_TO_BUYER'
  if (['RECEIVED', 'INSPECTING'].includes(r.stage)) return 'WAIT_FOR_INSPECTION'
  if (r.stage === 'FINAL_PRICE') return 'DECIDE_FINAL_PRICE'
  if (r.stage === 'PAYOUT_PENDING') return r.payout_status === 'NONE' || (r.payout_status === 'PENDING' && !r.payout_method) ? 'CHOOSE_PAYOUT' : r.payout_status === 'PROCESSING' ? 'PAYOUT_PROCESSING' : 'PAYOUT_PENDING'
  if (r.stage === 'PAID') return 'DONE'
  if (r.stage === 'RETURNING') return 'DEVICE_RETURNING'
  return 'CLOSED'
}

async function build(r, { forCustomer }) {
  const [{ rows: ev }, { rows: pk }, { rows: pay }, { rows: qcr }, { rows: ve }] = await Promise.all([
    query('SELECT kind, label, created_at, meta FROM sell_request_events WHERE request_id = $1 ORDER BY id', [r.id]),
    query('SELECT * FROM sell_pickups WHERE request_id = $1', [r.id]),
    query('SELECT * FROM sell_payments WHERE request_id = $1 ORDER BY created_at', [r.id]),
    query('SELECT * FROM sell_request_qc WHERE request_id = $1', [r.id]),
    r.assigned_vendor_id ? query(
      `SELECT v.name, v.phone, s.name AS shop, concat_ws(', ', s.address_line1, s.city, s.pincode) AS address
         FROM vendors v LEFT JOIN LATERAL (SELECT * FROM shops WHERE vendor_id = v.id AND deleted_at IS NULL AND is_active ORDER BY created_at LIMIT 1) s ON TRUE WHERE v.id = $1`, [r.assigned_vendor_id]) : { rows: [] },
  ])
  const first = new Map()
  for (const e of ev) if (!first.has(e.kind)) first.set(e.kind, e)
  const defs = r.fulfilment ? CUSTOMER_STEPS[r.fulfilment] : BEFORE_CHOICE
  const ended = ['CANCELLED', 'REJECTED'].includes(r.status)
  const steps = defs.map(([label, kind]) => ({ key: kind, label, done: first.has(kind), at: iso(first.get(kind)?.created_at) }))
  const cur = steps.findIndex((s) => !s.done)
  steps.forEach((s, i) => { s.current = !ended && i === cur })
  const p = pk[0]
  const qc = qcr[0]
  const out = {
    stage: r.stage, status: r.status, nextAction: nextAction(r, qc, p), steps, ended,
    estimate: { min: num(r.estimate_min), max: num(r.estimate_max), quote: num(r.quote) },
    offersCloseAt: iso(r.offers_close_at), imeiVerifiedAt: iso(r.imei_verified_at),
    acceptedAt: iso(r.accepted_at), agreedPrice: r.accepted_offer_id ? num(r.final_price) : null,
    buyer: ve[0] ? { name: ve[0].shop || ve[0].name, phone: forCustomer && !['PICKUP_REQUESTED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING', 'FINAL_PRICE', 'PAYOUT_PENDING', 'PAID'].includes(r.stage) ? undefined : ve[0].phone, address: r.fulfilment === 'DROP_OFF' || !forCustomer ? ve[0].address : undefined } : null,
    fulfilment: r.fulfilment ? { mode: r.fulfilment, address: r.pickup_address, pincode: r.pickup_pincode, date: ymd(r.pickup_date), window: r.pickup_window, note: r.pickup_note } : null,
    pickup: p ? {
      provider: p.provider, awb: p.awb, courier: p.courier_name, trackingUrl: p.tracking_url, status: p.status, providerStatus: p.provider_status,
      scheduledAt: iso(p.scheduled_at), pickedUpAt: iso(p.picked_up_at), receivedAt: iso(p.received_at),
    } : null,
    inspection: qc ? { status: qc.status, finalValuation: num(qc.final_valuation), customerDecision: qc.customer_decision, originalPrice: num(r.accepted_offer_id ? r.final_price : null) } : null,
    payout: r.payout_status === 'NONE' && r.stage !== 'PAYOUT_PENDING' ? null : {
      method: r.payout_method, display: r.payout_display, status: r.payout_status, amount: num(r.payout_amount), reference: forCustomer ? undefined : r.payout_reference,
      paidAt: iso(r.payout_at), receiptRef: r.payout_status === 'PAID' ? r.payout_reference : undefined,
    },
    vendorPayment: { status: r.vendor_payment_status, heldAmount: num(r.vendor_held_amount), amountDue: r.accepted_offer_id ? num(r.final_price) : null },
  }
  if (!forCustomer) {
    out.payments = pay.map((x) => ({ id: x.id, kind: x.kind, method: x.method, amount: num(x.amount), status: x.status, reference: x.reference, note: x.note, at: iso(x.created_at) }))
    out.pickupEvents = p ? (await query('SELECT status, provider_status, note, occurred_at FROM sell_pickup_events WHERE pickup_id = $1 ORDER BY occurred_at', [p.id])).rows.map((e) => ({ status: e.status, providerStatus: e.provider_status, note: e.note, at: iso(e.occurred_at) })) : []
  } else {
    out.payoutOptions = r.stage === 'PAYOUT_PENDING' ? await payoutOptions(r.user_id, Number(r.payout_amount)) : undefined
  }
  return out
}

/** Customer's view of one of their requests' journey. */
export async function getJourney(userId, id) {
  const { rows } = await query('SELECT * FROM sell_requests WHERE id = $1 AND user_id = $2 AND kind = $3', [id, userId, 'SELL'])
  if (!rows[0]) throw new SellError('NOT_FOUND', 'Sell request not found', 404)
  return build(rows[0], { forCustomer: true })
}

/** Dashboard / vendor view. A vendor only sees requests it was assigned (or open ones, without journey money). */
export async function getManageJourney(actor, id) {
  const { rows } = await query('SELECT * FROM sell_requests WHERE id = $1 AND kind = $2', [id, 'SELL'])
  const r = rows[0]
  if (!r || (actor.kind === 'VENDOR' && r.assigned_vendor_id !== actor.vendorId && !(r.assigned_vendor_id == null && ['PENDING', 'IN_PROGRESS'].includes(r.status)))) {
    throw new SellError('NOT_FOUND', 'Sell request not found', 404)
  }
  const view = await build(r, { forCustomer: false })
  if (actor.kind === 'VENDOR' && r.assigned_vendor_id !== actor.vendorId) { view.payments = undefined; view.payout = null; view.vendorPayment = undefined; view.buyer = null }
  return view
}

/** Finance queues for the dashboard. */
export async function financeQueue() {
  const { rows } = await query(
    `SELECT r.id, r.code, r.model_name, r.variant, r.customer_name, r.final_price, r.payout_amount, r.payout_method, r.payout_display, r.payout_status, r.vendor_payment_status,
            r.vendor_held_amount, r.updated_at, v.name AS vendor_name
       FROM sell_requests r LEFT JOIN vendors v ON v.id = r.assigned_vendor_id
      WHERE r.kind = 'SELL' AND (r.vendor_payment_status IN ('SUBMITTED', 'REFUNDING') OR r.payout_status = 'PROCESSING')
      ORDER BY r.updated_at`)
  const row = (r) => ({ id: r.id, code: r.code, device: `${r.model_name} ${r.variant}`, customer: r.customer_name, vendor: r.vendor_name, amount: num(r.final_price), payoutAmount: num(r.payout_amount),
    payoutMethod: r.payout_method, payoutDisplay: r.payout_display, vendorPaymentStatus: r.vendor_payment_status, heldAmount: num(r.vendor_held_amount), updatedAt: iso(r.updated_at) })
  return {
    fundingToConfirm: rows.filter((r) => r.vendor_payment_status === 'SUBMITTED').map(row),
    payoutsToSend: rows.filter((r) => r.payout_status === 'PROCESSING').map(row),
    refundsToSend: rows.filter((r) => r.vendor_payment_status === 'REFUNDING').map(row),
  }
}

/** Finance only: the customer's payout destination in clear (UPI id / bank account) so the transfer can be made. */
export async function revealPayoutDetails(actor, id) {
  const { rows } = await query('SELECT payout_details, payout_method, payout_status FROM sell_requests WHERE id = $1 AND kind = $2', [id, 'SELL'])
  if (!rows[0]?.payout_details || rows[0].payout_status !== 'PROCESSING') throw new SellError('NOT_FOUND', 'No payout destination to show', 404)
  logger.info({ requestId: id, by: actor.userId }, 'sell payout destination viewed')
  return { method: rows[0].payout_method, ...JSON.parse(decryptSecret(rows[0].payout_details)) }
}

/** Distance (km) from a point to the vendor's nearest live shop. */
export async function vendorDistanceKm(vendorId, lat, lng) {
  if (lat == null || lng == null) return null
  const { rows } = await query('SELECT lat, lng FROM shops WHERE vendor_id = $1 AND deleted_at IS NULL AND is_active', [vendorId])
  const d = rows.map((s) => haversineKm(lat, lng, s.lat, s.lng)).filter((x) => x != null)
  return d.length ? Math.round(Math.min(...d) * 10) / 10 : null
}
