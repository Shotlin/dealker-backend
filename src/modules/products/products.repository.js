import { query } from '../../config/database.js'

function emptyPagination(page, limit) {
  return {
    data: [],
    pagination: {
      page,
      limit,
      total: 0,
      totalPages: 0,
    },
  }
}

function normalizeSearchTerms(q) {
  return String(q || '')
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter(Boolean)
}

/**
 * Customer-scoped visibility predicate (Requirements 1.5, 4.5, 11.5, 14.7).
 *
 * When an `allocatedShopIds` array is provided the predicate gates each
 * product on the existence of at least one shop_products row that:
 *   - belongs to a shop in the customer's User_Shop_Allocations
 *   - has is_available = true and deleted_at IS NULL
 *   - is on a shop with is_active = true and deleted_at IS NULL
 *
 * The helper appends to the existing `params` array and returns the SQL
 * snippet plus the next placeholder index. Callers that don't want
 * customer scoping (admin queries, anonymous browsing) pass `null` and
 * receive an empty snippet so the master-catalog SQL is unchanged.
 *
 * Implementation notes:
 *   - Uses idx_shop_products_shop_available (shop_id, is_available)
 *     and the products PK on `id` for the EXISTS lookup.
 *   - Casts $N::uuid[] so PostgreSQL can use the GIN-friendly array path
 *     without per-row casts on the inner query.
 *   - Only $-placeholder *numbers* are spliced into the returned string;
 *     all user-supplied values continue through the pg parameter bindings.
 *
 * @param {string[]|null} allocatedShopIds
 * @param {any[]} params - Mutated; the array of $-placeholder values.
 * @param {number} startIdx - Next available $-placeholder index.
 * @returns {{ sql: string, nextIdx: number }}
 */
export function buildCustomerVisibilitySnippet(allocatedShopIds, params, startIdx) {
  if (!Array.isArray(allocatedShopIds)) {
    return { sql: '', nextIdx: startIdx }
  }
  // Empty allocations → caller is expected to short-circuit; we still emit a
  // predicate that matches no rows in case we get here defensively.
  if (allocatedShopIds.length === 0) {
    return { sql: 'AND FALSE', nextIdx: startIdx }
  }
  params.push(allocatedShopIds)
  const idx = startIdx
  return {
    sql: `AND EXISTS (
      SELECT 1
        FROM shop_products sp
        JOIN shops s ON s.id = sp.shop_id
       WHERE sp.product_id = p.id
         AND sp.shop_id = ANY($${idx}::uuid[])
         AND sp.is_available = true
         AND sp.deleted_at IS NULL
         AND s.is_active = true
         AND s.deleted_at IS NULL
    )`,
    nextIdx: startIdx + 1,
  }
}

/**
 * Customer-scoped price/stock resolution. A customer-facing response must
 * show the price they'll actually be charged and the stock the shop
 * actually has — the shop's own `shop_products` listing — never the
 * master `products.price`/`products.stock_quantity`, which are only the
 * admin-facing catalog/MRP figures and can legitimately differ per shop.
 *
 * LEFT JOIN LATERAL picks the single best-matching shop_products row
 * (cheapest among the customer's allocated shops that actually carry it)
 * and pulls price, sale_price AND stock_quantity from that same row, so
 * none of them mismatch across different shops. `allocatedShopIds = null`
 * (admin/anonymous callers) falls back to the master values unchanged —
 * this only changes customer-facing (mobile app) responses.
 *
 * When a customer is allocated to exactly one shop carrying the product —
 * the only case a bare add-to-cart resolves without an explicit shop pick
 * (see cart.service.js `_resolveCartIdentity()` Path 3, which rejects
 * with CART_SHOP_REQUIRED for multi-shop matches) — this is EXACTLY the
 * price/stock that will be charged/deducted. In the rarer multi-shop case
 * it shows the cheapest option, a defensible "starting from ₹X" display.
 *
 * @param {string[]|null} allocatedShopIds
 * @param {any[]} params - Mutated; the array of $-placeholder values.
 * @param {number} startIdx - Next available $-placeholder index.
 * @returns {{ joinSql: string, priceExpr: string, salePriceExpr: string, stockExpr: string, nextIdx: number }}
 */
export function buildShopPriceJoin(allocatedShopIds, params, startIdx, priceMode = 'retail') {
  const isWholesale = priceMode === 'wholesale'
  if (!Array.isArray(allocatedShopIds) || allocatedShopIds.length === 0) {
    return {
      joinSql: '',
      priceExpr: isWholesale ? 'COALESCE(p.wholesale_price, p.price)' : 'p.price',
      // A "sale" discount is a retail concept — wholesale shows one flat
      // admin-set price with no separate strike-through MRP.
      salePriceExpr: isWholesale ? 'NULL' : 'p.sale_price',
      stockExpr: 'p.stock_quantity',
      nextIdx: startIdx,
    }
  }
  params.push(allocatedShopIds)
  const idx = startIdx
  return {
    joinSql: `LEFT JOIN LATERAL (
      SELECT sp.price AS sp_price, sp.sale_price AS sp_sale_price,
             sp.wholesale_price AS sp_wholesale_price,
             sp.stock_quantity AS sp_stock_quantity
        FROM shop_products sp
       WHERE sp.product_id = p.id
         AND sp.shop_id = ANY($${idx}::uuid[])
         AND sp.is_available = true AND sp.deleted_at IS NULL
       ORDER BY COALESCE(sp.sale_price, sp.price) ASC
       LIMIT 1
    ) shop_price ON true`,
    priceExpr: isWholesale
      ? 'COALESCE(shop_price.sp_wholesale_price, p.wholesale_price, shop_price.sp_price, p.price)'
      : 'COALESCE(shop_price.sp_price, p.price)',
    // A scoped store listing owns its retail promotion. Falling back to the
    // master sale price makes a store price of ₹100 display as a master
    // catalogue ₹95 sale even when that store has no sale configured.
    salePriceExpr: isWholesale ? 'NULL' : 'shop_price.sp_sale_price',
    stockExpr: 'COALESCE(shop_price.sp_stock_quantity, p.stock_quantity)',
    nextIdx: startIdx + 1,
  }
}

/**
 * Products repository — all SQL queries for products
 * NEVER uses SELECT * — always named columns
 *
 * Customer-facing read paths accept an optional `allocatedShopIds` array
 * that gates product visibility on the customer's User_Shop_Allocations
 * (Requirements 1.5, 4.5, 11.5). Admin/anonymous callers pass `null` to
 * preserve the legacy unscoped behaviour.
 */
