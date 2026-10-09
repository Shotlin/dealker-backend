/**
 * Auction management — used by platform admins (any product: their own or any
 * vendor's) and by vendors (their own products only, subject to approval).
 *
 * `actor` = { kind: 'ADMIN' | 'VENDOR', userId, vendorId }
 * Vendor actors are hard-scoped: every read/write is filtered by vendor_id and
 * a foreign auction answers 404 (never 403 — do not confirm it exists).
 *
 * @module modules/auctions/auction-admin.service
 */

import crypto from 'node:crypto'
import { query } from '../../config/database.js'
import { fromPaise, toPaise, validateFee } from './auction-engine.js'
import {
  AuctionError, broadcastState, getSettings, invalidateSettingsCache, logEvent, serializeAdmin,
} from './auction.shared.js'
import {
  cancelAuction, endAuctionNow, lockAuction, reserveStock, startAuctionNow, startDueAuctions, withTx,
} from './auction-settlement.service.js'

const LIVE_LIKE = ['PENDING_APPROVAL', 'SCHEDULED', 'LIVE', 'PAUSED', 'AWAITING_PAYMENT']
const isAdmin = (actor) => actor.kind === 'ADMIN'

/** Re-read after a post-commit auto-start so callers never see a stale status. */
async function fresh(id) {
  const { rows } = await query(
    `SELECT a.*, v.name AS seller_name FROM auctions a LEFT JOIN vendors v ON v.id = a.vendor_id WHERE a.id = $1`, [id]
  )
  return serializeAdmin(rows[0])
}

const unauthorized = () => new AuctionError('NOT_FOUND', 'Auction not found', 404)

function assertScope(actor, a) {
  if (!a) throw unauthorized()
  if (!isAdmin(actor) && a.vendor_id !== actor.vendorId) throw unauthorized()
}

const ensureAdmin = (actor, what) => {
  if (!isAdmin(actor)) throw new AuctionError('FORBIDDEN', `Only the platform can ${what}`, 403)
}

// ── product search (for the create form) ────────────────────────────────

export async function searchProducts(actor, { q = '', limit = 20 } = {}) {
  const params = []
  const where = [`p.is_active = TRUE`, `sp.deleted_at IS NULL`, `sp.stock_quantity >= 1`,
    `NOT EXISTS (SELECT 1 FROM auctions x WHERE x.product_id = p.id AND x.status = ANY($1))`]
  params.push(LIVE_LIKE)
  if (!isAdmin(actor)) { params.push(actor.vendorId); where.push(`p.owner_vendor_id = $${params.length}`) }
  if (q) { params.push(`%${q}%`); where.push(`p.name ILIKE $${params.length}`) }
  params.push(Math.min(50, limit))
  const { rows } = await query(
    `SELECT DISTINCT ON (p.id) p.id, p.name, p.brand, p.price, p.sale_price, p.thumbnail_url, p.images, p.owner_type,
            p.owner_vendor_id, v.name AS vendor_name, sp.id AS shop_product_id, sp.shop_id, sp.stock_quantity
       FROM products p
       JOIN shop_products sp ON sp.product_id = p.id
       LEFT JOIN vendors v ON v.id = p.owner_vendor_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.id, sp.stock_quantity DESC
      LIMIT $${params.length}`,
    params
  )
  return rows
}

// ── validation ──────────────────────────────────────────────────────────

function parseMoney(v, field, { required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new AuctionError('VALIDATION', `${field} is required`, 422)
    return null
  }
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new AuctionError('VALIDATION', `${field} must be a valid amount`, 422)
  return toPaise(n)
}

/** Normalise + validate create/update input against platform rules. Returns paise & dates. */
function normalise(input, settings, base = null) {
  const errors = []
  const startPrice = parseMoney(input.startPrice ?? (base && Number(base.start_price)), 'Start price', { required: true })
  const reservePrice = input.reservePrice === undefined && base ? (base.reserve_price == null ? null : toPaise(base.reserve_price)) : parseMoney(input.reservePrice, 'Reserve price')
  const bidIncrement = input.bidIncrement === undefined && base ? (base.bid_increment == null ? null : toPaise(base.bid_increment)) : parseMoney(input.bidIncrement, 'Bid increment')
  const buyNow = input.buyNowPrice === undefined && base ? (base.buy_now_price == null ? null : toPaise(base.buy_now_price)) : parseMoney(input.buyNowPrice, 'Buy-now price')
  const fee = parseMoney(input.registrationFee ?? (base && Number(base.registration_fee)), 'Registration fee', { required: true })

  if (startPrice <= 0) errors.push('Start price must be greater than zero')
  if (reservePrice != null && reservePrice < startPrice) errors.push('Reserve price cannot be below the start price')
  if (bidIncrement != null && bidIncrement <= 0) errors.push('Bid increment must be greater than zero')
  if (buyNow != null && buyNow <= Math.max(startPrice, reservePrice ?? 0)) errors.push('Buy-now price must be above the start and reserve prices')
  errors.push(...validateFee({ fee, startPrice }, settings))

  const startsAt = new Date(input.startsAt ?? base?.starts_at ?? Date.now())
  const endsAt = input.endsAt
    ? new Date(input.endsAt)
    : input.durationHours ? new Date(startsAt.getTime() + Number(input.durationHours) * 3600_000)
      : base ? new Date(base.ends_at) : null
  if (!endsAt || Number.isNaN(endsAt.getTime())) errors.push('End time is required')
  if (Number.isNaN(startsAt.getTime())) errors.push('Start time is invalid')
  if (endsAt && !Number.isNaN(startsAt.getTime())) {
    const mins = (endsAt - startsAt) / 60000
    if (mins < settings.min_duration_minutes) errors.push(`An auction must run at least ${settings.min_duration_minutes} minutes`)
    if (mins > settings.max_duration_days * 1440) errors.push(`An auction cannot run longer than ${settings.max_duration_days} days`)
  }
  if (errors.length) throw new AuctionError('VALIDATION', errors[0], 422, { errors })
  return { startPrice, reservePrice, bidIncrement, buyNow, fee, startsAt, endsAt }
}

