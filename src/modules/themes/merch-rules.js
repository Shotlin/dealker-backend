/**
 * Rule-based product filling for home sections (Deals & Merchandising page).
 *
 * A section — or one tab of a tabbed section — can carry `rules`: filters + a sort
 * + an optional per-brand cap. The same function feeds the public manifest and the
 * admin live preview, so what the admin sees is what shoppers get.
 */
import { query } from '../../config/database.js'
import { withCardFields } from '../../utils/product-card-fields.js'
import { buildCustomerVisibilitySnippet, buildShopPriceJoin } from '../products/products.repository.js'

export const RULE_SORTS = ['best_selling', 'discount', 'newest', 'price_asc', 'price_desc', 'rating']

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// null / undefined / '' mean "not set" — Number(null) is 0, which would turn an unset max price into "≤ 0".
const num = (v, lo, hi) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= lo ? Math.min(n, hi) : null
}
const strList = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 30) : [])

/** Clamp/clean untrusted rules. Returns null when no filter is set. */
export function normalizeRules(raw) {
  if (!raw || typeof raw !== 'object') return null
  const rules = {
    category_ids: (Array.isArray(raw.category_ids) ? raw.category_ids : []).filter((x) => UUID.test(x)).slice(0, 30),
    brands: strList(raw.brands),
    tags: strList(raw.tags),
    min_price: num(raw.min_price, 0, 10_000_000),
    max_price: num(raw.max_price, 0, 10_000_000),
    min_discount: num(raw.min_discount, 0, 95),
    min_rating: num(raw.min_rating, 0, 5),
    new_within_days: num(raw.new_within_days, 1, 3650),
    max_per_brand: num(raw.max_per_brand, 1, 50),
    sort: RULE_SORTS.includes(raw.sort) ? raw.sort : 'best_selling',
  }
  const active = rules.category_ids.length || rules.brands.length || rules.tags.length || rules.min_price != null
    || rules.max_price != null || rules.min_discount != null || rules.min_rating != null
    || rules.new_within_days != null || rules.max_per_brand != null || (raw.sort && RULE_SORTS.includes(raw.sort))
  return active ? rules : null
}

/**
 * @returns {Promise<{ products: object[], total: number }>} `total` = matches before the per-brand cap and limit.
 */
export async function getProductsByRules(rawRules, limit, excludeIds = [], allocatedShopIds = null, priceMode = 'retail') {
  const rules = normalizeRules(rawRules)
  if (!rules || limit <= 0) return { products: [], total: 0 }

  const params = []
  const p = (v) => { params.push(v); return `$${params.length}` }
  const visibility = buildCustomerVisibilitySnippet(allocatedShopIds, params, params.length + 1)
  const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx, priceMode)
  const legacyStockCheck = allocatedShopIds === null ? 'AND p.stock_quantity > 0' : ''

  const sale = shopPrice.salePriceExpr
  const price = shopPrice.priceExpr
  const eff = `(CASE WHEN COALESCE(${sale}, 0) > 0 THEN ${sale} ELSE ${price} END)`
  const disc = `(CASE WHEN COALESCE(${sale}, 0) > 0 AND ${price} > 0 THEN (1 - ${sale}::numeric / ${price}::numeric) * 100 ELSE 0 END)`

  const where = ['p.is_active = true']
  if (excludeIds.length) where.push(`NOT (p.id = ANY(${p(excludeIds)}::uuid[]))`)
  if (rules.category_ids.length) {
    const c = p(rules.category_ids)
    where.push(`(p.category_id = ANY(${c}::uuid[]) OR EXISTS (SELECT 1 FROM category_products cp WHERE cp.product_id = p.id AND cp.category_id = ANY(${c}::uuid[])))`)
  }
  if (rules.brands.length) where.push(`LOWER(p.brand) = ANY(${p(rules.brands.map((b) => b.toLowerCase()))}::text[])`)
  if (rules.tags.length) where.push(`p.tags && ${p(rules.tags)}::text[]`)
  if (rules.min_price != null) where.push(`${eff} >= ${p(rules.min_price)}`)
  if (rules.max_price != null) where.push(`${eff} <= ${p(rules.max_price)}`)
  if (rules.min_discount != null) where.push(`${disc} >= ${p(rules.min_discount)}`)
  if (rules.min_rating != null) where.push(`COALESCE(p.avg_rating, 0) >= ${p(rules.min_rating)}`)
  if (rules.new_within_days != null) where.push(`p.created_at >= NOW() - (${p(rules.new_within_days)} || ' days')::interval`)

  const orderBy = {
    best_selling: 'p.total_sold DESC, p.created_at DESC',
    discount: `${disc} DESC, p.total_sold DESC`,
    newest: 'p.created_at DESC',
    price_asc: `${eff} ASC`,
    price_desc: `${eff} DESC`,
    rating: 'COALESCE(p.avg_rating, 0) DESC, p.rating_count DESC',
  }[rules.sort]

  const brandCap = rules.max_per_brand != null ? p(Math.floor(rules.max_per_brand)) : null
  const limitIdx = p(limit)

  const { rows } = await query(
    `WITH base AS (
       SELECT
         p.id, p.name, p.slug,
         ${price} AS price, ${sale} AS sale_price, ${shopPrice.stockExpr} AS stock_quantity,
         p.unit, p.thumbnail_url, p.category_id, c.name AS category_name,
         COALESCE(p.images, '[]'::jsonb) AS images, COALESCE(p.tags, ARRAY[]::text[]) AS tags,
         p.is_active, p.is_featured, p.total_sold, p.description, p.ingredients, p.nutrition_info,
         p.highlights, p.storage_instructions, p.product_family_id, pf.name AS family_name,
         p.option_label, p.option_sort_order, p.is_default_option, p.food_type, p.origin_tag,
         p.custom_badges, p.display_delivery_minutes, p.net_quantity, p.brand, p.brand_logo_url,
         p.avg_rating, p.rating_count,
         COALESCE((SELECT COUNT(*)::int FROM products ps WHERE ps.product_family_id = p.product_family_id
                   AND ps.is_active = true AND ps.stock_quantity > 0), 1) AS option_count,
         ROW_NUMBER() OVER (ORDER BY ${orderBy}) AS rank_all,
         ROW_NUMBER() OVER (PARTITION BY LOWER(COALESCE(p.brand, p.id::text)) ORDER BY ${orderBy}) AS brand_rank,
         COUNT(*) OVER () AS total_matches
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN product_families pf ON pf.id = p.product_family_id
       ${shopPrice.joinSql}
       WHERE ${where.join(' AND ')} ${legacyStockCheck} ${visibility.sql}
     )
     SELECT * FROM base
     ${brandCap ? `WHERE brand_rank <= ${brandCap}` : ''}
     ORDER BY rank_all ASC
     LIMIT ${limitIdx}`,
    params
  )

  const total = rows.length ? Number(rows[0].total_matches) : 0
  const products = await withCardFields(rows.map(({ rank_all, brand_rank, total_matches, ...r }) => r))
  return { products, total }
}
