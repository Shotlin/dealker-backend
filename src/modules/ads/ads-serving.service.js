/**
 * Ad serving — decides which sponsored listings a shopper sees for a search / category page,
 * in what order, and what each click would cost.
 *
 * Flow: eligible candidates (SQL) → quality score → rank by bid × quality → GSP price →
 * sign one impression token per winner → record impressions → merge into organic results.
 *
 * Ads must NEVER break discovery: `injectSponsored` swallows every failure and returns the
 * organic results untouched.
 *
 * @module modules/ads/ads-serving.service
 */

import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import {
  fromPaise, keywordMatches, normalizeText, placeSponsored, qualityScore, rankAndPrice, remainingBudgetPaise, toPaise, withGst,
} from './ads-engine.js'
import { getSettings, IST_DAY_SQL, newNonce, signImpression } from './ads.shared.js'

// keyword ⇄ query match, in SQL. `k` = ad_keywords alias, $1 = normalised query.
const KW_MATCH = (k) => `(
  (${k}.match_type = 'EXACT'  AND ${k}.keyword = $1::text)
  OR (${k}.match_type = 'PHRASE' AND position(' ' || ${k}.keyword || ' ' in ' ' || $1::text || ' ') > 0)
  OR (${k}.match_type = 'BROAD'  AND string_to_array(${k}.keyword, ' ') <@ string_to_array($1::text, ' '))
)`

const CANDIDATES_SQL = `
  SELECT c.id AS campaign_id, c.vendor_id, c.targeting, c.default_bid, c.daily_budget, c.total_budget,
         cp.product_id, cp.bid_override,
         k.id AS keyword_id, k.keyword, k.match_type, k.bid AS keyword_bid,
         (c.targeting = 'AUTO' AND $1::text IS NOT NULL AND (
            p.search_vector @@ websearch_to_tsquery('simple', $1::text) OR p.name ILIKE $5::text OR p.brand ILIKE $5::text
         )) AS auto_text_match,
         COALESCE((SELECT SUM(spend) FROM ad_stats_daily WHERE campaign_id = c.id AND day = ${IST_DAY_SQL}), 0) AS spent_today,
         CASE WHEN c.total_budget IS NULL THEN 0
              ELSE COALESCE((SELECT SUM(spend) FROM ad_stats_daily WHERE campaign_id = c.id), 0) END AS spent_total,
         COALESCE((SELECT SUM(impressions) FROM ad_stats_daily WHERE campaign_id = c.id AND product_id = cp.product_id AND day >= ${IST_DAY_SQL} - 30), 0) AS impressions_30d,
         COALESCE((SELECT SUM(clicks)      FROM ad_stats_daily WHERE campaign_id = c.id AND product_id = cp.product_id AND day >= ${IST_DAY_SQL} - 30), 0) AS clicks_30d,
         p.id AS p_id, p.name, p.slug, p.brand, p.thumbnail, p.images, p.rating_avg, p.rating_count,
         p.condition, p.condition_notes, p.warranty_info, p.owner_type, p.gst_rate, p.return_policy_days, p.category_id,
         l.id AS listing_id, l.shop_id, l.price AS list_price, l.sale_price, l.mrp, l.stock_quantity,
         l.cod_eligible, l.nationwide_shipping_enabled, l.local_delivery_enabled, l.handling_time_days, l.min_order_qty, l.seller_sku,
         s.name AS shop_name, s.seller_rating AS shop_rating, s.pincode AS shop_pincode,
         COALESCE(v.name, 'Dealker') AS seller_name, v.name AS vendor_name,
         COALESCE(l.sale_price, l.price, p.sale_price, p.price) AS effective_price,
         ($3::text IS NOT NULL AND (s.pincode = $3::text OR $3::text = ANY (s.serviceable_pincodes))) AS pincode_match
    FROM ad_campaigns c
    JOIN ad_wallets w ON w.vendor_id = c.vendor_id AND w.balance >= $4::numeric
    JOIN ad_campaign_products cp ON cp.campaign_id = c.id AND cp.status = 'ACTIVE'
    JOIN products p ON p.id = cp.product_id AND p.deleted_at IS NULL AND p.is_active = TRUE
    JOIN LATERAL (
      SELECT sp.* FROM shop_products sp JOIN shops sx ON sx.id = sp.shop_id
       WHERE sp.product_id = cp.product_id AND sx.vendor_id = c.vendor_id AND sx.deleted_at IS NULL AND sx.is_active = TRUE
         AND sp.deleted_at IS NULL AND sp.listing_status = 'ACTIVE' AND sp.approval_status = 'APPROVED'
         AND sp.stock_quantity > 0 AND sp.is_available = TRUE
       ORDER BY ($3::text IS NOT NULL AND (sx.pincode = $3::text OR $3::text = ANY (sx.serviceable_pincodes))) DESC,
                COALESCE(sp.sale_price, sp.price) ASC
       LIMIT 1
    ) l ON TRUE
    JOIN shops s ON s.id = l.shop_id
    LEFT JOIN vendors v ON v.id = c.vendor_id
    LEFT JOIN ad_keywords k ON c.targeting = 'MANUAL' AND $1::text IS NOT NULL AND k.campaign_id = c.id
                           AND k.status = 'ACTIVE' AND NOT k.is_negative AND ${KW_MATCH('k')}
   WHERE c.status = 'ACTIVE'
     AND c.starts_on <= ${IST_DAY_SQL} AND (c.ends_on IS NULL OR c.ends_on >= ${IST_DAY_SQL})
     AND (
           (c.targeting = 'AUTO' AND (
               ($1::text IS NOT NULL AND (p.search_vector @@ websearch_to_tsquery('simple', $1::text) OR p.name ILIKE $5::text OR p.brand ILIKE $5::text))
            OR ($2::uuid IS NOT NULL AND (p.category_id = $2::uuid OR p.category_id IN (SELECT id FROM categories WHERE parent_id = $2::uuid)))
           ))
        OR (c.targeting = 'MANUAL' AND k.id IS NOT NULL)
         )
     AND NOT EXISTS (
           SELECT 1 FROM ad_keywords nk
            WHERE nk.campaign_id = c.id AND nk.is_negative AND nk.status = 'ACTIVE' AND $1::text IS NOT NULL AND ${KW_MATCH('nk')}
         )`