const genNumber = () => `AU-${new Date().toISOString().slice(2, 10).replaceAll('-', '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`

// ── create / update ─────────────────────────────────────────────────────

export async function createAuction(actor, input) {
  const settings = await getSettings()
  if (!settings.enabled && !isAdmin(actor)) throw new AuctionError('AUCTIONS_DISABLED', 'Auctions are currently disabled', 403)
  if (!input.productId) throw new AuctionError('VALIDATION', 'Choose a product', 422)

  const { rows: prod } = await query(
    `SELECT p.id, p.name, p.description, p.thumbnail_url, p.images, p.owner_type, p.owner_vendor_id
       FROM products p WHERE p.id = $1 AND p.is_active = TRUE`, [input.productId]
  )
  const p = prod[0]
  if (!p) throw new AuctionError('NOT_FOUND', 'Product not found', 404)
  if (!isAdmin(actor) && p.owner_vendor_id !== actor.vendorId) throw new AuctionError('NOT_FOUND', 'Product not found', 404)

  const { rows: dup } = await query(`SELECT 1 FROM auctions WHERE product_id = $1 AND status = ANY($2) LIMIT 1`, [p.id, LIVE_LIKE])
  if (dup[0]) throw new AuctionError('PRODUCT_ALREADY_IN_AUCTION', 'This product already has an active auction', 409)

  const { rows: sp } = await query(
    `SELECT id, shop_id, stock_quantity FROM shop_products
      WHERE product_id = $1 AND deleted_at IS NULL ORDER BY stock_quantity DESC LIMIT 1`, [p.id]
  )
  if (!sp[0]) throw new AuctionError('PRODUCT_NOT_LISTED', 'This product is not listed in any shop', 409)
  const audience = input.audience === 'B2B' ? 'B2B' : 'B2C'
  const quantity = audience === 'B2B' ? Number(input.quantity ?? 1) : 1
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) throw new AuctionError('VALIDATION', 'Quantity must be a whole number of 1 or more', 422)
  if (audience === 'B2C' && input.quantity != null && Number(input.quantity) !== 1) throw new AuctionError('VALIDATION', 'Customer auctions sell one unit — use a business (B2B) auction for lots', 422)
  if (Number(sp[0].stock_quantity) < quantity) {
    throw new AuctionError('OUT_OF_STOCK', quantity > 1 ? `Only ${sp[0].stock_quantity} in stock — a lot of ${quantity} needs more` : 'This product is out of stock', 409)
  }
  let eligibleVendors = null
  if (audience === 'B2B' && Array.isArray(input.eligibleVendorIds) && input.eligibleVendorIds.length) {
    if (!isAdmin(actor)) throw new AuctionError('FORBIDDEN', 'Only admins can invite specific vendors', 403)
    const ids = [...new Set(input.eligibleVendorIds.map(String))]
    const { rows: found } = await query(`SELECT id FROM vendors WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [ids])
    if (found.length !== ids.length) throw new AuctionError('VALIDATION', 'One of the invited vendors does not exist', 422)
    eligibleVendors = ids
  }

  const n = normalise(input, settings)
  if (!input.saveAsDraft && n.endsAt <= new Date()) throw new AuctionError('VALIDATION', 'End time must be in the future', 422)
  if (!isAdmin(actor) && !input.saveAsDraft) {
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM auctions WHERE vendor_id = $1 AND status = ANY($2)`, [actor.vendorId, LIVE_LIKE])
    if (rows[0].n >= settings.max_live_auctions_per_vendor) {
      throw new AuctionError('LIMIT_REACHED', `You can run at most ${settings.max_live_auctions_per_vendor} auctions at a time`, 409)
    }
  }

  const status = input.saveAsDraft
    ? 'DRAFT'
    : (!isAdmin(actor) && settings.vendor_auctions_require_approval) ? 'PENDING_APPROVAL' : 'SCHEDULED'

  const admin = isAdmin(actor)
  const refundPct = admin && input.loserFeeRefundPct != null ? Number(input.loserFeeRefundPct) : Number(settings.loser_fee_refund_pct)
  const sharePct = admin && input.feeVendorSharePct != null ? Number(input.feeVendorSharePct) : Number(settings.vendor_fee_share_pct)
  for (const [label, v] of [['Loser refund %', refundPct], ['Vendor share %', sharePct]]) {
    if (!(v >= 0 && v <= 100)) throw new AuctionError('VALIDATION', `${label} must be between 0 and 100`, 422)
  }

  return withTx(async (client, post) => {
    let row
    try {
      const { rows } = await client.query(
        `INSERT INTO auctions (
           auction_number, product_id, shop_product_id, shop_id, vendor_id, owner_type, created_by, created_by_role,
           title, description, image_url, images, status, start_price, reserve_price, bid_increment, increment_tiers, buy_now_price,
           registration_fee, fee_vendor_share_pct, loser_fee_refund_pct, anti_snipe_window_sec, anti_snipe_extend_sec,
           max_extensions, payment_window_hours, max_offer_rounds, starts_at, ends_at, original_ends_at, current_price, relisted_from,
           audience, quantity, eligible_vendor_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$28,$14,$29,$30,$31,$32)
         RETURNING *`,
        [
          genNumber(), p.id, sp[0].id, sp[0].shop_id, p.owner_vendor_id || null, p.owner_type, actor.userId, actor.kind,
          (input.title || p.name).slice(0, 200), input.description ?? p.description, input.imageUrl || p.thumbnail_url,
          JSON.stringify(input.images || p.images || []), status,
          fromPaise(n.startPrice), n.reservePrice == null ? null : fromPaise(n.reservePrice),
          n.bidIncrement == null ? null : fromPaise(n.bidIncrement), JSON.stringify(settings.increment_tiers),
          n.buyNow == null ? null : fromPaise(n.buyNow), fromPaise(n.fee), sharePct, refundPct,
          admin && input.antiSnipeWindowSec != null ? Number(input.antiSnipeWindowSec) : settings.anti_snipe_window_sec,
          admin && input.antiSnipeExtendSec != null ? Number(input.antiSnipeExtendSec) : settings.anti_snipe_extend_sec,
          admin && input.maxExtensions != null ? Number(input.maxExtensions) : settings.max_extensions,
          admin && input.paymentWindowHours != null ? Number(input.paymentWindowHours) : settings.payment_window_hours,
          settings.max_offer_rounds, n.startsAt, n.endsAt, input.relistedFrom || null,
          audience, quantity, eligibleVendors,
        ]
      )
      row = rows[0]
    } catch (err) {
      if (err.code === '23505') throw new AuctionError('PRODUCT_ALREADY_IN_AUCTION', 'This product already has an active auction', 409)
      throw err
    }
    if (status === 'SCHEDULED') await reserveStock(client, row)
    await logEvent(client, row.id, 'CREATED', actor, { status, product_id: p.id })
    return serializeAdmin(row)
  }).then(async (created) => {
    if (created.status !== 'SCHEDULED') return created
    await startDueAuctions()
    return fresh(created.id)
  })
}

