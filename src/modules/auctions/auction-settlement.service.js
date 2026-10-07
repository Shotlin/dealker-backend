/**
 * Auction settlement — lifecycle transitions driven by time and money.
 *
 *   SCHEDULED ─start─► LIVE ─close─► AWAITING_PAYMENT ─paid─► SOLD
 *                                 └► UNSOLD
 *   AWAITING_PAYMENT ─deadline missed─► (penalty) ─► next bidder … ─► DEFAULTED
 *   any pre-sale state ─cancel─► CANCELLED
 *
 * Fees are escrowed in auction_registrations (status ACTIVE) and released only
 * here, with an idempotency key on every ledger row so a retry can never pay
 * out twice. Every public method opens its own transaction and locks the
 * auction row first (lock order: auction → registrations → wallets).
 *
 * @module modules/auctions/auction-settlement.service
 */

import { getClient, query } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { WalletRepository } from '../wallet/wallet.repository.js'
import { ShopProductsRepository } from '../shop-products/shop-products.repository.js'
import {
  fromPaise, pickSecondChance, resolveClose, splitForfeitedFee, toPaise, winnerAmountDue,
} from './auction-engine.js'
import {
  AuctionError, aliasOf, broadcastState, emitToRoom, getSettings, logEvent, notifyUser, rupees,
} from './auction.shared.js'

const walletRepo = new WalletRepository()
const stockRepo = new ShopProductsRepository()

// ── tiny tx helpers ─────────────────────────────────────────────────────

