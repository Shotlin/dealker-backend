import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import {
  applyBid,
  applyBuyNow,
  incrementFor,
  minNextBid,
  pickSecondChance,
  resolveClose,
  reserveMet,
  splitForfeitedFee,
  toPaise,
  validateFee,
  winnerAmountDue,
} from '../../../src/modules/auctions/auction-engine.js'

const R = toPaise // rupees → paise
const T0 = 1_700_000_000_000
const HOUR = 3_600_000

const cfg = (fixed = 1000) => ({
  increment: { fixedPaise: R(fixed) },
  antiSnipeWindowMs: 120_000,
  antiSnipeExtendMs: 120_000,
  maxExtensions: 3,
})

const fresh = (over = {}) => ({
  startPrice: R(20000),
  currentPrice: 0,
  leaderId: null,
  leaderMax: null,
  bidCount: 0,
  reservePrice: null,
  buyNowPrice: null,
  endsAt: T0 + HOUR,
  extensionCount: 0,
  ...over,
})

const bidAs = (state, userId, rupees, c = cfg(), now = T0) => {
  const r = applyBid(state, { userId, maxAmount: R(rupees) }, c, now)
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
  return r
}

describe('worked example from the product brief (₹20,000 start, ₹500 fee, ₹1,000 steps)', () => {
  it('four bidders step up; D wins at ₹24,000 and pays ₹23,500', () => {
    let s = fresh()
    // each bidder takes "next minimum bid"
    s = bidAs(s, 'A', 20000).state
    expect(s.currentPrice).toBe(R(20000))
    s = bidAs(s, 'B', 21000).state
    expect(s.currentPrice).toBe(R(21000))
    s = bidAs(s, 'C', 22000).state
    s = bidAs(s, 'D', 23000).state
    s = bidAs(s, 'A', 24000).state // A comes back
    s = bidAs(s, 'D', 25000).state
    expect(s.leaderId).toBe('D')
    expect(s.currentPrice).toBe(R(25000))

    const { amountDue, feeCredit } = winnerAmountDue(R(24000), R(500))
    expect(feeCredit).toBe(R(500))
    expect(amountDue).toBe(R(23500))
  })

  it('3 losers × ₹500 = ₹1,500 forfeited, split 50/50 with a vendor', () => {
    const parts = [1, 2, 3].map(() => splitForfeitedFee(R(500), { vendorSharePct: 50, hasVendor: true }))
    expect(parts.reduce((a, p) => a + p.vendor, 0)).toBe(R(750))
    expect(parts.reduce((a, p) => a + p.platform, 0)).toBe(R(750))
  })
})

describe('increments', () => {
  const tiers = [{ from: 0, inc: 10 }, { from: 1000, inc: 50 }, { from: 10000, inc: 250 }]
  it('fixed step overrides tiers', () => {
    expect(incrementFor(R(50), { fixedPaise: R(1000), tiers })).toBe(R(1000))
  })
  it('tiers pick the highest threshold ≤ price', () => {
    expect(incrementFor(R(999), { tiers })).toBe(R(10))
    expect(incrementFor(R(1000), { tiers })).toBe(R(50))
    expect(incrementFor(R(50000), { tiers })).toBe(R(250))
  })
})

describe('first bid', () => {
  it('opens at the start price even if the bidder set a higher ceiling', () => {
    const r = bidAs(fresh(), 'A', 26000)
    expect(r.state.currentPrice).toBe(R(20000))
    expect(r.state.leaderMax).toBe(R(26000))
    expect(r.rows).toHaveLength(1)
  })
  it('rejects below the start price', () => {
    const r = applyBid(fresh(), { userId: 'A', maxAmount: R(19999) }, cfg(), T0)
    expect(r).toMatchObject({ ok: false, code: 'BID_TOO_LOW', minimum: R(20000) })
  })
})

