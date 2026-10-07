/**
 * Sponsored-ads engine — pure functions (no I/O) so ranking and pricing are unit-testable.
 *
 *   • query / keyword normalisation and EXACT / PHRASE / BROAD matching
 *   • quality score (relevance, historical CTR, rating, availability)
 *   • ad rank = bid × quality, generalized-second-price (GSP) pricing
 *   • slot placement into an organic result list
 *   • GST split
 *
 * All money is handled in integer paise to avoid float drift.
 *
 * @module modules/ads/ads-engine
 */

export const toPaise = (rupees) => Math.round(Number(rupees) * 100)
export const fromPaise = (paise) => Number((paise / 100).toFixed(2))

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeText(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const tokens = (s) => (s ? s.split(' ') : [])

/**
 * Does `keyword` match the shopper's `query`?
 *   EXACT   query === keyword
 *   PHRASE  keyword appears in the query as a contiguous run of whole words
 *   BROAD   every keyword word appears in the query, any order
 * Inputs are expected pre-normalised.
 */
export function keywordMatches(matchType, keyword, query) {
  if (!keyword || !query) return false
  if (matchType === 'EXACT') return keyword === query
  if (matchType === 'PHRASE') return ` ${query} `.includes(` ${keyword} `)
  const q = new Set(tokens(query))
  return tokens(keyword).every((t) => q.has(t))
}

export const RELEVANCE_BY_MATCH = Object.freeze({ EXACT: 1.0, PHRASE: 0.9, BROAD: 0.75, AUTO: 0.6, CATEGORY: 0.5 })

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/**
 * Quality score in (0, 1]. The platform's way of saying "would a shopper be glad to see this?".
 * A high bid cannot buy a bad ad into the top slot.
 *
 * @param {object} s
 * @param {string} s.matchKind        EXACT | PHRASE | BROAD | AUTO | CATEGORY
 * @param {number} s.impressions30d   lifetime-ish impressions for this campaign+product
 * @param {number} s.clicks30d
 * @param {number} s.ratingAvg        0–5
 * @param {number} s.ratingCount
 * @param {boolean} s.serviceable     deliverable to the shopper's pincode
 */
export function qualityScore({ matchKind, impressions30d = 0, clicks30d = 0, ratingAvg = 0, ratingCount = 0, serviceable = true }) {
  const relevance = RELEVANCE_BY_MATCH[matchKind] ?? 0.5
  // Smoothed CTR with a weak prior so brand-new ads are neither punished nor over-rewarded.
  const ctr = (clicks30d + 1) / (impressions30d + 50)
  const ctrScore = clamp(ctr / 0.04, 0, 1)
  const ratingScore = ratingCount >= 5 ? clamp(ratingAvg / 5, 0, 1) : 0.6
  const availability = serviceable ? 1 : 0.5
  const q = 0.45 * relevance + 0.25 * ctrScore + 0.2 * ratingScore + 0.1 * availability
  return Number(clamp(q, 0.01, 1).toFixed(4))
}

/**
 * Rank candidates and price them with GSP.
 *
 * @param {Array<{key:string, vendorId:string, bidPaise:number, quality:number}>} candidates
 * @param {{minCpcPaise:number, maxCpcPaise:number, slots:number, perVendorCap:number, minQuality:number}} rules
 * @returns {Array<{...candidate, rank:number, cpcPaise:number}>} winners in display order
 *
 * Price for winner i = the least it could have bid to hold position i:
 *   (rank_{i+1} / quality_i) + 1 paise, clamped to [minCpc, min(bid_i, maxCpc)].
 * The last winner is priced against the best *loser* (or the floor if there is none).
 */
export function rankAndPrice(candidates, rules) {
  const { minCpcPaise, maxCpcPaise, slots, perVendorCap, minQuality } = rules
  const eligible = candidates
    .filter((c) => c.quality >= minQuality && c.bidPaise >= minCpcPaise)
    .map((c) => {
      const bid = Math.min(c.bidPaise, maxCpcPaise)
      return { ...c, bidPaise: bid, rank: bid * c.quality }
    })
    // Highest rank first; ties → higher quality, then stable key order so output is deterministic.
    .sort((a, b) => b.rank - a.rank || b.quality - a.quality || (a.key < b.key ? -1 : 1))

  // One ad per product (best rank wins) and a per-vendor cap per page.
  const seenProducts = new Set()
  const perVendor = new Map()
  const ordered = []
  for (const c of eligible) {
    if (seenProducts.has(c.productId)) continue
    const n = perVendor.get(c.vendorId) || 0
    if (n >= perVendorCap) continue
    seenProducts.add(c.productId)
    perVendor.set(c.vendorId, n + 1)
    ordered.push(c)
  }

  return ordered.slice(0, slots).map((c, i) => {
    const next = ordered[i + 1]
    // No competitor below → the reserve (floor) price; otherwise one paisa over what the next ad needs.
    const raw = next ? Math.floor(next.rank / c.quality) + 1 : minCpcPaise
    const cpcPaise = clamp(raw, minCpcPaise, Math.min(c.bidPaise, maxCpcPaise))
    return { ...c, cpcPaise }
  })
}

/**
 * Merge sponsored items into an organic list: first ad at `first`, then every `spacing` positions.
 * Organic items that duplicate a sponsored product are dropped so a shopper never sees the same
 * product twice on one page.
 */
export function placeSponsored(organic, sponsored, { first = 0, spacing = 4 } = {}) {
  if (!sponsored.length) return organic.slice()
  const ids = new Set(sponsored.map((s) => s.product_id))
  const rest = organic.filter((o) => !ids.has(o.product_id))
  const out = []
  let ad = 0
  let o = 0
  const total = rest.length + sponsored.length
  for (let pos = 0; pos < total; pos++) {
    const isAdSlot = ad < sponsored.length && pos >= first && (pos - first) % spacing === 0
    if (isAdSlot || o >= rest.length) out.push(sponsored[ad++])
    else out.push(rest[o++])
  }
  return out
}

/** Split a net amount into net + GST, in paise (GST rounded half-up). */
export function withGst(netPaise, gstPct) {
  const tax = Math.round((netPaise * Number(gstPct)) / 100)
  return { netPaise, taxPaise: tax, grossPaise: netPaise + tax }
}

/** Net spend that still fits today's budget (and the lifetime budget if any). Negative never returned. */
export function remainingBudgetPaise({ dailyBudgetPaise, spentTodayPaise, totalBudgetPaise = null, spentTotalPaise = 0 }) {
  const day = dailyBudgetPaise - spentTodayPaise
  const life = totalBudgetPaise == null ? Infinity : totalBudgetPaise - spentTotalPaise
  return Math.max(0, Math.min(day, life))
}