/** Run `fn(client, post)` in a transaction; `post` closures run after COMMIT. */
export async function withTx(fn) {
  const client = await getClient()
  const post = []
  try {
    await client.query('BEGIN')
    const result = await fn(client, post)
    await client.query('COMMIT')
    for (const job of post) {
      try { await job() } catch (err) { logger.warn({ err: err.message }, 'auction post-commit job failed') }
    }
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function lockAuction(client, id, { skipLocked = false } = {}) {
  const { rows } = await client.query(
    `SELECT a.*, v.name AS seller_name
       FROM auctions a LEFT JOIN vendors v ON v.id = a.vendor_id
      WHERE a.id = $1 FOR UPDATE OF a ${skipLocked ? 'SKIP LOCKED' : ''}`,
    [id]
  )
  return rows[0] || null
}

const dbNow = async (client) => (await client.query('SELECT clock_timestamp() AS now')).rows[0].now

// ── stock reservation ───────────────────────────────────────────────────

export async function reserveStock(client, a) {
  if (a.stock_reserved) return
  if (!a.shop_product_id) throw new AuctionError('PRODUCT_NOT_LISTED', 'This product has no stock listing to auction', 409)
  try {
    await stockRepo.applyStockChange(client, {
      shopProductId: a.shop_product_id, delta: -1, type: 'ORDER_DEDUCTION', source: 'API',
      reason: `Reserved for auction ${a.auction_number}`, metadata: { auction_id: a.id },
    })
  } catch (err) {
    throw new AuctionError('OUT_OF_STOCK', 'Not enough stock to run this auction', 409, { cause: err.message })
  }
  await client.query('UPDATE auctions SET stock_reserved = TRUE WHERE id = $1', [a.id])
  a.stock_reserved = true
}

export async function releaseStock(client, a) {
  if (!a.stock_reserved) return
  await stockRepo.applyStockChange(client, {
    shopProductId: a.shop_product_id, delta: 1, type: 'CANCELLATION_RESTORE', source: 'API',
    reason: `Released from auction ${a.auction_number}`, metadata: { auction_id: a.id },
  })
  await client.query('UPDATE auctions SET stock_reserved = FALSE WHERE id = $1', [a.id])
  a.stock_reserved = false
}

// ── fee ledger & wallet movements ───────────────────────────────────────

async function ledger(client, a, reg, entryType, paise, reason) {
  if (paise <= 0) return
  await client.query(
    `INSERT INTO auction_fee_ledger (auction_id, registration_id, user_id, vendor_id, entry_type, amount, reason, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [a.id, reg.id, reg.user_id, a.vendor_id, entryType, fromPaise(paise), reason, `reg:${reg.id}:${entryType}`]
  )
}

async function creditWallet(client, userId, paise, description, refId, regId) {
  await client.query('INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING', [userId])
  const wallet = await walletRepo.getForUpdate(client, userId)
  await walletRepo.credit(client, wallet.id, fromPaise(paise), description, refId, { subType: 'AUCTION_REFUND', sourceId: regId })
}

async function lockActiveRegistrations(client, auctionId) {
  const { rows } = await client.query(
    `SELECT * FROM auction_registrations WHERE auction_id = $1 AND status = 'ACTIVE' ORDER BY user_id FOR UPDATE`,
    [auctionId]
  )
  return rows
}

/** Return the whole fee to the bidder's wallet. */
async function refundRegistration(client, a, reg, reason) {
  const fee = toPaise(reg.fee_amount)
  if (fee > 0) {
    await creditWallet(client, reg.user_id, fee, `Auction ${a.auction_number}: ${reason}`, `auction:${a.id}`, reg.id)
    await ledger(client, a, reg, 'FEE_REFUNDED', fee, reason)
  }
  await client.query(
    `UPDATE auction_registrations SET status = 'REFUNDED', refund_amount = $2, settled_at = NOW() WHERE id = $1`,
    [reg.id, fromPaise(fee)]
  )
}

/** Fee is applied as the winner's discount — no wallet movement. */
async function applyRegistration(client, a, reg) {
  await ledger(client, a, reg, 'FEE_APPLIED_TO_ORDER', toPaise(reg.fee_amount), 'Applied as discount on winning order')
  await client.query(`UPDATE auction_registrations SET status = 'APPLIED', settled_at = NOW() WHERE id = $1`, [reg.id])
}

/**
 * Forfeit a fee: optional % back to the bidder, the rest split vendor/platform.
 * `penalty` (defaulting winner) never gets a refund.
 */
async function forfeitRegistration(client, a, reg, { penalty = false } = {}) {
  const fee = toPaise(reg.fee_amount)
  const split = splitForfeitedFee(fee, {
    refundPct: penalty ? 0 : Number(a.loser_fee_refund_pct),
    vendorSharePct: Number(a.fee_vendor_share_pct),
    hasVendor: !!a.vendor_id,
  })
  if (split.refund > 0) {
    await creditWallet(client, reg.user_id, split.refund, `Auction ${a.auction_number}: partial fee refund`, `auction:${a.id}`, reg.id)
    await ledger(client, a, reg, 'FEE_REFUNDED', split.refund, 'Partial refund of registration fee')
  }
  if (split.vendor > 0) {
    await ledger(client, a, reg, 'FEE_FORFEIT_VENDOR', split.vendor, penalty ? 'Winner default penalty — vendor share' : 'Forfeited fee — vendor share')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`settle:${a.vendor_id}`])
    const { rows } = await client.query('SELECT COALESCE(SUM(amount),0) AS bal FROM settlement_ledger WHERE vendor_id = $1', [a.vendor_id])
    const amount = fromPaise(split.vendor)
    await client.query(
      `INSERT INTO settlement_ledger (vendor_id, entry_type, amount, balance_after, reason, idempotency_key)
       VALUES ($1, 'INCENTIVE', $2, $3, $4, $5) ON CONFLICT (idempotency_key) DO NOTHING`,
      [a.vendor_id, amount, Number((Number(rows[0].bal) + amount).toFixed(2)),
        `Auction ${a.auction_number} entry-fee share`, `auc:${reg.id}:vshare`]
    )
  }
  if (split.platform > 0) {
    await ledger(client, a, reg, 'FEE_FORFEIT_PLATFORM', split.platform, penalty ? 'Winner default penalty — platform share' : 'Forfeited fee — platform share')
  }
  await client.query(
    `UPDATE auction_registrations
        SET status = $2, refund_amount = $3, forfeited_amount = $4, settled_at = NOW()
      WHERE id = $1`,
    [reg.id, split.forfeited > 0 ? 'FORFEITED' : 'REFUNDED', fromPaise(split.refund), fromPaise(split.forfeited)]
  )
}

async function refundAllActive(client, a, reason) {
  for (const reg of await lockActiveRegistrations(client, a.id)) await refundRegistration(client, a, reg, reason)
}

// ── strikes ─────────────────────────────────────────────────────────────

async function addStrike(client, userId, settings, reason) {
  const { rows } = await client.query(
    `INSERT INTO auction_bidder_profiles (user_id, strikes) VALUES ($1, 1)
     ON CONFLICT (user_id) DO UPDATE SET strikes = auction_bidder_profiles.strikes + 1, updated_at = NOW()
     RETURNING strikes`,
    [userId]
  )
  if (rows[0].strikes >= settings.strike_limit) {
    await client.query(
      `UPDATE auction_bidder_profiles
          SET is_blocked = TRUE, blocked_reason = $2, blocked_at = NOW(), updated_at = NOW()
        WHERE user_id = $1 AND is_blocked = FALSE`,
      [userId, `Auto-blocked after ${rows[0].strikes} unpaid auction wins`]
    )
  }
  return rows[0].strikes
}

// ── terminal transitions (caller holds the auction lock) ────────────────

/** Winner has paid in full: release escrow. */
export async function settleAsSold(client, a, post) {
  const regs = await lockActiveRegistrations(client, a.id)
  for (const reg of regs) {
    if (reg.user_id === a.winner_id) await applyRegistration(client, a, reg)
    else await forfeitRegistration(client, a, reg)
  }
  await client.query(`UPDATE auctions SET status = 'SOLD', settled_at = NOW(), updated_at = NOW() WHERE id = $1`, [a.id])
  a.status = 'SOLD'
  await logEvent(client, a.id, 'SOLD', {}, { winner_id: a.winner_id, winning_bid: Number(a.winning_bid), losers_settled: regs.length - 1 })
  post.push(() => broadcastState(a))
}

/** Cancel / unsold / defaulted-with-no-successor: everyone gets their fee back. */
async function settleAsRefunded(client, a, status, reason, post, extra = {}) {
  await refundAllActive(client, a, reason)
  await releaseStock(client, a)
  await client.query(
    `UPDATE auctions SET status = $2, settled_at = NOW(), ended_at = COALESCE(ended_at, NOW()), updated_at = NOW(),
            cancelled_reason = COALESCE($3, cancelled_reason) WHERE id = $1`,
    [a.id, status, extra.cancelledReason || null]
  )
  a.status = status
  post.push(() => broadcastState(a))
}

// ── start ───────────────────────────────────────────────────────────────

async function activateLocked(client, a, post, actor = {}) {
  if (a.status !== 'SCHEDULED') return false
  const now = await dbNow(client)
  if (new Date(a.ends_at) <= now) {
    // the whole window was missed (e.g. worker was down) — close it out immediately
    await client.query(`UPDATE auctions SET status = 'LIVE', updated_at = NOW() WHERE id = $1`, [a.id])
    a.status = 'LIVE'
    await closeLocked(client, a, post)
    return true
  }
  await client.query(`UPDATE auctions SET status = 'LIVE', updated_at = NOW() WHERE id = $1`, [a.id])
  a.status = 'LIVE'
  await logEvent(client, a.id, 'STARTED', actor, {})
  post.push(async () => {
    await broadcastState(a)
    await emitToRoom('hq:global', 'auction:admin_event', { type: 'STARTED', auction_id: a.id, auction_number: a.auction_number })
    const { rows } = await query('SELECT user_id FROM auction_watchers WHERE auction_id = $1', [a.id])
    for (const r of rows) {
      await notifyUser(r.user_id, {
        title: 'Auction is live', body: `${a.title} — bidding has started.`,
        data: { event: 'auction:started', auction_id: a.id },
      })
    }
  })
  return true
}

export async function startAuctionNow(auctionId, actor) {
  return withTx(async (client, post) => {
    const a = await lockAuction(client, auctionId)
    if (!a) throw new AuctionError('NOT_FOUND', 'Auction not found', 404)
    if (a.status !== 'SCHEDULED') throw new AuctionError('INVALID_STATE', `Cannot start an auction that is ${a.status}`, 409)
    const now = await dbNow(client)
    await client.query('UPDATE auctions SET starts_at = LEAST(starts_at, $2) WHERE id = $1', [a.id, now])
    a.starts_at = now
    await activateLocked(client, a, post, actor)
    return a
  })
}

export async function startDueAuctions() {
  const { rows } = await query(`SELECT id FROM auctions WHERE status = 'SCHEDULED' AND starts_at <= NOW() ORDER BY starts_at LIMIT 50`)
  let started = 0
  for (const { id } of rows) {
    try {
      await withTx(async (client, post) => {
        const a = await lockAuction(client, id, { skipLocked: true })
        if (a && a.status === 'SCHEDULED' && new Date(a.starts_at) <= new Date()) {
          if (await activateLocked(client, a, post)) started += 1
        }
      })
    } catch (err) {
      logger.error({ err: err.message, auctionId: id }, 'auction start failed')
    }
  }
  return started
}

// ── close ───────────────────────────────────────────────────────────────

async function notifyAfterClose(a, outcome) {
  const { rows } = await query(
    `SELECT r.user_id, r.bidder_no FROM auction_registrations r WHERE r.auction_id = $1`, [a.id]
  )
  for (const r of rows) {
    if (outcome.type === 'WON' && r.user_id === a.winner_id) {
      await notifyUser(r.user_id, {
        title: '🎉 You won the auction!',
        body: `${a.title} is yours at ${rupees(a.winning_bid)}. Pay ${rupees(a.amount_due)} (your ${rupees(a.fee_credit)} fee is already deducted) before the deadline.`,
        data: { event: 'auction:won', auction_id: a.id, amount_due: Number(a.amount_due), payment_deadline: a.payment_deadline },
      })
    } else if (outcome.type === 'WON') {
      await notifyUser(r.user_id, {
        title: 'Auction ended', body: `${a.title} was won by ${aliasOf(outcome.winnerNo)} at ${rupees(a.winning_bid)}.`,
        data: { event: 'auction:ended', auction_id: a.id },
      })
    } else {
      await notifyUser(r.user_id, {
        title: 'Auction ended without a sale',
        body: `${a.title} did not sell${outcome.reason === 'RESERVE_NOT_MET' ? ' (reserve not met)' : ''}. Your registration fee has been refunded to your wallet.`,
        data: { event: 'auction:ended', auction_id: a.id },
      })
    }
  }
}

/** Close a LIVE/PAUSED auction whose lock the caller holds. */
export async function closeLocked(client, a, post) {
  if (!['LIVE', 'PAUSED'].includes(a.status)) return null
  const settings = await getSettings(client)
  const verdict = resolveClose({
    bidCount: Number(a.bid_count), leaderId: a.leader_id,
    currentPrice: toPaise(a.current_price),
    reservePrice: a.reserve_price == null ? null : toPaise(a.reserve_price),
  })

  if (verdict.outcome === 'UNSOLD') {
    await client.query(`UPDATE auctions SET ended_at = NOW() WHERE id = $1`, [a.id])
    await settleAsRefunded(client, a, 'UNSOLD', 'auction ended without a sale', post)
    await logEvent(client, a.id, 'ENDED_UNSOLD', {}, { reason: verdict.reason })
    post.push(async () => {
      await emitToRoom(`auction:${a.id}`, 'auction:ended', { id: a.id, status: 'UNSOLD', reason: verdict.reason })
      await emitToRoom('hq:global', 'auction:admin_event', { type: 'ENDED_UNSOLD', auction_id: a.id, auction_number: a.auction_number })
      await notifyAfterClose(a, { type: 'UNSOLD', reason: verdict.reason })
    })
    return { outcome: 'UNSOLD', reason: verdict.reason }
  }

  // WON
  const { rows: regRows } = await client.query(
    `SELECT * FROM auction_registrations WHERE auction_id = $1 AND user_id = $2`, [a.id, a.leader_id]
  )
  const winnerReg = regRows[0]
  const winningBid = toPaise(a.current_price)
  const { feeCredit, amountDue } = winnerAmountDue(winningBid, toPaise(winnerReg.fee_amount))
  const deadline = new Date((await dbNow(client)).getTime() + Number(a.payment_window_hours) * 3600_000)
  await client.query(
    `UPDATE auctions
        SET status = 'AWAITING_PAYMENT', winner_id = leader_id, winning_bid = $2, fee_credit = $3, amount_due = $4,
            offer_round = 1, payment_deadline = $5, ended_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [a.id, fromPaise(winningBid), fromPaise(feeCredit), fromPaise(amountDue), deadline]
  )
  Object.assign(a, {
    status: 'AWAITING_PAYMENT', winner_id: a.leader_id, winning_bid: fromPaise(winningBid),
    fee_credit: fromPaise(feeCredit), amount_due: fromPaise(amountDue), offer_round: 1, payment_deadline: deadline,
  })
  await logEvent(client, a.id, 'ENDED_WON', {}, {
    winner_id: a.winner_id, winning_bid: Number(a.winning_bid), amount_due: Number(a.amount_due), payment_deadline: deadline,
  })
  void settings
  post.push(async () => {
    await emitToRoom(`auction:${a.id}`, 'auction:ended', {
      id: a.id, status: 'AWAITING_PAYMENT', final_price: Number(a.winning_bid), winner_alias: aliasOf(winnerReg.bidder_no),
    })
    await emitToRoom('hq:global', 'auction:admin_event', { type: 'ENDED_WON', auction_id: a.id, auction_number: a.auction_number })
    await notifyAfterClose(a, { type: 'WON', winnerNo: winnerReg.bidder_no })
  })
  return { outcome: 'WON', winnerId: a.winner_id }
}

export async function closeEndedAuctions() {
  const { rows } = await query(`SELECT id FROM auctions WHERE status = 'LIVE' AND ends_at <= NOW() ORDER BY ends_at LIMIT 50`)
  let closed = 0
  for (const { id } of rows) {
    try {
      await withTx(async (client, post) => {
        const a = await lockAuction(client, id, { skipLocked: true })
        // re-check under the lock: a late bid may have extended the end time
        if (a && a.status === 'LIVE' && new Date(a.ends_at) <= (await dbNow(client))) {
          if (await closeLocked(client, a, post)) closed += 1
        }
      })
    } catch (err) {
      logger.error({ err: err.message, auctionId: id }, 'auction close failed')
    }
  }
  return closed
}

export async function endAuctionNow(auctionId, actor) {
  return withTx(async (client, post) => {
    const a = await lockAuction(client, auctionId)
    if (!a) throw new AuctionError('NOT_FOUND', 'Auction not found', 404)
    if (!['LIVE', 'PAUSED'].includes(a.status)) throw new AuctionError('INVALID_STATE', `Cannot end an auction that is ${a.status}`, 409)
    await client.query(`UPDATE auctions SET ends_at = LEAST(ends_at, NOW()), paused_at = NULL WHERE id = $1`, [a.id])
    await logEvent(client, a.id, 'ENDED_EARLY', actor, {})
    return closeLocked(client, a, post)
  })
}

// ── cancel ──────────────────────────────────────────────────────────────

export async function cancelAuction(auctionId, actor, reason, { allowWhen } = {}) {
  return withTx(async (client, post) => {
    const a = await lockAuction(client, auctionId)
    if (!a) throw new AuctionError('NOT_FOUND', 'Auction not found', 404)
    if (['SOLD', 'UNSOLD', 'CANCELLED', 'DEFAULTED'].includes(a.status)) {
      throw new AuctionError('INVALID_STATE', `Auction is already ${a.status}`, 409)
    }
    if (allowWhen && !allowWhen(a)) throw new AuctionError('NOT_ALLOWED', 'You cannot cancel this auction in its current state', 403)
    if (a.status === 'AWAITING_PAYMENT' && a.order_id) {
      throw new AuctionError('ORDER_EXISTS', 'The winner already has an order — cancel that order instead', 409)
    }
    await settleAsRefunded(client, a, 'CANCELLED', 'auction cancelled', post, { cancelledReason: reason || 'Cancelled' })
    await logEvent(client, a.id, 'CANCELLED', actor, { reason })
    post.push(async () => {
      await emitToRoom(`auction:${a.id}`, 'auction:ended', { id: a.id, status: 'CANCELLED' })
      const { rows } = await query('SELECT user_id FROM auction_registrations WHERE auction_id = $1', [a.id])
      for (const r of rows) {
        await notifyUser(r.user_id, {
          title: 'Auction cancelled', body: `${a.title} was cancelled. Your registration fee has been refunded to your wallet.`,
          data: { event: 'auction:ended', auction_id: a.id },
        })
      }
    })
    return a
  })
}

// ── winner paid / defaulted ─────────────────────────────────────────────

export async function onWinnerPaid(client, a, post) {
  if (a.status !== 'AWAITING_PAYMENT') return
  await settleAsSold(client, a, post)
  post.push(() => notifyUser(a.winner_id, {
    title: 'Payment received', body: `Your order for ${a.title} is confirmed.`,
    data: { event: 'auction:paid', auction_id: a.id, order_id: a.order_id },
  }))
}

async function orderState(client, orderId) {
  if (!orderId) return null
  const { rows } = await client.query('SELECT status, payment_status FROM orders WHERE id = $1', [orderId])
  return rows[0] || null
}

const orderIsPaid = (o) => o && String(o.payment_status).toUpperCase() === 'PAID' && String(o.status).toUpperCase() !== 'CANCELLED'
const orderIsDead = (o) => !o || String(o.status).toUpperCase() === 'CANCELLED' || ['FAILED', 'EXPIRED'].includes(String(o.payment_status).toUpperCase())

/** The current winner missed the deadline: penalise, then offer to the next bidder or give up. */
async function defaultLocked(client, a, post) {
  const settings = await getSettings(client)
  const regs = await client.query(
    `SELECT * FROM auction_registrations WHERE auction_id = $1 ORDER BY user_id FOR UPDATE`, [a.id]
  ).then((r) => r.rows)
  const defaulter = regs.find((r) => r.user_id === a.winner_id)
  if (defaulter && defaulter.status === 'ACTIVE') await forfeitRegistration(client, a, defaulter, { penalty: true })
  const strikes = await addStrike(client, a.winner_id, settings, 'unpaid auction win')
  const declined = [...(a.declined_winners || []), a.winner_id]
  await logEvent(client, a.id, 'WINNER_DEFAULTED', {}, { user_id: a.winner_id, strikes, round: a.offer_round })
  post.push(() => notifyUser(a.winner_id, {
    title: 'Auction payment missed',
    body: `You did not pay for ${a.title} in time. Your registration fee was forfeited.`,
    data: { event: 'auction:defaulted', auction_id: a.id },
  }))

  // next bidder, at their own highest bid
  const candidates = regs
    .filter((r) => r.status === 'ACTIVE' && r.highest_bid != null)
    .map((r) => ({ userId: r.user_id, highestBid: toPaise(r.highest_bid), firstBidAt: new Date(r.created_at).getTime(), reg: r }))
  const reservePaise = a.reserve_price == null ? null : toPaise(a.reserve_price)
  const next = a.offer_round < Number(a.max_offer_rounds) ? pickSecondChance(candidates, declined, reservePaise) : null

  if (!next) {
    await client.query(`UPDATE auctions SET declined_winners = $2, order_id = NULL WHERE id = $1`, [a.id, declined])
    await settleAsRefunded(client, a, 'DEFAULTED', 'winner did not pay and no other eligible bidder', post)
    await logEvent(client, a.id, 'DEFAULTED', {}, { declined })
    post.push(() => emitToRoom(`auction:${a.id}`, 'auction:ended', { id: a.id, status: 'DEFAULTED' }))
    return 'DEFAULTED'
  }

  const nextReg = candidates.find((c) => c.userId === next.userId).reg
  const { feeCredit, amountDue } = winnerAmountDue(next.price, toPaise(nextReg.fee_amount))
  const deadline = new Date((await dbNow(client)).getTime() + Number(a.payment_window_hours) * 3600_000)
  await client.query(
    `UPDATE auctions
        SET winner_id = $2, winning_bid = $3, fee_credit = $4, amount_due = $5, offer_round = offer_round + 1,
            declined_winners = $6, payment_deadline = $7, order_id = NULL, updated_at = NOW()
      WHERE id = $1`,
    [a.id, next.userId, fromPaise(next.price), fromPaise(feeCredit), fromPaise(amountDue), declined, deadline]
  )
  Object.assign(a, {
    winner_id: next.userId, winning_bid: fromPaise(next.price), fee_credit: fromPaise(feeCredit),
    amount_due: fromPaise(amountDue), offer_round: a.offer_round + 1, payment_deadline: deadline, order_id: null,
  })
  await logEvent(client, a.id, 'SECOND_CHANCE_OFFERED', {}, { user_id: next.userId, price: Number(a.winning_bid), round: a.offer_round })
  post.push(() => notifyUser(next.userId, {
    title: 'Second chance to buy',
    body: `${a.title} is available to you at your bid of ${rupees(a.winning_bid)}. Pay ${rupees(a.amount_due)} before the deadline.`,
    data: { event: 'auction:won', auction_id: a.id, amount_due: Number(a.amount_due), payment_deadline: deadline },
  }))
  return 'SECOND_CHANCE'
}

/**
 * Sweep AWAITING_PAYMENT auctions:
 *  1. an order that became PAID  → SOLD
 *  2. an order that died         → free the slot so the winner can retry
 *  3. deadline passed, no live payment → default / second chance
 */
export async function processPaymentDeadlines() {
  const { rows } = await query(`SELECT id FROM auctions WHERE status = 'AWAITING_PAYMENT' ORDER BY payment_deadline LIMIT 100`)
  const result = { sold: 0, released: 0, defaulted: 0 }
  for (const { id } of rows) {
    try {
      await withTx(async (client, post) => {
        const a = await lockAuction(client, id, { skipLocked: true })
        if (!a || a.status !== 'AWAITING_PAYMENT') return
        const order = await orderState(client, a.order_id)

        if (a.order_id && orderIsPaid(order)) {
          await onWinnerPaid(client, a, post)
          result.sold += 1
          return
        }
        if (a.order_id && orderIsDead(order)) {
          // the online payment window lapsed and the order was cancelled (which restored the unit):
          // take the unit back off sale and let the winner try again, if there is still time.
          await client.query('UPDATE auctions SET order_id = NULL, stock_reserved = FALSE WHERE id = $1', [a.id])
          a.order_id = null
          a.stock_reserved = false
          try {
            await reserveStock(client, a)
          } catch (err) {
            await settleAsRefunded(client, a, 'CANCELLED', 'item no longer available', post, { cancelledReason: 'Stock no longer available after order expiry' })
            await logEvent(client, a.id, 'CANCELLED', {}, { reason: 'STOCK_UNAVAILABLE_AFTER_ORDER_EXPIRY' })
            return
          }
          result.released += 1
        }
        if (new Date(a.payment_deadline) <= (await dbNow(client)) && !a.order_id) {
          await defaultLocked(client, a, post)
          result.defaulted += 1
        }
      })
    } catch (err) {
      logger.error({ err: err.message, auctionId: id }, 'auction payment sweep failed')
    }
  }
  return result
}

/** One-shot reminders: ending soon (watchers) and payment due soon (winner). */
export async function sendReminders() {
  const { rows: ending } = await query(
    `SELECT a.id, a.title, a.ends_at, w.user_id
       FROM auctions a JOIN auction_watchers w ON w.auction_id = a.id
      WHERE a.status = 'LIVE' AND a.ends_at <= NOW() + INTERVAL '15 minutes' AND w.ending_soon_notified = FALSE
      LIMIT 500`
  )
  for (const r of ending) {
    await query('UPDATE auction_watchers SET ending_soon_notified = TRUE WHERE auction_id = $1 AND user_id = $2', [r.id, r.user_id])
    await notifyUser(r.user_id, {
      title: 'Auction ending soon', body: `${r.title} ends in under 15 minutes.`,
      data: { event: 'auction:ending_soon', auction_id: r.id },
    })
  }
  return ending.length
}

/** Everything the worker runs on its beat. */
export async function tick({ slow = false } = {}) {
  const out = { started: await startDueAuctions(), closed: await closeEndedAuctions() }
  if (slow) {
    out.payments = await processPaymentDeadlines()
    out.reminders = await sendReminders()
  }
  return out
}