export async function updateAuction(actor, id, input) {
  return withTx(async (client) => {
    const a = await lockAuction(client, id)
    assertScope(actor, a)
    const editableAll = ['DRAFT', 'REJECTED', 'PENDING_APPROVAL']
    const adminTextOnly = ['SCHEDULED', 'LIVE', 'PAUSED']
    if (!editableAll.includes(a.status) && !(isAdmin(actor) && adminTextOnly.includes(a.status))) {
      throw new AuctionError('NOT_EDITABLE', `An auction that is ${a.status} cannot be edited`, 409)
    }
    const settings = await getSettings(client)
    const pricingLocked = !editableAll.includes(a.status) &&
      (['LIVE', 'PAUSED'].includes(a.status) || Number(a.registration_count) > 0 || Number(a.bid_count) > 0)

    const pricingKeys = ['startPrice', 'reservePrice', 'bidIncrement', 'buyNowPrice', 'registrationFee', 'startsAt']
    if (pricingLocked && pricingKeys.some((k) => input[k] !== undefined)) {
      throw new AuctionError('PRICING_LOCKED', 'Pricing and start time cannot change once bidders have registered', 409)
    }
    const sets = ['updated_at = NOW()']
    const vals = [a.id]
    const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`) }
    if (input.title !== undefined) set('title', String(input.title).slice(0, 200))
    if (input.description !== undefined) set('description', input.description)
    if (input.imageUrl !== undefined) set('image_url', input.imageUrl)
    if (input.images !== undefined) set('images', JSON.stringify(input.images))
    if (input.quantity !== undefined) {
      const qty = Number(input.quantity)
      if (a.audience !== 'B2B' && qty !== 1) throw new AuctionError('VALIDATION', 'Customer auctions sell one unit', 422)
      if (!Number.isInteger(qty) || qty < 1 || qty > 100000) throw new AuctionError('VALIDATION', 'Quantity must be a whole number of 1 or more', 422)
      if (a.stock_reserved && qty !== Number(a.quantity)) throw new AuctionError('QUANTITY_LOCKED', 'The lot size cannot change once stock is set aside — cancel and relist instead', 409)
      set('quantity', qty)
    }
    if (input.eligibleVendorIds !== undefined && isAdmin(actor) && a.audience === 'B2B') {
      const ids = Array.isArray(input.eligibleVendorIds) ? [...new Set(input.eligibleVendorIds.map(String))] : []
      if (ids.length) {
        const { rows: found } = await client.query(`SELECT id FROM vendors WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [ids])
        if (found.length !== ids.length) throw new AuctionError('VALIDATION', 'One of the invited vendors does not exist', 422)
      }
      set('eligible_vendor_ids', ids.length ? ids : null)
    }

    const touchesRules = [...pricingKeys, 'endsAt', 'durationHours'].some((k) => input[k] !== undefined)
    if (touchesRules) {
      const n = normalise(input, settings, a)
      if (!pricingLocked) {
        set('start_price', fromPaise(n.startPrice)); set('current_price', fromPaise(n.startPrice))
        set('reserve_price', n.reservePrice == null ? null : fromPaise(n.reservePrice))
        set('bid_increment', n.bidIncrement == null ? null : fromPaise(n.bidIncrement))
        set('buy_now_price', n.buyNow == null ? null : fromPaise(n.buyNow))
        set('registration_fee', fromPaise(n.fee))
        set('starts_at', n.startsAt)
      }
      set('ends_at', n.endsAt); set('original_ends_at', n.endsAt)
    }
    if (isAdmin(actor)) {
      if (input.loserFeeRefundPct !== undefined && !pricingLocked) set('loser_fee_refund_pct', Number(input.loserFeeRefundPct))
      if (input.feeVendorSharePct !== undefined && !pricingLocked) set('fee_vendor_share_pct', Number(input.feeVendorSharePct))
    }
    const { rows } = await client.query(`UPDATE auctions SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals)
    await logEvent(client, a.id, 'EDITED', actor, { fields: Object.keys(input) })
    return serializeAdmin(rows[0])
  })
}

// ── lifecycle transitions ───────────────────────────────────────────────

async function toScheduled(client, a, actor, eventType) {
  if (new Date(a.ends_at) <= new Date()) {
    throw new AuctionError('WINDOW_PASSED', 'The end time has already passed — edit the schedule first', 409)
  }
  await reserveStock(client, a)
  await client.query(`UPDATE auctions SET status = 'SCHEDULED', rejected_reason = NULL, updated_at = NOW() WHERE id = $1`, [a.id])
  a.status = 'SCHEDULED'
  await logEvent(client, a.id, eventType, actor, {})
}

export async function submitAuction(actor, id) {
  const out = await withTx(async (client) => {
    const a = await lockAuction(client, id)
    assertScope(actor, a)
    if (!['DRAFT', 'REJECTED'].includes(a.status)) throw new AuctionError('INVALID_STATE', `Cannot submit an auction that is ${a.status}`, 409)
    const settings = await getSettings(client)
    if (!isAdmin(actor) && settings.vendor_auctions_require_approval) {
      await client.query(`UPDATE auctions SET status = 'PENDING_APPROVAL', rejected_reason = NULL, updated_at = NOW() WHERE id = $1`, [a.id])
      await logEvent(client, a.id, 'SUBMITTED', actor, {})
      a.status = 'PENDING_APPROVAL'
    } else {
      await toScheduled(client, a, actor, 'PUBLISHED')
    }
    return serializeAdmin(a)
  })
  if (out.status !== 'SCHEDULED') return out
  await startDueAuctions()
  return fresh(out.id)
}

export async function approveAuction(actor, id) {
  ensureAdmin(actor, 'approve auctions')
  const out = await withTx(async (client) => {
    const a = await lockAuction(client, id)
    assertScope(actor, a)
    if (a.status !== 'PENDING_APPROVAL') throw new AuctionError('INVALID_STATE', `Cannot approve an auction that is ${a.status}`, 409)
    await toScheduled(client, a, actor, 'APPROVED')
    await client.query('UPDATE auctions SET approved_by = $2, approved_at = NOW() WHERE id = $1', [a.id, actor.userId])
    return serializeAdmin(a)
  })
  await startDueAuctions()
  return fresh(out.id)
}

export async function rejectAuction(actor, id, reason) {
  ensureAdmin(actor, 'reject auctions')
  if (!reason || !String(reason).trim()) throw new AuctionError('VALIDATION', 'Give the vendor a reason for rejecting', 422)
  return withTx(async (client) => {
    const a = await lockAuction(client, id)
    assertScope(actor, a)
    if (a.status !== 'PENDING_APPROVAL') throw new AuctionError('INVALID_STATE', `Cannot reject an auction that is ${a.status}`, 409)
    await client.query(`UPDATE auctions SET status = 'REJECTED', rejected_reason = $2, updated_at = NOW() WHERE id = $1`, [a.id, String(reason).trim()])
    await logEvent(client, a.id, 'REJECTED', actor, { reason })
    return serializeAdmin({ ...a, status: 'REJECTED', rejected_reason: reason })
  })
}

export async function startNow(actor, id) {
  ensureAdmin(actor, 'start an auction early')
  const a = await startAuctionNow(id, actor)
  return serializeAdmin(a)
}

export async function pauseAuction(actor, id) {
  ensureAdmin(actor, 'pause auctions')
  return withTx(async (client, post) => {
    const a = await lockAuction(client, id)
    assertScope(actor, a)
    if (a.status !== 'LIVE') throw new AuctionError('INVALID_STATE', 'Only a live auction can be paused', 409)
    await client.query(`UPDATE auctions SET status = 'PAUSED', paused_at = NOW(), updated_at = NOW() WHERE id = $1`, [a.id])
    a.status = 'PAUSED'
    await logEvent(client, a.id, 'PAUSED', actor, {})
    post.push(() => broadcastState(a))
    return serializeAdmin(a)
  })
}

export async function resumeAuction(actor, id) {
  ensureAdmin(actor, 'resume auctions')
  return withTx(async (client, post) => {
    const a = await lockAuction(client, id)
    assertScope(actor, a)
    if (a.status !== 'PAUSED') throw new AuctionError('INVALID_STATE', 'Only a paused auction can be resumed', 409)
    // pause time does not count against bidders: push the end out by however long we were paused
    const { rows } = await client.query(
      `UPDATE auctions SET status = 'LIVE',
              ends_at = ends_at + (clock_timestamp() - paused_at), original_ends_at = original_ends_at + (clock_timestamp() - paused_at),
              paused_at = NULL, updated_at = NOW()
        WHERE id = $1 RETURNING *`, [a.id]
    )
    await logEvent(client, a.id, 'RESUMED', actor, {})
    post.push(() => broadcastState(rows[0]))
    return serializeAdmin(rows[0])
  })
}

export async function extendAuction(actor, id, minutes) {
  ensureAdmin(actor, 'extend auctions')
  const m = Math.trunc(Number(minutes))
  if (!(m >= 1 && m <= 10080)) throw new AuctionError('VALIDATION', 'Extend by between 1 minute and 7 days', 422)
  return withTx(async (client, post) => {
    const a = await lockAuction(client, id)
    assertScope(actor, a)
    if (!['SCHEDULED', 'LIVE', 'PAUSED'].includes(a.status)) throw new AuctionError('INVALID_STATE', `Cannot extend an auction that is ${a.status}`, 409)
    const { rows } = await client.query(
      `UPDATE auctions SET ends_at = ends_at + make_interval(mins => $2), updated_at = NOW() WHERE id = $1 RETURNING *`, [a.id, m]
    )
    await logEvent(client, a.id, 'EXTENDED_BY_ADMIN', actor, { minutes: m })
    post.push(() => broadcastState(rows[0]))
    return serializeAdmin(rows[0])
  })
}

async function scopeCheck(actor, id) {
  const { rows } = await query('SELECT id, vendor_id FROM auctions WHERE id = $1', [id])
  assertScope(actor, rows[0])
}

export async function endNow(actor, id) {
  ensureAdmin(actor, 'end an auction early')
  await scopeCheck(actor, id)
  return endAuctionNow(id, actor)
}

export async function cancel(actor, id, reason) {
  await scopeCheck(actor, id)
  if (isAdmin(actor)) return cancelAuction(id, actor, reason || 'Cancelled by platform')
  // vendors: before it starts, or while live with nobody having bid
  return cancelAuction(id, actor, reason || 'Cancelled by seller', {
    allowWhen: (a) => ['DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'SCHEDULED'].includes(a.status) ||
      (a.status === 'LIVE' && Number(a.bid_count) === 0),
  })
}

export async function relist(actor, id, { startsAt, endsAt, durationHours } = {}) {
  const { rows } = await query('SELECT * FROM auctions WHERE id = $1', [id])
  const a = rows[0]
  assertScope(actor, a)
  if (!['UNSOLD', 'DEFAULTED', 'CANCELLED', 'REJECTED'].includes(a.status)) {
    throw new AuctionError('INVALID_STATE', 'Only a finished, unsold auction can be relisted', 409)
  }
  return createAuction(actor, {
    productId: a.product_id, title: a.title, description: a.description, imageUrl: a.image_url, images: a.images,
    startPrice: Number(a.start_price), reservePrice: a.reserve_price == null ? undefined : Number(a.reserve_price),
    bidIncrement: a.bid_increment == null ? undefined : Number(a.bid_increment),
    buyNowPrice: a.buy_now_price == null ? undefined : Number(a.buy_now_price),
    registrationFee: Number(a.registration_fee),
    startsAt: startsAt || new Date(Date.now() + 5 * 60000).toISOString(),
    endsAt, durationHours: endsAt ? undefined : (durationHours || 24),
    audience: a.audience, quantity: Number(a.quantity), eligibleVendorIds: a.eligible_vendor_ids || undefined,
    relistedFrom: a.id, saveAsDraft: true,
  })
}

// ── reads ───────────────────────────────────────────────────────────────

const scopeClause = (actor, params, alias = 'a') => {
  if (isAdmin(actor)) return ''
  params.push(actor.vendorId)
  return ` AND ${alias}.vendor_id = $${params.length}`
}

export async function listManage(actor, { status = '', q = '', ownerType = '', audience = '', page = 1, limit = 20 } = {}) {
  const params = []
  const where = ['1=1']
  if (status) { params.push(String(status).split(',')); where.push(`a.status = ANY($${params.length})`) }
  if (q) { params.push(`%${q}%`); where.push(`(a.title ILIKE $${params.length} OR a.auction_number ILIKE $${params.length})`) }
  if (ownerType) { params.push(ownerType); where.push(`a.owner_type = $${params.length}`) }
  if (audience === 'B2B' || audience === 'B2C') { params.push(audience); where.push(`a.audience = $${params.length}`) }
  const scope = scopeClause(actor, params)
  const base = `FROM auctions a LEFT JOIN vendors v ON v.id = a.vendor_id WHERE ${where.join(' AND ')}${scope}`
  const offset = (Math.max(1, page) - 1) * limit
  const [rows, count, tabs] = await Promise.all([
    query(`SELECT a.*, v.name AS seller_name ${base} ORDER BY
             CASE a.status WHEN 'LIVE' THEN 0 WHEN 'PENDING_APPROVAL' THEN 1 WHEN 'AWAITING_PAYMENT' THEN 2 WHEN 'SCHEDULED' THEN 3 ELSE 4 END,
             a.ends_at ASC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, params),
    query(`SELECT COUNT(*)::int AS n ${base}`, params),
    query(`SELECT a.status, COUNT(*)::int AS n FROM auctions a WHERE 1=1${scopeClause(actor, [])} GROUP BY a.status`,
      isAdmin(actor) ? [] : [actor.vendorId]),
  ])
  return {
    success: true,
    data: rows.rows.map((r) => serializeAdmin(r, { includePrivate: isAdmin(actor) })),
    pagination: { page, limit, total: count.rows[0].n },
    counts: Object.fromEntries(tabs.rows.map((r) => [r.status, r.n])),
  }
}

