/**
 * Shared helpers for the auctions module: typed errors, settings, row ⇄ engine
 * mapping, serializers, audit events, realtime fan-out and notifications.
 *
 * SECURITY: `leader_max` (the private proxy ceiling) and `reserve_price` must
 * never be returned by a customer-facing serializer. Only `serializeAdmin`
 * may include them.
 *
 * @module modules/auctions/auction.shared
 */

import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { fromPaise, minNextBid, incrementFor, reserveMet, toPaise } from './auction-engine.js'

export class AuctionError extends Error {
  constructor(code, message, statusCode = 400, details = {}) {
    super(message)
    this.name = 'AuctionError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

/** Terminal states: nothing more can happen to the auction itself. */
export const TERMINAL = Object.freeze(['SOLD', 'UNSOLD', 'CANCELLED', 'DEFAULTED', 'REJECTED'])
/** States in which the unit is held out of regular sale. */
export const HOLDS_STOCK = Object.freeze(['SCHEDULED', 'LIVE', 'PAUSED', 'AWAITING_PAYMENT'])

const num = (v) => (v == null ? null : Number(v))

// ── Settings ────────────────────────────────────────────────────────────

const SETTINGS_TTL_MS = 5000
let settingsCache = { at: 0, value: null }

export function invalidateSettingsCache() {
  settingsCache = { at: 0, value: null }
}

export async function getSettings(client = null) {
  if (!client && settingsCache.value && Date.now() - settingsCache.at < SETTINGS_TTL_MS) {
    return settingsCache.value
  }
  const run = client ? client.query.bind(client) : query
  const { rows } = await run('SELECT * FROM auction_settings WHERE id = TRUE')
  const value = rows[0]
  if (!value) throw new AuctionError('SETTINGS_MISSING', 'Auction settings are not initialised', 500)
  if (!client) settingsCache = { at: Date.now(), value }
  return value
}

// ── Row ⇄ engine ────────────────────────────────────────────────────────

/** Build the engine's integer-paise state from an `auctions` row. */
export function toEngineState(a) {
  return {
    startPrice: toPaise(a.start_price),
    currentPrice: toPaise(a.current_price),
    leaderId: a.leader_id || null,
    leaderMax: a.leader_max == null ? null : toPaise(a.leader_max),
    bidCount: Number(a.bid_count),
    reservePrice: a.reserve_price == null ? null : toPaise(a.reserve_price),
    buyNowPrice: a.buy_now_price == null ? null : toPaise(a.buy_now_price),
    endsAt: new Date(a.ends_at).getTime(),
    extensionCount: Number(a.extension_count),
  }
}

export function toEngineCfg(a) {
  return {
    increment: {
      fixedPaise: a.bid_increment == null ? null : toPaise(a.bid_increment),
      tiers: a.increment_tiers || undefined,
    },
    antiSnipeWindowMs: Number(a.anti_snipe_window_sec) * 1000,
    antiSnipeExtendMs: Number(a.anti_snipe_extend_sec) * 1000,
    maxExtensions: Number(a.max_extensions),
  }
}

// ── Audit trail ─────────────────────────────────────────────────────────

export async function logEvent(client, auctionId, eventType, actor = {}, payload = {}) {
  const run = client ? client.query.bind(client) : query
  await run(
    `INSERT INTO auction_events (auction_id, event_type, actor_id, actor_role, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [auctionId, eventType, actor.userId || null, actor.kind || null, JSON.stringify(payload)]
  )
}

// ── Serializers ─────────────────────────────────────────────────────────

const aliasOf = (bidderNo) => (bidderNo ? `Bidder #${bidderNo}` : null)
export { aliasOf }

function feePolicyText(a) {
  const fee = Number(a.registration_fee)
  if (!fee) return 'Free to join.'
  const refund = Number(a.loser_fee_refund_pct)
  const base = `₹${fee} registration fee, charged to your wallet when you join. If you win, it is deducted from the price you pay.`
  if (refund >= 100) return `${base} If you do not win, it is refunded in full.`
  if (refund > 0) return `${base} If you do not win, ${refund}% is refunded.`
  return `${base} If you do not win, the fee is not refunded. If the auction is cancelled or the reserve is not met, it is refunded in full.`
}

/**
 * Customer-safe view. `ctx.my` is the viewer's registration row (with bidder_no) or null.
 * `ctx.leaderBidderNo` / `ctx.winnerBidderNo` resolve public aliases.
 */
export function serializePublic(a, ctx = {}) {
  const state = toEngineState(a)
  const cfg = toEngineCfg(a)
  const live = a.status === 'LIVE'
  const my = ctx.my || null
  const isLeader = !!(my && a.leader_id && a.leader_id === my.user_id)
  const isWinner = !!(my && a.winner_id && a.winner_id === my.user_id)
  const showMin = live || a.status === 'SCHEDULED'

  return {
    id: a.id,
    auction_number: a.auction_number,
    product_id: a.product_id,
    title: a.title,
    description: a.description,
    image_url: a.image_url,
    images: a.images || [],
    status: a.status,
    seller: { type: a.vendor_id ? 'VENDOR' : 'PLATFORM', name: a.seller_name || (a.vendor_id ? 'Verified seller' : 'Dealker Official') },
    start_price: num(a.start_price),
    current_price: a.bid_count > 0 ? num(a.current_price) : num(a.start_price),
    min_next_bid: showMin ? fromPaise(minNextBid(state, cfg)) : null,
    increment: fromPaise(incrementFor(state.currentPrice || state.startPrice, cfg.increment)),
    buy_now_price: live && a.buy_now_price != null && a.bid_count === 0 ? num(a.buy_now_price) : null,
    reserve_status: a.reserve_price == null ? 'NONE' : reserveMet(state) && a.bid_count > 0 ? 'MET' : 'NOT_MET',
    registration_fee: num(a.registration_fee),
    fee_policy: feePolicyText(a),
    loser_fee_refund_pct: num(a.loser_fee_refund_pct),
    bid_count: a.bid_count,
    bidder_count: a.bidder_count,
    registration_count: a.registration_count,
    extension_count: a.extension_count,
    starts_at: a.starts_at,
    ends_at: a.ends_at,
    ended_at: a.ended_at,
    server_time: new Date().toISOString(),
    leader_alias: aliasOf(ctx.leaderBidderNo),
    winner_alias: ['AWAITING_PAYMENT', 'SOLD'].includes(a.status) ? aliasOf(ctx.winnerBidderNo) : null,
    final_price: ['AWAITING_PAYMENT', 'SOLD'].includes(a.status) ? num(a.winning_bid) : null,
    watching: !!ctx.watching,
    my: my
      ? {
          registered: true,
          bidder_no: my.bidder_no,
          fee_paid: num(my.fee_amount),
          fee_status: my.status,
          is_leading: isLeader && live,
          my_max: isLeader ? num(a.leader_max) : my.highest_bid == null ? null : num(my.highest_bid),
          is_winner: isWinner,
          amount_due: isWinner && a.status === 'AWAITING_PAYMENT' ? num(a.amount_due) : null,
          fee_credit: isWinner ? num(a.fee_credit) : null,
          payment_deadline: isWinner && a.status === 'AWAITING_PAYMENT' ? a.payment_deadline : null,
          order_id: isWinner ? a.order_id : null,
        }
      : { registered: false },
  }
}

/** Full view for dashboard users (admin, or the owning vendor). */
export function serializeAdmin(a, { includePrivate = true } = {}) {
  const out = {
    ...a,
    start_price: num(a.start_price),
    current_price: num(a.current_price),
    reserve_price: num(a.reserve_price),
    bid_increment: num(a.bid_increment),
    buy_now_price: num(a.buy_now_price),
    registration_fee: num(a.registration_fee),
    fee_vendor_share_pct: num(a.fee_vendor_share_pct),
    loser_fee_refund_pct: num(a.loser_fee_refund_pct),
    leader_max: num(a.leader_max),
    winning_bid: num(a.winning_bid),
    fee_credit: num(a.fee_credit),
    amount_due: num(a.amount_due),
    server_time: new Date().toISOString(),
  }
  if (!includePrivate) delete out.leader_max
  return out
}

// ── Realtime ────────────────────────────────────────────────────────────

async function getEmitter() {
  try {
    const { getSocketIo } = await import('../../plugins/socketio.plugin.js')
    const io = getSocketIo()
    if (io) return io
    const { getSocketEmitter } = await import('../../plugins/socket-emitter.js')
    return getSocketEmitter()
  } catch (err) {
    logger.debug({ err: err.message }, 'auction realtime emitter unavailable')
    return null
  }
}

export async function emitToRoom(room, event, payload) {
  try {
    const em = await getEmitter()
    em?.to(room).emit(event, payload)
  } catch (err) {
    logger.warn({ err: err.message, room, event }, 'auction emit failed (non-critical)')
  }
}

/** Public live-state frame broadcast to everyone watching an auction. */
export async function broadcastState(a, { leaderBidderNo = null } = {}) {
  const state = toEngineState(a)
  const cfg = toEngineCfg(a)
  await emitToRoom(`auction:${a.id}`, 'auction:state', {
    id: a.id,
    status: a.status,
    current_price: a.bid_count > 0 ? num(a.current_price) : num(a.start_price),
    min_next_bid: a.status === 'LIVE' ? fromPaise(minNextBid(state, cfg)) : null,
    bid_count: a.bid_count,
    bidder_count: a.bidder_count,
    registration_count: a.registration_count,
    ends_at: a.ends_at,
    extension_count: a.extension_count,
    reserve_status: a.reserve_price == null ? 'NONE' : reserveMet(state) && a.bid_count > 0 ? 'MET' : 'NOT_MET',
    leader_alias: aliasOf(leaderBidderNo),
    buy_now_price: a.status === 'LIVE' && a.buy_now_price != null && a.bid_count === 0 ? num(a.buy_now_price) : null,
    server_time: new Date().toISOString(),
  })
}

// ── Notifications (best effort — never fail the business transaction) ────

let notifier = null
async function getNotifier() {
  if (notifier) return notifier
  const { NotificationsService } = await import('../notifications/notifications.service.js')
  const { NotificationsRepository } = await import('../notifications/notifications.repository.js')
  notifier = new NotificationsService(new NotificationsRepository(), null)
  return notifier
}

export async function notifyUser(userId, { title, body, data = {} }) {
  try {
    const svc = await getNotifier()
    await svc.sendNotification(userId, { title, body, type: 'AUCTION', data })
    await emitToRoom(`user:${userId}`, data.event || 'auction:notice', { title, body, ...data })
  } catch (err) {
    logger.warn({ err: err.message, userId }, 'auction notification failed (non-critical)')
  }
}

export const rupees = (n) => `₹${Number(n).toLocaleString('en-IN')}`
