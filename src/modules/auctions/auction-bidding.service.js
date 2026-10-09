/**
 * Customer-side auction operations: browse, register (pay the entry fee),
 * bid, buy-now, watch.
 *
 * Concurrency: every mutation runs in ONE transaction that first locks the
 * auction row (`SELECT … FOR UPDATE`), so bids on the same auction are fully
 * serialised and the engine always sees the true current state. Different
 * auctions never block each other.
 *
 * @module modules/auctions/auction-bidding.service
 */

import crypto from 'node:crypto'
import { query } from '../../config/database.js'
import { redis } from '../../config/redis.js'
import { logger } from '../../config/logger.js'
import { WalletRepository } from '../wallet/wallet.repository.js'
import { applyBid, applyBuyNow, fromPaise, minNextBid, toPaise } from './auction-engine.js'
import {
  AuctionError, aliasOf, broadcastState, emitToRoom, getSettings, logEvent, notifyUser, rupees,
  serializePublic, toEngineCfg, toEngineState,
} from './auction.shared.js'
import { closeLocked, lockAuction, withTx } from './auction-settlement.service.js'

const walletRepo = new WalletRepository()
const PUBLIC_STATUSES = ['SCHEDULED', 'LIVE', 'PAUSED', 'AWAITING_PAYMENT', 'SOLD', 'UNSOLD', 'DEFAULTED', 'CANCELLED']

const dbNow = async (client) => (await client.query('SELECT clock_timestamp() AS now')).rows[0].now

// ── eligibility ─────────────────────────────────────────────────────────

async function assertEligible(client, userId, a, settings) {
  if (!settings.enabled) throw new AuctionError('AUCTIONS_DISABLED', 'Auctions are currently unavailable', 403)

  const { rows: users } = await client.query(
    `SELECT id, role, is_active, is_blocked, platform_role FROM users WHERE id = $1`, [userId]
  )
  const u = users[0]
  if (!u || u.is_active === false || u.is_blocked) throw new AuctionError('ACCOUNT_RESTRICTED', 'Your account cannot take part in auctions', 403)

  // A vendor bidder = a user linked to an active, verified vendor. B2B auctions are for them only;
  // B2C auctions are for customers only.
  const { rows: links } = await client.query(
    `SELECT vu.vendor_id, v.status FROM vendor_users vu JOIN vendors v ON v.id = vu.vendor_id
      WHERE vu.user_id = $1 AND vu.is_active = TRUE AND vu.deleted_at IS NULL AND v.deleted_at IS NULL`, [userId])
  const verified = links.filter((l) => ['VERIFIED', 'ACTIVE'].includes(l.status))
  if (a.audience === 'B2B') {
    if (u.platform_role) throw new AuctionError('STAFF_CANNOT_BID', 'Staff accounts cannot take part in auctions', 403)
    if (!verified.length) throw new AuctionError('VENDORS_ONLY', 'This is a business (B2B) auction for verified vendors only', 403)
    if (a.eligible_vendor_ids?.length && !verified.some((l) => a.eligible_vendor_ids.includes(l.vendor_id))) {
      throw new AuctionError('NOT_INVITED', 'This business auction is by invitation only', 403)
    }
  } else {
    if (u.role !== 'CUSTOMER' || u.platform_role) {
      throw new AuctionError('STAFF_CANNOT_BID', 'Staff accounts cannot take part in auctions', 403)
    }
  }

  const { rows: prof } = await client.query('SELECT is_blocked, blocked_reason FROM auction_bidder_profiles WHERE user_id = $1', [userId])
  if (prof[0]?.is_blocked) throw new AuctionError('BIDDER_BLOCKED', 'You are not able to take part in auctions. Contact support.', 403)

  if (a.vendor_id) {
    const { rows } = await client.query(
      `SELECT 1 FROM vendor_users WHERE vendor_id = $1 AND user_id = $2 AND is_active = TRUE AND deleted_at IS NULL LIMIT 1`,
      [a.vendor_id, userId]
    )
    if (rows[0]) throw new AuctionError('OWN_AUCTION', 'You cannot bid on your own auction', 403)
  }
  if (a.created_by === userId) throw new AuctionError('OWN_AUCTION', 'You cannot bid on your own auction', 403)
  if (a.audience !== 'B2B' && links.length) {
    throw new AuctionError('CUSTOMERS_ONLY', 'This auction is for customers. Vendors can bid in business (B2B) auctions.', 403)
  }

  if (settings.blocked_states?.length) {
    const { rows } = await client.query(
      `SELECT lower(state) AS state FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC LIMIT 1`, [userId]
    )
    const st = rows[0]?.state
    if (st && settings.blocked_states.map((s) => String(s).toLowerCase()).includes(st)) {
      throw new AuctionError('REGION_RESTRICTED', 'Auctions are not available in your region', 403)
    }
  }
}