/** Fraud / quality signals for one auction. Admin-only detail; vendors get a count. */
export async function flagsForAuction(auctionId) {
  const flags = []
  const { rows: ips } = await query(
    `SELECT ip, array_agg(DISTINCT user_id) AS users FROM auction_bids
      WHERE auction_id = $1 AND ip IS NOT NULL GROUP BY ip HAVING COUNT(DISTINCT user_id) > 1`, [auctionId]
  )
  for (const r of ips) flags.push({ type: 'SHARED_IP', severity: 'HIGH', detail: `${r.users.length} different bidders bid from the same IP`, user_ids: r.users })

  const { rows: a } = await query('SELECT bidder_count, bid_count, vendor_id FROM auctions WHERE id = $1', [auctionId])
  if (a[0] && a[0].bidder_count === 2 && a[0].bid_count >= 8) {
    flags.push({ type: 'TWO_BIDDER_DUEL', severity: 'MEDIUM', detail: 'Only two bidders, many alternating bids — possible price-pumping', user_ids: [] })
  }
  if (a[0]?.vendor_id) {
    const { rows } = await query(
      `SELECT u.id FROM auction_registrations r JOIN users u ON u.id = r.user_id JOIN vendors v ON v.id = $2
        WHERE r.auction_id = $1 AND v.phone IS NOT NULL AND regexp_replace(u.phone, '\\D', '', 'g') = regexp_replace(v.phone, '\\D', '', 'g')`,
      [auctionId, a[0].vendor_id]
    )
    if (rows.length) flags.push({ type: 'SELLER_LINKED', severity: 'HIGH', detail: 'A bidder shares the seller\'s phone number', user_ids: rows.map((r) => r.id) })
  }
  const { rows: strikers } = await query(
    `SELECT r.user_id, p.strikes FROM auction_registrations r JOIN auction_bidder_profiles p ON p.user_id = r.user_id
      WHERE r.auction_id = $1 AND p.strikes > 0`, [auctionId]
  )
  if (strikers.length) flags.push({ type: 'PRIOR_DEFAULTS', severity: 'LOW', detail: `${strikers.length} bidder(s) have unpaid-win strikes`, user_ids: strikers.map((s) => s.user_id) })
  return flags
}

