import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import {
  keywordMatches, normalizeText, placeSponsored, qualityScore, rankAndPrice, remainingBudgetPaise, toPaise, withGst,
} from '../../../src/modules/ads/ads-engine.js'

const rules = { minCpcPaise: 200, maxCpcPaise: 50000, slots: 4, perVendorCap: 2, minQuality: 0.25 }
const cand = (key, vendorId, bidRupees, quality, productId = key) => ({ key, vendorId, productId, bidPaise: toPaise(bidRupees), quality })

describe('keyword matching', () => {
  it('normalises case, punctuation and accents', () => {
    expect(normalizeText('  iPhone-15   PRO!! ')).toBe('iphone 15 pro')
    expect(normalizeText('Café  Latté')).toBe('cafe latte')
  })
  it('EXACT requires the whole query', () => {
    expect(keywordMatches('EXACT', 'iphone 15', 'iphone 15')).toBe(true)
    expect(keywordMatches('EXACT', 'iphone 15', 'iphone 15 case')).toBe(false)
  })
  it('PHRASE needs contiguous whole words', () => {
    expect(keywordMatches('PHRASE', 'iphone 15', 'buy iphone 15 pro')).toBe(true)
    expect(keywordMatches('PHRASE', 'iphone 15', 'iphone pro 15')).toBe(false)
    expect(keywordMatches('PHRASE', 'phone', 'iphone 15')).toBe(false) // substring of a word is not a match
  })
  it('BROAD needs every word, any order', () => {
    expect(keywordMatches('BROAD', 'iphone 15', 'new 15 iphone')).toBe(true)
    expect(keywordMatches('BROAD', 'iphone 15', 'iphone')).toBe(false)
  })
  it('never matches empty input', () => {
    expect(keywordMatches('BROAD', '', 'x')).toBe(false)
    expect(keywordMatches('BROAD', 'x', '')).toBe(false)
  })
})

describe('quality score', () => {
  it('is bounded and rewards relevance, CTR and ratings', () => {
    const lo = qualityScore({ matchKind: 'CATEGORY', impressions30d: 10_000, clicks30d: 5, ratingAvg: 1.5, ratingCount: 50, serviceable: false })
    const hi = qualityScore({ matchKind: 'EXACT', impressions30d: 10_000, clicks30d: 800, ratingAvg: 4.8, ratingCount: 50, serviceable: true })
    expect(lo).toBeGreaterThan(0)
    expect(hi).toBeLessThanOrEqual(1)
    expect(hi).toBeGreaterThan(lo)
  })
  it('does not punish a brand-new ad for having no history', () => {
    expect(qualityScore({ matchKind: 'EXACT' })).toBeGreaterThan(0.6)
  })
})

