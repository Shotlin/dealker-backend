import { query } from '../../../config/database.js'

export class AdminAnalyticsRepository {
  async getSalesAnalytics({ startDate, endDate, groupBy = 'day', shopId }) {
    const trunc = groupBy === 'month' ? 'month' : groupBy === 'week' ? 'week' : 'day'
    const params = []
    let dateFilter = "WHERE o.status = 'DELIVERED'"
    if (startDate) { params.push(startDate); dateFilter += ` AND o.created_at >= $${params.length}` }
    if (endDate) { params.push(endDate); dateFilter += ` AND o.created_at <= $${params.length}` }
    if (shopId) { params.push(shopId); dateFilter += ` AND o.shop_id = $${params.length}` }

    const { rows: timeSeries } = await query(
      `SELECT DATE_TRUNC('${trunc}', o.created_at) AS period,
              SUM(o.total_amount) AS revenue, COUNT(*)::int AS orders,
              AVG(o.total_amount) AS avg_order_value,
              SUM(COALESCE(o.discount_amount, 0)) AS total_discount
       FROM orders o ${dateFilter}
       GROUP BY period ORDER BY period`,
      params
    )

    const { rows: [summary] } = await query(
      `SELECT SUM(o.total_amount) AS total_revenue, COUNT(*)::int AS total_orders,
              AVG(o.total_amount) AS avg_order_value,
              COUNT(DISTINCT o.user_id)::int AS unique_customers,
              SUM(COALESCE(o.discount_amount, 0)) AS total_discounts
       FROM orders o ${dateFilter}`,
      params
    )

    return {
      summary: {
        total_revenue: parseFloat(summary.total_revenue || 0),
        total_orders: summary.total_orders,
        avg_order_value: parseFloat(summary.avg_order_value || 0),
        unique_customers: summary.unique_customers,
        total_discounts: parseFloat(summary.total_discounts || 0),
      },
      timeSeries: timeSeries.map(r => ({
        period: r.period,
        revenue: parseFloat(r.revenue),
        orders: r.orders,
        avg_order_value: parseFloat(r.avg_order_value),
        total_discount: parseFloat(r.total_discount),
      })),
    }
  }

  async getProductPerformance({ startDate, endDate, limit = 20, shopId }) {
    const params = [limit]
    let dateFilter = "WHERE o.status = 'DELIVERED'"
    if (startDate) { params.push(startDate); dateFilter += ` AND o.created_at >= $${params.length}` }
    if (endDate) { params.push(endDate); dateFilter += ` AND o.created_at <= $${params.length}` }
    if (shopId) { params.push(shopId); dateFilter += ` AND o.shop_id = $${params.length}` }

    const { rows } = await query(
      `SELECT p.id, p.name, p.thumbnail_url, c.name AS category,
              SUM(oi.quantity)::int AS units_sold,
              SUM(oi.total) AS revenue,
              COUNT(DISTINCT o.user_id)::int AS unique_buyers,
              COALESCE(pv.views, 0)::int AS views,
              CASE WHEN COALESCE(pv.views, 0) > 0
                THEN ROUND(SUM(oi.quantity)::numeric / pv.views * 100, 2) ELSE 0 END AS conversion_rate
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN (SELECT product_id, COUNT(*)::int AS views FROM product_views GROUP BY product_id) pv ON pv.product_id = p.id
       ${dateFilter}
       GROUP BY p.id, p.name, p.thumbnail_url, c.name, pv.views
       ORDER BY revenue DESC
       LIMIT $1`,
      params
    )
    return rows.map(r => ({ ...r, revenue: parseFloat(r.revenue), conversion_rate: parseFloat(r.conversion_rate) }))
  }