export async function getManage(actor, id) {
  const { rows } = await query(
    `SELECT a.*, v.name AS seller_name FROM auctions a LEFT JOIN vendors v ON v.id = a.vendor_id WHERE a.id = $1`, [id]
  )
  const a = rows[0]
  assertScope(actor, a)
  const admin = isAdmin(actor)

  const [regs, bids, ledgerRows, events, series, flags] = await Promise.all([
    query(
      `SELECT r.id, r.user_id, r.bidder_no, r.fee_amount, r.status, r.refund_amount, r.forfeited_amount, r.highest_bid,
              r.bid_count, r.last_bid_at, r.created_at, u.name, u.phone, p.strikes, p.is_blocked
         FROM auction_registrations r JOIN users u ON u.id = r.user_id
         LEFT JOIN auction_bidder_profiles p ON p.user_id = r.user_id
        WHERE r.auction_id = $1 ORDER BY r.bidder_no`, [id]),
    query(
      `SELECT b.seq, b.amount, b.max_amount, b.bid_type, b.is_leading, b.ip, b.created_at, b.user_id, r.bidder_no
         FROM auction_bids b LEFT JOIN auction_registrations r ON r.id = b.registration_id
        WHERE b.auction_id = $1 ORDER BY b.seq DESC LIMIT 300`, [id]),
    query(`SELECT entry_type, SUM(amount)::numeric(12,2) AS total, COUNT(*)::int AS n FROM auction_fee_ledger WHERE auction_id = $1 GROUP BY entry_type`, [id]),
    query(`SELECT id, event_type, actor_role, payload, created_at FROM auction_events WHERE auction_id = $1 ORDER BY id DESC LIMIT 100`, [id]),
    query(`SELECT seq, amount, created_at FROM auction_bids WHERE auction_id = $1 ORDER BY seq`, [id]),
    admin ? flagsForAuction(id) : Promise.resolve([]),
  ])

  const mask = (phone) => (phone ? `${String(phone).slice(0, 2)}******${String(phone).slice(-2)}` : null)
  return {
    auction: serializeAdmin(a, { includePrivate: admin }),
    registrations: regs.rows.map((r) => ({
      ...r, fee_amount: Number(r.fee_amount), refund_amount: Number(r.refund_amount), forfeited_amount: Number(r.forfeited_amount),
      highest_bid: admin && r.highest_bid != null ? Number(r.highest_bid) : null,
      name: admin ? r.name : null, phone: admin ? r.phone : mask(r.phone), alias: `Bidder #${r.bidder_no}`,
      user_id: admin ? r.user_id : null,
    })),
    bids: bids.rows.map((b) => ({
      seq: Number(b.seq), amount: Number(b.amount), type: b.bid_type, is_leading: b.is_leading, at: b.created_at,
      alias: `Bidder #${b.bidder_no}`, max_amount: admin && b.max_amount != null ? Number(b.max_amount) : undefined,
      ip: admin ? b.ip : undefined, user_id: admin ? b.user_id : undefined,
    })),
    price_series: series.rows.map((s) => ({ seq: Number(s.seq), amount: Number(s.amount), at: s.created_at })),
    fees: Object.fromEntries(ledgerRows.rows.map((r) => [r.entry_type, Number(r.total)])),
    events: events.rows,
    flags,
    flag_count: admin ? flags.length : undefined,
  }
}

