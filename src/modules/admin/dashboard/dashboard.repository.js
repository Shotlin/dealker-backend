import { query } from '../../../config/database.js'
import { CLAIMED_ASSIGNMENT_STATUSES, sqlInList } from '../../../constants/delivery-statuses.js'
import { redis } from '../../../config/redis.js'

export class DashboardRepository {
  /**
   * Enhanced dashboard stats with comparison period + sparklines
   * @param {'today'|'week'|'month'} period
   * @param {string|null} [shopId] - when present, every order-derived stat
   *   is scoped to this shop instead of the whole platform (R17 shop
   *   scoping — a shop-staff caller must only see their own numbers).
   */
  async getStats(period, shopId = null) {
    const { currentStart, previousStart, previousEnd, days } = this._periodRange(period)

    const [revenue, orders, products, customers, riders, today] = await Promise.all([
      this._revenueStats(currentStart, previousStart, previousEnd, days, shopId),
      this._orderStats(currentStart, previousStart, previousEnd, days, shopId),
      this._productStats(currentStart, previousStart, previousEnd, shopId),
      this._customerStats(currentStart, previousStart, previousEnd, shopId),
      this._riderStats(),
      this._todayStats(shopId),
    ])

    return { revenue, orders, products, customers, riders, today }
  }

  /**
   * Flat KPI summary for the HQ Dashboard page's top strip
   * (`GET /admin/dashboard/kpis`). Shop-scoped when `shopId` is present:
   * totalShops/activeShops collapse to "this shop only" rather than
   * leaking the platform-wide shop count to shop staff.
   */
  async getKpis(shopId = null) {
    const orderParams = []
    let orderShopFilter = ''
    if (shopId) { orderParams.push(shopId); orderShopFilter = ` AND shop_id = $${orderParams.length}` }

    const [orderRow, riderRow, shopRow, daily] = await Promise.all([
      query(
        `SELECT COALESCE(SUM(total_amount), 0) AS total_revenue,
                COUNT(*)::int AS total_orders,
                COALESCE(AVG(total_amount), 0) AS avg_order_value,
                COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending_orders,
                COUNT(DISTINCT user_id)::int AS total_customers
           FROM orders
          WHERE payment_status = 'PAID' AND status != 'CANCELLED'${orderShopFilter}`,
        orderParams
      ),
      query(
        `SELECT COUNT(*)::int AS total_riders,
                COUNT(*) FILTER (WHERE is_online = true)::int AS online_riders
           FROM rider_profiles`
      ),
      shopId
        ? query(
            `SELECT 1::int AS total_shops,
                    COUNT(*) FILTER (WHERE is_active = true)::int AS active_shops
               FROM shops WHERE id = $1`,
            [shopId]
          )
        : query(
            `SELECT COUNT(*)::int AS total_shops,
                    COUNT(*) FILTER (WHERE is_active = true)::int AS active_shops
               FROM shops`
          ),
      this.getStats('today', shopId),
    ])

    const o = orderRow.rows[0]
    const r = riderRow.rows[0]
    const s = shopRow.rows[0]

    return {
      totalRevenue: parseFloat(o.total_revenue),
      totalOrders: o.total_orders,
      totalCustomers: o.total_customers,
      totalShops: s.total_shops,
      activeShops: s.active_shops,
      totalRiders: r.total_riders,
      onlineRiders: r.online_riders,
      avgOrderValue: parseFloat(o.avg_order_value),
      pendingOrders: o.pending_orders,
      todayRevenue: daily.revenue.current,
      todayOrders: daily.orders.current,
      revenueChange: daily.revenue.change_pct,
      ordersChange: daily.orders.change_pct,
    }
  }