  /**
   * Cohort retention is inherently platform-wide (cohort = signup month,
   * independent of any shop) EXCEPT for the "active in month" measure, which
   * counts orders and can be scoped to one shop's orders when a shop-scoped
   * caller is asking (their own repeat-customer retention).
   */
  async getCustomerCohorts({ shopId } = {}) {
    const params = []
    let orderShopFilter = ''
    if (shopId) { params.push(shopId); orderShopFilter = ` AND o.shop_id = $${params.length}` }

    const { rows } = await query(
      `WITH cohorts AS (
         SELECT DATE_TRUNC('month', u.created_at) AS cohort_month,
                u.id AS user_id
         FROM users u WHERE u.role = 'CUSTOMER'
       ),
       orders_by_month AS (
         SELECT c.cohort_month, DATE_TRUNC('month', o.created_at) AS order_month,
                COUNT(DISTINCT c.user_id)::int AS active_users
         FROM cohorts c
         JOIN orders o ON o.user_id = c.user_id AND o.status = 'DELIVERED'${orderShopFilter}
         GROUP BY c.cohort_month, DATE_TRUNC('month', o.created_at)
       ),
       cohort_sizes AS (
         SELECT cohort_month, COUNT(*)::int AS size FROM cohorts GROUP BY cohort_month
       )
       SELECT obm.cohort_month, cs.size AS cohort_size, obm.order_month,
              obm.active_users,
              ROUND(obm.active_users::numeric / cs.size * 100, 2) AS retention_pct
       FROM orders_by_month obm
       JOIN cohort_sizes cs ON cs.cohort_month = obm.cohort_month
       ORDER BY obm.cohort_month, obm.order_month`,
      params
    )
    return rows.map(r => ({ ...r, retention_pct: parseFloat(r.retention_pct) }))
  }

  async getDeliveryAnalytics({ startDate, endDate, shopId }) {
    const params = []
    let dateFilter = "WHERE da.status = 'DELIVERED'"
    if (startDate) { params.push(startDate); dateFilter += ` AND da.delivered_at >= $${params.length}` }
    if (endDate) { params.push(endDate); dateFilter += ` AND da.delivered_at <= $${params.length}` }

    // delivery_assignments has no shop_id column directly — scope via its
    // parent order instead, joining only when a shop-scoped caller needs it
    // (keeps the unscoped/HQ query plan identical to before this change).
    const fromClause = shopId
      ? 'FROM delivery_assignments da JOIN orders o ON o.id = da.order_id'
      : 'FROM delivery_assignments da'
    if (shopId) { params.push(shopId); dateFilter += ` AND o.shop_id = $${params.length}` }

    const { rows: [summary] } = await query(
      `SELECT COUNT(*)::int AS total_deliveries,
              AVG(da.delivery_time_minutes) AS avg_delivery_time,
              AVG(da.distance_km) AS avg_distance,
              AVG(da.rating) AS avg_rating,
              COUNT(CASE WHEN da.delivery_time_minutes <= 30 THEN 1 END)::int AS on_time_count,
              SUM(da.tip_amount) AS total_tips
       ${fromClause} ${dateFilter}`,
      params
    )

    const { rows: byHour } = await query(
      `SELECT EXTRACT(HOUR FROM da.delivered_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
              COUNT(*)::int AS deliveries,
              AVG(da.delivery_time_minutes) AS avg_time
       ${fromClause} ${dateFilter}
       GROUP BY hour ORDER BY hour`,
      params
    )

    const onTimePct = summary.total_deliveries > 0
      ? Math.round(summary.on_time_count / summary.total_deliveries * 100)
      : 0

    return {
      summary: {
        total_deliveries: summary.total_deliveries,
        avg_delivery_time: parseFloat(summary.avg_delivery_time || 0).toFixed(1),
        avg_distance: parseFloat(summary.avg_distance || 0).toFixed(2),
        avg_rating: parseFloat(summary.avg_rating || 0).toFixed(2),
        on_time_percentage: onTimePct,
        total_tips: parseFloat(summary.total_tips || 0),
      },
      byHour: byHour.map(r => ({ hour: r.hour, deliveries: r.deliveries, avg_time: parseFloat(r.avg_time).toFixed(1) })),
    }
  }

