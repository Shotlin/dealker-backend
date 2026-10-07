/**
 * Auction engine — PURE bid/settlement maths. No I/O, no clock, no randomness.
 *
 * Every amount here is an INTEGER NUMBER OF PAISE (₹1 = 100). The service layer
 * converts NUMERIC(12,2) ⇄ paise at the boundary so no float ever touches money.
 *
 * Model: ascending auction with proxy ("maximum") bidding and soft close.
 *   - A bid is a private ceiling. The system bids the minimum needed to keep the
 *     leader in front, up to that ceiling (eBay semantics).
 *   - Ties go to the earlier bidder (the incumbent leader).
 *   - A bid inside the anti-snipe window pushes the end time out, capped.
 *
 * @module modules/auctions/auction-engine
 */

export const toPaise = (rupees) => Math.round(Number(rupees) * 100)
export const fromPaise = (paise) => Number((paise / 100).toFixed(2))

/** Bid-typo guard: a max bid above this multiple of the start price is rejected. */
export const MAX_BID_MULTIPLE_OF_START = 100

/**
 * @typedef {object} IncrementConfig
 * @property {number|null} [fixedPaise]  per-auction fixed step (wins over tiers)
 * @property {Array<{from:number, inc:number}>} [tiers]  RUPEE thresholds, ascending
 */

/**
 * Increment that applies at `pricePaise`.
 * @param {number} pricePaise
 * @param {IncrementConfig} cfg
 */
export function incrementFor(pricePaise, cfg = {}) {
  if (cfg.fixedPaise && cfg.fixedPaise > 0) return cfg.fixedPaise
  const tiers = (cfg.tiers && cfg.tiers.length ? cfg.tiers : [{ from: 0, inc: 10 }])
    .map((t) => ({ from: toPaise(t.from), inc: toPaise(t.inc) }))
    .sort((a, b) => a.from - b.from)
  let inc = tiers[0].inc
  for (const t of tiers) if (pricePaise >= t.from) inc = t.inc
  return inc
}

/**
 * @typedef {object} AuctionState
 * @property {number} startPrice
 * @property {number} currentPrice
 * @property {string|null} leaderId
 * @property {number|null} leaderMax
 * @property {number} bidCount
 * @property {number|null} reservePrice
 * @property {number|null} buyNowPrice
 * @property {number} endsAt            epoch ms
 * @property {number} extensionCount
 *
 * @typedef {object} RuleConfig
 * @property {IncrementConfig} increment
 * @property {number} antiSnipeWindowMs
 * @property {number} antiSnipeExtendMs
 * @property {number} maxExtensions
 */

/** Lowest max a NEW (non-leading) bidder may submit right now. */
export function minNextBid(state, cfg) {
  if (state.bidCount === 0 || state.leaderId == null) return state.startPrice
  return state.currentPrice + incrementFor(state.currentPrice, cfg.increment)
}

export const reserveMet = (state) =>
  state.reservePrice == null || state.currentPrice >= state.reservePrice

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra }
}

/** Soft-close: returns updated {endsAt, extensionCount} and whether it moved. */
export function applyAntiSnipe(state, cfg, now) {
  const remaining = state.endsAt - now
  if (
    cfg.antiSnipeWindowMs > 0 &&
    remaining <= cfg.antiSnipeWindowMs &&
    state.extensionCount < cfg.maxExtensions
  ) {
    const candidate = now + cfg.antiSnipeExtendMs
    if (candidate > state.endsAt) {
      return { endsAt: candidate, extensionCount: state.extensionCount + 1, extended: true }
    }
  }
  return { endsAt: state.endsAt, extensionCount: state.extensionCount, extended: false }
}

/**
 * Apply one customer bid (a private maximum).
 *
 * @param {AuctionState} state
 * @param {{userId:string, maxAmount:number}} bid   maxAmount in paise
 * @param {RuleConfig} cfg
 * @param {number} now   epoch ms
 * @returns {{ok:false, code:string, message:string, minimum?:number}
 *   | {ok:true, state:AuctionState, rows:Array<{userId:string, amount:number, maxAmount:number, type:'MANUAL'|'AUTO'}>,
 *      outbidUserId:string|null, leaderChanged:boolean, raisedOwnMax:boolean, extended:boolean}}
 */
