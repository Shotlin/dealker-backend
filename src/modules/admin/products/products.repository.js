import { query, getClient } from '../../../config/database.js'

export class AdminProductsRepository {
  async getAnalytics({ offset, limit, sortBy = 'revenue' }) {
    const orderCol = sortBy === 'views' ? 'views' : sortBy === 'sold' ? 'units_sold' : 'revenue'
    const { rows } = await query(
      `SELECT p.id, p.name, p.thumbnail_url, p.price, p.stock_quantity, p.is_active,
              COALESCE(oi_stats.units_sold, 0)::int AS units_sold,
              COALESCE(oi_stats.revenue, 0) AS revenue,
              COALESCE(pv_stats.views, 0)::int AS views,
              CASE WHEN COALESCE(pv_stats.views, 0) > 0
                THEN ROUND(COALESCE(oi_stats.units_sold, 0)::numeric / pv_stats.views * 100, 2)
                ELSE 0 END AS conversion_rate,
              c.name AS category
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN (
         SELECT oi.product_id, SUM(oi.quantity)::int AS units_sold, SUM(oi.total) AS revenue
         FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = 'DELIVERED'
         GROUP BY oi.product_id
       ) oi_stats ON oi_stats.product_id = p.id
       LEFT JOIN (
         SELECT product_id, COUNT(*)::int AS views FROM product_views GROUP BY product_id
       ) pv_stats ON pv_stats.product_id = p.id
       ORDER BY ${orderCol} DESC NULLS LAST
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    )
    const countRes = await query('SELECT COUNT(*)::int AS total FROM products')
    return { products: rows.map(r => ({ ...r, revenue: parseFloat(r.revenue) })), total: countRes.rows[0].total }
  }

  async getDeadStock(days = 30) {
    const { rows } = await query(
      `SELECT p.id, p.name, p.thumbnail_url, p.stock_quantity, p.price, p.created_at,
              c.name AS category
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN (
         SELECT DISTINCT oi.product_id
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.created_at >= NOW() - make_interval(days => $1)
       ) recent ON recent.product_id = p.id
       WHERE p.is_active = true AND recent.product_id IS NULL
       ORDER BY p.stock_quantity DESC`,
      [days]
    )
    return rows
  }

  async getLowMargin(threshold = 15) {
    const { rows } = await query(
      `SELECT id, name, thumbnail_url, price, cost_price, stock_quantity,
              CASE WHEN price > 0 THEN ROUND((price - COALESCE(cost_price, 0)) / price * 100, 2) ELSE 0 END AS margin_pct
       FROM products
       WHERE is_active = true AND cost_price IS NOT NULL AND cost_price > 0
         AND ((price - cost_price) / price * 100) < $1
       ORDER BY margin_pct ASC`,
      [threshold]
    )
    return rows.map(r => ({ ...r, margin_pct: parseFloat(r.margin_pct) }))
  }

  async getAllForExport() {
    const { rows } = await query(
      `SELECT p.id, p.name, p.sku, p.price, p.sale_price, p.cost_price, p.stock_quantity,
              p.unit, p.is_active, p.total_sold, c.name AS category, p.created_at
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       ORDER BY p.name`
    )
    return rows
  }

  /**
   * @param {Array<object>} updates
   * @param {boolean} propagateToShops - When true, any product whose `price`
   *   is included in this batch also has that price written to every
   *   `shop_products` row selling it (Req: master-catalog quick-edit "push
   *   to stores" toggle). Left false, master and per-shop prices stay fully
   *   independent, matching existing behavior.
   */
  async bulkUpdate(updates, propagateToShops = false) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const results = []
      let shopProductsUpdated = 0
      for (const u of updates) {
        const sets = []
        const params = []
        let idx = 1
        if (u.price !== undefined) { sets.push(`price = $${idx++}`); params.push(u.price) }
        if (u.sale_price !== undefined) { sets.push(`sale_price = $${idx++}`); params.push(u.sale_price) }
        if (u.stock_quantity !== undefined) { sets.push(`stock_quantity = $${idx++}`); params.push(u.stock_quantity) }
        if (u.category_id !== undefined) { sets.push(`category_id = $${idx++}`); params.push(u.category_id) }
        if (u.is_active !== undefined) { sets.push(`is_active = $${idx++}`); params.push(u.is_active) }
        if (sets.length === 0) continue

        sets.push(`updated_at = NOW()`)
        params.push(u.id)
        const { rows } = await client.query(
          `UPDATE products SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, name`,
          params
        )
        if (rows[0]) results.push(rows[0])

        if (propagateToShops && u.price !== undefined && rows[0]) {
          const { rowCount } = await client.query(
            `UPDATE shop_products SET price = $1, updated_at = NOW()
             WHERE product_id = $2 AND deleted_at IS NULL`,
            [u.price, u.id]
          )
          shopProductsUpdated += rowCount
        }
      }
      await client.query('COMMIT')
      return { results, shopProductsUpdated }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async duplicate(productId) {
    const { rows: [p] } = await query('SELECT * FROM products WHERE id = $1', [productId])
    if (!p) return null

    const suffix = Date.now().toString(36)
    const newSlug = p.slug + '-copy-' + suffix
    const { rows: [newProduct] } = await query(
      `INSERT INTO products (name, slug, description, price, sale_price, cost_price, category_id,
         stock_quantity, unit, thumbnail_url, images, tags, is_active, is_featured, sku, low_stock_threshold)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, false, $13, $14)
       RETURNING *`,
      [
        p.name + ' (Copy)', newSlug, p.description, p.price, p.sale_price, p.cost_price,
        p.category_id, 0, p.unit, p.thumbnail_url, JSON.stringify(p.images || []),
        p.tags, p.sku ? p.sku + '-COPY-' + suffix : null, p.low_stock_threshold,
      ]
    )
    return newProduct
  }

  async findBySku(sku) {
    const { rows } = await query(
      `SELECT p.*, c.name AS category FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.sku = $1`,
      [sku]
    )
    return rows[0] || null
  }
}