  async getRevenueChart(days = 7, shopId = null) {
    const params = [days]
    let shopFilter = ''
    if (shopId) { params.push(shopId); shopFilter = ` AND shop_id = $${params.length}` }

    const { rows } = await query(
      `SELECT
         DATE(created_at AT TIME ZONE 'Asia/Kolkata') AS date,
         COUNT(*) AS orders,
         COALESCE(SUM(total_amount), 0) AS revenue,
         COALESCE(AVG(total_amount), 0) AS avg_order_value,
         COALESCE(SUM(CASE WHEN payment_method = 'COD' THEN total_amount ELSE 0 END), 0) AS cod_revenue
       FROM orders
       WHERE created_at >= NOW() - make_interval(days => $1)
         AND payment_status = 'PAID'
         AND status != 'CANCELLED'${shopFilter}
       GROUP BY date
       ORDER BY date ASC`,
      params
    )
    return rows.map(r => ({
      date: r.date,
      orders: parseInt(r.orders),
      revenue: parseFloat(r.revenue),
      avgOrderValue: parseFloat(r.avg_order_value),
      codRevenue: parseFloat(r.cod_revenue),
    }))
  }

  async getOrdersByHour(shopId = null) {
    const params = []
    let shopFilter = ''
    if (shopId) { params.push(shopId); shopFilter = ` AND shop_id = $${params.length}` }

    const { rows } = await query(
      `SELECT
         EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
         COUNT(*)::int AS order_count
       FROM orders
       WHERE created_at >= NOW() - INTERVAL '30 days'${shopFilter}
       GROUP BY hour
       ORDER BY hour`,
      params
    )
    const avg = rows.length > 0
      ? rows.reduce((s, r) => s + r.order_count, 0) / 24
      : 0
    return { hours: rows, avgOrders: Math.round(avg) }
  }

  async getTopProducts(limit = 10, shopId = null) {
    const params = [limit]
    let shopFilter = ''
    if (shopId) { params.push(shopId); shopFilter = ` AND o.shop_id = $${params.length}` }

    const { rows } = await query(
      `SELECT
         p.id, p.name, p.thumbnail_url,
         COUNT(oi.id)::int AS units_sold,
         COALESCE(SUM(oi.total), 0) AS revenue,
         c.name AS category
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       JOIN orders o ON o.id = oi.order_id
       WHERE o.created_at >= NOW() - INTERVAL '30 days'
         AND o.status = 'DELIVERED'${shopFilter}
       GROUP BY p.id, p.name, p.thumbnail_url, c.name
       ORDER BY revenue DESC
       LIMIT $1`,
      params
    )
    return rows.map(r => ({
      ...r,
      revenue: parseFloat(r.revenue),
    }))
  }

  async getLowStockAlerts(threshold = 10, shopId = null) {
    if (shopId) {
      // Shop-scoped: stock lives on shop_products (per-shop overlay), not
      // the global products catalog.
      const { rows } = await query(
        `SELECT sp.id, p.name, p.thumbnail_url, sp.stock_quantity, sp.low_stock_threshold, p.category_id
           FROM shop_products sp
           JOIN products p ON p.id = sp.product_id
          WHERE sp.shop_id = $1
            AND sp.is_available = true
            AND sp.stock_quantity <= COALESCE(sp.low_stock_threshold, $2)
          ORDER BY sp.stock_quantity ASC
          LIMIT 50`,
        [shopId, threshold]
      )
      return rows
    }

    const { rows } = await query(
      `SELECT id, name, thumbnail_url, stock_quantity, low_stock_threshold, category_id
       FROM products
       WHERE is_active = true
         AND stock_quantity <= COALESCE(low_stock_threshold, $1)
       ORDER BY stock_quantity ASC
       LIMIT 50`,
      [threshold]
    )
    return rows
  }