async function enforceRateLimit(userId, settings) {
  try {
    const key = `auction:bidrate:${userId}`
    const n = await redis.incr(key)
    if (n === 1) await redis.expire(key, 60)
    if (n > Number(settings.bid_rate_limit_per_minute)) {
      throw new AuctionError('RATE_LIMITED', 'You are bidding too fast — please slow down', 429)
    }
  } catch (err) {
    if (err instanceof AuctionError) throw err
    logger.warn({ err: err.message }, 'auction rate limiter unavailable — failing open')
  }
}

// ── hydration (batch the per-viewer extras) ─────────────────────────────

async function hydrate(rows, userId) {
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const [regs, watch, nos] = await Promise.all([
    query('SELECT * FROM auction_registrations WHERE user_id = $1 AND auction_id = ANY($2)', [userId, ids]),
    query('SELECT auction_id FROM auction_watchers WHERE user_id = $1 AND auction_id = ANY($2)', [userId, ids]),
    query(
      `SELECT r.auction_id, r.user_id, r.bidder_no FROM auction_registrations r
         JOIN auctions a ON a.id = r.auction_id AND (r.user_id = a.leader_id OR r.user_id = a.winner_id)
        WHERE a.id = ANY($1)`, [ids]
    ),
  ])
  const myReg = new Map(regs.rows.map((r) => [r.auction_id, r]))
  const watching = new Set(watch.rows.map((r) => r.auction_id))
  const noOf = new Map(nos.rows.map((r) => [`${r.auction_id}:${r.user_id}`, r.bidder_no]))
  return rows.map((a) => serializePublic(a, {
    my: myReg.get(a.id) || null,
    watching: watching.has(a.id),
    leaderBidderNo: a.leader_id ? noOf.get(`${a.id}:${a.leader_id}`) : null,
    winnerBidderNo: a.winner_id ? noOf.get(`${a.id}:${a.winner_id}`) : null,
  }))
}

// ── browse ──────────────────────────────────────────────────────────────

/** Vendor accounts see business (B2B) auctions; everyone else sees customer (B2C) auctions. */
async function audienceFor(userId) {
  if (!userId) return 'B2C'
  const { rows } = await query(
    `SELECT 1 FROM vendor_users vu JOIN vendors v ON v.id = vu.vendor_id
      WHERE vu.user_id = $1 AND vu.is_active = TRUE AND vu.deleted_at IS NULL AND v.deleted_at IS NULL AND v.status IN ('VERIFIED','ACTIVE') LIMIT 1`, [userId])
  return rows[0] ? 'B2B' : 'B2C'
}

export async function listPublic(userId, { tab = 'live', q = '', categoryId = null, page = 1, limit = 20 } = {}) {
  const where = []
  const params = []
  let order = 'a.ends_at ASC'
  params.push(await audienceFor(userId)); where.push(`a.audience = $${params.length}`)
  if (tab === 'upcoming') { where.push(`a.status = 'SCHEDULED'`); order = 'a.starts_at ASC' }
  else if (tab === 'ended') {
    where.push(`a.status IN ('AWAITING_PAYMENT','SOLD','UNSOLD') AND a.ended_at > NOW() - INTERVAL '7 days'`)
    order = 'a.ended_at DESC'
  } else where.push(`a.status IN ('LIVE','PAUSED')`)
  if (q) { params.push(`%${q}%`); where.push(`a.title ILIKE $${params.length}`) }
  if (categoryId) {
    params.push(categoryId)
    where.push(`EXISTS (SELECT 1 FROM products p WHERE p.id = a.product_id AND p.category_id = $${params.length})`)
  }
  const offset = (Math.max(1, page) - 1) * limit
  params.push(limit, offset)
  const sql = `SELECT a.*, v.name AS seller_name FROM auctions a LEFT JOIN vendors v ON v.id = a.vendor_id
                WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`
  const countSql = `SELECT COUNT(*)::int AS n FROM auctions a WHERE ${where.join(' AND ')}`
  const [rows, count] = await Promise.all([query(sql, params), query(countSql, params.slice(0, -2))])
  return {
    success: true,
    data: await hydrate(rows.rows, userId),
    pagination: { page, limit, total: count.rows[0].n },
    server_time: new Date().toISOString(),
  }
}