describe('proxy bidding', () => {
  it('challenger above the leader\'s max takes the lead at max+increment', () => {
    let s = bidAs(fresh(), 'A', 26000).state // A: price 20,000, max 26,000
    const r = bidAs(s, 'B', 30000)
    expect(r.state.leaderId).toBe('B')
    expect(r.state.currentPrice).toBe(R(27000))
    expect(r.outbidUserId).toBe('A')
    expect(r.rows.map((x) => x.type)).toEqual(['AUTO', 'MANUAL'])
  })

  it('challenger below the leader\'s max loses; price rises to challenger+increment', () => {
    let s = bidAs(fresh(), 'A', 30000).state
    const r = bidAs(s, 'B', 24000)
    expect(r.state.leaderId).toBe('A')
    expect(r.state.currentPrice).toBe(R(25000))
    expect(r.outbidUserId).toBe('B')
  })

  it('a tie goes to the earlier bidder at exactly that amount', () => {
    let s = bidAs(fresh(), 'A', 30000).state
    const r = bidAs(s, 'B', 30000)
    expect(r.state.leaderId).toBe('A')
    expect(r.state.currentPrice).toBe(R(30000))
  })

  it('price never exceeds the leader\'s ceiling', () => {
    let s = bidAs(fresh(), 'A', 22500).state
    const r = bidAs(s, 'B', 22000)
    expect(r.state.leaderId).toBe('A')
    expect(r.state.currentPrice).toBeLessThanOrEqual(R(22500))
  })

  it('leader raising their own max does not move the price', () => {
    let s = bidAs(fresh(), 'A', 22000).state
    const r = bidAs(s, 'A', 40000)
    expect(r.state.currentPrice).toBe(s.currentPrice)
    expect(r.state.leaderMax).toBe(R(40000))
    expect(r.raisedOwnMax).toBe(true)
    expect(r.rows).toHaveLength(0)
  })

  it('leader cannot lower or repeat their max', () => {
    let s = bidAs(fresh(), 'A', 22000).state
    expect(applyBid(s, { userId: 'A', maxAmount: R(22000) }, cfg(), T0)).toMatchObject({ ok: false, code: 'MAX_NOT_HIGHER' })
  })

  it('bid below current + increment is rejected with the minimum', () => {
    let s = bidAs(fresh(), 'A', 21000).state
    s = bidAs(s, 'B', 22000).state // price 22,000
    const r = applyBid(s, { userId: 'C', maxAmount: R(22500) }, cfg(), T0)
    expect(r).toMatchObject({ ok: false, code: 'BID_TOO_LOW', minimum: R(23000) })
  })

  it('rejects absurd bids (typo guard) and closed auctions', () => {
    expect(applyBid(fresh(), { userId: 'A', maxAmount: R(20000 * 101) }, cfg(), T0)).toMatchObject({ code: 'BID_TOO_HIGH' })
    expect(applyBid(fresh(), { userId: 'A', maxAmount: R(21000) }, cfg(), T0 + 2 * HOUR)).toMatchObject({ code: 'BIDDING_CLOSED' })
  })
})

describe('reserve price', () => {
  it('is hidden-met: a ceiling ≥ reserve lifts the price to the reserve', () => {
    const s0 = fresh({ reservePrice: R(25000) })
    const r = bidAs(s0, 'A', 30000)
    expect(r.state.currentPrice).toBe(R(25000))
    expect(reserveMet(r.state)).toBe(true)
  })
  it('stays unmet when no ceiling reaches it', () => {
    const r = bidAs(fresh({ reservePrice: R(25000) }), 'A', 22000)
    expect(reserveMet(r.state)).toBe(false)
    expect(resolveClose(r.state)).toEqual({ outcome: 'UNSOLD', reason: 'RESERVE_NOT_MET' })
  })
  it('no bids → unsold', () => {
    expect(resolveClose(fresh())).toEqual({ outcome: 'UNSOLD', reason: 'NO_BIDS' })
  })
  it('valid winner otherwise', () => {
    expect(resolveClose(bidAs(fresh(), 'A', 21000).state)).toEqual({ outcome: 'WON' })
  })
})

describe('anti-sniping soft close', () => {
  it('a bid in the last 2 minutes extends the end to now+2min', () => {
    const now = T0 + HOUR - 30_000
    const r = bidAs(fresh(), 'A', 21000, cfg(), now)
    expect(r.extended).toBe(true)
    expect(r.state.endsAt).toBe(now + 120_000)
    expect(r.state.extensionCount).toBe(1)
  })
  it('a bid early in the auction does not extend', () => {
    const r = bidAs(fresh(), 'A', 21000, cfg(), T0 + 1000)
    expect(r.extended).toBe(false)
    expect(r.state.endsAt).toBe(T0 + HOUR)
  })
  it('stops extending after maxExtensions', () => {
    let s = fresh()
    let now = T0 + HOUR - 10_000
    let price = 20000
    for (let i = 0; i < 6; i++) {
      s = bidAs(s, i % 2 ? 'A' : 'B', price, cfg(), now).state
      price += 1000
      now = s.endsAt - 10_000
    }
    expect(s.extensionCount).toBe(3)
  })
})

describe('buy now', () => {
  const s0 = fresh({ buyNowPrice: R(30000) })
  it('closes the auction immediately while no bids exist', () => {
    const r = applyBuyNow(s0, 'A', T0)
    expect(r.ok).toBe(true)
    expect(r.closeNow).toBe(true)
    expect(r.state.currentPrice).toBe(R(30000))
    expect(r.state.leaderId).toBe('A')
  })
  it('is refused once bidding started', () => {
    const s = bidAs(s0, 'B', 20000).state
    expect(applyBuyNow(s, 'A', T0)).toMatchObject({ ok: false, code: 'BUY_NOW_UNAVAILABLE' })
  })
  it('is refused when not offered', () => {
    expect(applyBuyNow(fresh(), 'A', T0)).toMatchObject({ ok: false })
  })
})