export async function stats(actor) {
  const params = []
  const scope = scopeClause(actor, params)
  const vendorId = isAdmin(actor) ? null : actor.vendorId
  const [counts, money, series, sold] = await Promise.all([
    query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'LIVE')::int AS live,
         COUNT(*) FILTER (WHERE status = 'LIVE' AND ends_at <= NOW() + INTERVAL '1 hour')::int AS ending_soon,
         COUNT(*) FILTER (WHERE status = 'AWAITING_PAYMENT')::int AS awaiting_payment,
         COUNT(*) FILTER (WHERE status = 'PENDING_APPROVAL')::int AS pending_approval,
         COUNT(*) FILTER (WHERE status = 'SCHEDULED')::int AS scheduled,
         COALESCE(SUM(registration_count) FILTER (WHERE status IN ('LIVE','SCHEDULED')), 0)::int AS active_registrations
       FROM auctions a WHERE 1=1 ${scope}`, params),
    query(
      `SELECT
         COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'FEE_FORFEIT_PLATFORM'), 0)::numeric(12,2) AS platform_fee_revenue,
         COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'FEE_FORFEIT_VENDOR'), 0)::numeric(12,2) AS vendor_fee_revenue,
         COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'FEE_CHARGED'), 0)::numeric(12,2) AS fees_collected
       FROM auction_fee_ledger l ${isAdmin(actor) ? '' : 'WHERE l.vendor_id = $1'}
       ${isAdmin(actor) ? 'WHERE' : 'AND'} l.created_at >= NOW() - INTERVAL '30 days'`, vendorId ? [vendorId] : []),
    query(
      `SELECT to_char(date_trunc('day', l.created_at), 'YYYY-MM-DD') AS day,
              SUM(l.amount) FILTER (WHERE l.entry_type IN ('FEE_FORFEIT_PLATFORM','FEE_FORFEIT_VENDOR'))::numeric(12,2) AS revenue,
              SUM(l.amount) FILTER (WHERE l.entry_type = 'FEE_CHARGED')::numeric(12,2) AS collected
         FROM auction_fee_ledger l
        WHERE l.created_at >= NOW() - INTERVAL '30 days' ${isAdmin(actor) ? '' : 'AND l.vendor_id = $1'}
        GROUP BY 1 ORDER BY 1`, vendorId ? [vendorId] : []),
    query(
      `SELECT COUNT(*) FILTER (WHERE status = 'SOLD')::int AS sold, COUNT(*) FILTER (WHERE status IN ('SOLD','UNSOLD','DEFAULTED'))::int AS finished,
              COALESCE(SUM(winning_bid) FILTER (WHERE status = 'SOLD'), 0)::numeric(12,2) AS gmv,
              COALESCE(AVG(bid_count) FILTER (WHERE status IN ('SOLD','UNSOLD')), 0)::numeric(8,1) AS avg_bids
         FROM auctions a WHERE a.created_at >= NOW() - INTERVAL '30 days' ${scope}`, params),
  ])
  const m = money.rows[0]
  return {
    ...counts.rows[0],
    platform_fee_revenue_30d: Number(m.platform_fee_revenue),
    vendor_fee_revenue_30d: Number(m.vendor_fee_revenue),
    fees_collected_30d: Number(m.fees_collected),
    gmv_30d: Number(sold.rows[0].gmv),
    sold_30d: sold.rows[0].sold,
    sell_through_pct_30d: sold.rows[0].finished ? Math.round((sold.rows[0].sold / sold.rows[0].finished) * 100) : null,
    avg_bids_per_auction_30d: Number(sold.rows[0].avg_bids),
    revenue_series: series.rows.map((r) => ({ day: r.day, revenue: Number(r.revenue || 0), collected: Number(r.collected || 0) })),
  }
}

/** Auctions a vendor/admin must act on. */
export async function attentionQueue(actor) {
  const params = []
  const scope = scopeClause(actor, params)
  const { rows } = await query(
    `SELECT a.id, a.auction_number, a.title, a.status, a.payment_deadline, a.ends_at, a.created_at, a.offer_round, v.name AS seller_name
       FROM auctions a LEFT JOIN vendors v ON v.id = a.vendor_id
      WHERE a.status IN ('PENDING_APPROVAL','AWAITING_PAYMENT','REJECTED') ${scope}
      ORDER BY COALESCE(a.payment_deadline, a.created_at) ASC LIMIT 20`, params
  )
  return rows
}

// ── settings & bidder risk (platform only) ──────────────────────────────

const NUM_FIELDS = {
  min_registration_fee: [0, 1e6], max_registration_fee: [0, 1e6], fee_max_pct_of_start_price: [0, 100],
  anti_snipe_window_sec: [0, 3600], anti_snipe_extend_sec: [0, 3600], max_extensions: [0, 100],
  min_duration_minutes: [1, 1e5], max_duration_days: [1, 365], payment_window_hours: [1, 720], max_offer_rounds: [1, 10],
  vendor_fee_share_pct: [0, 100], loser_fee_refund_pct: [0, 100], max_live_auctions_per_vendor: [1, 1000],
  strike_limit: [1, 100], bid_rate_limit_per_minute: [1, 1000],
}

export async function getSettingsForAdmin() {
  invalidateSettingsCache()
  return getSettings()
}

export async function updateSettings(actor, patch) {
  ensureAdmin(actor, 'change auction settings')
  const sets = ['updated_at = NOW()', 'updated_by = $1']
  const vals = [actor.userId]
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`) }
  for (const [k, [lo, hi]] of Object.entries(NUM_FIELDS)) {
    if (patch[k] === undefined) continue
    const n = Number(patch[k])
    if (!Number.isFinite(n) || n < lo || n > hi) throw new AuctionError('VALIDATION', `${k} must be between ${lo} and ${hi}`, 422)
    add(k, n)
  }
  for (const k of ['enabled', 'vendor_auctions_require_approval']) if (patch[k] !== undefined) add(k, !!patch[k])
  if (patch.blocked_states !== undefined) {
    if (!Array.isArray(patch.blocked_states)) throw new AuctionError('VALIDATION', 'blocked_states must be a list', 422)
    add('blocked_states', patch.blocked_states.map((s) => String(s).trim().toLowerCase()).filter(Boolean))
  }
  if (patch.consent_text !== undefined) add('consent_text', String(patch.consent_text).slice(0, 2000))
  if (patch.consent_text_version !== undefined) add('consent_text_version', String(patch.consent_text_version).slice(0, 20))
  if (patch.increment_tiers !== undefined) {
    const t = patch.increment_tiers
    const ok = Array.isArray(t) && t.length > 0 && t[0].from === 0 &&
      t.every((x, i) => Number(x.inc) > 0 && Number(x.from) >= 0 && (i === 0 || Number(x.from) > Number(t[i - 1].from)))
    if (!ok) throw new AuctionError('VALIDATION', 'Increment tiers must start at ₹0, ascend, and have positive steps', 422)
    add('increment_tiers', JSON.stringify(t.map((x) => ({ from: Number(x.from), inc: Number(x.inc) }))))
  }
  const cur = await getSettings()
  const merged = { ...cur, ...patch }
  if (Number(merged.min_registration_fee) > Number(merged.max_registration_fee)) {
    throw new AuctionError('VALIDATION', 'Minimum fee cannot exceed the maximum fee', 422)
  }
  await query(`UPDATE auction_settings SET ${sets.join(', ')} WHERE id = TRUE`, vals)
  invalidateSettingsCache()
  return getSettings()
}