export async function getPublic(userId, auctionId) {
  const { rows } = await query(
    `SELECT a.*, v.name AS seller_name FROM auctions a LEFT JOIN vendors v ON v.id = a.vendor_id WHERE a.id = $1`, [auctionId]
  )
  const a = rows[0]
  if (!a || !PUBLIC_STATUSES.includes(a.status)) throw new AuctionError('NOT_FOUND', 'Auction not found', 404)
  if (a.audience !== (await audienceFor(userId))) throw new AuctionError('NOT_FOUND', 'Auction not found', 404)
  const [item] = await hydrate([a], userId)
  if (a.status === 'CANCELLED' && !item.my.registered) throw new AuctionError('NOT_FOUND', 'Auction not found', 404)
  return item
}

export async function listBids(userId, auctionId, { limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT b.seq, b.amount, b.bid_type, b.created_at, b.user_id, r.bidder_no
       FROM auction_bids b LEFT JOIN auction_registrations r ON r.id = b.registration_id
      WHERE b.auction_id = $1 ORDER BY b.seq DESC LIMIT $2`,
    [auctionId, Math.min(200, limit)]
  )
  return rows.map((b) => ({
    seq: Number(b.seq), amount: Number(b.amount), type: b.bid_type, at: b.created_at,
    alias: aliasOf(b.bidder_no), is_you: b.user_id === userId,
  }))
}

export async function mine(userId, { tab = 'active', page = 1, limit = 20 } = {}) {
  const cond = tab === 'won'
    ? `a.winner_id = $1 AND a.status IN ('AWAITING_PAYMENT','SOLD')`
    : tab === 'past'
      ? `a.status IN ('SOLD','UNSOLD','CANCELLED','DEFAULTED','AWAITING_PAYMENT')`
      : `a.status IN ('SCHEDULED','LIVE','PAUSED')`
  const { rows } = await query(
    `SELECT a.*, v.name AS seller_name FROM auctions a LEFT JOIN vendors v ON v.id = a.vendor_id
      WHERE ${cond} AND (a.winner_id = $1 OR EXISTS (SELECT 1 FROM auction_registrations r WHERE r.auction_id = a.id AND r.user_id = $1))
      ORDER BY COALESCE(a.ended_at, a.ends_at) DESC LIMIT $2 OFFSET $3`,
    [userId, limit, (Math.max(1, page) - 1) * limit]
  )
  return { success: true, data: await hydrate(rows, userId), server_time: new Date().toISOString() }
}

// ── register (pay the entry fee) ────────────────────────────────────────

export async function register(userId, auctionId, { consent, ip }) {
  if (consent !== true) throw new AuctionError('CONSENT_REQUIRED', 'You must accept the registration terms to join', 400)

  const out = await withTx(async (client, post) => {
    const a = await lockAuction(client, auctionId)
    if (!a || !PUBLIC_STATUSES.includes(a.status)) throw new AuctionError('NOT_FOUND', 'Auction not found', 404)
    const settings = await getSettings(client)
    if (!['SCHEDULED', 'LIVE'].includes(a.status)) throw new AuctionError('REGISTRATION_CLOSED', 'Registration is closed for this auction', 409)
    if (a.status === 'LIVE' && new Date(a.ends_at) <= (await dbNow(client))) {
      throw new AuctionError('REGISTRATION_CLOSED', 'This auction has ended', 409)
    }
    await assertEligible(client, userId, a, settings)

    const { rows: existing } = await client.query(
      'SELECT id FROM auction_registrations WHERE auction_id = $1 AND user_id = $2', [a.id, userId]
    )
    if (existing[0]) throw new AuctionError('ALREADY_REGISTERED', 'You are already registered for this auction', 409)

    const fee = toPaise(a.registration_fee)
    await client.query('INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING', [userId])
    const wallet = await walletRepo.getForUpdate(client, userId)
    if (fee > 0 && toPaise(wallet.balance) < fee) {
      throw new AuctionError('INSUFFICIENT_WALLET', 'Add money to your wallet to join this auction', 402, {
        required: fromPaise(fee), balance: Number(wallet.balance), shortfall: fromPaise(fee - toPaise(wallet.balance)),
      })
    }

    const regId = crypto.randomUUID()
    const bidderNo = Number(a.registration_count) + 1
    const { rows: [reg] } = await client.query(
      `INSERT INTO auction_registrations (id, auction_id, user_id, bidder_no, fee_amount, consented_at, consent_text_version, ip)
       VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7) RETURNING *`,
      [regId, a.id, userId, bidderNo, fromPaise(fee), settings.consent_text_version, ip || null]
    )
    let balanceAfter = Number(wallet.balance)
    if (fee > 0) {
      const debit = await walletRepo.debit(
        client, wallet.id, fromPaise(fee), `Auction ${a.auction_number}: registration fee`, `auction:${a.id}`,
        { subType: 'AUCTION_FEE', sourceId: regId }
      )
      balanceAfter = Number(debit.wallet.balance)
      await client.query(
        `INSERT INTO auction_fee_ledger (auction_id, registration_id, user_id, vendor_id, entry_type, amount, reason, idempotency_key)
         VALUES ($1,$2,$3,$4,'FEE_CHARGED',$5,'Registration fee charged',$6)`,
        [a.id, regId, userId, a.vendor_id, fromPaise(fee), `reg:${regId}:FEE_CHARGED`]
      )
    }
    await client.query('UPDATE auctions SET registration_count = registration_count + 1, version = version + 1 WHERE id = $1', [a.id])
    a.registration_count = bidderNo
    await client.query(
      'INSERT INTO auction_watchers (auction_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [a.id, userId]
    )
    await logEvent(client, a.id, 'REGISTERED', { userId, kind: 'CUSTOMER' }, { bidder_no: bidderNo, fee: fromPaise(fee) })
    post.push(() => broadcastState(a))
    return { registration: reg, wallet_balance: balanceAfter }
  })

  return {
    registered: true,
    bidder_no: out.registration.bidder_no,
    fee_paid: Number(out.registration.fee_amount),
    wallet_balance: out.wallet_balance,
  }
}

// ── bidding ─────────────────────────────────────────────────────────────

async function persistRows(client, a, result, actorReg, ctx) {
  const regByUser = new Map([[actorReg.user_id, actorReg]])
  for (const row of result.rows) {
    if (!regByUser.has(row.userId)) {
      const { rows } = await client.query('SELECT * FROM auction_registrations WHERE auction_id = $1 AND user_id = $2', [a.id, row.userId])
      regByUser.set(row.userId, rows[0])
    }
  }
  let seq = Number(a.bid_seq)
  const stored = []
  for (let i = 0; i < result.rows.length; i++) {
    const row = result.rows[i]
    seq += 1
    const reg = regByUser.get(row.userId)
    const isActor = row.userId === actorReg.user_id
    const leading = i === result.rows.length - 1 && row.userId === result.state.leaderId
    await client.query(
      `INSERT INTO auction_bids (auction_id, user_id, registration_id, seq, amount, max_amount, bid_type, is_leading, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [a.id, row.userId, reg?.id || null, seq, fromPaise(row.amount), fromPaise(row.maxAmount), row.type, leading,
        isActor && row.type !== 'AUTO' ? ctx.ip || null : null, isActor && row.type !== 'AUTO' ? ctx.userAgent || null : null]
    )
    stored.push({ seq, amount: fromPaise(row.amount), type: row.type, alias: aliasOf(reg?.bidder_no), userId: row.userId })
  }
  return { regByUser, stored, lastSeq: seq }
}