describe('ranking & GSP pricing', () => {
  it('ranks by bid × quality, so a better ad can win with a lower bid', () => {
    const w = rankAndPrice([cand('a', 'v1', 10, 0.5), cand('b', 'v2', 7, 0.9)], rules)
    expect(w.map((x) => x.key)).toEqual(['b', 'a']) // 6.3 beats 5.0
  })
  it('charges the minimum needed to hold position, never above the bid', () => {
    const [first, second] = rankAndPrice([cand('a', 'v1', 20, 1), cand('b', 'v2', 8, 1)], rules)
    expect(first.cpcPaise).toBe(toPaise(8) + 1) // beats rank 8.00 by one paisa
    expect(first.cpcPaise).toBeLessThanOrEqual(first.bidPaise)
    expect(second.cpcPaise).toBe(rules.minCpcPaise) // last winner pays the floor
  })
  it('uses the quality ratio when qualities differ', () => {
    const [first] = rankAndPrice([cand('a', 'v1', 20, 0.8), cand('b', 'v2', 10, 0.8)], rules)
    expect(first.cpcPaise).toBe(1000 + 1)
  })
  it('drops low-quality ads and bids below the floor', () => {
    const w = rankAndPrice([cand('a', 'v1', 50, 0.1), cand('b', 'v2', 1, 1), cand('c', 'v3', 5, 0.5)], rules)
    expect(w.map((x) => x.key)).toEqual(['c'])
  })
  it('clamps absurd bids to the platform ceiling', () => {
    const [w] = rankAndPrice([cand('a', 'v1', 99999, 1)], rules)
    expect(w.bidPaise).toBe(rules.maxCpcPaise)
  })
  it('shows a product once and caps ads per vendor', () => {
    const w = rankAndPrice([
      cand('a', 'v1', 9, 1, 'p1'), cand('a2', 'v2', 8, 1, 'p1'),
      cand('b', 'v1', 7, 1, 'p2'), cand('c', 'v1', 6, 1, 'p3'), cand('d', 'v2', 5, 1, 'p4'),
    ], rules)
    expect(w.map((x) => x.key)).toEqual(['a', 'b', 'd']) // a2 is a duplicate product, c exceeds v1's cap of 2
  })
  it('is deterministic on ties', () => {
    const a = rankAndPrice([cand('x', 'v1', 5, 1), cand('y', 'v2', 5, 1)], rules).map((c) => c.key)
    const b = rankAndPrice([cand('y', 'v2', 5, 1), cand('x', 'v1', 5, 1)], rules).map((c) => c.key)
    expect(a).toEqual(b)
  })
  it('property: price is within [floor, bid] and never above the next advertiser would need', () => {
    fc.assert(fc.property(
      fc.array(fc.record({ bid: fc.integer({ min: 2, max: 500 }), q: fc.integer({ min: 30, max: 100 }) }), { minLength: 1, maxLength: 8 }),
      (list) => {
        const cands = list.map((c, i) => cand(`k${i}`, `v${i}`, c.bid, c.q / 100))
        const w = rankAndPrice(cands, rules)
        for (const x of w) {
          expect(x.cpcPaise).toBeGreaterThanOrEqual(rules.minCpcPaise)
          expect(x.cpcPaise).toBeLessThanOrEqual(x.bidPaise)
        }
        // order is non-increasing in rank
        for (let i = 1; i < w.length; i++) expect(w[i - 1].rank).toBeGreaterThanOrEqual(w[i].rank)
      }))
  })
})

describe('placement', () => {
  const org = (n) => Array.from({ length: n }, (_, i) => ({ product_id: `o${i}` }))
  const ads = (n) => Array.from({ length: n }, (_, i) => ({ product_id: `a${i}`, is_sponsored: true }))
  it('puts ads at first slot then every `spacing` positions', () => {
    const out = placeSponsored(org(10), ads(3), { first: 0, spacing: 4 })
    expect(out.map((x, i) => (x.is_sponsored ? i : null)).filter((x) => x !== null)).toEqual([0, 4, 8])
    expect(out).toHaveLength(13)
  })
  it('removes organic duplicates of a sponsored product', () => {
    const out = placeSponsored([{ product_id: 'a0' }, { product_id: 'o1' }], ads(1))
    expect(out.filter((x) => x.product_id === 'a0')).toHaveLength(1)
    expect(out).toHaveLength(2)
  })
  it('still shows ads when organic results are short or empty', () => {
    expect(placeSponsored([], ads(2))).toHaveLength(2)
    expect(placeSponsored(org(1), ads(3), { first: 2, spacing: 3 })).toHaveLength(4)
  })
  it('returns organic untouched when there are no ads', () => {
    expect(placeSponsored(org(3), [])).toHaveLength(3)
  })
})

describe('money', () => {
  it('splits GST in integer paise', () => {
    expect(withGst(1000, 18)).toEqual({ netPaise: 1000, taxPaise: 180, grossPaise: 1180 })
    expect(withGst(333, 18).taxPaise).toBe(60)
  })
  it('remaining budget never goes negative and honours the lifetime cap', () => {
    expect(remainingBudgetPaise({ dailyBudgetPaise: 10000, spentTodayPaise: 12000 })).toBe(0)
    expect(remainingBudgetPaise({ dailyBudgetPaise: 10000, spentTodayPaise: 2000, totalBudgetPaise: 9000, spentTotalPaise: 8000 })).toBe(1000)
  })
})
