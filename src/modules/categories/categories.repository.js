import { query, getClient } from '../../config/database.js'
import { buildShopPriceJoin } from '../products/products.repository.js'

/**
 * Product count for a category, counting BOTH a product's primary
 * category (products.category_id) AND any cross-listing via
 * category_products — a product can belong to its real category (e.g.
 * "Fresh Vegetables") and ALSO be cross-listed into another category (e.g.
 * "Exotic Vegetables") without duplication, since the LEFT JOIN can match
 * at most one category_products row per product per category (enforced by
 * the UNIQUE(category_id, product_id) constraint).
 */
const PRODUCT_COUNT_EXPR = (categoryAlias) => `(
      SELECT COUNT(DISTINCT p.id)::int
        FROM products p
        LEFT JOIN category_products cp ON cp.product_id = p.id AND cp.category_id = ${categoryAlias}.id
       WHERE p.is_active = true AND (p.category_id = ${categoryAlias}.id OR cp.category_id IS NOT NULL)
    )`

/**
 * Categories repository — all SQL queries for categories
 */
export class CategoriesRepository {
  /**
   * Get all active, non-bundle categories ordered by sort_order.
   *
   * BUNDLE-type categories are promo-only groupings (see migration 066) and
   * must never appear in the public category list/menu — they stay
   * reachable only by direct id (findById / findProducts), e.g. via a
   * banner deep-link. This also enforces is_active, which findAll()
   * previously did not (a pre-existing gap — an inactive category used to
   * still show up in the public menu).
   */
  async findAll() {
    const { rows } = await query(
      `SELECT c.id, c.name, c.slug, c.description, c.image_url, c.parent_id, c.sort_order, c.is_active, c.category_type, c.created_at,
              ${PRODUCT_COUNT_EXPR('c')} AS product_count
       FROM categories c
       WHERE c.deleted_at IS NULL AND c.is_active = true AND c.category_type != 'BUNDLE'
       ORDER BY c.sort_order ASC, c.name ASC`
    )
    return rows
  }

  /**
   * Find a single category by ID — used both for public category detail and
   * internally to resolve a category's type before querying its products.
   * Deliberately has no is_active/category_type filter: a hidden bundle
   * category, or a category the admin just deactivated, must still resolve
   * here so admin tooling and banner deep-links keep working.
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT id, name, slug, description, image_url, parent_id, sort_order, is_active, category_type, created_at, updated_at
       FROM categories WHERE id = $1`,
      [id]
    )
    return rows[0] || null
  }

  /**
   * Admin variant of findAll() — every non-deleted STANDARD category
   * regardless of is_active, so a category the admin deactivated (but
   * didn't delete) still shows in the dashboard's category list, badged as
   * inactive, instead of silently vanishing like a deleted one. The public
   * findAll() above intentionally keeps its is_active filter — customer
   * menus must never show a deactivated category.
   */
  async findAllAdmin() {
    const { rows } = await query(
      `SELECT c.id, c.name, c.slug, c.description, c.image_url, c.parent_id, c.sort_order, c.is_active, c.category_type, c.created_at,
              ${PRODUCT_COUNT_EXPR('c')} AS product_count
       FROM categories c
       WHERE c.deleted_at IS NULL AND c.category_type != 'BUNDLE'
       ORDER BY c.sort_order ASC, c.name ASC`
    )
    return rows
  }

