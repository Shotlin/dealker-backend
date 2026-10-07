/**
 * Marketplace Catalog Service — location-first product discovery (spec §8/§31/§39)
 * and admin seller-listing moderation.
 *
 * Ranking = text relevance × availability × serviceability × LOCAL PROXIMITY
 * BOOST × delivery promise × seller rating × popularity. Local matching is a
 * ranking signal only — nationwide listings are never hidden just because the
 * customer is outside a shop's local radius.
 *
 * @module modules/marketplace-catalog/marketplace-catalog.service
 */

import { query } from '../../config/database.js'

// Haversine in pure SQL (no PostGIS dependency).
const DISTANCE_SQL = `
  CASE WHEN s.lat IS NOT NULL AND $2::numeric IS NOT NULL
    THEN (6371 * acos(LEAST(1.0, GREATEST(-1.0,
      cos(radians($2::numeric)) * cos(radians(s.lat)) * cos(radians(s.lng) - radians($3::numeric))
      + sin(radians($2::numeric)) * sin(radians(s.lat))))))
    ELSE NULL END`

export class MarketplaceCatalogService {
  /**
   * Ranked marketplace search.
   * @param {object} args
   * @param {string} [args.q] - free text
   * @param {string} [args.pincode] - delivery pincode (the location context)
   * @param {number} [args.lat] [args.lng] - customer coords when permitted
   */
  async search({ q = '', pincode = '', lat = null, lng = null, categoryId = null, brand = null, minPrice = null, maxPrice = null, minRating = null, condition = null, owner = null, inStockOnly = true, sort = 'relevance', page = 1, limit = 24 } = {}) {
    const params = [pincode || null, lat, lng]
    const pinMatchSql = pincode
      ? `(s.pincode = $1 OR $1::text = ANY (s.serviceable_pincodes))`
      : `FALSE`

    const where = [`($1::text IS NOT NULL OR $2::numeric IS NOT NULL OR $3::numeric IS NOT NULL OR TRUE)`, `p.deleted_at IS NULL`, `p.is_active = TRUE`, `sp.deleted_at IS NULL`, `s.deleted_at IS NULL`, `s.is_active = TRUE`, `sp.listing_status = 'ACTIVE'`, `sp.approval_status = 'APPROVED'`]
    if (inStockOnly) where.push(`sp.stock_quantity > 0 AND sp.is_available = TRUE`)
    if (brand) { params.push(brand); where.push(`p.brand = $${params.length}`) }
    if (categoryId) { params.push(categoryId); where.push(`(p.category_id = $${params.length} OR p.category_id IN (SELECT id FROM categories WHERE parent_id = $${params.length}))`) }
    if (minPrice != null) { params.push(minPrice); where.push(`COALESCE(sp.sale_price, sp.price, p.sale_price, p.price) >= $${params.length}`) }
    if (maxPrice != null) { params.push(maxPrice); where.push(`COALESCE(sp.sale_price, sp.price, p.sale_price, p.price) <= $${params.length}`) }
    if (condition) {
      params.push(condition === 'USED' ? ['USED_LIKE_NEW', 'USED_GOOD', 'USED_FAIR'] : [condition])
      where.push(`p.condition = ANY($${params.length})`)
    }
    if (owner) { params.push(owner); where.push(`p.owner_type = $${params.length}`) }
    if (minRating != null) { params.push(minRating); where.push(`p.rating_avg >= $${params.length}`) }
    if (q) {
      params.push(`%${q}%`)
      where.push(`(p.search_vector @@ websearch_to_tsquery('simple', $${params.length}) OR p.name ILIKE $${params.length} OR p.brand ILIKE $${params.length})`)
    }
    const whereSql = `WHERE ${where.join(' AND ')}`

    // Rank: local boost (pincode exact match), proximity within region,
    // availability, seller rating, popularity. Text relevance dominates.
    const relevance = q
      ? `ts_rank(p.search_vector, websearch_to_tsquery('simple', $${params.length}))`
      : `0`
    const rankSql = `
      ( ${relevance} * 10.0
        + CASE WHEN ${pinMatchSql} THEN 6.0 ELSE 0 END
        + CASE WHEN ${DISTANCE_SQL} IS NOT NULL AND ${DISTANCE_SQL} < 15 THEN GREATEST(0, 4.0 - ${DISTANCE_SQL} / 5.0) ELSE 0 END
        + CASE WHEN sp.stock_quantity > 0 THEN 2.0 ELSE 0 END
        + COALESCE(s.seller_rating, 0)
        + LEAST(COALESCE(p.popularity_score, 0) / 100.0, 2.0)
      )`

    const orderBy = {
      relevance: `rank_score DESC, p.rating_count DESC`,
      price_asc: `effective_price ASC`,
      price_desc: `effective_price DESC`,
      rating: `p.rating_avg DESC NULLS LAST, p.rating_count DESC`,
      newest: `p.created_at DESC`,
    }[sort] || `rank_score DESC, p.rating_count DESC`

    const offset = (Math.max(1, page) - 1) * limit
    const { rows } = await query(
      `WITH matched AS (
         SELECT p.id AS product_id, sp.id AS listing_id, s.id AS shop_id,
                ${q ? `${relevance} AS text_rank` : '0 AS text_rank'}
           FROM shop_products sp
           JOIN products p ON p.id = sp.product_id
           JOIN shops s ON s.id = sp.shop_id
           ${whereSql.replace('p.search_vector @@ websearch_to_tsquery', 'p.search_vector @@ websearch_to_tsquery')}
       )
       SELECT m.product_id, m.listing_id, m.shop_id,
              p.name, p.slug, p.brand, p.thumbnail, p.images, p.rating_avg, p.rating_count,
              p.condition, p.condition_notes, p.usage_duration, p.battery_health, p.warranty_info, p.owner_type,
              COALESCE(v.name, 'Dealker') AS seller_name,
              p.gst_rate, p.return_policy_days, p.category_id,
              sp.price AS list_price, sp.sale_price, sp.mrp, sp.stock_quantity,
              sp.cod_eligible, sp.nationwide_shipping_enabled, sp.local_delivery_enabled,
              sp.handling_time_days, sp.min_order_qty, sp.seller_sku,
              s.name AS shop_name, s.seller_rating AS shop_rating, s.pincode AS shop_pincode,
              s.vendor_id, v.name AS vendor_name,
              ${DISTANCE_SQL} AS distance_km,
              ${pinMatchSql.replace(/\$1/g, '$1')} AS pincode_match,
              CASE WHEN ${pinMatchSql} AND sp.local_delivery_enabled
                   THEN 'LOCAL' ELSE 'NATIONWIDE' END AS delivery_tier,
              COALESCE(sp.sale_price, sp.price, p.sale_price, p.price) AS effective_price,
              rank_score
         FROM matched m
         JOIN products p ON p.id = m.product_id
         JOIN shop_products sp ON sp.id = m.listing_id
         JOIN shops s ON s.id = m.shop_id
         LEFT JOIN vendors v ON v.id = s.vendor_id
         CROSS JOIN LATERAL (SELECT ${rankSql} AS rank_score, COALESCE(sp.sale_price, sp.price, p.sale_price, p.price) AS effective_price) calc
        ORDER BY ${orderBy}
        LIMIT ${limit} OFFSET ${offset}`,
      params
    )
    const { rows: countRows } = await query(
      `SELECT COUNT(DISTINCT p.id) AS total
         FROM shop_products sp
         JOIN products p ON p.id = sp.product_id
         JOIN shops s ON s.id = sp.shop_id
         ${whereSql}`,
      params
    )
    return {
      data: rows.map((r) => ({
        ...r,
        pincode_match: !!r.pincode_match,
        estimated_delivery: r.delivery_tier === 'LOCAL'
          ? `${1 + Number(r.handling_time_days || 0)}-${3 + Number(r.handling_time_days || 0)} days`
          : `${3 + Number(r.handling_time_days || 0)}-${7 + Number(r.handling_time_days || 0)} days`,
      })),
      ranking: { pincode: pincode || null, note: 'Local proximity is a boost, not a filter — nationwide listings stay visible.' },
      pagination: { page: Number(page), limit, total: Number(countRows[0]?.total || 0) },
    }
  }