export async function placeBid(userId, auctionId, { maxAmount, ip, userAgent }) {
  const amount = Number(maxAmount)
  if (!Number.isFinite(amount) || amount <= 0) throw new AuctionError('INVALID_AMOUNT', 'Enter a valid bid amount', 400)
  const settings = await getSettings()
  await enforceRateLimit(userId, settings)

  const out = await withTx(async (client, post) => {
    const a = await lockAuction(client, auctionId)
    if (!a || !PUBLIC_STATUSES.includes(a.status)) throw new AuctionError('NOT_FOUND', 'Auction not found', 404)
    if (a.status !== 'LIVE') throw new AuctionError('NOT_LIVE', a.status === 'PAUSED' ? 'Bidding is paused' : 'This auction is not accepting bids', 409)
    const { rows: [reg] } = await client.query(
      `SELECT * FROM auction_registrations WHERE auction_id = $1 AND user_id = $2 FOR UPDATE`, [a.id, userId]
    )
    if (!reg || reg.status !== 'ACTIVE') throw new AuctionError('NOT_REGISTERED', 'Register for this auction before bidding', 403)
    await assertEligible(client, userId, a, await getSettings(client))

    const now = (await dbNow(client)).getTime()
    const result = applyBid(toEngineState(a), { userId, maxAmount: toPaise(amount) }, toEngineCfg(a), now)
    if (!result.ok) {
      throw new AuctionError(result.code, result.message, result.code === 'BIDDING_CLOSED' ? 409 : 422,
        result.minimum ? { minimum: fromPaise(result.minimum) } : {})
    }

    const { regByUser, stored, lastSeq } = await persistRows(client, a, result, reg, { ip, userAgent })
    const s = result.state
    const firstEverBid = Number(reg.bid_count) === 0
    await client.query(
      `UPDATE auctions
          SET current_price = $2, leader_id = $3, leader_max = $4, bid_count = $5, bidder_count = bidder_count + $6,
              bid_seq = $7, ends_at = $8, extension_count = $9, version = version + 1, updated_at = NOW()
        WHERE id = $1`,
      [a.id, fromPaise(s.currentPrice), s.leaderId, fromPaise(s.leaderMax), s.bidCount, firstEverBid ? 1 : 0,
        lastSeq, new Date(s.endsAt), s.extensionCount]
    )
    await client.query(
      `UPDATE auction_registrations
          SET highest_bid = GREATEST(COALESCE(highest_bid, 0), $2), bid_count = bid_count + 1, last_bid_at = NOW()
        WHERE id = $1`,
      [reg.id, amount]
    )
    // the displaced incumbent's proxy rode up to their ceiling
    for (const row of result.rows) {
      if (row.userId !== userId) {
        await client.query(
          `UPDATE auction_registrations SET highest_bid = GREATEST(COALESCE(highest_bid, 0), $2) WHERE auction_id = $1 AND user_id = $3`,
          [a.id, fromPaise(row.maxAmount), row.userId]
        )
      }
    }
    if (result.raisedOwnMax) {
      await logEvent(client, a.id, 'MAX_RAISED', { userId, kind: 'CUSTOMER' }, { new_max: amount })
    }
    if (result.extended) {
      await logEvent(client, a.id, 'EXTENDED', {}, { ends_at: new Date(s.endsAt), extension_count: s.extensionCount })
    }

    Object.assign(a, {
      current_price: fromPaise(s.currentPrice), leader_id: s.leaderId, leader_max: fromPaise(s.leaderMax),
      bid_count: s.bidCount, bidder_count: Number(a.bidder_count) + (firstEverBid ? 1 : 0),
      ends_at: new Date(s.endsAt), extension_count: s.extensionCount,
    })
    const leaderNo = regByUser.get(s.leaderId)?.bidder_no
      ?? (await client.query('SELECT bidder_no FROM auction_registrations WHERE auction_id=$1 AND user_id=$2', [a.id, s.leaderId])).rows[0]?.bidder_no

    post.push(async () => {
      await broadcastState(a, { leaderBidderNo: leaderNo })
      for (const b of stored) {
        await emitToRoom(`auction:${a.id}`, 'auction:bid', { seq: b.seq, amount: b.amount, type: b.type, alias: b.alias, at: new Date().toISOString() })
      }
      if (result.extended) await emitToRoom(`auction:${a.id}`, 'auction:extended', { id: a.id, ends_at: a.ends_at, extension_count: a.extension_count })
      if (result.outbidUserId) {
        await emitToRoom(`user:${result.outbidUserId}`, 'auction:outbid', {
          auction_id: a.id, title: a.title, current_price: Number(a.current_price),
          min_next_bid: fromPaise(minNextBid(toEngineState(a), toEngineCfg(a))),
        })
        // push/in-app at most once per 20s per user per auction so a bid war does not spam
        const throttled = await redis.set(`auction:outbidnote:${a.id}:${result.outbidUserId}`, '1', 'EX', 20, 'NX').catch(() => 'OK')
        if (throttled === 'OK') {
          await notifyUser(result.outbidUserId, {
            title: "You've been outbid",
            body: `${a.title} is now at ${rupees(a.current_price)}. Bid again to stay in.`,
            data: { event: 'auction:outbid_note', auction_id: a.id },
          })
        }
      }
    })

    return {
      accepted: true,
      you_are_leading: s.leaderId === userId,
      current_price: fromPaise(s.currentPrice),
      min_next_bid: fromPaise(minNextBid(s, toEngineCfg(a))),
      my_max: Math.max(amount, Number(reg.highest_bid || 0)),
      ends_at: new Date(s.endsAt),
      extended: result.extended,
      raised_own_max: result.raisedOwnMax,
      server_time: new Date().toISOString(),
    }
  })
  return out
}