  /**
   * List all BUNDLE-type categories (admin "Bundles" tab) — mirrors
   * findAll() but returns exactly the rows findAll() excludes, plus does
   * NOT filter on is_active so a temporarily-disabled bundle still shows in
   * admin tooling for re-activation.
   *
   * @param {string|null} [productId] - When given, each row also carries
   *   `is_member: boolean` for that product — powers the "also show in
   *   bundles" multi-select on the product edit form.
   */
  async findBundles(productId = null) {
    if (productId) {
      const { rows } = await query(
        `SELECT c.id, c.name, c.slug, c.description, c.image_url, c.sort_order, c.is_active, c.category_type, c.created_at,
                (SELECT COUNT(*)::int FROM category_products cp2 WHERE cp2.category_id = c.id) AS product_count,
                EXISTS (
                  SELECT 1 FROM category_products cp
                  WHERE cp.category_id = c.id AND cp.product_id = $1
                ) AS is_member
         FROM categories c
         WHERE c.deleted_at IS NULL AND c.category_type = 'BUNDLE'
         ORDER BY c.sort_order ASC, c.name ASC`,
        [productId]
      )
      return rows
    }
    const { rows } = await query(
      `SELECT c.id, c.name, c.slug, c.description, c.image_url, c.sort_order, c.is_active, c.category_type, c.created_at,
              (SELECT COUNT(*)::int FROM category_products cp WHERE cp.category_id = c.id) AS product_count
       FROM categories c
       WHERE c.deleted_at IS NULL AND c.category_type = 'BUNDLE'
       ORDER BY c.sort_order ASC, c.name ASC`
    )
    return rows
  }

  /**
   * Every category a product could be cross-listed into (its own primary
   * category is excluded — that's set on the product itself, not here),
   * each flagged `is_member`. Powers the product edit form's "also show in
   * other categories" multi-select — the dashboard side of the
   * multi-category feature: a product keeps its one real category, and
   * this lists every OTHER category (standard or bundle) it can
   * additionally appear under.
   */
  async findCategoriesForProduct(productId) {
    const { rows } = await query(
      `SELECT c.id, c.name, c.category_type, c.is_active,
              EXISTS (
                SELECT 1 FROM category_products cp
                WHERE cp.category_id = c.id AND cp.product_id = $1
              ) AS is_member
         FROM categories c
        WHERE c.deleted_at IS NULL
          AND c.id != COALESCE((SELECT category_id FROM products WHERE id = $1), '00000000-0000-0000-0000-000000000000'::uuid)
        ORDER BY c.category_type ASC, c.sort_order ASC, c.name ASC`,
      [productId]
    )
    return rows
  }

  /**
   * Add or remove a single product from a category (its real category via
   * category_id is untouched either way) without disturbing the rest of
   * the category's ranking — used by the product edit form's "also show in
   * other categories" toggle, which only knows about one product at a
   * time. Works for both STANDARD categories (multi-category cross-
   * listing) and BUNDLE categories.
   */
  async toggleCategoryMembership(categoryId, productId, isMember) {
    if (isMember) {
      const { rows } = await query(
        `SELECT COALESCE(MAX(rank), -1) + 1 AS next_rank FROM category_products WHERE category_id = $1`,
        [categoryId]
      )
      await query(
        `INSERT INTO category_products (category_id, product_id, rank)
         VALUES ($1, $2, $3)
         ON CONFLICT (category_id, product_id) DO NOTHING`,
        [categoryId, productId, rows[0].next_rank]
      )
    } else {
      await query(
        `DELETE FROM category_products WHERE category_id = $1 AND product_id = $2`,
        [categoryId, productId]
      )
    }
  }

  /**
   * Find direct children of a category (used to block re-parenting a
   * category that already has its own subcategories).
   */
  async findChildren(parentId) {
    const { rows } = await query(
      `SELECT id FROM categories WHERE parent_id = $1 AND deleted_at IS NULL`,
      [parentId]
    )
    return rows
  }

  /**
   * Find a category by slug
   */
  async findBySlug(slug) {
    const { rows } = await query(
      `SELECT id FROM categories WHERE slug = $1`,
      [slug]
    )
    return rows[0] || null
  }

  /**
   * Create a new category (or bundle, when category_type='BUNDLE')
   */
  async create({ name, slug, description, image_url, parent_id, sort_order, is_active, category_type }) {
    const { rows } = await query(
      `INSERT INTO categories (name, slug, description, image_url, parent_id, sort_order, is_active, category_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, slug, description, image_url, parent_id, sort_order, is_active, category_type, created_at`,
      [
        name,
        slug,
        description || null,
        image_url || null,
        parent_id || null,
        sort_order || 0,
        is_active !== false,
        category_type === 'BUNDLE' ? 'BUNDLE' : 'STANDARD',
      ]
    )
    return rows[0]
  }

