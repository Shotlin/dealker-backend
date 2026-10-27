/**
 * Shop directory — the customer-facing list of vendor shops (Home "Shops (Nearby N)"
 * section, All-shops page) and the follow / unfollow toggle.
 */
import { query } from '../../config/database.js'
import { withCardFields } from '../../utils/product-card-fields.js'

const LISTED = `sp.shop_id = $1 AND sp.is_available = true AND sp.deleted_at IS NULL
  AND sp.approval_status = 'APPROVED' AND sp.listing_status = 'ACTIVE' AND p.is_active = true`

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v))

export class ShopDirectoryService {
  /**
   * Active vendor shops that currently sell something, nearest first when the
   * caller sends coordinates (distance_km), best rated first otherwise.
   */
  async list({ lat = null, lng = null, limit = 12, userId = null } = {}) {
    const la = num(lat)
    const ln = num(lng)
    const hasGeo = la != null && ln != null
    const params = [userId, hasGeo ? la : null, hasGeo ? ln : null, Math.min(30, Math.max(1, Number(limit) || 12))]
    const { rows } = await query(
      `SELECT * FROM (
         SELECT
           s.id, s.name, s.slug, s.logo_url, s.banner_url, s.city, s.state,
           s.address_line1, s.is_verified,
           COALESCE(s.seller_rating, 0)::float AS rating,
           COALESCE(s.rating_count, 0)::int AS rating_count,
           v.name AS vendor_name,
           (SELECT COUNT(*) FROM shop_products sp
              WHERE sp.shop_id = s.id AND sp.is_available = true AND sp.deleted_at IS NULL
                AND sp.approval_status = 'APPROVED' AND sp.listing_status = 'ACTIVE')::int AS product_count,
           (SELECT COUNT(*) FROM shop_follows f WHERE f.shop_id = s.id)::int AS follower_count,
           ($1::uuid IS NOT NULL AND EXISTS (
              SELECT 1 FROM shop_follows f WHERE f.shop_id = s.id AND f.user_id = $1::uuid)) AS is_following,
           CASE WHEN $2::float8 IS NULL OR s.lat IS NULL OR s.lng IS NULL THEN NULL
                ELSE ROUND((6371 * 2 * ASIN(SQRT(
                  POWER(SIN(RADIANS(s.lat::float8 - $2::float8) / 2), 2) +
                  COS(RADIANS($2::float8)) * COS(RADIANS(s.lat::float8)) *
                  POWER(SIN(RADIANS(s.lng::float8 - $3::float8) / 2), 2)
                )))::numeric, 1)::float
           END AS distance_km
         FROM shops s
         JOIN vendors v ON v.id = s.vendor_id
         WHERE s.is_active = true AND s.deleted_at IS NULL
           AND v.is_active = true AND v.deleted_at IS NULL AND v.status = 'ACTIVE'
       ) t
       WHERE t.product_count > 0
       ORDER BY t.distance_km ASC NULLS LAST, t.rating DESC, t.product_count DESC, t.name ASC
       LIMIT $4`,
      params
    )
    return {
      success: true,
      data: rows,
      meta: { total: rows.length, has_location: hasGeo },
    }
  }

  /** One shop's public profile (header, stats, address, category chips). */
  async profile(shopId, userId = null) {
    const { rows } = await query(
      `SELECT s.id, s.name, s.slug, s.description, s.logo_url, s.banner_url, s.is_verified,
              s.address_line1, s.address_line2, s.city, s.state, s.pincode,
              s.created_at, COALESCE(s.seller_rating, 0)::float AS rating,
              COALESCE(s.rating_count, 0)::int AS rating_count, v.name AS vendor_name,
              (SELECT COUNT(*) FROM shop_follows f WHERE f.shop_id = s.id)::int AS follower_count,
              ($2::uuid IS NOT NULL AND EXISTS (
                 SELECT 1 FROM shop_follows f WHERE f.shop_id = s.id AND f.user_id = $2::uuid)) AS is_following
         FROM shops s JOIN vendors v ON v.id = s.vendor_id
        WHERE s.id = $1 AND s.is_active = true AND s.deleted_at IS NULL AND v.deleted_at IS NULL`,
      [shopId, userId]
    )
    const shop = rows[0]
    if (!shop) return null
    const [{ rows: counts }, { rows: cats }] = await Promise.all([
      query(
        `SELECT COUNT(*)::int AS product_count,
                COUNT(*) FILTER (WHERE sp.sale_price IS NOT NULL AND sp.sale_price < sp.price)::int AS deal_count
           FROM shop_products sp JOIN products p ON p.id = sp.product_id
          WHERE ${LISTED}`,
        [shopId]
      ),
      query(
        `WITH lp AS (
           SELECT sp.id AS spid, p.id AS pid, p.category_id
             FROM shop_products sp JOIN products p ON p.id = sp.product_id WHERE ${LISTED}
         ), cat AS (
           SELECT spid, category_id AS cid FROM lp WHERE category_id IS NOT NULL
           UNION
           SELECT lp.spid, cp.category_id FROM lp JOIN category_products cp ON cp.product_id = lp.pid
         )
         SELECT c.id, c.name, c.image_url, COUNT(DISTINCT cat.spid)::int AS count
           FROM cat JOIN categories c ON c.id = cat.cid
          WHERE c.is_active = true AND c.category_type = 'STANDARD'
          GROUP BY c.id ORDER BY count DESC, c.name ASC`,
        [shopId]
      ),
    ])
    const total = counts[0]?.product_count ?? 0
    // A category holding every listing adds nothing next to "All" — hide it unless it is the only one.
    const categories = cats.length > 1 ? cats.filter((c) => c.count < total) : cats
    return {
      success: true,
      data: {
        ...shop,
        product_count: total,
        deal_count: counts[0]?.deal_count ?? 0,
        categories,
      },
    }
  }