export async function buyNow(userId, auctionId, { ip, userAgent }) {
  const settings = await getSettings()
  await enforceRateLimit(userId, settings)
  return withTx(async (client, post) => {
    const a = await lockAuction(client, auctionId)
    if (!a || a.status !== 'LIVE') throw new AuctionError('NOT_LIVE', 'This auction is not accepting bids', 409)
    const { rows: [reg] } = await client.query(
      `SELECT * FROM auction_registrations WHERE auction_id = $1 AND user_id = $2 FOR UPDATE`, [a.id, userId]
    )
    if (!reg || reg.status !== 'ACTIVE') throw new AuctionError('NOT_REGISTERED', 'Register for this auction before buying', 403)
    await assertEligible(client, userId, a, await getSettings(client))

    const now = (await dbNow(client)).getTime()
    const result = applyBuyNow(toEngineState(a), userId, now)
    if (!result.ok) throw new AuctionError(result.code, result.message, 409)

    const { stored, lastSeq } = await persistRows(client, a, result, reg, { ip, userAgent })
    const s = result.state
    await client.query(
      `UPDATE auctions
          SET current_price = $2, leader_id = $3, leader_max = $4, bid_count = 1, bidder_count = 1,
              bid_seq = $5, ends_at = NOW(), version = version + 1, updated_at = NOW()
        WHERE id = $1`,
      [a.id, fromPaise(s.currentPrice), userId, fromPaise(s.leaderMax), lastSeq]
    )
    await client.query(
      `UPDATE auction_registrations SET highest_bid = $2, bid_count = 1, last_bid_at = NOW() WHERE id = $1`,
      [reg.id, fromPaise(s.currentPrice)]
    )
    Object.assign(a, {
      current_price: fromPaise(s.currentPrice), leader_id: userId, leader_max: fromPaise(s.leaderMax),
      bid_count: 1, bidder_count: 1, ends_at: new Date(),
    })
    await logEvent(client, a.id, 'BUY_NOW', { userId, kind: 'CUSTOMER' }, { price: fromPaise(s.currentPrice) })
    post.push(() => emitToRoom(`auction:${a.id}`, 'auction:bid', { seq: stored[0].seq, amount: stored[0].amount, type: 'BUY_NOW', alias: stored[0].alias, at: new Date().toISOString() }))
    await closeLocked(client, a, post)
    return { accepted: true, closed: true, final_price: fromPaise(s.currentPrice), amount_due: Number(a.amount_due), payment_deadline: a.payment_deadline }
  })
}

// ── watchlist ───────────────────────────────────────────────────────────

export async function watch(userId, auctionId) {
  const { rows } = await query('SELECT id, status FROM auctions WHERE id = $1', [auctionId])
  if (!rows[0] || !PUBLIC_STATUSES.includes(rows[0].status)) throw new AuctionError('NOT_FOUND', 'Auction not found', 404)
  await query('INSERT INTO auction_watchers (auction_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [auctionId, userId])
  return { watching: true }
}

export async function unwatch(userId, auctionId) {
  await query('DELETE FROM auction_watchers WHERE auction_id = $1 AND user_id = $2', [auctionId, userId])
  return { watching: false }
}