  async getPendingActions(shopId = null) {
    if (shopId) {
      const { rows } = await query(
        `SELECT
           (SELECT COUNT(*) FROM orders WHERE status = 'PENDING' AND shop_id = $1)::int AS pending_orders,
           (SELECT COUNT(*) FROM orders WHERE status = 'CONFIRMED' AND shop_id = $1)::int AS confirmed_orders,
           (SELECT COUNT(*) FROM rider_profiles WHERE is_approved = false)::int AS pending_riders,
           (SELECT COUNT(*) FROM shop_products WHERE shop_id = $1 AND is_available = true AND stock_quantity <= COALESCE(low_stock_threshold, 10))::int AS low_stock_products,
           (SELECT COUNT(*) FROM rider_payouts WHERE status = 'PENDING')::int AS pending_payouts`,
        [shopId]
      )
      return rows[0]
    }

    const { rows } = await query(
      `SELECT
         (SELECT COUNT(*) FROM orders WHERE status = 'PENDING')::int AS pending_orders,
         (SELECT COUNT(*) FROM orders WHERE status = 'CONFIRMED')::int AS confirmed_orders,
         (SELECT COUNT(*) FROM rider_profiles WHERE is_approved = false)::int AS pending_riders,
         (SELECT COUNT(*) FROM products WHERE is_active = true AND stock_quantity <= COALESCE(low_stock_threshold, 10))::int AS low_stock_products,
         (SELECT COUNT(*) FROM rider_payouts WHERE status = 'PENDING')::int AS pending_payouts`
    )
    return rows[0]
  }

  async getLiveStats(shopId = null) {
    const [stats, onlineRiders] = await Promise.all([
      this._todayStats(shopId),
      this._riderStats(),
    ])
    return { today: stats, riders: onlineRiders }
  }

  async getCategoryRevenue(shopId = null) {
    const params = []
    let shopFilter = ''
    if (shopId) { params.push(shopId); shopFilter = ` AND o.shop_id = $${params.length}` }

    const { rows } = await query(
      `SELECT
         c.name AS category,
         COALESCE(SUM(oi.total), 0) AS revenue
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       JOIN categories c ON c.id = p.category_id
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status != 'CANCELLED'
         AND o.payment_status = 'PAID'
         AND o.created_at >= NOW() - INTERVAL '30 days'${shopFilter}
       GROUP BY c.name
       ORDER BY revenue DESC`,
      params
    )
    return rows.map(r => ({
      category: r.category,
      revenue: parseFloat(r.revenue),
    }))
  }

  // ─── PRIVATE HELPERS ────────────────────────────────

  _periodRange(period) {
    const now = new Date()
    let days
    switch (period) {
      case 'today':
        days = 1; break
      case 'month':
        days = 30; break
      case 'week':
      default:
        days = 7; break
    }
    const currentStart = new Date(now - days * 86400000).toISOString()
    const previousEnd = currentStart
    const previousStart = new Date(now - days * 2 * 86400000).toISOString()
    return { currentStart, previousStart, previousEnd, days }
  }

  async _revenueStats(currentStart, previousStart, previousEnd, days, shopId = null) {
    const shopFilter = shopId ? ' AND shop_id = $2' : ''
    const shopFilter2 = shopId ? ' AND shop_id = $3' : ''
    const currentParams = shopId ? [currentStart, shopId] : [currentStart]
    const previousParams = shopId ? [previousStart, previousEnd, shopId] : [previousStart, previousEnd]

    const [current, previous, sparkline] = await Promise.all([
      query(
        `SELECT COALESCE(SUM(total_amount), 0) AS total
         FROM orders WHERE payment_status = 'PAID' AND status != 'CANCELLED'
           AND created_at >= $1${shopFilter}`, currentParams
      ),
      query(
        `SELECT COALESCE(SUM(total_amount), 0) AS total
         FROM orders WHERE payment_status = 'PAID' AND status != 'CANCELLED'
           AND created_at >= $1 AND created_at < $2${shopFilter2}`, previousParams
      ),
      query(
        `SELECT COALESCE(SUM(total_amount), 0)::numeric AS rev
         FROM orders
         WHERE payment_status = 'PAID' AND status != 'CANCELLED'
           AND created_at >= $1${shopFilter}
         GROUP BY DATE(created_at AT TIME ZONE 'Asia/Kolkata')
         ORDER BY DATE(created_at AT TIME ZONE 'Asia/Kolkata') ASC`, currentParams
      ),
    ])
    const cur = parseFloat(current.rows[0].total)
    const prev = parseFloat(previous.rows[0].total)
    return {
      current: cur,
      previous: prev,
      change_pct: prev > 0 ? parseFloat(((cur - prev) / prev * 100).toFixed(1)) : 0,
      sparkline: sparkline.rows.map(r => parseFloat(r.rev)),
    }
  }