export function applyBid(state, bid, cfg, now) {
  if (!Number.isInteger(bid.maxAmount) || bid.maxAmount <= 0) {
    return fail('INVALID_AMOUNT', 'Bid amount must be a positive amount')
  }
  if (now >= state.endsAt) return fail('BIDDING_CLOSED', 'Bidding has ended for this auction')
  if (bid.maxAmount > state.startPrice * MAX_BID_MULTIPLE_OF_START) {
    return fail('BID_TOO_HIGH', 'That bid looks too high — please check the amount')
  }

  const next = { ...state }
  const rows = []
  let outbidUserId = null
  let leaderChanged = false
  let raisedOwnMax = false

  // ── Leader raising their own ceiling: price does not move ───────────────
  if (state.leaderId === bid.userId) {
    if (bid.maxAmount <= (state.leaderMax ?? 0)) {
      return fail('MAX_NOT_HIGHER', 'Your new maximum must be higher than your current maximum', {
        minimum: (state.leaderMax ?? 0) + 1,
      })
    }
    next.leaderMax = bid.maxAmount
    raisedOwnMax = true
  } else {
    const minimum = minNextBid(state, cfg)
    if (bid.maxAmount < minimum) {
      return fail('BID_TOO_LOW', 'Your bid is below the minimum next bid', { minimum })
    }

    if (state.leaderId == null || state.bidCount === 0) {
      // First bid: opens at the start price; the rest of the ceiling stays private.
      next.currentPrice = state.startPrice
      next.leaderId = bid.userId
      next.leaderMax = bid.maxAmount
      leaderChanged = true
      rows.push({ userId: bid.userId, amount: state.startPrice, maxAmount: bid.maxAmount, type: 'MANUAL' })
    } else {
      const incumbent = state.leaderId
      const incumbentMax = state.leaderMax
      if (bid.maxAmount > incumbentMax) {
        // Challenger overtakes: incumbent's proxy rides up to its ceiling first.
        if (incumbentMax > state.currentPrice) {
          rows.push({ userId: incumbent, amount: incumbentMax, maxAmount: incumbentMax, type: 'AUTO' })
        }
        const price = Math.min(bid.maxAmount, incumbentMax + incrementFor(incumbentMax, cfg.increment))
        rows.push({ userId: bid.userId, amount: price, maxAmount: bid.maxAmount, type: 'MANUAL' })
        next.currentPrice = price
        next.leaderId = bid.userId
        next.leaderMax = bid.maxAmount
        outbidUserId = incumbent
        leaderChanged = true
      } else {
        // Incumbent holds (ties go to the earlier bidder). Challenger is recorded, then out-proxied.
        rows.push({ userId: bid.userId, amount: bid.maxAmount, maxAmount: bid.maxAmount, type: 'MANUAL' })
        const price = bid.maxAmount === incumbentMax
          ? incumbentMax
          : Math.min(incumbentMax, bid.maxAmount + incrementFor(bid.maxAmount, cfg.increment))
        rows.push({ userId: incumbent, amount: price, maxAmount: incumbentMax, type: 'AUTO' })
        next.currentPrice = price
        outbidUserId = bid.userId
      }
    }
  }

  // ── Reserve: a ceiling at/above the reserve lifts the price to the reserve ──
  if (next.reservePrice != null && next.currentPrice < next.reservePrice && (next.leaderMax ?? 0) >= next.reservePrice) {
    next.currentPrice = next.reservePrice
    rows.push({ userId: next.leaderId, amount: next.reservePrice, maxAmount: next.leaderMax, type: 'AUTO' })
  }

  if (rows.length) next.bidCount = state.bidCount + rows.length
  const snipe = applyAntiSnipe(next, cfg, now)
  next.endsAt = snipe.endsAt
  next.extensionCount = snipe.extensionCount

  return { ok: true, state: next, rows, outbidUserId, leaderChanged, raisedOwnMax, extended: snipe.extended }
}

/**
 * Buy-now: only while nobody has bid. Ends the auction at the buy-now price.
 */