  async getFinancialReport({ startDate, endDate, shopId }) {
    const params = []
    let dateFilter = "WHERE o.status = 'DELIVERED'"
    if (startDate) { params.push(startDate); dateFilter += ` AND o.created_at >= $${params.length}` }
    if (endDate) { params.push(endDate); dateFilter += ` AND o.created_at <= $${params.length}` }
    if (shopId) { params.push(shopId); dateFilter += ` AND o.shop_id = $${params.length}` }

    const { rows: [rev] } = await query(
      `SELECT SUM(o.total_amount) AS gross_revenue,
              SUM(COALESCE(o.discount_amount, 0)) AS total_discounts,
              SUM(COALESCE(o.delivery_fee, 0)) AS delivery_fees,
              SUM(o.total_amount - COALESCE(o.discount_amount, 0)) AS net_revenue,
              COUNT(*)::int AS order_count
       FROM orders o ${dateFilter}`,
      params
    )

    const { rows: byPayment } = await query(
      `SELECT o.payment_method, SUM(o.total_amount) AS revenue, COUNT(*)::int AS count
       FROM orders o ${dateFilter}
       GROUP BY o.payment_method ORDER BY revenue DESC`,
      params
    )

    // GST is now a real, exclusive charge computed per order by
    // TotalsEngine and persisted to orders.tax_amount (fee_settings.gst_rate
    // / gst_enabled, Settings → Fees). The breakdown sums the actual
    // charged tax rather than back-calculating from item totals — accurate
    // as long as the rate hasn't changed mid-period (a real rate change is
    // a rare, deliberate admin action, not a per-order concern).
    const { rows: [taxRow] } = await query(
      `SELECT COALESCE(SUM(o.tax_amount), 0) AS gst_amount,
              COALESCE(SUM(o.total_amount - COALESCE(o.tax_amount, 0)), 0) AS taxable_amount
       FROM orders o
       ${dateFilter}`,
      params
    )
    const { rows: [gstConfig] } = await query(
      `SELECT gst_rate FROM fee_settings WHERE scope = 'GLOBAL' LIMIT 1`
    )
    const gstRate = parseFloat(gstConfig?.gst_rate) || 0
    const gstAmount = Math.round(parseFloat(taxRow.gst_amount || 0) * 100) / 100
    const taxableAmount = Math.round(parseFloat(taxRow.taxable_amount || 0) * 100) / 100

    return {
      revenue: {
        gross: parseFloat(rev.gross_revenue || 0),
        discounts: parseFloat(rev.total_discounts || 0),
        delivery_fees: parseFloat(rev.delivery_fees || 0),
        net: parseFloat(rev.net_revenue || 0),
        order_count: rev.order_count,
      },
      byPaymentMethod: byPayment.map(r => ({ ...r, revenue: parseFloat(r.revenue) })),
      gstBreakdown: rev.order_count > 0
        ? [{ gst_rate: gstRate, taxable_amount: taxableAmount, gst_amount: gstAmount }]
        : [],
    }
  }

  async getCartEnhancementAnalytics({ startDate, endDate, shopId }) {
    const params = []
    let dateFilter = "WHERE o.status = 'DELIVERED'"
    if (startDate) { params.push(startDate); dateFilter += ` AND o.created_at >= $${params.length}` }
    if (endDate) { params.push(endDate); dateFilter += ` AND o.created_at <= $${params.length}` }
    if (shopId) { params.push(shopId); dateFilter += ` AND o.shop_id = $${params.length}` }

    const { rows: [summary] } = await query(
      `SELECT COALESCE(SUM(COALESCE(o.tip_amount, 0)), 0) AS total_tips,
              COALESCE(AVG(NULLIF(o.tip_amount, 0)), 0) AS average_tip,
              COUNT(CASE WHEN COALESCE(o.tip_amount, 0) > 0 THEN 1 END)::int AS tipped_orders,
              COALESCE(SUM(COALESCE(o.delivery_fee, 0)), 0) AS total_delivery_fees,
              COALESCE(SUM(COALESCE(o.handling_fee, 0)), 0) AS total_handling_fees,
              COALESCE(SUM(COALESCE(o.late_night_fee, 0)), 0) AS total_late_night_fees
       FROM orders o ${dateFilter}`,
      params
    )

    const { rows: [popularTip] } = await query(
      `SELECT o.tip_amount AS amount, COUNT(*)::int AS frequency
       FROM orders o
       ${dateFilter} AND COALESCE(o.tip_amount, 0) > 0
       GROUP BY o.tip_amount
       ORDER BY frequency DESC, o.tip_amount DESC
       LIMIT 1`,
      params
    )

    return {
      tipAnalytics: {
        totalTips: parseFloat(summary.total_tips || 0),
        averageTip: parseFloat(summary.average_tip || 0),
        mostPopularAmount: popularTip ? parseFloat(popularTip.amount) : null,
        tippedOrders: summary.tipped_orders || 0,
      },
      feeRevenue: {
        totalDeliveryFees: parseFloat(summary.total_delivery_fees || 0),
        totalHandlingFees: parseFloat(summary.total_handling_fees || 0),
        totalLateNightFees: parseFloat(summary.total_late_night_fees || 0),
      },
    }
  }