export async function riskOverview() {
  const [profiles, sharedIps, duels, linked] = await Promise.all([
    query(
      `SELECT p.user_id, p.strikes, p.is_blocked, p.blocked_reason, p.blocked_at, u.name, u.phone
         FROM auction_bidder_profiles p JOIN users u ON u.id = p.user_id
        WHERE p.strikes > 0 OR p.is_blocked ORDER BY p.is_blocked DESC, p.strikes DESC LIMIT 100`),
    query(
      `SELECT b.auction_id, a.auction_number, a.title, b.ip, COUNT(DISTINCT b.user_id)::int AS bidders
         FROM auction_bids b JOIN auctions a ON a.id = b.auction_id
        WHERE a.created_at >= NOW() - INTERVAL '30 days' AND b.ip IS NOT NULL
        GROUP BY b.auction_id, a.auction_number, a.title, b.ip HAVING COUNT(DISTINCT b.user_id) > 1
        ORDER BY bidders DESC LIMIT 50`),
    query(
      `SELECT id AS auction_id, auction_number, title, bid_count FROM auctions
        WHERE bidder_count = 2 AND bid_count >= 8 AND created_at >= NOW() - INTERVAL '30 days' ORDER BY bid_count DESC LIMIT 50`),
    query(
      `SELECT DISTINCT a.id AS auction_id, a.auction_number, a.title, u.name AS bidder
         FROM auctions a JOIN vendors v ON v.id = a.vendor_id
         JOIN auction_registrations r ON r.auction_id = a.id JOIN users u ON u.id = r.user_id
        WHERE v.phone IS NOT NULL AND a.created_at >= NOW() - INTERVAL '30 days'
          AND regexp_replace(u.phone, '\\D', '', 'g') = regexp_replace(v.phone, '\\D', '', 'g') LIMIT 50`),
  ])
  return { bidders: profiles.rows, shared_ip: sharedIps.rows, duels: duels.rows, seller_linked: linked.rows }
}