  async _orderStats(currentStart, previousStart, previousEnd, days, shopId = null) {
    const shopFilter = shopId ? ' AND shop_id = $2' : ''
    const shopFilter2 = shopId ? ' AND shop_id = $3' : ''
    const currentParams = shopId ? [currentStart, shopId] : [currentStart]
    const previousParams = shopId ? [previousStart, previousEnd, shopId] : [previousStart, previousEnd]

    const [current, previous, sparkline] = await Promise.all([
      query(`SELECT COUNT(*)::int AS total FROM orders WHERE created_at >= $1${shopFilter}`, currentParams),
      query(`SELECT COUNT(*)::int AS total FROM orders WHERE created_at >= $1 AND created_at < $2${shopFilter2}`, previousParams),
      query(
        `SELECT COUNT(*)::int AS cnt
         FROM orders WHERE created_at >= $1${shopFilter}
         GROUP BY DATE(created_at AT TIME ZONE 'Asia/Kolkata')
         ORDER BY DATE(created_at AT TIME ZONE 'Asia/Kolkata') ASC`, currentParams
      ),
    ])
    const cur = current.rows[0].total
    const prev = previous.rows[0].total
    return {
      current: cur,
      previous: prev,
      change_pct: prev > 0 ? parseFloat(((cur - prev) / prev * 100).toFixed(1)) : 0,
      sparkline: sparkline.rows.map(r => r.cnt),
    }
  }