  /** The shop's own listings as product cards (shop price + shop_product_id so Add to cart buys from this shop). */
  async products(shopId, { categoryId = null, deals = false, sort = 'popular', page = 1, limit = 24 } = {}) {
    const lim = Math.min(60, Math.max(1, Number(limit) || 24))
    const off = (Math.max(1, Number(page) || 1) - 1) * lim
    const order = {
      price_asc: 'COALESCE(sp.sale_price, sp.price) ASC',
      price_desc: 'COALESCE(sp.sale_price, sp.price) DESC',
      new: 'p.created_at DESC',
      discount: '(sp.price - COALESCE(sp.sale_price, sp.price)) / NULLIF(sp.price, 0) DESC NULLS LAST',
    }[sort] || 'p.total_sold DESC, p.is_featured DESC, p.created_at DESC'
    const params = [shopId, lim, off]
    let extra = ''
    if (categoryId) {
      params.push(categoryId)
      extra += ` AND (p.category_id = $${params.length} OR EXISTS (
        SELECT 1 FROM category_products cp WHERE cp.product_id = p.id AND cp.category_id = $${params.length}))`
    }
    if (deals) extra += ' AND sp.sale_price IS NOT NULL AND sp.sale_price < sp.price'
    const { rows } = await query(
      `SELECT p.id, p.name, p.slug, sp.price AS price, sp.sale_price AS sale_price,
              sp.stock_quantity AS stock_quantity, p.unit, p.thumbnail_url, p.category_id,
              c.name AS category_name, COALESCE(p.images, '[]'::jsonb) AS images,
              COALESCE(p.tags, ARRAY[]::text[]) AS tags, p.is_active, p.is_featured, p.total_sold,
              p.description, p.highlights, p.product_family_id, p.option_label, p.option_sort_order,
              p.is_default_option, p.custom_badges, p.net_quantity, p.brand,
              p.avg_rating, p.rating_count, 1 AS option_count,
              sp.id AS shop_product_id, sp.shop_id,
              COUNT(*) OVER()::int AS total_count
         FROM shop_products sp
         JOIN products p ON p.id = sp.product_id
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE ${LISTED}${extra}
        ORDER BY ${order}
        LIMIT $2 OFFSET $3`,
      params
    )
    const total = rows[0]?.total_count ?? 0
    const items = await withCardFields(rows.map(({ total_count, ...r }) => r))
    return { success: true, data: items, pagination: { page: Math.max(1, Number(page) || 1), limit: lim, total } }
  }

  async follow(userId, shopId) {
    const exists = await query('SELECT 1 FROM shops WHERE id = $1 AND deleted_at IS NULL', [shopId])
    if (!exists.rows.length) return null
    await query(
      'INSERT INTO shop_follows (user_id, shop_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, shopId]
    )
    return this.#state(userId, shopId)
  }

  async unfollow(userId, shopId) {
    await query('DELETE FROM shop_follows WHERE user_id = $1 AND shop_id = $2', [userId, shopId])
    return this.#state(userId, shopId)
  }

  async #state(userId, shopId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS follower_count,
              BOOL_OR(user_id = $1) AS is_following
         FROM shop_follows WHERE shop_id = $2`,
      [userId, shopId]
    )
    return {
      shop_id: shopId,
      follower_count: rows[0]?.follower_count ?? 0,
      is_following: Boolean(rows[0]?.is_following),
    }
  }
}