export async function blockBidder(actor, userId, reason) {
  ensureAdmin(actor, 'block bidders')
  await query(
    `INSERT INTO auction_bidder_profiles (user_id, is_blocked, blocked_reason, blocked_by, blocked_at)
     VALUES ($1, TRUE, $2, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE SET is_blocked = TRUE, blocked_reason = $2, blocked_by = $3, blocked_at = NOW(), updated_at = NOW()`,
    [userId, reason || 'Blocked by admin', actor.userId]
  )
  return { user_id: userId, is_blocked: true }
}

export async function unblockBidder(actor, userId) {
  ensureAdmin(actor, 'unblock bidders')
  await query(
    `UPDATE auction_bidder_profiles SET is_blocked = FALSE, blocked_reason = NULL, strikes = 0, updated_at = NOW() WHERE user_id = $1`, [userId]
  )
  return { user_id: userId, is_blocked: false }
}


/**
 * Auction orders: Winner → Order created → Payment → QC → Shipping → Delivered,
 * for B2C and B2B auctions separately.
 */
export async function listOrders(actor, { audience = '', status = '', q = '', page = 1, limit = 20 } = {}) {
  const params = []
  const where = [`a.winner_id IS NOT NULL`]
  if (audience === 'B2B' || audience === 'B2C') { params.push(audience); where.push(`a.audience = $${params.length}`) }
  if (q) { params.push(`%${q}%`); where.push(`(a.title ILIKE $${params.length} OR a.auction_number ILIKE $${params.length} OR o.order_number ILIKE $${params.length})`) }
  if (status === 'AWAITING_PAYMENT') where.push(`a.status = 'AWAITING_PAYMENT'`)
  else if (status === 'IN_PROGRESS') where.push(`o.id IS NOT NULL AND o.status NOT IN ('DELIVERED','COMPLETED','CANCELLED','REFUNDED')`)
  else if (status === 'DELIVERED') where.push(`o.status IN ('DELIVERED','COMPLETED')`)
  else if (status === 'PROBLEM') where.push(`(a.status = 'DEFAULTED' OR o.status IN ('CANCELLED','REFUNDED'))`)
  const scope = scopeClause(actor, params)
  const base = `FROM auctions a
      JOIN users u ON u.id = a.winner_id
      LEFT JOIN orders o ON o.id = a.order_id
      LEFT JOIN products p ON p.id = a.product_id
      LEFT JOIN shop_products sp ON sp.id = a.shop_product_id
      WHERE ${where.join(' AND ')}${scope}`
  const offset = (Math.max(1, page) - 1) * limit
  const [rows, count] = await Promise.all([
    query(
      `SELECT a.id, a.auction_number, a.title, a.audience, a.quantity, a.winning_bid, a.amount_due, a.status AS auction_status, a.ended_at, a.payment_deadline,
              u.name AS winner_name, u.phone AS winner_phone, o.id AS order_id, o.order_number, o.status AS order_status, o.payment_status,
              sp.qc_status, (SELECT MIN(so.shipped_at) FROM seller_orders so WHERE so.order_id = o.id) AS shipped_at, o.delivered_at,
              (SELECT string_agg(DISTINCT vv.name, ', ') FROM seller_orders so JOIN vendors vv ON vv.id = so.vendor_id WHERE so.order_id = o.id) AS seller_name
         ${base} ORDER BY COALESCE(a.ended_at, a.updated_at) DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, params),
    query(`SELECT COUNT(*)::int AS n ${base}`, params),
  ])
  const data = rows.rows.map((r) => {
    const paid = ['PAID', 'PARTIALLY_PAID'].includes(r.payment_status)
    const delivered = ['DELIVERED', 'COMPLETED'].includes(r.order_status)
    const stages = [
      { key: 'WINNER', label: 'Winner', done: true },
      { key: 'ORDER', label: 'Order created', done: !!r.order_id },
      { key: 'PAYMENT', label: 'Payment', done: paid },
      { key: 'QC', label: 'QC', done: r.qc_status === 'QC_PASSED' },
      { key: 'SHIPPING', label: 'Shipping', done: !!r.shipped_at || delivered },
      { key: 'DELIVERED', label: 'Delivered', done: delivered },
    ]
    return {
      ...r, winning_bid: Number(r.winning_bid), amount_due: Number(r.amount_due), quantity: Number(r.quantity || 1),
      unit_price: Number(r.quantity) > 1 ? Math.round((Number(r.winning_bid) / Number(r.quantity)) * 100) / 100 : null,
      stages, current: (stages.find((s) => !s.done) || { key: 'DELIVERED' }).key,
    }
  })
  return { success: true, data, pagination: { page, limit, total: count.rows[0].n } }
}