  /**
   * Update a category — only provided fields
   */
  async update(id, data) {
    const fields = []
    const params = []
    let idx = 1

    const allowed = ['name', 'slug', 'description', 'image_url', 'parent_id', 'sort_order', 'is_active', 'category_type']
    for (const key of allowed) {
      if (data[key] !== undefined) {
        fields.push(`${key} = $${idx++}`)
        params.push(data[key])
      }
    }

    if (fields.length === 0) return this.findById(id)

    fields.push(`updated_at = NOW()`)
    params.push(id)

    const { rows } = await query(
      `UPDATE categories SET ${fields.join(', ')} WHERE id = $${idx}
       RETURNING id, name, slug, description, image_url, parent_id, sort_order, is_active, category_type, created_at, updated_at`,
      params
    )
    return rows[0]
  }

  /**
   * Soft-delete: deactivate a category
   */
  async delete(id) {
    await query(
      `UPDATE categories SET is_active = false, deleted_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id]
    )
  }

  /**
   * Get products belonging to a category (paginated).
   *
   * Surfaces the same product-family / option fields as the products
   * listing endpoint so the Flutter category grid can render "N options",
   * veg/origin markers, ratings and delivery time consistently
   * (product-options contract). `option_count` counts active siblings in
   * the same family (1 for standalone products).
   *
   * @param {string} categoryId
   * @param {object} opts
   * @param {number} opts.limit
   * @param {number} opts.offset
   * @param {string} [opts.sort]
   * @param {boolean} [opts.inStock]
   * @param {boolean} [opts.groupOptions] - When true, returns one
   *   representative per product_family_id (prefer default option) so
   *   sibling options collapse into a single card.
   * @param {string[]|null} [opts.allocatedShopIds] - Customer shop scoping;
   *   when set, only products available in at least one allocated shop are
   *   returned (mirrors ProductsRepository.buildCustomerVisibilitySnippet).
   * @param {string} [opts.categoryType='STANDARD'] - When 'BUNDLE', product
   *   membership comes exclusively from the category_products join table
   *   (never p.category_id) and results are always ordered by the admin's
   *   curated rank. When 'STANDARD', membership is the UNION of the
   *   product's real category (p.category_id = categoryId) and any
   *   cross-listing into this category via category_products — this is
   *   the multi-category feature: a product keeps showing under its real
   *   category (e.g. "Fresh Vegetables") while ALSO appearing under
   *   another category it's been cross-listed into (e.g. "Exotic
   *   Vegetables"), without duplicating the product. An explicit
   *   per-product rank in category_products — if the admin has set one —
   *   takes priority over the customer-facing sort, falling back to a
   *   deterministic created_at DESC, id ASC order (fixes the previous
   *   nondeterministic tie-break) when nothing has been ranked.
   */
  async findProducts(
    categoryId,
    {
      limit,
      offset,
      sort,
      inStock,
      groupOptions = false,
      allocatedShopIds = null,
      categoryType = 'STANDARD',
      priceMode = 'retail',
    }
  ) {
    const isBundle = categoryType === 'BUNDLE'
    const conditions = ['p.is_active = true']
    const params = [categoryId]
    let paramIdx = 2

    conditions.push(
      isBundle ? 'cp.category_id IS NOT NULL' : '(p.category_id = $1 OR cp.category_id IS NOT NULL)'
    )

    // Customer shop-allocation visibility (additive — only when scoped).
    if (Array.isArray(allocatedShopIds)) {
      if (allocatedShopIds.length === 0) {
        conditions.push('FALSE')
      } else {
        params.push(allocatedShopIds)
        conditions.push(`EXISTS (
          SELECT 1
            FROM shop_products sp
            JOIN shops s ON s.id = sp.shop_id
           WHERE sp.product_id = p.id
             AND sp.shop_id = ANY($${paramIdx}::uuid[])
             AND sp.is_available = true
             AND sp.deleted_at IS NULL
             AND s.is_active = true
             AND s.deleted_at IS NULL
        )`)
        paramIdx++
      }
    }

    // Customer-facing price/stock must be the shop's own `shop_products`
    // listing, never the master `products.price`/`stock_quantity` — the
    // EXISTS check above only gates VISIBILITY (does some allocated shop
    // carry this product at all); it was never used to pick which shop's
    // price to actually show. Every other customer-facing product read
    // (products.repository.js#findMany/findById) already resolves through
    // this exact helper — this endpoint was the one path left showing the
    // admin/master catalogue price regardless of the customer's shop, so a
    // dashboard price change for one shop never appeared here no matter how
    // fresh the fetch was. See buildShopPriceJoin()'s own docstring.
    const shopPrice = buildShopPriceJoin(allocatedShopIds, params, paramIdx, priceMode)
    paramIdx = shopPrice.nextIdx

    // Matches findMany()'s own inStock handling: the customer's shop may
    // carry a different quantity than the master catalog row, so "in stock"
    // must mean in stock at the shop this response is actually scoped to.
    if (inStock) {
      conditions.push(`${shopPrice.stockExpr} > 0`)
    }

    // Two equivalent ORDER BY clauses per sort choice: `inner` uses real
    // table aliases for the plain query, `outer` uses the flattened column
    // names exposed by the groupOptions CTE (which can't see `p.`/`cp.`
    // aliases). Every clause ends in `id ASC` so ties are never
    // nondeterministic — this closes the "sometimes alphabetical, sometimes
    // by upload date" gap the admin reported.
    const sortMap = {
      price_asc: { inner: 'p.price ASC, p.id ASC', outer: 'price ASC, id ASC' },
      price_desc: { inner: 'p.price DESC, p.id ASC', outer: 'price DESC, id ASC' },
      newest: { inner: 'p.created_at DESC, p.id ASC', outer: 'created_at DESC, id ASC' },
      popular: { inner: 'p.total_sold DESC, p.id ASC', outer: 'total_sold DESC, id ASC' },
    }
    const rankAwareDefault = {
      inner: 'COALESCE(cp.rank, 2147483647) ASC, p.created_at DESC, p.id ASC',
      outer: 'COALESCE(category_rank, 2147483647) ASC, created_at DESC, id ASC',
    }
    const bundleOrder = {
      inner: 'cp.rank ASC, p.created_at DESC, p.id ASC',
      outer: 'category_rank ASC, created_at DESC, id ASC',
    }
    const orderSpec = isBundle ? bundleOrder : sortMap[sort] || rankAwareDefault
    const where = conditions.join(' AND ')
    // Always needed now: for BUNDLE it's the membership condition itself;
    // for STANDARD the cross-listing half of the union condition above
    // (`cp.category_id IS NOT NULL`) references it directly too.
    const categoryProductsJoin =
      'LEFT JOIN category_products cp ON cp.category_id = $1 AND cp.product_id = p.id'

    const optionCountExpr = `COALESCE(
      (SELECT COUNT(*)::int FROM products sib
       WHERE sib.product_family_id = p.product_family_id
         AND sib.product_family_id IS NOT NULL
         AND sib.is_active = true), 1)`

    const selectCols = `
      p.id, p.name, p.slug,
      ${shopPrice.priceExpr} AS price, ${shopPrice.salePriceExpr} AS sale_price,
      ${shopPrice.stockExpr} AS stock_quantity,
      p.category_id, p.unit, p.thumbnail_url, p.is_featured, p.total_sold,
      p.product_family_id, p.option_label, p.option_sort_order,
      p.is_default_option, p.food_type, p.origin_tag,
      p.custom_badges, p.display_delivery_minutes,
      p.avg_rating, p.rating_count, p.net_quantity,
      p.created_at,
      pf.name AS family_name,
      ${optionCountExpr} AS option_count`

    if (groupOptions) {
      const { rows } = await query(
        `WITH ranked AS (
          SELECT ${selectCols}, cp.rank AS category_rank,
            ROW_NUMBER() OVER (
              PARTITION BY COALESCE(p.product_family_id, p.id)
              ORDER BY p.is_default_option DESC, p.option_sort_order ASC, p.price ASC
            ) AS rn
          FROM products p
          LEFT JOIN product_families pf ON pf.id = p.product_family_id
          ${categoryProductsJoin}
          ${shopPrice.joinSql}
          WHERE ${where}
        )
        SELECT id, name, slug, price, sale_price, stock_quantity, category_id,
               unit, thumbnail_url, is_featured, total_sold,
               product_family_id, option_label, option_sort_order,
               is_default_option, food_type, origin_tag,
               custom_badges, display_delivery_minutes,
               avg_rating, rating_count, net_quantity,
               created_at, family_name, option_count
        FROM ranked
        WHERE rn = 1
        ORDER BY ${orderSpec.outer}
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
          ${categoryProductsJoin}
          ${shopPrice.joinSql}
          WHERE ${where}
        )
        SELECT COUNT(*)::int AS total FROM ranked WHERE rn = 1`,
        params
      )

      return { data: rows, total: countRows[0]?.total || 0 }
    }

    const { rows } = await query(
      `SELECT ${selectCols}
       FROM products p
       LEFT JOIN product_families pf ON pf.id = p.product_family_id
       ${categoryProductsJoin}
       ${shopPrice.joinSql}
       WHERE ${where}
       ORDER BY ${orderSpec.inner}
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    )

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total
       FROM products p
       ${categoryProductsJoin}
       ${shopPrice.joinSql}
       WHERE ${where}`,
      params
    )

    return { data: rows, total: countRows[0]?.total || 0 }
  }

  /**
   * Get the current admin-set product order for a category (bundle or
   * standard) — used by the dashboard's product-ranking panel to render
   * the existing order before the admin drags to reorder.
   */
  async getCategoryProductRanks(categoryId) {
    const { rows } = await query(
      `SELECT cp.product_id, cp.rank, p.name, p.thumbnail_url, p.price
       FROM category_products cp
       JOIN products p ON p.id = cp.product_id
       WHERE cp.category_id = $1
       ORDER BY cp.rank ASC`,
      [categoryId]
    )
    return rows
  }

  /**
   * Look up which of the given product ids actually exist (and their real
   * category), for validation before setCategoryProducts writes anything.
   */
  async findProductsByIds(productIds) {
    if (!productIds || productIds.length === 0) return []
    const { rows } = await query(
      `SELECT id, category_id, is_active FROM products WHERE id = ANY($1::uuid[])`,
      [productIds]
    )
    return rows
  }

  /**
   * Replace a category's product membership/order in one shot — used both
   * for setting a bundle's member products and for pinning an explicit
   * rank for products within a standard category. `rank` is simply the
   * array index, so this doubles as the "reorder/shuffle" endpoint: sending
   * the full list in the new order is how the admin "replaces" ranks.
   *
   * Transactional delete-then-insert: simplest correct way to also drop any
   * product removed from the list, without a separate diff/cleanup step.
   */
  async setCategoryProducts(categoryId, orderedProductIds) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM category_products WHERE category_id = $1', [categoryId])
      for (let i = 0; i < orderedProductIds.length; i++) {
        await client.query(
          `INSERT INTO category_products (category_id, product_id, rank)
           VALUES ($1, $2, $3)
           ON CONFLICT (category_id, product_id) DO UPDATE SET rank = $3, updated_at = NOW()`,
          [categoryId, orderedProductIds[i], i]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    return this.getCategoryProductRanks(categoryId)
  }
}