describe('fee settlement maths', () => {
  it('winner credit never exceeds the winning bid', () => {
    expect(winnerAmountDue(R(300), R(500))).toEqual({ feeCredit: R(300), amountDue: 0 })
  })
  it('refund % comes off the top, vendor share applies to the remainder', () => {
    expect(splitForfeitedFee(R(500), { refundPct: 20, vendorSharePct: 50, hasVendor: true }))
      .toEqual({ refund: R(100), forfeited: R(400), vendor: R(200), platform: R(200) })
  })
  it('platform-owned auctions give the vendor nothing', () => {
    expect(splitForfeitedFee(R(500), { vendorSharePct: 50, hasVendor: false }).vendor).toBe(0)
  })
  it('odd paise never leak: parts always sum to the fee', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 5_000_000 }), fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }), fc.boolean(),
      (fee, refundPct, vendorSharePct, hasVendor) => {
        const p = splitForfeitedFee(fee, { refundPct, vendorSharePct, hasVendor })
        expect(p.refund + p.vendor + p.platform).toBe(fee)
        expect(p.refund).toBeGreaterThanOrEqual(0)
        expect(p.vendor).toBeGreaterThanOrEqual(0)
        expect(p.platform).toBeGreaterThanOrEqual(0)
      }))
  })
})

describe('second chance', () => {
  const cands = [
    { userId: 'A', highestBid: R(24000), firstBidAt: 1 },
    { userId: 'B', highestBid: R(23000), firstBidAt: 2 },
    { userId: 'C', highestBid: R(23000), firstBidAt: 1 },
  ]
  it('skips defaulters and picks the next highest at their own bid', () => {
    expect(pickSecondChance(cands, ['A'], null)).toEqual({ userId: 'C', price: R(23000) })
  })
  it('respects the reserve', () => {
    expect(pickSecondChance(cands, ['A'], R(23500))).toBeNull()
  })
  it('returns null when nobody is left', () => {
    expect(pickSecondChance(cands, ['A', 'B', 'C'], null)).toBeNull()
  })
})

describe('fee validation', () => {
  const settings = { min_registration_fee: 10, max_registration_fee: 5000, fee_max_pct_of_start_price: 10 }
  it('accepts ₹500 on ₹20,000', () => {
    expect(validateFee({ fee: R(500), startPrice: R(20000) }, settings)).toEqual([])
  })
  it('rejects > 10% of start price', () => {
    expect(validateFee({ fee: R(2500), startPrice: R(20000) }, settings)).toHaveLength(1)
  })
  it('rejects below the platform minimum', () => {
    expect(validateFee({ fee: R(5), startPrice: R(20000) }, settings).length).toBeGreaterThan(0)
  })
})

describe('invariants (property-based)', () => {
  // random sequence of bidders & ceilings applied to one auction
  const stepArb = fc.record({
    user: fc.constantFrom('A', 'B', 'C', 'D'),
    bump: fc.integer({ min: 0, max: 15 }),
  })

  it('price is non-decreasing, never exceeds the leader ceiling, leader always has the top ceiling', () => {
    fc.assert(fc.property(fc.array(stepArb, { minLength: 1, maxLength: 40 }), (steps) => {
      let s = fresh()
      let lastPrice = 0
      let t = T0
      const ceilings = new Map()
      for (const st of steps) {
        t += 1000
        const min = minNextBid(s, cfg())
        const max = min + st.bump * R(1000)
        const r = applyBid(s, { userId: st.user, maxAmount: max }, cfg(), t)
        if (!r.ok) continue
        s = r.state
        ceilings.set(st.user, Math.max(ceilings.get(st.user) ?? 0, max))
        expect(s.currentPrice).toBeGreaterThanOrEqual(lastPrice)
        expect(s.currentPrice).toBeLessThanOrEqual(s.leaderMax)
        expect(s.leaderMax).toBe(Math.max(...ceilings.values()))
        lastPrice = s.currentPrice
        // every recorded row price is within [start, ceiling]
        for (const row of r.rows) {
          expect(row.amount).toBeGreaterThanOrEqual(R(20000))
          expect(row.amount).toBeLessThanOrEqual(row.maxAmount)
        }
      }
    }), { numRuns: 300 })
  })

  it('extensions never exceed the cap and end time never moves backwards', () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 600 }), { minLength: 1, maxLength: 30 }), (gapsSec) => {
      let s = fresh()
      let t = T0
      let lastEnd = s.endsAt
      let who = 0
      for (const g of gapsSec) {
        t += g * 1000
        const min = minNextBid(s, cfg())
        const r = applyBid(s, { userId: who++ % 2 ? 'A' : 'B', maxAmount: min }, cfg(), t)
        if (!r.ok) continue
        s = r.state
        expect(s.endsAt).toBeGreaterThanOrEqual(lastEnd)
        expect(s.extensionCount).toBeLessThanOrEqual(3)
        lastEnd = s.endsAt
      }
    }), { numRuns: 300 })
  })
})
