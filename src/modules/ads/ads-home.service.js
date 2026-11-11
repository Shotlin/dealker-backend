/**
 * Sponsored placements inside HOME / tab sections (the section manifest).
 *
 * Search and category pages already run the ads auction (ads-serving.service.js). Home
 * sections are different: there is no query, so a campaign is shown in every product
 * section it is RELEVANT to and is always placed FIRST in that section:
 *
 *   • section pinned to categories / brand rules → ads whose product sits in the same
 *     category family (root category) or has the same brand
 *   • section with no category context (Trending, Recently viewed…) → every active ad
 *
 * Eligibility is identical to search ads: campaign ACTIVE (admin-approved) and inside its
 * dates, vendor wallet can pay a click, daily/total budget left, product listed and visible
 * to the shopper. Winners are ordered by bid × quality, capped per vendor, and each carries
 * the same signed impression token the click endpoint bills against.
 *
 * Never breaks the home screen: any failure returns the manifest untouched.
 *
 * @module modules/ads/ads-home.service
 */

import { createHash } from 'node:crypto'
import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { fromPaise, qualityScore, remainingBudgetPaise, toPaise, withGst } from './ads-engine.js'
import { getSettings, IST_DAY_SQL, newNonce, signImpression } from './ads.shared.js'
import { recordImpressions } from './ads-serving.service.js'

// Section types that list products. Others (banners, strips, hubs) are never touched.
export const AD_SECTION_TYPES = new Set([
  'product_carousel', 'trending_products', 'category_product_grid', 'deal_of_day', 'banner_rail',
  'arched_product_showcase', 'brand_spotlight', 'oval_spotlight', 'seasonal_mosaic', 'recent_recommended',
])

const POOL_SQL = `
  SELECT c.id AS campaign_id, c.vendor_id, c.default_bid, c.daily_budget, c.total_budget,
         cp.product_id, cp.bid_override,
         p.category_id, p.brand, p.rating_avg, p.rating_count, l.shop_id,
         COALESCE((SELECT SUM(spend) FROM ad_stats_daily WHERE campaign_id = c.id AND day = ${IST_DAY_SQL}), 0) AS spent_today,
         CASE WHEN c.total_budget IS NULL THEN 0
              ELSE COALESCE((SELECT SUM(spend) FROM ad_stats_daily WHERE campaign_id = c.id), 0) END AS spent_total,
         COALESCE((SELECT SUM(impressions) FROM ad_stats_daily WHERE campaign_id = c.id AND product_id = cp.product_id AND day >= ${IST_DAY_SQL} - 30), 0) AS impressions_30d,
         COALESCE((SELECT SUM(clicks)      FROM ad_stats_daily WHERE campaign_id = c.id AND product_id = cp.product_id AND day >= ${IST_DAY_SQL} - 30), 0) AS clicks_30d
    FROM ad_campaigns c
    JOIN ad_wallets w ON w.vendor_id = c.vendor_id AND w.balance >= $1::numeric
    JOIN ad_campaign_products cp ON cp.campaign_id = c.id AND cp.status = 'ACTIVE'
    JOIN products p ON p.id = cp.product_id AND p.deleted_at IS NULL AND p.is_active = TRUE
    JOIN LATERAL (
      -- the advertiser's cheapest live listing: its shop supplies the price the card shows
      SELECT sp.shop_id FROM shop_products sp JOIN shops sx ON sx.id = sp.shop_id
       WHERE sp.product_id = cp.product_id AND sx.vendor_id = c.vendor_id AND sx.deleted_at IS NULL AND sx.is_active = TRUE
         AND sp.deleted_at IS NULL AND sp.listing_status = 'ACTIVE' AND sp.approval_status = 'APPROVED'
         AND sp.stock_quantity > 0 AND sp.is_available = TRUE
       ORDER BY COALESCE(sp.sale_price, sp.price) ASC
       LIMIT 1
    ) l ON TRUE
   WHERE c.status = 'ACTIVE'
     AND c.starts_on <= ${IST_DAY_SQL} AND (c.ends_on IS NULL OR c.ends_on >= ${IST_DAY_SQL})`

const lower = (v) => String(v ?? '').trim().toLowerCase()

/** Root ancestor of every category, so "Mobiles" and "Mobiles > Smartphones" are one family. */
async function loadRoots() {
  const { rows } = await query('SELECT id, parent_id FROM categories')
  const parent = new Map(rows.map((r) => [r.id, r.parent_id]))
  const roots = new Map()
  for (const id of parent.keys()) {
    let cur = id
    for (let i = 0; i < 8 && parent.get(cur); i++) cur = parent.get(cur)
    roots.set(id, cur)
  }
  return roots
}