  /**
   * Shop-scoped product counts read shop_products (the per-shop stock
   * overlay) instead of the global products catalog — "how many products
   * is MY shop stocking/low-on" rather than the platform-wide catalog size.
   */
  async _productStats(currentStart, previousStart, previousEnd, shopId = null) {
    if (shopId) {
      const { rows } = await query(
        `SELECT
           COUNT(*) FILTER (WHERE is_available = true)::int AS total,
           COUNT(*) FILTER (WHERE is_available = true AND stock_quantity > COALESCE(low_stock_threshold, 10))::int AS active,
           COUNT(*) FILTER (WHERE is_available = true AND stock_quantity = 0)::int AS out_of_stock,
           COUNT(*) FILTER (WHERE is_available = true AND stock_quantity > 0 AND stock_quantity <= COALESCE(low_stock_threshold, 10))::int AS low_stock
         FROM shop_products
         WHERE shop_id = $1`,
        [shopId]
      )
      return rows[0]
    }

    const { rows } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE is_active = true)::int AS total,
         COUNT(*) FILTER (WHERE is_active = true AND stock_quantity > COALESCE(low_stock_threshold, 10))::int AS active,
         COUNT(*) FILTER (WHERE is_active = true AND stock_quantity = 0)::int AS out_of_stock,
         COUNT(*) FILTER (WHERE is_active = true AND stock_quantity > 0 AND stock_quantity <= COALESCE(low_stock_threshold, 10))::int AS low_stock
       FROM products`
    )
    return rows[0]
  }

  /**
   * Customer counts. Unscoped (HQ) reads the users table directly (all
   * registered customers). Shop-scoped reads distinct customers who have
   * actually ordered from that shop — the users table has no shop
   * affiliation, so "my shop's customers" can only be derived from orders.
   */
  async _customerStats(currentStart, previousStart, previousEnd, shopId = null) {
    if (shopId) {
      const [total, newCustomers, repeat] = await Promise.all([
        query(`SELECT COUNT(DISTINCT user_id)::int AS total FROM orders WHERE shop_id = $1 AND status != 'CANCELLED'`, [shopId]),
        query(`SELECT COUNT(DISTINCT user_id)::int AS total FROM orders WHERE shop_id = $1 AND status != 'CANCELLED' AND created_at >= $2`, [shopId, currentStart]),
        query(
          `SELECT COUNT(*)::int AS total FROM (
             SELECT user_id FROM orders
             WHERE shop_id = $1 AND status != 'CANCELLED'
             GROUP BY user_id HAVING COUNT(*) > 1
           ) sub`,
          [shopId]
        ),
      ])
      const totalCount = total.rows[0].total
      const repeatCount = repeat.rows[0].total
      return {
        current: totalCount,
        new_this_period: newCustomers.rows[0].total,
        change_pct: 0,
        repeat_rate: totalCount > 0 ? parseFloat((repeatCount / totalCount * 100).toFixed(1)) : 0,
      }
    }

    const [total, newCustomers, repeat] = await Promise.all([
      query(`SELECT COUNT(*)::int AS total FROM users WHERE role = 'CUSTOMER'`),
      query(`SELECT COUNT(*)::int AS total FROM users WHERE role = 'CUSTOMER' AND created_at >= $1`, [currentStart]),
      query(
        `SELECT COUNT(*)::int AS total FROM (
           SELECT user_id FROM orders
           WHERE status != 'CANCELLED'
           GROUP BY user_id HAVING COUNT(*) > 1
         ) sub`
      ),
    ])
    const totalCount = total.rows[0].total
    const repeatCount = repeat.rows[0].total
    return {
      current: totalCount,
      new_this_period: newCustomers.rows[0].total,
      change_pct: 0, // computed from comparison period in sparkline
      repeat_rate: totalCount > 0 ? parseFloat((repeatCount / totalCount * 100).toFixed(1)) : 0,
    }
  }

  /**
   * Riders are a shared platform-wide pool, not owned by any one shop
   * (a rider can deliver for any shop) — intentionally NOT shop-scoped.
   */
  async _riderStats() {
    const [totals, onlineKeys] = await Promise.all([
      query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE is_online = true)::int AS online,
           COUNT(*) FILTER (WHERE is_approved = false)::int AS pending
         FROM rider_profiles`
      ),
      // Count riders with active delivery assignments
      query(
        `SELECT COUNT(DISTINCT rider_id)::int AS on_delivery
         FROM delivery_assignments
         WHERE status IN (${sqlInList(CLAIMED_ASSIGNMENT_STATUSES)})`
      ),
    ])
    const t = totals.rows[0]
    return {
      total: t.total,
      online: t.online,
      on_delivery: onlineKeys.rows[0].on_delivery,
      offline: t.total - t.online,
    }
  }

  async _todayStats(shopId = null) {
    // IST calendar day, not the DB session's (UTC) day — matches every
    // other date-bucketing query in this file. A raw CURRENT_DATE compare
    // is offset from IST midnight by 5:30, so it double-counts part of
    // yesterday's IST orders before 05:30 IST and drops this morning's
    // orders (00:00-05:30 IST) once the UTC day rolls over.
    const params = []
    let shopFilter = ''
    if (shopId) { params.push(shopId); shopFilter = ` AND shop_id = $${params.length}` }

    const { rows } = await query(
      `SELECT
         COALESCE(SUM(total_amount), 0) AS revenue,
         COUNT(*)::int AS orders,
         COALESCE(SUM(CASE WHEN payment_method = 'COD' AND status != 'DELIVERED' THEN total_amount ELSE 0 END), 0) AS cod_to_collect,
         COUNT(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered
       FROM orders
       WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date${shopFilter}`,
      params
    )
    const r = rows[0]
    return {
      revenue: parseFloat(r.revenue),
      orders: r.orders,
      cod_to_collect: parseFloat(r.cod_to_collect),
      delivered: r.delivered,
    }
  }
}