  /** Home feed: nearby highlights + trending (theme builder can override). */
  async homeFeed({ pincode = '', lat = null, lng = null, limit = 12 } = {}) {
    const nearby = pincode || lat != null
      ? await this.search({ pincode, lat, lng, sort: 'relevance', limit })
      : { data: [] }
    const trending = await this.search({ sort: 'relevance', limit, inStockOnly: true })
    return { nearby: nearby.data || [], trending: trending.data || [] }
  }

  // ── Admin seller listings ─────────────────────────────────────────────

  async adminListings({ vendorId = null, shopId = null, status = '', approvalStatus = '', search = '', page = 1, limit = 20 } = {}) {
    const params = []
    const where = [`sp.deleted_at IS NULL`]
    if (vendorId) { params.push(vendorId); where.push(`s.vendor_id = $${params.length}`) }
    if (shopId) { params.push(shopId); where.push(`sp.shop_id = $${params.length}`) }
    if (status) { params.push(status); where.push(`sp.listing_status = $${params.length}`) }
    if (approvalStatus) { params.push(approvalStatus); where.push(`sp.approval_status = $${params.length}`) }
    if (search) { params.push(`%${search}%`); where.push(`(p.name ILIKE $${params.length} OR sp.seller_sku ILIKE $${params.length})`) }
    const whereSql = `WHERE ${where.join(' AND ')}`
    const offset = (Math.max(1, page) - 1) * limit
    const { rows } = await query(
      `SELECT sp.id, sp.shop_id, sp.product_id, sp.seller_sku, sp.price, sp.sale_price, sp.mrp,
              sp.stock_quantity, sp.listing_status, sp.approval_status, sp.nationwide_shipping_enabled,
              sp.local_delivery_enabled, sp.cod_eligible, sp.updated_at,
              p.name AS product_name, p.brand, p.thumbnail,
              s.name AS shop_name, s.vendor_id, v.name AS vendor_name
         FROM shop_products sp
         JOIN products p ON p.id = sp.product_id
         JOIN shops s ON s.id = sp.shop_id
         LEFT JOIN vendors v ON v.id = s.vendor_id
         ${whereSql}
        ORDER BY sp.updated_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )
    const { rows: count } = await query(
      `SELECT COUNT(*) AS total
         FROM shop_products sp
         JOIN products p ON p.id = sp.product_id
         JOIN shops s ON s.id = sp.shop_id
         ${whereSql}`,
      params
    )
    return { data: rows, pagination: { page: Number(page), limit, total: Number(count[0]?.total || 0) } }
  }

  async moderateListing(listingId, { listingStatus, approvalStatus, reason, actorId = null }) {
    const sets = ['updated_at = NOW()']
    const params = [listingId]
    if (listingStatus) {
      params.push(listingStatus)
      sets.push(`listing_status = $${params.length}`)
    }
    if (approvalStatus) {
      params.push(approvalStatus)
      sets.push(`approval_status = $${params.length}`)
    }
    await query(
      `UPDATE shop_products SET ${sets.join(', ')} WHERE id = $1`,
      params
    )
    if (reason || actorId) {
      await query(
        `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata)
         VALUES ($1, 'SELLER_LISTING_MODERATED', 'shop_products', $2, $3)
         ON CONFLICT DO NOTHING`,
        [actorId, listingId, JSON.stringify({ listingStatus, approvalStatus, reason })]
      ).catch(() => {})
    }
    const { rows } = await query(`SELECT * FROM shop_products WHERE id = $1`, [listingId])
    return rows[0]
  }
}