/** Ranked, de-duplicated ad candidates (one per product), best bid × quality first. */
async function loadCandidates() {
  const s = await getSettings()
  if (!s.enabled) return { settings: s, ads: [] }
  const minCpc = toPaise(s.min_cpc)
  const minWallet = fromPaise(withGst(minCpc, s.gst_pct).grossPaise)
  const { rows } = await query(POOL_SQL, [minWallet])
  const best = new Map()
  for (const r of rows) {
    const remaining = remainingBudgetPaise({
      dailyBudgetPaise: toPaise(r.daily_budget), spentTodayPaise: toPaise(r.spent_today),
      totalBudgetPaise: r.total_budget == null ? null : toPaise(r.total_budget), spentTotalPaise: toPaise(r.spent_total),
    })
    const bidPaise = Math.min(toPaise(r.bid_override ?? r.default_bid), toPaise(s.max_cpc))
    if (remaining < minCpc || bidPaise < minCpc) continue
    const quality = qualityScore({
      matchKind: 'CATEGORY', impressions30d: Number(r.impressions_30d), clicks30d: Number(r.clicks_30d),
      ratingAvg: Number(r.rating_avg || 0), ratingCount: Number(r.rating_count || 0), serviceable: true,
    })
    const cand = {
      campaignId: r.campaign_id, vendorId: r.vendor_id, productId: r.product_id, shopId: r.shop_id, categoryId: r.category_id,
      brand: lower(r.brand), bidPaise, quality, rank: bidPaise * quality, remaining,
    }
    const prev = best.get(r.product_id)
    if (!prev || cand.rank > prev.rank) best.set(r.product_id, cand)
  }
  const ads = [...best.values()].sort((a, b) => b.rank - a.rank || (a.productId < b.productId ? -1 : 1))
  return { settings: s, ads }
}

/** Categories + brands a section is "about". Empty sets = no context → any ad fits. */
function sectionContext(section, roots) {
  const binding = section.merch_binding || {}
  const rules = binding.rules || {}
  const catIds = new Set([...(binding.category_ids || []), ...(rules.category_ids || [])])
  for (const p of section.products || []) if (p?.category_id) catIds.add(p.category_id)
  const roots_ = new Set([...catIds].map((id) => roots.get(id) || id))
  const brands = new Set((Array.isArray(rules.brands) ? rules.brands : []).map(lower).filter(Boolean))
  return { roots: roots_, brands }
}

function fits(ad, ctx, roots) {
  if (ctx.brands.size) return ctx.brands.has(ad.brand)
  if (!ctx.roots.size) return true
  return ctx.roots.has(roots.get(ad.categoryId) || ad.categoryId)
}

/**
 * Put approved sponsored products first in every product section of a manifest.
 *
 * @param {{sections: Array<object>}} data   manifest payload (not mutated)
 * @param {object} o
 * @param {(ads:Array<{productId:string, shopId:string}>) => Promise<Array<object>>} o.loadCards  card-format loader; prices come from the advertiser's own shop listing
 * @param {string|null} [o.userId]
 * @param {boolean} [o.preview]   dashboard preview: flag cards, sign no tokens, record no impressions
 * @returns {Promise<{data: object, injected: number}>}
 */
export async function injectHomeAds(data, { loadCards, userId = null, preview = false }) {
  try {
    const sections = Array.isArray(data?.sections) ? data.sections : []
    const eligible = sections.filter((sec) => AD_SECTION_TYPES.has(sec.type || sec.section_type) && sec.merch_binding?.ads !== false)
    if (!eligible.length) return { data, injected: 0 }

    const { settings, ads } = await loadCandidates()
    if (!ads.length) return { data, injected: 0 }

    const cards = new Map((await loadCards(ads.map((a) => ({ productId: a.productId, shopId: a.shopId })))).map((c) => [c.id, c]))
    const live = ads.filter((a) => cards.has(a.productId))
    if (!live.length) return { data, injected: 0 }

    const roots = await loadRoots()
    const slots = Math.max(1, Number(settings.slots_per_page) || 4)
    const perVendor = Math.max(1, Number(settings.max_ads_per_vendor_per_page) || 2)
    const exp = Date.now() + settings.impression_token_ttl_minutes * 60_000
    const tokens = new Map()
    const tokenFor = (a) => {
      if (!tokens.has(a.productId)) {
        tokens.set(a.productId, signImpression({
          n: newNonce(), c: a.campaignId, v: a.vendorId, p: a.productId, k: null, q: null, u: userId || null,
          b: fromPaise(Math.max(toPaise(settings.min_cpc), Math.min(a.bidPaise, toPaise(settings.max_cpc)))), e: exp,
        }))
      }
      return tokens.get(a.productId)
    }

    const served = new Map() // productId → ad, for impressions
    let injected = 0
    const out = sections.map((sec) => {
      if (!eligible.includes(sec)) return sec
      const ctx = sectionContext(sec, roots)
      const per = new Map()
      const chosen = []
      for (const a of live) {
        if (chosen.length >= slots) break
        if (!fits(a, ctx, roots)) continue
        if ((per.get(a.vendorId) || 0) >= perVendor) continue
        per.set(a.vendorId, (per.get(a.vendorId) || 0) + 1)
        chosen.push(a)
      }
      if (!chosen.length) return sec
      const adCards = chosen.map((a) => {
        served.set(a.productId, a)
        return {
          ...cards.get(a.productId), is_sponsored: true, ad_label: 'Ad', ...(preview ? {} : { ad_token: tokenFor(a) }),
        }
      })
      const taken = new Set(chosen.map((a) => a.productId))
      const organic = (sec.products || []).filter((p) => !taken.has(p.id))
      const room = Math.max(sec.products?.length || 0, adCards.length)
      injected += adCards.length
      return { ...sec, products: [...adCards, ...organic].slice(0, room) }
    })

    if (!served.size) return { data, injected: 0 }
    if (!preview) {
      const list = [...served.values()]
      recordImpressions(list).catch((err) => logger.warn({ err: err.message, action: 'ads_home_impression_failed' }, 'Home ad impressions failed'))
    }
    return { data: { ...data, sections: out }, injected }
  } catch (err) {
    logger.error({ err: err.message, action: 'ads_home_inject_failed' }, 'Home ad injection failed — serving organic manifest')
    return { data, injected: 0 }
  }
}

export const manifestEtag = (data) => createHash('md5').update(JSON.stringify(data)).digest('hex')