export function applyBuyNow(state, userId, now) {
  if (now >= state.endsAt) return fail('BIDDING_CLOSED', 'Bidding has ended for this auction')
  if (state.buyNowPrice == null) return fail('BUY_NOW_UNAVAILABLE', 'Buy-now is not offered for this auction')
  if (state.bidCount > 0) return fail('BUY_NOW_UNAVAILABLE', 'Buy-now is no longer available — bidding has started')
  const next = {
    ...state,
    currentPrice: state.buyNowPrice,
    leaderId: userId,
    leaderMax: state.buyNowPrice,
    bidCount: 1,
    endsAt: now,
  }
  return {
    ok: true,
    state: next,
    rows: [{ userId, amount: state.buyNowPrice, maxAmount: state.buyNowPrice, type: 'BUY_NOW' }],
    outbidUserId: null,
    leaderChanged: true,
    raisedOwnMax: false,
    extended: false,
    closeNow: true,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Settlement maths
// ─────────────────────────────────────────────────────────────────────────

/**
 * Split one forfeited registration fee. Integer paise; the three parts always sum to `fee`.
 *   refund   = floor(fee × refundPct)           → back to the bidder's wallet
 *   vendor   = floor(forfeit × vendorSharePct)  → vendor settlement (0 for platform-owned)
 *   platform = remainder
 */
export function splitForfeitedFee(fee, { refundPct = 0, vendorSharePct = 0, hasVendor = false } = {}) {
  const refund = Math.floor((fee * Math.min(100, Math.max(0, refundPct))) / 100)
  const forfeited = fee - refund
  const vendor = hasVendor ? Math.floor((forfeited * Math.min(100, Math.max(0, vendorSharePct))) / 100) : 0
  return { refund, forfeited, vendor, platform: forfeited - vendor }
}

/** What the winner pays: winning bid minus the fee they already paid (never below zero). */
export function winnerAmountDue(winningBid, feeCredit) {
  const credit = Math.min(feeCredit, winningBid)
  return { feeCredit: credit, amountDue: winningBid - credit }
}

/**
 * Decide the outcome when bidding closes.
 * @returns {{outcome:'WON'|'UNSOLD', reason?:string}}
 */
export function resolveClose(state) {
  if (state.bidCount === 0 || state.leaderId == null) return { outcome: 'UNSOLD', reason: 'NO_BIDS' }
  if (!reserveMet(state)) return { outcome: 'UNSOLD', reason: 'RESERVE_NOT_MET' }
  return { outcome: 'WON' }
}

/**
 * Second-chance candidate after the winner defaults: the highest remaining bidder
 * who reached the reserve (or, with no reserve, any bidder), at their own highest bid.
 *
 * @param {Array<{userId:string, highestBid:number|null, firstBidAt:number}>} candidates
 * @param {string[]} declined  user ids that already defaulted/declined
 * @param {number|null} reservePrice
 */
export function pickSecondChance(candidates, declined, reservePrice) {
  const skip = new Set(declined)
  const eligible = candidates
    .filter((c) => !skip.has(c.userId) && c.highestBid != null && c.highestBid > 0)
    .filter((c) => reservePrice == null || c.highestBid >= reservePrice)
    .sort((a, b) => b.highestBid - a.highestBid || a.firstBidAt - b.firstBidAt)
  return eligible[0] ? { userId: eligible[0].userId, price: eligible[0].highestBid } : null
}

/** Compliance-friendly validation of fee vs. start price and platform bounds. */
export function validateFee({ fee, startPrice }, settings) {
  const errors = []
  if (fee < 0) errors.push('Registration fee cannot be negative')
  if (fee < toPaise(settings.min_registration_fee)) {
    errors.push(`Registration fee must be at least ₹${settings.min_registration_fee}`)
  }
  if (fee > toPaise(settings.max_registration_fee)) {
    errors.push(`Registration fee cannot exceed ₹${settings.max_registration_fee}`)
  }
  const cap = Math.floor((startPrice * Number(settings.fee_max_pct_of_start_price)) / 100)
  if (fee > cap) {
    errors.push(`Registration fee cannot exceed ${settings.fee_max_pct_of_start_price}% of the start price (₹${fromPaise(cap)})`)
  }
  return errors
}