export class ProductsRepository {
  /**
   * List products with filtering, sorting, pagination
   *
   * @param {object} filters
   * @param {string[]|null} [filters.allocatedShopIds] - When set, restrict
   *   results to products available in at least one allocated shop.
   */
  async findMany({
    page = 1,
    limit = 20,
    category,
    search,
    status,
    sort,
    minPrice,
    maxPrice,
    inStock,
    allocatedShopIds = null,
    groupOptions = false,
    priceMode = 'retail',
  }) {
    const offset = (page - 1) * limit
    const conditions = ['p.deleted_at IS NULL']
    const params = []
    let paramIdx = 1

    // Customer scoping (Req 1.5, 4.5, 11.5)
    const visibility = buildCustomerVisibilitySnippet(
      allocatedShopIds,
      params,
      paramIdx
    )
    if (visibility.sql) {
      // Strip the leading "AND " — we add it back via the conditions join
      conditions.push(visibility.sql.replace(/^AND\s+/, ''))
      paramIdx = visibility.nextIdx
    }

    // Customer-facing price/stock must be the shop's own listing, not the
    // master catalog — see buildShopPriceJoin() docstring. No-ops (falls
    // back to p.price/p.sale_price/p.stock_quantity) for admin/anonymous
    // callers. Computed before the stock/status filters below so they can
    // reference shopPrice.stockExpr instead of the raw master column.
    // Note: minPrice/maxPrice still filter on the master p.price —
    // changing filter semantics is a separate, riskier scope than fixing
    // the DISPLAYED price and isn't part of the reported bug.
    const shopPrice = buildShopPriceJoin(allocatedShopIds, params, paramIdx, priceMode)
    paramIdx = shopPrice.nextIdx

    // Status filter (for admin dashboard)
    if (status === 'active') {
      conditions.push('p.is_active = true')
    } else if (status === 'inactive') {
      conditions.push('p.is_active = false')
    } else if (status === 'out_of_stock') {
      conditions.push(`${shopPrice.stockExpr} = 0`)
    } else if (status === 'low_stock') {
      conditions.push(`${shopPrice.stockExpr} > 0 AND ${shopPrice.stockExpr} <= p.low_stock_threshold`)
    } else if (status === 'on_sale') {
      conditions.push('p.sale_price IS NOT NULL AND p.sale_price < p.price')
    }

    if (category) {
      conditions.push(`p.category_id = $${paramIdx++}`)
      params.push(category)
    }

    if (search) {
      conditions.push(`(p.name ILIKE $${paramIdx} OR p.sku ILIKE $${paramIdx} OR p.barcode ILIKE $${paramIdx})`)
      params.push(`%${search}%`)
      paramIdx++
    }

    if (minPrice !== undefined) {
      conditions.push(`p.price >= $${paramIdx++}`)
      params.push(minPrice)
    }

    if (maxPrice !== undefined) {
      conditions.push(`p.price <= $${paramIdx++}`)
      params.push(maxPrice)
    }

    if (inStock === true || inStock === 'true') {
      conditions.push(`${shopPrice.stockExpr} > 0`)
    } else if (inStock === false || inStock === 'false') {
      conditions.push(`${shopPrice.stockExpr} = 0`)
    }

    const sortMap = {
      price_asc: 'p.price ASC',
      price_desc: 'p.price DESC',
      newest: 'p.created_at DESC',
      popular: 'p.total_sold DESC',
      name_asc: 'p.name ASC',
      name_desc: 'p.name DESC',
      stock_asc: 'p.stock_quantity ASC',
    }
    const orderBy = sortMap[sort] || 'p.created_at DESC'
    const where = conditions.length > 0 ? conditions.join(' AND ') : '1=1'

    // option_count: number of active siblings in same family (or 1 if standalone)
    const optionCountExpr = `COALESCE(
      (SELECT COUNT(*)::int FROM products sib
       WHERE sib.product_family_id = p.product_family_id
         AND sib.product_family_id IS NOT NULL
         AND sib.is_active = true), 1)`

    if (groupOptions) {
      // When grouping, pick one representative per product_family_id:
      // prefer is_default_option, then lowest option_sort_order, then lowest price.
      // Standalone products (NULL family) always appear.
      const { rows } = await query(
        `WITH ranked AS (
          SELECT
            p.id, p.name, p.slug, ${shopPrice.priceExpr} AS price, ${shopPrice.salePriceExpr} AS sale_price,
            ${shopPrice.stockExpr} AS stock_quantity, p.unit, p.thumbnail_url,
            p.is_active, p.is_featured, p.total_sold,
            p.sku, p.barcode, p.low_stock_threshold, p.category_id, p.wholesale_price,
            p.product_family_id, p.option_label, p.option_sort_order,
            p.is_default_option, p.food_type, p.origin_tag, p.cut_type, p.piece_count, p.skin_type,
            p.custom_badges, p.display_delivery_minutes, p.cut_options, p.piece_options,
            p.avg_rating, p.rating_count, p.net_quantity,
            p.created_at,
            c.name AS category_name,
            pf.name AS family_name,
            ${optionCountExpr} AS option_count,
            ROW_NUMBER() OVER (
              PARTITION BY COALESCE(p.product_family_id, p.id)
              ORDER BY p.is_default_option DESC, p.option_sort_order ASC, p.price ASC
            ) AS rn
          FROM products p
          LEFT JOIN categories c ON c.id = p.category_id
          LEFT JOIN product_families pf ON pf.id = p.product_family_id
          ${shopPrice.joinSql}
          WHERE ${where}
        )
        SELECT id, name, slug, price, sale_price,
               stock_quantity, unit, thumbnail_url,
               is_active, is_featured, total_sold,
               sku, barcode, low_stock_threshold, category_id,
               product_family_id, option_label, option_sort_order,
               is_default_option, food_type, origin_tag, cut_type, piece_count, skin_type,
               custom_badges, display_delivery_minutes, cut_options, piece_options,
               avg_rating, rating_count, net_quantity,
               category_name, family_name, option_count
        FROM ranked
        WHERE rn = 1
        ORDER BY ${orderBy.replace(/p\./g, '')}
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      )

      const { rows: countRows } = await query(
        `WITH ranked AS (
          SELECT p.id,
            ROW_NUMBER() OVER (
              PARTITION BY COALESCE(p.product_family_id, p.id)
              ORDER BY p.is_default_option DESC, p.option_sort_order ASC, p.price ASC
            ) AS rn
          FROM products p
          ${shopPrice.joinSql}
          WHERE ${where}
        )
        SELECT COUNT(*)::int AS total FROM ranked WHERE rn = 1`,
        params
      )

      return {
        data: rows,
        pagination: {
          page,
          limit,
          total: countRows[0]?.total || 0,
          totalPages: Math.ceil((countRows[0]?.total || 0) / limit),
        },
      }
    }

    const { rows } = await query(
      `SELECT
        p.id, p.name, p.slug, ${shopPrice.priceExpr} AS price, ${shopPrice.salePriceExpr} AS sale_price,
        ${shopPrice.stockExpr} AS stock_quantity, p.unit, p.thumbnail_url,
        p.is_active, p.is_featured, p.total_sold,
        p.sku, p.barcode, p.low_stock_threshold, p.category_id, p.wholesale_price,
        p.product_family_id, p.option_label, p.option_sort_order,
        p.is_default_option, p.food_type, p.origin_tag, p.cut_type, p.piece_count, p.skin_type,
        p.custom_badges, p.display_delivery_minutes, p.cut_options, p.piece_options,
        p.avg_rating, p.rating_count, p.net_quantity,
        c.name AS category_name,
        pf.name AS family_name,
        ${optionCountExpr} AS option_count
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN product_families pf ON pf.id = p.product_family_id
       ${shopPrice.joinSql}
       WHERE ${where}
       ORDER BY ${orderBy.replace('p.price', 'price').replace('p.stock_quantity', 'stock_quantity')}
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    )

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM products p ${shopPrice.joinSql} WHERE ${where}`,
      params
    )

    return {
      data: rows,
      pagination: {
        page,
        limit,
        total: countRows[0]?.total || 0,
        totalPages: Math.ceil((countRows[0]?.total || 0) / limit),
      },
    }
  }

  /**
   * Hybrid search: prefix full-text (simple dictionary) + ILIKE fallback.
   * Uses 'simple' dictionary so prefix queries like 'amu:*' match 'amul'
   * without English stemming issues. Returns fuzzy suggestions when 0 results.
   *
   * `search_vector` (migration 081) indexes name + brand (weight A), tags +
   * category name (weight B), meta title/description (weight C), and the
   * long description (weight D) — so a query matching only the category or
   * a tag still returns results, and ts_rank_cd naturally scores a
   * name/brand match higher than a category/tag match, higher again than a
   * plain description match. The ILIKE fallback mirrors the same field set
   * for the (rarer) case where the ranked FTS branch finds nothing.
   *
   * @param {string} q
   * @param {object} filters
   * @param {string[]|null} [filters.allocatedShopIds]
   */
  async fullTextSearch(q, { page = 1, limit = 20, allocatedShopIds = null, priceMode = 'retail' }) {
    const offset = (page - 1) * limit
    const trimmed = String(q || '').trim()
    const searchTerms = normalizeSearchTerms(trimmed)

    if (!trimmed || searchTerms.length === 0) {
      return { ...emptyPagination(page, limit), suggestions: [] }
    }

    const prefixTsQuery = searchTerms.map((term) => `${term}:*`).join(' & ')
    const likePattern = `%${trimmed}%`

    const params = [prefixTsQuery, likePattern]
    const visibility = buildCustomerVisibilitySnippet(
      allocatedShopIds,
      params,
      params.length + 1
    )
    const visClause = visibility.sql

    const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx, priceMode)

    // $1 = prefixTsQuery, $2 = likePattern, optional $3 = shop_ids for
    // visibility, optional $4 = shop_ids again for price resolution,
    // then limit + offset.
    const limitIdx = shopPrice.nextIdx
    const offsetIdx = shopPrice.nextIdx + 1

    const sql = `
      WITH fts AS (
        SELECT
          p.id,
          p.name,
          p.slug,
          ${shopPrice.priceExpr} AS price,
          ${shopPrice.salePriceExpr} AS sale_price,
          ${shopPrice.stockExpr} AS stock_quantity,
          p.unit,
          p.thumbnail_url,
          c.name AS category_name,
          p.is_featured,
          p.total_sold,
          p.product_family_id, p.option_label, p.option_sort_order,
          p.is_default_option, p.food_type, p.origin_tag, p.cut_type, p.piece_count, p.skin_type,
          p.custom_badges, p.display_delivery_minutes, p.cut_options, p.piece_options,
          p.avg_rating, p.rating_count, p.net_quantity,
          pf.name AS family_name,
          ts_rank_cd(p.search_vector, to_tsquery('simple', $1)) AS rank,
          1 AS source
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN product_families pf ON pf.id = p.product_family_id
        ${shopPrice.joinSql}
        WHERE p.is_active = true
          AND p.search_vector @@ to_tsquery('simple', $1)
          ${visClause}
      ),
      ilike_fallback AS (
        SELECT
          p.id,
          p.name,
          p.slug,
          ${shopPrice.priceExpr} AS price,
          ${shopPrice.salePriceExpr} AS sale_price,
          ${shopPrice.stockExpr} AS stock_quantity,
          p.unit,
          p.thumbnail_url,
          c.name AS category_name,
          p.is_featured,
          p.total_sold,
          p.product_family_id, p.option_label, p.option_sort_order,
          p.is_default_option, p.food_type, p.origin_tag, p.cut_type, p.piece_count, p.skin_type,
          p.custom_badges, p.display_delivery_minutes, p.cut_options, p.piece_options,
          p.avg_rating, p.rating_count, p.net_quantity,
          pf.name AS family_name,
          0.1 AS rank,
          2 AS source
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN product_families pf ON pf.id = p.product_family_id
        ${shopPrice.joinSql}
        WHERE p.is_active = true
          AND p.id NOT IN (SELECT id FROM fts)
          AND (
            p.name ILIKE $2
            OR p.sku ILIKE $2
            OR p.barcode ILIKE $2
            OR p.brand ILIKE $2
            OR c.name ILIKE $2
            OR EXISTS (SELECT 1 FROM unnest(p.tags) tag WHERE tag ILIKE $2)
          )
          ${visClause}
      ),
      combined AS (
        SELECT * FROM fts
        UNION ALL
        SELECT * FROM ilike_fallback
      )
      SELECT
        id,
        name,
        slug,
        price,
        sale_price,
        stock_quantity,
        unit,
        thumbnail_url,
        category_name,
        is_featured,
        total_sold,
        product_family_id, option_label, option_sort_order,
        is_default_option, food_type, origin_tag, cut_type, piece_count, skin_type,
        custom_badges, display_delivery_minutes, cut_options, piece_options,
        avg_rating, rating_count, net_quantity,
        family_name,
        rank
      FROM combined
      ORDER BY source ASC, rank DESC, total_sold DESC, name ASC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `

    const countSql = `
      SELECT COUNT(DISTINCT id)::int AS total
      FROM (
        SELECT p.id
        FROM products p
        WHERE p.is_active = true
          AND p.search_vector @@ to_tsquery('simple', $1)
          ${visClause}
        UNION
        SELECT p.id
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.is_active = true
          AND (
            p.name ILIKE $2
            OR p.sku ILIKE $2
            OR p.barcode ILIKE $2
            OR p.brand ILIKE $2
            OR c.name ILIKE $2
            OR EXISTS (SELECT 1 FROM unnest(p.tags) tag WHERE tag ILIKE $2)
          )
          ${visClause}
      ) AS matches
    `

    // countSql only ever references up through the visibility placeholder
    // ($3 at most) — it doesn't join shop_price, so it must never receive
    // the extra shopPrice param appended to `params` below, or Postgres
    // rejects the bind ("supplies N parameters, but prepared statement
    // requires N-1").
    const countParams = params.slice(0, visibility.nextIdx - 1)

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(sql, [...params, limit, offset]),
      query(countSql, countParams),
    ])

    const total = countRows[0]?.total || 0

    // When no exact/prefix results, provide fuzzy nearest-match suggestions.
    // Suggestions inherit the same allocation scoping so customers never
    // see suggestions for products outside their allocated shops.
    let suggestions = []
    if (rows.length === 0 && trimmed.length >= 2) {
      suggestions = await this.fuzzySuggest(trimmed, 6, allocatedShopIds, priceMode)
    }

    return {
      data: rows,
      suggestions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }

  /**
   * Fuzzy suggestions using pg_trgm similarity.
   * Returns nearest products when exact/prefix search finds nothing.
   * Requires: CREATE EXTENSION pg_trgm (migration 017)
   *
   * @param {string} q
   * @param {number} [limit=6]
   * @param {string[]|null} [allocatedShopIds]
   */
  async fuzzySuggest(q, limit = 6, allocatedShopIds = null, priceMode = 'retail') {
    try {
      const params = [q]
      const visibility = buildCustomerVisibilitySnippet(
        allocatedShopIds,
        params,
        params.length + 1
      )
      const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx, priceMode)
      params.push(limit)
      const limitIdx = shopPrice.nextIdx

      const { rows } = await query(
        `SELECT p.id, p.name, p.slug, ${shopPrice.priceExpr} AS price, ${shopPrice.salePriceExpr} AS sale_price,
                ${shopPrice.stockExpr} AS stock_quantity, p.unit, p.thumbnail_url,
                c.name AS category_name,
                p.is_featured, p.total_sold,
                GREATEST(
                  similarity(p.name, $1),
                  similarity(COALESCE(p.brand, ''), $1),
                  similarity(COALESCE(c.name, ''), $1)
                ) AS sim
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         ${shopPrice.joinSql}
         WHERE p.is_active = true
           AND (
             similarity(p.name, $1) > 0.08
             OR similarity(COALESCE(p.brand, ''), $1) > 0.08
             OR similarity(COALESCE(c.name, ''), $1) > 0.08
           )
           ${visibility.sql}
         ORDER BY sim DESC, p.total_sold DESC
         LIMIT $${limitIdx}`,
        params
      )
      return rows
    } catch {
      // pg_trgm not available — return empty gracefully
      return []
    }
  }

  /**
   * Get featured/bestseller products
   *
   * @param {number} [limit=20]
   * @param {string[]|null} [allocatedShopIds]
   */
  async findFeatured(limit = 20, allocatedShopIds = null, priceMode = 'retail') {
    const params = []
    const visibility = buildCustomerVisibilitySnippet(
      allocatedShopIds,
      params,
      params.length + 1
    )
    const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx, priceMode)
    params.push(limit)
    const limitIdx = shopPrice.nextIdx

    const { rows } = await query(
      `SELECT p.id, p.name, p.slug, ${shopPrice.priceExpr} AS price, ${shopPrice.salePriceExpr} AS sale_price,
              ${shopPrice.stockExpr} AS stock_quantity, p.unit, p.thumbnail_url,
              c.name AS category_name, p.total_sold,
              p.product_family_id, p.option_label, p.option_sort_order,
              p.is_default_option, p.food_type, p.origin_tag, p.cut_type, p.piece_count, p.skin_type,
              p.custom_badges, p.display_delivery_minutes, p.cut_options, p.piece_options,
              p.avg_rating, p.rating_count, p.net_quantity,
              pf.name AS family_name,
              COALESCE(
                (SELECT COUNT(*)::int FROM products sib
                 WHERE sib.product_family_id = p.product_family_id
                   AND sib.product_family_id IS NOT NULL
                   AND sib.is_active = true), 1) AS option_count
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN product_families pf ON pf.id = p.product_family_id
       ${shopPrice.joinSql}
       WHERE p.is_active = true AND p.is_featured = true
         ${visibility.sql}
       ORDER BY p.total_sold DESC
       LIMIT $${limitIdx}`,
      params
    )
    return rows
  }

  /**
   * Resolve the best supplying shop for a product for a given customer.
   *
   * Prefers a shop in the customer's allocation (so the product can actually
   * be delivered), falling back to ANY active shop that carries it so the UI
   * can show "Sold by {storeName} — not available for delivery to {pincode}".
   *
   * @param {string} userId
   * @param {string} productId
   * @returns {Promise<{
   *   shop_product_id: string, shop_id: string, shop_name: string,
   *   is_available: boolean, stock_quantity: number, in_allocation: boolean
   * }|null>}
   */
  async findSupplyingShopForUser(userId, productId) {
    const { rows } = await query(
      `SELECT sp.id            AS shop_product_id,
              sp.shop_id,
              s.name           AS shop_name,
              sp.is_available,
              sp.stock_quantity,
              (a.user_id IS NOT NULL) AS in_allocation
         FROM shop_products sp
         JOIN shops s ON s.id = sp.shop_id
         LEFT JOIN user_shop_allocations a
                ON a.shop_id = sp.shop_id
               AND a.user_id = $1
        WHERE sp.product_id = $2
          AND sp.deleted_at IS NULL
          AND s.is_active = true
          AND s.deleted_at IS NULL
        ORDER BY (a.user_id IS NOT NULL) DESC,
                 a.is_primary DESC NULLS LAST,
                 sp.is_available DESC,
                 sp.stock_quantity DESC
        LIMIT 1`,
      [userId, productId]
    )
    return rows[0] || null
  }

  /**
   * Returns the customer's currently-selected delivery pincode (default
   * address first, else most recently updated). Null when no address exists.
   *
   * @param {string} userId
   * @returns {Promise<string|null>}
   */
  async findSelectedPincodeForUser(userId) {
    const { rows } = await query(
      `SELECT pincode
         FROM addresses
        WHERE user_id = $1 AND deleted_at IS NULL
        ORDER BY is_default DESC, updated_at DESC
        LIMIT 1`,
      [userId]
    )
    const pincode = rows[0]?.pincode
    return pincode ? String(pincode).trim() : null
  }

  /**
   * Get single product with full details
   *
   * @param {string} id
   * @param {string[]|null} [allocatedShopIds] - Customer scoping; when set
   *   the product is only returned if at least one allocated shop carries it.
   */
  async findById(id, allocatedShopIds = null, priceMode = 'retail') {
    const params = [id]
    const visibility = buildCustomerVisibilitySnippet(
      allocatedShopIds,
      params,
      params.length + 1
    )
    const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx, priceMode)

    const { rows } = await query(
      `SELECT p.id, p.name, p.slug, p.description, ${shopPrice.priceExpr} AS price, ${shopPrice.salePriceExpr} AS sale_price,
              p.cost_price, p.wholesale_price, p.category_id, ${shopPrice.stockExpr} AS stock_quantity, p.unit,
              p.thumbnail_url, p.images, p.tags, p.is_active,
              p.is_featured, p.total_sold,
              p.sku, p.barcode, p.low_stock_threshold, p.max_order_qty,
              p.ingredients, p.allergen_info, p.shelf_life, p.storage_instructions,
              p.certifications, p.nutrition_info,
              p.meta_title, p.meta_description,
              p.brand, p.brand_logo_url, p.net_quantity, p.highlights, p.attributes,
              p.vendor_name, p.vendor_address, p.vendor_fssai, p.return_policy,
              p.avg_rating, p.rating_count, p.is_authentic,
              p.product_family_id, p.option_label, p.option_sort_order,
              p.is_default_option, p.food_type, p.origin_tag, p.cut_type, p.piece_count, p.skin_type,
              p.custom_badges, p.display_delivery_minutes, p.cut_options, p.piece_options,
              c.name AS category_name,
              pf.name AS family_name,
              COALESCE(
                (SELECT COUNT(*)::int FROM products sib
                 WHERE sib.product_family_id = p.product_family_id
                   AND sib.product_family_id IS NOT NULL
                   AND sib.is_active = true), 1) AS option_count,
              (SELECT json_agg(v) FROM product_variants v WHERE v.product_id = p.id) AS variants,
              p.created_at, p.updated_at
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN product_families pf ON pf.id = p.product_family_id
       ${shopPrice.joinSql}
       WHERE p.id = $1
         ${visibility.sql}`,
      params
    )
    return rows[0] || null
  }

  /**
   * Get product by slug (public-facing)
   *
   * @param {string} slug
   * @param {string[]|null} [allocatedShopIds]
   */
  async findBySlug(slug, allocatedShopIds = null, priceMode = 'retail') {
    const params = [slug]
    const visibility = buildCustomerVisibilitySnippet(
      allocatedShopIds,
      params,
      params.length + 1
    )
    const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx, priceMode)

    const { rows } = await query(
      `SELECT p.id, p.name, p.slug, p.description, ${shopPrice.priceExpr} AS price, ${shopPrice.salePriceExpr} AS sale_price,
              p.cost_price, p.wholesale_price, p.category_id, ${shopPrice.stockExpr} AS stock_quantity, p.unit,
              p.thumbnail_url, p.images, p.tags, p.is_active,
              p.is_featured, p.total_sold,
              p.sku, p.barcode, p.low_stock_threshold, p.max_order_qty,
              p.ingredients, p.allergen_info, p.shelf_life, p.storage_instructions,
              p.certifications, p.nutrition_info,
              p.meta_title, p.meta_description,
              p.brand, p.brand_logo_url, p.net_quantity, p.highlights, p.attributes,
              p.vendor_name, p.vendor_address, p.vendor_fssai, p.return_policy,
              p.avg_rating, p.rating_count, p.is_authentic,
              p.product_family_id, p.option_label, p.option_sort_order,
              p.is_default_option, p.food_type, p.origin_tag, p.cut_type, p.piece_count, p.skin_type,
              p.custom_badges, p.display_delivery_minutes, p.cut_options, p.piece_options,
              c.name AS category_name,
              pf.name AS family_name,
              COALESCE(
                (SELECT COUNT(*)::int FROM products sib
                 WHERE sib.product_family_id = p.product_family_id
                   AND sib.product_family_id IS NOT NULL
                   AND sib.is_active = true), 1) AS option_count,
              (SELECT json_agg(v) FROM product_variants v WHERE v.product_id = p.id) AS variants,
              p.created_at, p.updated_at
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN product_families pf ON pf.id = p.product_family_id
       ${shopPrice.joinSql}
       WHERE p.slug = $1 AND p.is_active = true
         ${visibility.sql}`,
      params
    )
    return rows[0] || null
  }

  /**
   * Get related products (same category, excluding current)
   *
   * @param {string} productId
   * @param {string} categoryId
   * @param {number} [limit=10]
   * @param {string[]|null} [allocatedShopIds]
   */
  async findRelated(productId, categoryId, limit = 10, allocatedShopIds = null) {
    const params = [categoryId, productId]
    const visibility = buildCustomerVisibilitySnippet(
      allocatedShopIds,
      params,
      params.length + 1
    )
    const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx)
    params.push(limit)
    const limitIdx = shopPrice.nextIdx

    const { rows } = await query(
      `SELECT p.id, p.name, p.slug, ${shopPrice.priceExpr} AS price, ${shopPrice.salePriceExpr} AS sale_price,
              ${shopPrice.stockExpr} AS stock_quantity, p.unit, p.thumbnail_url, p.total_sold,
              p.product_family_id, p.option_label, p.option_sort_order,
              p.is_default_option, p.food_type, p.origin_tag, p.cut_type, p.piece_count, p.skin_type,
              p.custom_badges, p.display_delivery_minutes, p.cut_options, p.piece_options,
              p.avg_rating, p.rating_count, p.net_quantity,
              pf.name AS family_name
       FROM products p
       LEFT JOIN product_families pf ON pf.id = p.product_family_id
       ${shopPrice.joinSql}
       WHERE p.is_active = true
         AND ${shopPrice.stockExpr} > 0
         AND p.category_id = $1
         AND p.id != $2
         ${visibility.sql}
       ORDER BY p.total_sold DESC
       LIMIT $${limitIdx}`,
      params
    )
    return rows
  }

  /**
   * Active target_category_ids configured for `categoryId` via the admin's
   * Product Suggestions rules (migration 080, category_suggestion_rules).
   * Returns [] when the category has no configured rule — callers must
   * treat that as "no rule", not "suggest nothing", and fall back to their
   * own default behavior (see findPairWith below).
   */
  async getSuggestionTargetCategoryIds(categoryId) {
    const { rows } = await query(
      `SELECT target_category_id FROM category_suggestion_rules
       WHERE source_category_id = $1 AND is_active = true
       ORDER BY display_order ASC`,
      [categoryId]
    )
    return rows.map((r) => r.target_category_id)
  }

  /**
   * "Pair With" cross-sell candidates for a product.
   *
   * When the viewed product's category has admin-configured target
   * categories (`targetCategoryIds` non-empty — see getSuggestionTargetCategoryIds
   * / migration 080), candidates are restricted to those categories,
   * ranked by total_sold. A source category can legitimately target
   * itself (e.g. Dairy -> [Dairy, Bakery]), so same-category items are
   * allowed through in that case — only the current product is excluded.
   *
   * When no rule is configured (`targetCategoryIds` null/empty), falls
   * back to the original behavior: any other category, ranked by
   * total_sold — unchanged for every category the admin hasn't set up.
   *
   * @param {string} productId
   * @param {string} categoryId
   * @param {number} [limit=10]
   * @param {string[]|null} [allocatedShopIds]
   * @param {string[]|null} [targetCategoryIds]
   */
  async findPairWith(productId, categoryId, limit = 10, allocatedShopIds = null, targetCategoryIds = null) {
    const params = [categoryId, productId]

    let categoryPredicate = 'p.category_id != $1'
    if (Array.isArray(targetCategoryIds) && targetCategoryIds.length > 0) {
      params.push(targetCategoryIds)
      categoryPredicate = `p.category_id = ANY($${params.length}::uuid[])`
    }

    const visibility = buildCustomerVisibilitySnippet(
      allocatedShopIds,
      params,
      params.length + 1
    )
    const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx)
    params.push(limit)
    const limitIdx = shopPrice.nextIdx

    const { rows } = await query(
      `SELECT p.id, p.name, p.slug, ${shopPrice.priceExpr} AS price, ${shopPrice.salePriceExpr} AS sale_price,
              ${shopPrice.stockExpr} AS stock_quantity, p.unit, p.thumbnail_url,
              p.brand, p.total_sold, p.avg_rating, p.rating_count,
              c.name AS category_name,
              p.product_family_id, p.option_label, p.option_sort_order,
              p.is_default_option, p.food_type, p.origin_tag, p.cut_type, p.piece_count, p.skin_type,
              p.custom_badges, p.display_delivery_minutes, p.cut_options, p.piece_options,
              p.net_quantity,
              pf.name AS family_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN product_families pf ON pf.id = p.product_family_id
       ${shopPrice.joinSql}
       WHERE p.is_active = true
         AND ${shopPrice.stockExpr} > 0
         AND ${categoryPredicate}
         AND p.id != $2
         ${visibility.sql}
       ORDER BY p.total_sold DESC
       LIMIT $${limitIdx}`,
      params
    )
    return rows
  }

  /**
   * Popular products (by total_sold) across a set of categories — the
   * "same category as the cart" tier of the cart's Quick Add rail. Mirrors
   * findRelated()'s visibility/price handling but takes multiple category
   * ids and an arbitrary exclude list instead of excluding a single
   * product id.
   *
   * @param {string[]} categoryIds
   * @param {string[]} excludeProductIds
   * @param {number} limit
   * @param {string[]|null} [allocatedShopIds]
   */
  async findPopularByCategories(categoryIds, excludeProductIds, limit, allocatedShopIds = null) {
    if (!Array.isArray(categoryIds) || categoryIds.length === 0 || limit <= 0) return []

    const params = [categoryIds]
    let excludeSql = ''
    if (Array.isArray(excludeProductIds) && excludeProductIds.length > 0) {
      params.push(excludeProductIds)
      excludeSql = `AND p.id != ALL($${params.length}::uuid[])`
    }
    const visibility = buildCustomerVisibilitySnippet(allocatedShopIds, params, params.length + 1)
    const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx)
    params.push(limit)
    const limitIdx = shopPrice.nextIdx

    const { rows } = await query(
      `SELECT p.id, p.name, p.slug, ${shopPrice.priceExpr} AS price, ${shopPrice.salePriceExpr} AS sale_price,
              ${shopPrice.stockExpr} AS stock_quantity, p.unit, p.thumbnail_url, p.brand, p.total_sold,
              p.avg_rating, p.rating_count, p.net_quantity,
              p.product_family_id, p.option_label, p.option_sort_order,
              p.is_default_option, p.food_type, p.origin_tag, p.cut_type, p.piece_count, p.skin_type,
              p.custom_badges, p.display_delivery_minutes, p.cut_options, p.piece_options,
              pf.name AS family_name
         FROM products p
         LEFT JOIN product_families pf ON pf.id = p.product_family_id
         ${shopPrice.joinSql}
        WHERE p.is_active = true
          AND ${shopPrice.stockExpr} > 0
          AND p.category_id = ANY($1::uuid[])
          ${excludeSql}
          ${visibility.sql}
        ORDER BY p.total_sold DESC
        LIMIT $${limitIdx}`,
      params
    )
    return rows
  }

  /**
   * Random sample from the overall popular pool (top 100 by total_sold),
   * excluding given ids — the "surprise" tier of the cart's Quick Add rail,
   * and also the fallback used to top up any other tier that falls short.
   *
   * @param {string[]} excludeProductIds
   * @param {number} limit
   * @param {string[]|null} [allocatedShopIds]
   */
  async findPopularRandom(excludeProductIds, limit, allocatedShopIds = null) {
    if (limit <= 0) return []

    const params = []
    let excludeSql = ''
    if (Array.isArray(excludeProductIds) && excludeProductIds.length > 0) {
      params.push(excludeProductIds)
      excludeSql = `AND p.id != ALL($${params.length}::uuid[])`
    }
    const visibility = buildCustomerVisibilitySnippet(allocatedShopIds, params, params.length + 1)
    const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx)
    params.push(limit)
    const limitIdx = shopPrice.nextIdx

    const { rows } = await query(
      `SELECT * FROM (
         SELECT p.id, p.name, p.slug, ${shopPrice.priceExpr} AS price, ${shopPrice.salePriceExpr} AS sale_price,
                ${shopPrice.stockExpr} AS stock_quantity, p.unit, p.thumbnail_url, p.brand, p.total_sold,
                p.avg_rating, p.rating_count, p.net_quantity,
                p.product_family_id, p.option_label, p.option_sort_order,
                p.is_default_option, p.food_type, p.origin_tag, p.cut_type, p.piece_count, p.skin_type,
                p.custom_badges, p.display_delivery_minutes, p.cut_options, p.piece_options,
                pf.name AS family_name
           FROM products p
           LEFT JOIN product_families pf ON pf.id = p.product_family_id
           ${shopPrice.joinSql}
          WHERE p.is_active = true
            AND ${shopPrice.stockExpr} > 0
            ${excludeSql}
            ${visibility.sql}
          ORDER BY p.total_sold DESC
          LIMIT 100
       ) popular
       ORDER BY RANDOM()
       LIMIT $${limitIdx}`,
      params
    )
    return rows
  }

  /**
   * Find all purchasable options for a product's family.
   *
   * @param {string} productId
   * @param {string[]|null} [allocatedShopIds] - Customer shop scoping
   * @returns {{ family: object|null, options: object[] }}
   */
  async findFamilyOptions(productId, allocatedShopIds = null) {
    // 1. Look up the product's family
    const { rows: productRows } = await query(
      `SELECT p.id, p.name, p.slug, p.price, p.sale_price,
              p.stock_quantity, p.unit, p.thumbnail_url,
              p.product_family_id, p.option_label, p.option_sort_order,
              p.is_default_option, p.food_type, p.origin_tag, p.cut_type, p.piece_count, p.skin_type,
              p.custom_badges, p.display_delivery_minutes, p.cut_options, p.piece_options,
              p.avg_rating, p.rating_count, p.net_quantity,
              p.category_id, p.is_active
       FROM products p
       WHERE p.id = $1`,
      [productId]
    )

    if (productRows.length === 0) return null

    const product = productRows[0]
    const familyId = product.product_family_id

    // 2. If no family, return just this product as a single option
    if (!familyId) {
      const option = { ...product }
      // Enrich with shop data if customer context
      if (Array.isArray(allocatedShopIds) && allocatedShopIds.length > 0) {
        const shopData = await this._fetchShopDataForProducts([product.id], allocatedShopIds)
        const shop = shopData[product.id]
        if (shop) {
          Object.assign(option, shop)
          // Customer-facing price/stock must be the shop's own listing —
          // the Object.assign above only added sp_price/sp_sale_price/
          // sp_stock_quantity as EXTRA keys alongside the master price/
          // sale_price/stock_quantity already on `option`, so a caller
          // reading the conventional field names got the wrong (master)
          // values. Overwrite, then drop the now-redundant sp_* keys so
          // there's exactly one unambiguous value per field.
          option.price = shop.sp_price ?? option.price
          option.sale_price = shop.sp_sale_price ?? null
          option.stock_quantity = shop.sp_stock_quantity ?? option.stock_quantity
          delete option.sp_price
          delete option.sp_sale_price
          delete option.sp_stock_quantity
          delete option.sp_is_available
        }
      }
      return {
        family: null,
        options: [option],
      }
    }

    // 3. Get family info
    const { rows: familyRows } = await query(
      `SELECT id, name, slug, description FROM product_families WHERE id = $1`,
      [familyId]
    )
    const family = familyRows[0] || null

    // 4. Get all active products in the family
    const { rows: options } = await query(
      `SELECT p.id, p.name, p.slug, p.price, p.sale_price,
              p.stock_quantity, p.unit, p.thumbnail_url,
              p.product_family_id, p.option_label, p.option_sort_order,
              p.is_default_option, p.food_type, p.origin_tag, p.cut_type, p.piece_count, p.skin_type,
              p.custom_badges, p.display_delivery_minutes, p.cut_options, p.piece_options,
              p.avg_rating, p.rating_count, p.net_quantity,
              p.category_id
       FROM products p
       WHERE p.product_family_id = $1
         AND p.is_active = true
       ORDER BY p.is_default_option DESC, p.option_sort_order ASC, p.name ASC`,
      [familyId]
    )

    // 5. Enrich with shop data if customer context
    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length > 0) {
      const productIds = options.map(o => o.id)
      const shopData = await this._fetchShopDataForProducts(productIds, allocatedShopIds)

      // Filter out options with no available shop_product and enrich the
      // rest. Same price/stock-overwrite as the standalone-product branch
      // above — the merge alone leaves sp_price/sp_sale_price/
      // sp_stock_quantity as extra keys beside the master price/sale_price/
      // stock_quantity, which is exactly the bug that let a variant
      // selector show the wrong price AND the wrong stock (a shop-listed,
      // in-stock item could show "not available" because of the master
      // product's unrelated stock number).
      const enrichedOptions = options
        .filter(o => shopData[o.id])
        .map(o => {
          const shop = shopData[o.id]
          const merged = { ...o, ...shop }
          merged.price = shop.sp_price ?? merged.price
          merged.sale_price = shop.sp_sale_price ?? null
          merged.stock_quantity = shop.sp_stock_quantity ?? merged.stock_quantity
          delete merged.sp_price
          delete merged.sp_sale_price
          delete merged.sp_stock_quantity
          delete merged.sp_is_available
          return merged
        })

      return { family, options: enrichedOptions }
    }

    return { family, options }
  }

  /**
   * Batch-fetch best shop_product data for a list of product IDs.
   * Returns a map of productId → shop data object.
   *
   * @param {string[]} productIds
   * @param {string[]} shopIds
   * @returns {Promise<Record<string, object>>}
   */
  async _fetchShopDataForProducts(productIds, shopIds) {
    if (!productIds.length || !shopIds.length) return {}

    const { rows } = await query(
      `SELECT DISTINCT ON (sp.product_id)
        sp.product_id, sp.id AS shop_product_id, sp.shop_id,
        sp.price AS sp_price, sp.sale_price AS sp_sale_price,
        sp.stock_quantity, sp.max_order_qty, sp.is_available
      FROM shop_products sp
      JOIN shops s ON s.id = sp.shop_id
      WHERE sp.product_id = ANY($1::uuid[])
        AND sp.shop_id = ANY($2::uuid[])
        AND sp.is_available = true
        AND sp.deleted_at IS NULL
        AND s.is_active = true
        AND s.deleted_at IS NULL
      ORDER BY sp.product_id, sp.stock_quantity DESC`,
      [productIds, shopIds]
    )

    const map = {}
    for (const row of rows) {
      map[row.product_id] = {
        shop_product_id: row.shop_product_id,
        shop_id: row.shop_id,
        sp_price: row.sp_price,
        sp_sale_price: row.sp_sale_price,
        sp_stock_quantity: row.stock_quantity,
        sp_max_order_qty: row.max_order_qty,
        sp_is_available: row.is_available,
      }
    }
    return map
  }

  /**
   * Create a new product
   */
  async create(data) {
    const { rows } = await query(
      `INSERT INTO products
        (name, slug, description, price, sale_price, cost_price, wholesale_price,
         category_id, stock_quantity, unit, thumbnail_url, images, tags,
         is_featured, is_active, sku, barcode, low_stock_threshold, max_order_qty,
         ingredients, allergen_info, shelf_life, storage_instructions,
         certifications, nutrition_info, meta_title, meta_description,
         brand, brand_logo_url, net_quantity, highlights, attributes,
         vendor_name, vendor_address, vendor_fssai, return_policy,
         avg_rating, rating_count, is_authentic,
         product_family_id, option_label, option_sort_order, is_default_option,
         food_type, origin_tag, custom_badges, display_delivery_minutes, cut_options, piece_options,
         cut_type, piece_count, skin_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50,$51,$52)
       RETURNING id, name, slug, price, sale_price, stock_quantity, unit,
                 thumbnail_url, category_id, is_featured, is_active, sku, created_at`,
      [
        data.name, data.slug, data.description || null,
        data.price, data.salePrice || null, data.costPrice || null, data.wholesalePrice ?? null,
        data.categoryId, data.stock || 0, data.unit || 'piece',
        data.thumbnailUrl || null, JSON.stringify(data.images || []),
        data.tags || [], data.isFeatured || false, data.isActive !== false,
        data.sku || null, data.barcode || null,
        data.lowStockThreshold || 10, data.maxOrderQty || null,
        data.ingredients || null, data.allergenInfo || null,
        data.shelfLife || null, data.storageInstructions || null,
        data.certifications || null,
        data.nutritionInfo ? data.nutritionInfo : null,
        data.metaTitle || null, data.metaDescription || null,
        data.brand || null, data.brandLogoUrl || null,
        data.netQuantity || null, JSON.stringify(data.highlights || {}),
        JSON.stringify(data.attributes || []),
        data.vendorName || null, data.vendorAddress || null,
        data.vendorFssai || null, data.returnPolicy || 'no_return',
        data.avgRating ?? 0, data.ratingCount ?? 0,
        data.isAuthentic !== false,
        data.productFamilyId || null, data.optionLabel || null,
        data.optionSortOrder ?? 0, data.isDefaultOption || false,
        data.foodType || 'NONE', data.originTag || 'NONE',
        JSON.stringify(data.customBadges || []),
        data.displayDeliveryMinutes || null,
        JSON.stringify(data.cutOptions || []), JSON.stringify(data.pieceOptions || []),
        data.cutType || null, data.pieceCount || null, data.skinType || 'NONE',
      ]
    )

    if (data.variants && data.variants.length > 0) {
      await this.saveVariants(rows[0].id, data.variants)
    }

    return rows[0]
  }

  /**
   * Update product fields
   */
  async update(id, data) {
    const fieldMap = {
      name: 'name', description: 'description', price: 'price',
      salePrice: 'sale_price', costPrice: 'cost_price',
      wholesalePrice: 'wholesale_price',
      categoryId: 'category_id', stock: 'stock_quantity',
      unit: 'unit', thumbnailUrl: 'thumbnail_url',
      isFeatured: 'is_featured', isActive: 'is_active', slug: 'slug',
      sku: 'sku', barcode: 'barcode',
      lowStockThreshold: 'low_stock_threshold', maxOrderQty: 'max_order_qty',
      ingredients: 'ingredients', allergenInfo: 'allergen_info',
      shelfLife: 'shelf_life', storageInstructions: 'storage_instructions',
      metaTitle: 'meta_title', metaDescription: 'meta_description',
      brand: 'brand', brandLogoUrl: 'brand_logo_url',
      netQuantity: 'net_quantity', vendorName: 'vendor_name',
      vendorAddress: 'vendor_address', vendorFssai: 'vendor_fssai',
      returnPolicy: 'return_policy', isAuthentic: 'is_authentic',
      avgRating: 'avg_rating', ratingCount: 'rating_count',
      productFamilyId: 'product_family_id',
      optionLabel: 'option_label',
      optionSortOrder: 'option_sort_order',
      isDefaultOption: 'is_default_option',
      foodType: 'food_type',
      originTag: 'origin_tag',
      displayDeliveryMinutes: 'display_delivery_minutes',
      cutType: 'cut_type',
      pieceCount: 'piece_count',
      skinType: 'skin_type',
    }

    const fields = []
    const params = []
    let idx = 1

    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbKey} = $${idx++}`)
        params.push(data[jsKey] === '' ? null : data[jsKey])
      }
    }

    // Handle JSON/array fields separately
    if (data.images !== undefined) {
      fields.push(`images = $${idx++}`)
      params.push(JSON.stringify(data.images))
    }
    if (data.tags !== undefined) {
      fields.push(`tags = $${idx++}`)
      params.push(data.tags)
    }
    if (data.highlights !== undefined) {
      fields.push(`highlights = $${idx++}`)
      params.push(JSON.stringify(data.highlights))
    }
    if (data.attributes !== undefined) {
      fields.push(`attributes = $${idx++}`)
      params.push(JSON.stringify(data.attributes))
    }
    if (data.certifications !== undefined) {
      fields.push(`certifications = $${idx++}`)
      params.push(data.certifications)
    }
    if (data.nutritionInfo !== undefined) {
      // Was missing from this fieldMap entirely — nutritionInfo saved fine
      // on product create (see create() above) but every subsequent edit
      // silently dropped it: the schema accepts the field, validation
      // passes, and the request 200s, but the UPDATE query never touched
      // the nutrition_info column.
      fields.push(`nutrition_info = $${idx++}`)
      params.push(data.nutritionInfo)
    }
    if (data.customBadges !== undefined) {
      fields.push(`custom_badges = $${idx++}`)
      params.push(JSON.stringify(data.customBadges))
    }
    if (data.cutOptions !== undefined) {
      fields.push(`cut_options = $${idx++}`)
      params.push(JSON.stringify(data.cutOptions))
    }
    if (data.pieceOptions !== undefined) {
      fields.push(`piece_options = $${idx++}`)
      params.push(JSON.stringify(data.pieceOptions))
    }
    if (data.variants !== undefined) {
      await this.saveVariants(id, data.variants)
    }

    if (fields.length === 0) return this.findById(id)

    fields.push(`updated_at = NOW()`)
    params.push(id)

    const { rows } = await query(
      `UPDATE products SET ${fields.join(', ')} WHERE id = $${idx}
       RETURNING id, name, slug, price, sale_price, stock_quantity, unit,
                 thumbnail_url, category_id, is_featured, is_active, updated_at`,
      params
    )
    return rows[0]
  }

  /**
   * Helper to save variants (deletes existing and inserts new)
   */
  async saveVariants(productId, variants) {
    if (!variants) return

    // Clear old variants
    await query(`DELETE FROM product_variants WHERE product_id = $1`, [productId])

    if (variants.length === 0) return

    // Insert new variants
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i]
      await query(
        `INSERT INTO product_variants
          (product_id, name, sku, price, sale_price, stock, display_order, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          productId,
          v.name || ("Variant " + (i + 1)),
          v.sku || null,
          v.price || 0,
          v.salePrice || null,
          v.stockQuantity ?? v.stock ?? 0,
          i,
          v.isActive !== false
        ]
      )
    }
  }

  /**
   * Update stock quantity only
   */
  async updateStock(id, stock) {
    const { rows } = await query(
      `UPDATE products SET stock_quantity = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, name, stock_quantity`,
      [stock, id]
    )
    return rows[0]
  }

  /**
   * Soft-delete product
   */
  async delete(id) {
    await query(
      `UPDATE products SET is_active = false, deleted_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id]
    )
  }

  /**
   * Find products with active price drops (sale_price < price)
   * Used in cart "Price Drop Alert" section
   *
   * @param {number} [limit=10]
   * @param {string[]|null} [allocatedShopIds]
   */
  async getPriceDrops(limit = 10, allocatedShopIds = null, priceMode = 'retail') {
    const params = []
    const visibility = buildCustomerVisibilitySnippet(
      allocatedShopIds,
      params,
      params.length + 1
    )
    // Which PRODUCTS qualify as "on sale" stays a master-catalog/admin
    // curation signal (p.sale_price < p.price below, unchanged) — but the
    // price actually DISPLAYED for a qualifying product must still be the
    // shop's own listing, same as everywhere else, so the discount shown
    // here always matches what checkout will charge.
    const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx, priceMode)
    params.push(limit)
    const limitIdx = shopPrice.nextIdx

    const { rows } = await query(
      `SELECT p.id, p.name, p.thumbnail_url,
              ${shopPrice.priceExpr} AS price, ${shopPrice.salePriceExpr} AS sale_price, p.unit, ${shopPrice.stockExpr} AS stock_quantity,
              (${shopPrice.priceExpr} - ${shopPrice.salePriceExpr}) AS discount
       FROM products p
       ${shopPrice.joinSql}
       WHERE p.is_active = true
         AND p.sale_price IS NOT NULL
         AND p.sale_price < p.price
         ${visibility.sql}
       ORDER BY discount DESC
       LIMIT $${limitIdx}`,
      params
    )
    return rows
  }

  /**
   * Find last-minute / cafe / snack products
   * Used in cart "Last-Minute Cravings" section
   *
   * @param {number} [limit=10]
   * @param {string[]|null} [allocatedShopIds]
   */
  async getLastMinute(limit = 10, allocatedShopIds = null, priceMode = 'retail') {
    const params = []
    const visibility = buildCustomerVisibilitySnippet(
      allocatedShopIds,
      params,
      params.length + 1
    )
    // "cheap enough to feature here" stays a master-catalog curation
    // filter (p.price <= 150 below, unchanged) — displayed price is the
    // shop's own listing, same reasoning as getPriceDrops() above.
    const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx, priceMode)
    params.push(limit)
    const limitIdx = shopPrice.nextIdx

    const { rows } = await query(
      `SELECT p.id, p.name, p.thumbnail_url, ${shopPrice.priceExpr} AS price, ${shopPrice.salePriceExpr} AS sale_price, p.unit
       FROM products p
       JOIN categories c ON p.category_id = c.id
       ${shopPrice.joinSql}
       WHERE p.is_active = true
         AND p.price <= 150
         AND (c.slug IN ('snacks','cafe','bakery','sweets','beverages')
              OR c.name ILIKE '%cafe%'
              OR c.name ILIKE '%snack%')
         ${visibility.sql}
       ORDER BY p.sale_price ASC NULLS LAST
       LIMIT $${limitIdx}`,
      params
    )
    return rows
  }

  async findPriceDrops(limit = 10, allocatedShopIds = null) {
    return this.getPriceDrops(limit, allocatedShopIds)
  }

  async findLastMinute(limit = 10, allocatedShopIds = null) {
    return this.getLastMinute(limit, allocatedShopIds)
  }
}