  async getComparisonStats(period1Start, period1End, period2Start, period2End, shopId) {
    const getStats = async (start, end) => {
      const params = [start, end]
      let shopFilter = ''
      if (shopId) { params.push(shopId); shopFilter = ` AND shop_id = $${params.length}` }
      const { rows: [s] } = await query(
        `SELECT SUM(total_amount) AS revenue, COUNT(*)::int AS orders,
                COUNT(DISTINCT user_id)::int AS customers, AVG(total_amount) AS aov
         FROM orders WHERE status = 'DELIVERED' AND created_at >= $1 AND created_at <= $2${shopFilter}`,
        params
      )
      return {
        revenue: parseFloat(s.revenue || 0),
        orders: s.orders,
        customers: s.customers,
        aov: parseFloat(s.aov || 0),
      }
    }

    const [current, previous] = await Promise.all([
      getStats(period1Start, period1End),
      getStats(period2Start, period2End),
    ])

    const pctChange = (cur, prev) => prev > 0 ? Math.round((cur - prev) / prev * 100) : cur > 0 ? 100 : 0

    return {
      current,
      previous,
      changes: {
        revenue: pctChange(current.revenue, previous.revenue),
        orders: pctChange(current.orders, previous.orders),
        customers: pctChange(current.customers, previous.customers),
        aov: pctChange(current.aov, previous.aov),
      },
    }
  }

  async getGeographicAnalytics({ startDate, endDate, shopId }) {
    const params = []
    let dateFilter = "WHERE o.status = 'DELIVERED'"
    if (startDate) { params.push(startDate); dateFilter += ` AND o.created_at >= $${params.length}` }
    if (endDate) { params.push(endDate); dateFilter += ` AND o.created_at <= $${params.length}` }
    if (shopId) { params.push(shopId); dateFilter += ` AND o.shop_id = $${params.length}` }

    const { rows } = await query(
      `SELECT COALESCE(NULLIF(TRIM(o.delivery_address->>'city'), ''), 'Unknown') AS area,
              COUNT(*)::int AS orders,
              SUM(o.total_amount) AS revenue,
              COUNT(DISTINCT o.user_id)::int AS customers,
              AVG(o.total_amount) AS avg_order_value
       FROM orders o ${dateFilter}
       GROUP BY area
       ORDER BY revenue DESC`,
      params
    )

    return rows.map(r => ({
      area: r.area,
      orders: r.orders,
      revenue: parseFloat(r.revenue || 0),
      customers: r.customers,
      avg_order_value: parseFloat(r.avg_order_value || 0),
    }))
  }

  async getDeadStockProducts({ limit = 20, shopId }) {
    const params = []
    let shopFilter = ''
    if (shopId) { params.push(shopId); shopFilter = ` AND sp.shop_id = $${params.length}` }
    params.push(limit)

    const { rows } = await query(
      `SELECT p.id, p.name, p.sku, sp.stock_quantity,
              c.name AS category,
              MAX(o.created_at) AS last_sold_at,
              MIN(sp.created_at) AS stocked_at
       FROM shop_products sp
       JOIN products p ON p.id = sp.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN order_items oi ON oi.product_id = p.id
       LEFT JOIN orders o ON o.id = oi.order_id AND o.status = 'DELIVERED'
       WHERE sp.stock_quantity > 0${shopFilter}
       GROUP BY p.id, p.name, p.sku, sp.stock_quantity, c.name
       HAVING MAX(o.created_at) IS NULL OR MAX(o.created_at) < NOW() - INTERVAL '60 days'
       ORDER BY last_sold_at ASC NULLS FIRST
       LIMIT $${params.length}`,
      params
    )

    const now = Date.now()
    return rows.map(r => {
      const reference = r.last_sold_at || r.stocked_at
      const daysSince = reference
        ? Math.floor((now - new Date(reference).getTime()) / 86400000)
        : 0
      return {
        id: r.id,
        name: r.name,
        sku: r.sku,
        stock_quantity: r.stock_quantity,
        last_sold_at: r.last_sold_at,
        days_since_sold: daysSince,
        category: r.category || null,
      }
    })
  }
}