/**
 * Winners for one results page, already priced and token-signed.
 * @returns {Promise<Array<object>>} product cards flagged `is_sponsored`
 */
export async function serve({ q = '', categoryId = null, pincode = '', userId = null, page = 1 } = {}) {
  const s = await getSettings()
  if (!s.enabled || s.slots_per_page <= 0) return []

  const nq = normalizeText(q)
  if (!nq && !categoryId) return []

  const minCpcPaise = toPaise(s.min_cpc)
  const maxCpcPaise = toPaise(s.max_cpc)
  const minWallet = fromPaise(withGst(minCpcPaise, s.gst_pct).grossPaise)

  const { rows } = await query(CANDIDATES_SQL, [
    nq || null, categoryId || null, pincode || null, minWallet, nq ? `%${nq}%` : null,
  ])
  if (!rows.length) return []

  // One candidate per (campaign, product): keep the strongest keyword match.
  const best = new Map()
  for (const r of rows) {
    const matchKind = r.targeting === 'AUTO' ? (r.auto_text_match ? 'AUTO' : 'CATEGORY') : r.match_type
    if (r.targeting === 'MANUAL' && !keywordMatches(r.match_type, r.keyword, nq)) continue // SQL/JS parity guard
    const bidPaise = toPaise(r.targeting === 'MANUAL' ? (r.keyword_bid ?? r.bid_override ?? r.default_bid) : (r.bid_override ?? r.default_bid))
    const remaining = remainingBudgetPaise({
      dailyBudgetPaise: toPaise(r.daily_budget), spentTodayPaise: toPaise(r.spent_today),
      totalBudgetPaise: r.total_budget == null ? null : toPaise(r.total_budget), spentTotalPaise: toPaise(r.spent_total),
    })
    if (remaining < minCpcPaise) continue
    const serviceable = !!r.pincode_match || !!r.nationwide_shipping_enabled
    const quality = qualityScore({
      matchKind, impressions30d: Number(r.impressions_30d), clicks30d: Number(r.clicks_30d),
      ratingAvg: Number(r.rating_avg || 0), ratingCount: Number(r.rating_count || 0), serviceable,
    })
    const key = `${r.campaign_id}:${r.product_id}`
    const cand = { key, campaignId: r.campaign_id, vendorId: r.vendor_id, productId: r.product_id, bidPaise, quality, remaining, matchKind, keyword: r.keyword || null, row: r }
    const prev = best.get(key)
    if (!prev || cand.bidPaise * cand.quality > prev.bidPaise * prev.quality) best.set(key, cand)
  }

  const slots = s.slots_per_page
  const page1 = Math.max(1, Number(page) || 1)
  const priced = rankAndPrice([...best.values()], {
    minCpcPaise, maxCpcPaise, slots: slots * page1, perVendorCap: s.max_ads_per_vendor_per_page * page1, minQuality: Number(s.min_quality_score),
  }).slice((page1 - 1) * slots, page1 * slots)

  // Drop winners whose remaining budget can't cover the price they'd actually pay.
  const winners = priced.filter((w) => w.remaining >= w.cpcPaise)
  if (!winners.length) return []

  recordImpressions(winners).catch((err) => logger.warn({ err: err.message, action: 'ads_impression_failed' }, 'Impression recording failed'))

  const exp = Date.now() + s.impression_token_ttl_minutes * 60_000
  return winners.map((w) => {
    const r = w.row
    const token = signImpression({
      n: newNonce(), c: w.campaignId, v: w.vendorId, p: w.productId,
      k: w.keyword, q: nq || null, u: userId || null, b: fromPaise(w.cpcPaise), e: exp,
    })
    return {
      product_id: r.product_id, listing_id: r.listing_id, shop_id: r.shop_id,
      name: r.name, slug: r.slug, brand: r.brand, thumbnail: r.thumbnail, images: r.images,
      rating_avg: r.rating_avg, rating_count: r.rating_count,
      condition: r.condition, condition_notes: r.condition_notes, warranty_info: r.warranty_info, owner_type: r.owner_type,
      seller_name: r.seller_name, vendor_id: r.vendor_id, vendor_name: r.vendor_name,
      gst_rate: r.gst_rate, return_policy_days: r.return_policy_days, category_id: r.category_id,
      list_price: r.list_price, sale_price: r.sale_price, mrp: r.mrp, stock_quantity: r.stock_quantity,
      cod_eligible: r.cod_eligible, nationwide_shipping_enabled: r.nationwide_shipping_enabled,
      local_delivery_enabled: r.local_delivery_enabled, handling_time_days: r.handling_time_days,
      min_order_qty: r.min_order_qty, seller_sku: r.seller_sku,
      shop_name: r.shop_name, shop_rating: r.shop_rating, shop_pincode: r.shop_pincode,
      effective_price: r.effective_price, pincode_match: !!r.pincode_match,
      delivery_tier: r.pincode_match && r.local_delivery_enabled ? 'LOCAL' : 'NATIONWIDE',
      is_sponsored: true,
      // The price and keyword stay inside the signed token — never in the clear.
      ad: { label: 'Sponsored', token },
    }
  })
}

async function recordImpressions(winners) {
  await query(
    `INSERT INTO ad_stats_daily (campaign_id, product_id, day, impressions)
     SELECT c, p, ${IST_DAY_SQL}, 1 FROM unnest($1::uuid[], $2::uuid[]) AS t(c, p)
     ON CONFLICT (campaign_id, product_id, day) DO UPDATE SET impressions = ad_stats_daily.impressions + 1`,
    [winners.map((w) => w.campaignId), winners.map((w) => w.productId)]
  )
}

/**
 * Decorate a discovery `search()` result with sponsored placements.
 * Any failure → the organic result is returned unchanged.
 */
export async function injectSponsored(result, ctx) {
  try {
    const s = await getSettings()
    if (!s.enabled) return result
    const sponsored = await serve(ctx)
    if (!sponsored.length) return result
    return {
      ...result,
      data: placeSponsored(result.data || [], sponsored, { first: s.first_slot_position, spacing: s.slot_spacing }),
      sponsored: { count: sponsored.length, label: 'Sponsored' },
    }
  } catch (err) {
    logger.error({ err: err.message, action: 'ads_inject_failed' }, 'Sponsored injection failed — serving organic results')
    return result
  }
}
