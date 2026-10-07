import { query } from '../../../config/database.js'

/**
 * Business Overview data access.
 *
 * Every windowed query takes the same positional params so the shared `facts`
 * CTE can be reused verbatim:
 *   $1 = window start (inclusive)   $2 = window end (exclusive)
 *   $3 = shop id or NULL            $4 = delivery pincode or NULL
 *
 * Column names follow the LIVE schema (orders.customer_id / total_payable,
 * order_items.product_name / unit_price / subtotal) — see CLAUDE.md §5/§7.2.10.
 *
 * What counts as a "sale" (a row in `facts`): the order was not cancelled and
 * is not an unpaid online order still waiting on Razorpay.
 */

const IST = `'Asia/Kolkata'`

/** SQL predicate for "this order counts as a sale". `a` = orders alias. */
const VALID_ORDER = (a = 'o') => `(${a}.status <> 'CANCELLED'
    AND NOT (${a}.payment_method = 'ONLINE' AND ${a}.payment_status <> 'PAID'))`

/**
 * One row per sale in the window with every money component resolved.
 *  - refund  = approved refund requests (else the whole order when it is REFUNDED)
 *  - cogs    = Σ quantity × cost price (shop price row, else master) over lines
 *              that HAVE a cost price; `costed` = every line has one, so profit
 *              is only ever computed for orders where it is exact.
 *  - rider_cost strips the tip (customer money passed through to the rider).
 */
const FACTS_CTE = `
facts AS (
  SELECT o.id, o.customer_id, o.shop_id, o.status, o.created_at, o.delivered_at,
         o.estimated_delivery, o.payment_method, o.coupon_code,
         NULLIF(BTRIM(o.delivery_address->>'pincode'), '') AS pincode,
         COALESCE(o.subtotal, 0)         AS subtotal,
         COALESCE(o.discount_amount, 0)  AS discount,
         COALESCE(o.delivery_fee, 0)     AS delivery_fee,
         COALESCE(o.delivery_fee, 0) + COALESCE(o.platform_fee, 0)
           + COALESCE(o.handling_fee, 0) + COALESCE(o.late_night_fee, 0) AS fee_revenue,
         COALESCE(o.tax_amount, 0)       AS tax_amount,
         COALESCE(o.total_payable, 0)    AS total_payable,
         LEAST(COALESCE(o.total_payable, 0),
               CASE WHEN COALESCE(ar.amount, 0) > 0 THEN ar.amount
                    WHEN o.status = 'REFUNDED' THEN COALESCE(o.total_payable, 0)
                    ELSE 0 END)          AS refund,
         COALESCE(ic.cogs, 0)            AS cogs,
         (COALESCE(ic.item_lines, 0) > 0 AND COALESCE(ic.unknown_lines, 0) = 0) AS costed,
         GREATEST(COALESCE(re.amount, 0) - COALESCE(re.tip_amount, 0), 0) AS rider_cost,
         COALESCE(ss.rate, 0)            AS shiprocket_cost
    FROM orders o
    LEFT JOIN LATERAL (
      SELECT SUM(COALESCE(r.resolved_amount, r.computed_amount)) AS amount
        FROM refund_requests r
       WHERE r.order_id = o.id AND r.status = 'APPROVED'
    ) ar ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS item_lines,
             COUNT(*) FILTER (WHERE COALESCE(sp.cost_price, p.cost_price) IS NULL) AS unknown_lines,
             SUM(oi.quantity * COALESCE(sp.cost_price, p.cost_price)) AS cogs
        FROM order_items oi
        LEFT JOIN products p       ON p.id  = oi.product_id
        LEFT JOIN shop_products sp ON sp.id = oi.shop_product_id
       WHERE oi.order_id = o.id
    ) ic ON true
    LEFT JOIN rider_earnings re ON re.order_id = o.id
    LEFT JOIN shiprocket_shipments ss
           ON ss.order_id = o.id AND ss.is_simulated IS NOT TRUE
          AND ss.status NOT IN ('CANCELLED', 'FAILED')
   WHERE o.created_at >= $1 AND o.created_at < $2
     AND ${VALID_ORDER('o')}
     AND ($3::uuid IS NULL OR o.shop_id = $3)
     AND ($4::text IS NULL OR BTRIM(o.delivery_address->>'pincode') = $4)
)`

/** Exact contribution of a costed order (SQL expression over `facts`). */
const CONTRIB = `(subtotal - discount - refund - cogs + fee_revenue - rider_cost - shiprocket_cost)`

const num = (v) => (v == null ? null : Number(v))

export class OverviewRepository {
  /** Headline money + counts for one window. */
  async financials(params) {
    const { rows } = await query(
      `WITH ${FACTS_CTE}
       SELECT COUNT(*)::int                                   AS orders,
              COUNT(DISTINCT customer_id)::int                AS customers,
              COALESCE(SUM(subtotal), 0)                      AS gross_revenue,
              COALESCE(SUM(discount), 0)                      AS discounts,
              COALESCE(SUM(refund), 0)                        AS refunds,
              COALESCE(SUM(delivery_fee), 0)                  AS delivery_revenue,
              COALESCE(SUM(fee_revenue - delivery_fee), 0)    AS other_fee_revenue,
              COALESCE(SUM(tax_amount), 0)                    AS taxes,
              COALESCE(SUM(total_payable), 0)                 AS collected,
              COALESCE(SUM(cogs), 0)                          AS product_cost,
              COALESCE(SUM(rider_cost), 0)                    AS rider_cost,
              COALESCE(SUM(shiprocket_cost), 0)               AS shiprocket_cost,
              COUNT(*) FILTER (WHERE costed)::int             AS costed_orders,
              COALESCE(SUM(subtotal - discount - refund) FILTER (WHERE costed), 0) AS costed_net_revenue,
              COALESCE(SUM(subtotal - discount - refund - cogs) FILTER (WHERE costed), 0) AS gross_profit,
              COALESCE(SUM(${CONTRIB}) FILTER (WHERE costed), 0) AS net_profit
         FROM facts`,
      params
    )
    return rows[0]
  }

  /** Time series (hourly for ≤2-day windows, daily otherwise). */
  async series(params, bucket) {
    const unit = bucket === 'hour' ? 'hour' : 'day'
    const { rows } = await query(
      `WITH ${FACTS_CTE}
       SELECT to_char(date_trunc('${unit}', created_at AT TIME ZONE ${IST}), 'YYYY-MM-DD"T"HH24:MI') AS bucket,
              COUNT(*)::int AS orders,
              COALESCE(SUM(subtotal - discount - refund), 0) AS net_revenue,
              COALESCE(SUM(${CONTRIB}) FILTER (WHERE costed), 0) AS net_profit
         FROM facts GROUP BY 1 ORDER BY 1`,
      params
    )
    return rows
  }

  /** Raw status counts (every order, not just sales) + return requests. */
  async orderHealth(params) {
    const [statuses, returns, daily] = await Promise.all([
      query(
        `SELECT o.status, COUNT(*)::int AS n
           FROM orders o
          WHERE o.created_at >= $1 AND o.created_at < $2
            AND ($3::uuid IS NULL OR o.shop_id = $3)
            AND ($4::text IS NULL OR BTRIM(o.delivery_address->>'pincode') = $4)
          GROUP BY o.status`,
        params
      ),
      query(
        `SELECT COUNT(*)::int AS n
           FROM refund_requests r JOIN orders o ON o.id = r.order_id
          WHERE r.created_at >= $1 AND r.created_at < $2
            AND r.status IN ('PENDING', 'PROCESSING')
            AND ($3::uuid IS NULL OR o.shop_id = $3)
            AND ($4::text IS NULL OR BTRIM(o.delivery_address->>'pincode') = $4)`,
        params
      ),
      query(
        `SELECT to_char(date_trunc('day', o.created_at AT TIME ZONE ${IST}), 'YYYY-MM-DD') AS day,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE o.status = 'DELIVERED')::int AS delivered,
                COUNT(*) FILTER (WHERE o.status = 'CANCELLED')::int AS cancelled,
                COUNT(*) FILTER (WHERE o.status = 'REFUNDED')::int  AS refunded
           FROM orders o
          WHERE o.created_at >= $1 AND o.created_at < $2
            AND ($3::uuid IS NULL OR o.shop_id = $3)
            AND ($4::text IS NULL OR BTRIM(o.delivery_address->>'pincode') = $4)
          GROUP BY 1 ORDER BY 1`,
        params
      ),
    ])
    return { statuses: statuses.rows, returnRequests: returns.rows[0]?.n ?? 0, daily: daily.rows }
  }

  /**
   * Per-product sales, cost and refund stats for one window.
   * Refund attribution: whole-order refunds hit every line; item-level
   * approved requests hit just the picked lines (matched by productId, else name).
   */
  async productStats(params) {
    const { rows } = await query(
      `WITH ${FACTS_CTE},
       lines AS (
         SELECT oi.product_id, oi.product_name, oi.quantity, oi.subtotal,
                f.id AS order_id, f.customer_id,
                COALESCE(NULLIF(p.thumbnail_url, ''), NULLIF(p.images->>0, '')) AS image,
                COALESCE(sp.cost_price, p.cost_price) AS unit_cost
           FROM facts f
           JOIN order_items oi        ON oi.order_id = f.id
           LEFT JOIN products p       ON p.id  = oi.product_id
           LEFT JOIN shop_products sp ON sp.id = oi.shop_product_id
          WHERE oi.product_id IS NOT NULL
       ),
       sales AS (
         SELECT product_id, MAX(product_name) AS name, MAX(image) AS image,
                SUM(quantity) AS units, SUM(subtotal) AS revenue,
                SUM(quantity * unit_cost) FILTER (WHERE unit_cost IS NOT NULL) AS cogs,
                SUM(subtotal) FILTER (WHERE unit_cost IS NOT NULL)             AS costed_revenue,
                COUNT(DISTINCT order_id)::int    AS orders,
                COUNT(DISTINCT customer_id)::int AS buyers
           FROM lines GROUP BY product_id
       ),
       repeat_buyers AS (
         SELECT product_id, COUNT(*)::int AS repeat_buyers,
                COALESCE(SUM(spend), 0) AS repeat_revenue
           FROM (SELECT product_id, customer_id, COUNT(DISTINCT order_id) AS n, SUM(subtotal) AS spend
                   FROM lines GROUP BY product_id, customer_id) t
          WHERE n >= 2 GROUP BY product_id
       ),
       refund_full AS (
         SELECT oi.product_id, SUM(oi.quantity) AS units, SUM(oi.subtotal) AS value
           FROM facts f JOIN order_items oi ON oi.order_id = f.id
          WHERE f.refund > 0 AND oi.product_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM refund_requests r
                             WHERE r.order_id = f.id AND r.status = 'APPROVED' AND r.scope = 'ITEMS')
          GROUP BY oi.product_id
       ),
       refund_items AS (
         SELECT oi.product_id,
                SUM(COALESCE((e->>'quantity')::numeric, oi.quantity)) AS units,
                SUM(COALESCE((e->>'lineTotal')::numeric, oi.subtotal)) AS value
           FROM facts f
           JOIN refund_requests r ON r.order_id = f.id AND r.status = 'APPROVED' AND r.scope = 'ITEMS'
           CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.items, '[]'::jsonb)) e
           JOIN order_items oi ON oi.order_id = f.id
            AND ((e ? 'productId' AND oi.product_id::text = e->>'productId')
              OR (NOT (e ? 'productId') AND oi.product_name = e->>'name'))
          WHERE oi.product_id IS NOT NULL
          GROUP BY oi.product_id
       ),
       refunds AS (
         SELECT product_id, SUM(units) AS units, SUM(value) AS value
           FROM (SELECT * FROM refund_full UNION ALL SELECT * FROM refund_items) u
          GROUP BY product_id
       )
       SELECT s.product_id, s.name, s.image, s.units, s.revenue, s.cogs, s.costed_revenue,
              s.orders, s.buyers,
              COALESCE(rb.repeat_buyers, 0) AS repeat_buyers,
              COALESCE(rb.repeat_revenue, 0) AS repeat_revenue,
              COALESCE(rf.units, 0) AS refunded_units,
              COALESCE(rf.value, 0) AS refunded_value
         FROM sales s
         LEFT JOIN repeat_buyers rb ON rb.product_id = s.product_id
         LEFT JOIN refunds rf       ON rf.product_id = s.product_id
        ORDER BY s.revenue DESC
        LIMIT 1000`,
      params
    )
    return rows.map((r) => ({
      product_id: r.product_id,
      name: r.name,
      image: r.image || null,
      units: num(r.units),
      revenue: num(r.revenue),
      cogs: num(r.cogs),
      costed_revenue: num(r.costed_revenue),
      orders: r.orders,
      buyers: r.buyers,
      repeat_buyers: r.repeat_buyers,
      repeat_revenue: num(r.repeat_revenue),
      refunded_units: num(r.refunded_units),
      refunded_value: num(r.refunded_value),
    }))
  }

  /** Stock that is sitting on the shelf and barely selling. */
  async slowMovers(params, limit = 8) {
    const { rows } = await query(
      `WITH sold AS (
         SELECT oi.product_id, SUM(oi.quantity) AS units
           FROM orders o JOIN order_items oi ON oi.order_id = o.id
          WHERE o.created_at >= $1 AND o.created_at < $2
            AND ${VALID_ORDER('o')}
            AND ($3::uuid IS NULL OR o.shop_id = $3)
          GROUP BY oi.product_id
       )
       SELECT p.id AS product_id, p.name, MAX(COALESCE(NULLIF(p.thumbnail_url, ''), NULLIF(p.images->>0, ''))) AS image,
              SUM(sp.stock_quantity)::int AS stock,
              COALESCE(MAX(sold.units), 0) AS units_sold,
              SUM(sp.stock_quantity * COALESCE(sp.cost_price, p.cost_price, sp.price)) AS stock_value
         FROM shop_products sp
         JOIN products p ON p.id = sp.product_id
         LEFT JOIN sold ON sold.product_id = p.id
        WHERE sp.deleted_at IS NULL AND sp.is_available = true AND sp.stock_quantity > 0
          AND ($3::uuid IS NULL OR sp.shop_id = $3)
        GROUP BY p.id, p.name
       HAVING COALESCE(MAX(sold.units), 0) <= GREATEST(SUM(sp.stock_quantity) * 0.1, 1)
        ORDER BY stock_value DESC NULLS LAST
        LIMIT ${Number(limit) || 8}`,
      [params[0], params[1], params[2]]
    )
    return rows.map((r) => ({
      product_id: r.product_id, name: r.name, image: r.image || null, stock: r.stock,
      units_sold: num(r.units_sold), stock_value: num(r.stock_value),
    }))
  }

  /** Per-pincode performance for one window (top N by revenue). */
  async areaStats(params, limit = 25) {
    const { rows } = await query(
      `WITH ${FACTS_CTE}
       SELECT COALESCE(pincode, 'Unknown') AS pincode,
              COUNT(*)::int AS orders,
              COUNT(DISTINCT customer_id)::int AS customers,
              COALESCE(SUM(subtotal - discount - refund), 0) AS net_revenue,
              COALESCE(SUM(total_payable), 0) AS collected,
              COALESCE(SUM(delivery_fee), 0) AS delivery_revenue,
              COALESCE(SUM(rider_cost + shiprocket_cost), 0) AS delivery_cost
         FROM facts GROUP BY 1
        ORDER BY net_revenue DESC
        LIMIT ${Number(limit) || 25}`,
      params
    )
    return rows.map((r) => ({
      pincode: r.pincode, orders: r.orders, customers: r.customers,
      net_revenue: num(r.net_revenue), collected: num(r.collected),
      delivery_revenue: num(r.delivery_revenue), delivery_cost: num(r.delivery_cost),
    }))
  }

  /** Top 3 products per pincode (by units) for the given pincodes. */
  async topProductsByArea(params, pincodes) {
    if (!pincodes.length) return []
    const { rows } = await query(
      `WITH ${FACTS_CTE},
       ranked AS (
         SELECT COALESCE(f.pincode, 'Unknown') AS pincode, oi.product_id,
                MAX(oi.product_name) AS name, MAX(COALESCE(NULLIF(p.thumbnail_url, ''), NULLIF(p.images->>0, ''))) AS image,
                SUM(oi.quantity) AS units, SUM(oi.subtotal) AS revenue,
                ROW_NUMBER() OVER (PARTITION BY COALESCE(f.pincode, 'Unknown')
                                   ORDER BY SUM(oi.subtotal) DESC) AS rn
           FROM facts f JOIN order_items oi ON oi.order_id = f.id
           LEFT JOIN products p ON p.id = oi.product_id
          WHERE oi.product_id IS NOT NULL
          GROUP BY 1, oi.product_id
       )
       SELECT pincode, product_id, name, image, units, revenue
         FROM ranked WHERE rn <= 3 AND pincode = ANY($5::text[])
        ORDER BY pincode, rn`,
      [...params, pincodes]
    )
    return rows.map((r) => ({
      pincode: r.pincode, product_id: r.product_id, name: r.name, image: r.image || null,
      units: num(r.units), revenue: num(r.revenue),
    }))
  }

  /** New vs repeat, frequency, top customers, lifetime value. */
  async customers(params) {
    const { rows } = await query(
      `WITH ${FACTS_CTE},
       cust AS (
         SELECT customer_id, COUNT(*)::int AS orders, SUM(total_payable) AS spend
           FROM facts GROUP BY customer_id
       ),
       life AS (
         SELECT o.customer_id, COUNT(*)::int AS lifetime_orders,
                MIN(o.created_at) AS first_order_at, SUM(o.total_payable) AS lifetime_value
           FROM orders o
          WHERE ${VALID_ORDER('o')} AND o.customer_id IN (SELECT customer_id FROM cust)
          GROUP BY o.customer_id
       )
       SELECT c.customer_id, c.orders, c.spend,
              l.lifetime_orders, l.first_order_at, l.lifetime_value,
              u.name, u.phone,
              (l.first_order_at >= $1) AS is_new
         FROM cust c
         JOIN life l ON l.customer_id = c.customer_id
         LEFT JOIN users u ON u.id = c.customer_id`,
      params
    )
    return rows.map((r) => ({
      customer_id: r.customer_id, name: r.name, phone: r.phone,
      orders: r.orders, spend: num(r.spend),
      lifetime_orders: r.lifetime_orders, lifetime_value: num(r.lifetime_value),
      is_new: r.is_new === true,
    }))
  }

  /**
   * Previously frequent buyers (3+ orders) who have gone quiet for 30–180 days.
   * "As of now" — independent of the selected range. `monthly_value` is what
   * they used to spend per 30 days at their own historical cadence.
   */
  async lapsedCustomers(shopId, limit = 5) {
    const { rows } = await query(
      `WITH hist AS (
         SELECT o.customer_id, COUNT(*)::int AS n,
                MIN(o.created_at) AS first_at, MAX(o.created_at) AS last_at,
                AVG(o.total_payable) AS aov
           FROM orders o
          WHERE ${VALID_ORDER('o')} AND ($1::uuid IS NULL OR o.shop_id = $1)
          GROUP BY o.customer_id
         HAVING COUNT(*) >= 3
            AND MAX(o.created_at) < NOW() - INTERVAL '30 days'
            AND MAX(o.created_at) >= NOW() - INTERVAL '180 days'
       ),
       scored AS (
         SELECT h.*, u.name, u.phone,
                GREATEST(EXTRACT(EPOCH FROM (last_at - first_at)) / 86400.0 / (n - 1), 1) AS gap_days
           FROM hist h LEFT JOIN users u ON u.id = h.customer_id
       )
       SELECT customer_id, name, phone, n AS orders, last_at,
              aov, LEAST(30.0 / gap_days, 8) * aov AS monthly_value,
              COUNT(*) OVER ()::int AS total_count,
              SUM(LEAST(30.0 / gap_days, 8) * aov) OVER () AS total_monthly_value
         FROM scored
        ORDER BY monthly_value DESC
        LIMIT ${Number(limit) || 5}`,
      [shopId]
    )
    return {
      total: rows[0]?.total_count ?? 0,
      monthly_value: num(rows[0]?.total_monthly_value) ?? 0,
      top: rows.map((r) => ({
        customer_id: r.customer_id, name: r.name, phone: r.phone, orders: r.orders,
        last_order_at: r.last_at, monthly_value: num(r.monthly_value),
      })),
    }
  }

  /** Delivery / rider performance for the window. */
  async delivery(params) {
    const [base, assignments] = await Promise.all([
      query(
        `WITH ${FACTS_CTE}
         SELECT COUNT(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered,
                COALESCE(SUM(rider_cost) FILTER (WHERE status = 'DELIVERED'), 0) AS rider_cost,
                COALESCE(SUM(shiprocket_cost) FILTER (WHERE status = 'DELIVERED'), 0) AS shiprocket_cost,
                AVG(EXTRACT(EPOCH FROM (delivered_at - created_at)) / 60.0)
                  FILTER (WHERE status = 'DELIVERED' AND delivered_at IS NOT NULL
                            AND delivered_at > created_at
                            AND delivered_at - created_at < INTERVAL '24 hours') AS avg_minutes,
                COUNT(*) FILTER (WHERE status = 'DELIVERED' AND delivered_at IS NOT NULL
                                   AND estimated_delivery IS NOT NULL)::int AS timed,
                COUNT(*) FILTER (WHERE status = 'DELIVERED' AND delivered_at IS NOT NULL
                                   AND estimated_delivery IS NOT NULL
                                   AND delivered_at <= estimated_delivery)::int AS on_time
           FROM facts`,
        params
      ),
      query(
        `SELECT
           (SELECT COUNT(*)::int FROM delivery_assignments da JOIN orders o ON o.id = da.order_id
             WHERE da.status = 'CANCELLED' AND o.created_at >= $1 AND o.created_at < $2
               AND ($3::uuid IS NULL OR o.shop_id = $3)
               AND ($4::text IS NULL OR BTRIM(o.delivery_address->>'pincode') = $4)) AS rider_cancelled,
           (SELECT COUNT(*)::int FROM shiprocket_shipments ss JOIN orders o ON o.id = ss.order_id
             WHERE ss.status IN ('FAILED', 'CANCELLED') AND ss.is_simulated IS NOT TRUE
               AND o.created_at >= $1 AND o.created_at < $2
               AND ($3::uuid IS NULL OR o.shop_id = $3)
               AND ($4::text IS NULL OR BTRIM(o.delivery_address->>'pincode') = $4)) AS partner_failed`,
        params
      ),
    ])
    const b = base.rows[0]
    const a = assignments.rows[0]
    return {
      delivered: b.delivered,
      rider_cost: num(b.rider_cost),
      shiprocket_cost: num(b.shiprocket_cost),
      avg_minutes: num(b.avg_minutes),
      timed: b.timed,
      on_time: b.on_time,
      failed: (a.rider_cancelled || 0) + (a.partner_failed || 0),
    }
  }

  /** Vendor purchases (stock bought) + receiving rejections in the window. */
  async vendorPurchases(params) {
    const { rows } = await query(
      `WITH sup AS (
         SELECT so.id, so.vendor_id, so.award_amount
           FROM procurement_supply_orders so
          WHERE so.deleted_at IS NULL AND so.status IN ('RECEIVED', 'CLOSED')
            AND COALESCE(so.received_at, so.updated_at) >= $1
            AND COALESCE(so.received_at, so.updated_at) < $2
            AND ($3::uuid IS NULL OR so.shop_id = $3)
       ),
       rec AS (
         SELECT so.vendor_id,
                SUM(ri.received_quantity * si.agreed_unit_price) AS received_value,
                SUM(ri.rejected_quantity * si.agreed_unit_price) AS rejected_value
           FROM procurement_receipt_items ri
           JOIN procurement_receipts r  ON r.id  = ri.receipt_id
           JOIN procurement_supply_order_items si ON si.id = ri.supply_order_item_id
           JOIN procurement_supply_orders so ON so.id = si.supply_order_id
          WHERE r.received_at >= $1 AND r.received_at < $2
            AND ($3::uuid IS NULL OR so.shop_id = $3)
          GROUP BY so.vendor_id
       )
       SELECT v.id AS vendor_id, v.name,
              COUNT(s.id)::int AS supply_orders,
              COALESCE(SUM(s.award_amount), 0) AS purchases,
              COALESCE(MAX(rec.received_value), 0) AS received_value,
              COALESCE(MAX(rec.rejected_value), 0) AS rejected_value
         FROM sup s
         JOIN vendors v ON v.id = s.vendor_id
         LEFT JOIN rec ON rec.vendor_id = s.vendor_id
        GROUP BY v.id, v.name
        ORDER BY purchases DESC
        LIMIT 20`,
      [params[0], params[1], params[2]]
    )
    return rows.map((r) => ({
      vendor_id: r.vendor_id, name: r.name, supply_orders: r.supply_orders,
      purchases: num(r.purchases), received_value: num(r.received_value),
      rejected_value: num(r.rejected_value),
    }))
  }

  /**
   * Margin generated by each vendor's stock: order lines are attributed to the
   * vendor whose lot fulfilled them (share = allocated qty / ordered qty) and
   * costed with the product's catalogue cost price (unit-safe — vendor unit
   * prices are per kg while lines are per pack).
   */
  async vendorSkuMargins(params) {
    const { rows } = await query(
      `WITH ${FACTS_CTE}
       SELECT so.vendor_id, oi.product_id, MAX(oi.product_name) AS name, MAX(COALESCE(NULLIF(p.thumbnail_url, ''), NULLIF(p.images->>0, ''))) AS image,
              SUM(oi.subtotal * LEAST(a.quantity_allocated / NULLIF(oi.quantity, 0), 1)) AS revenue,
              SUM(a.quantity_allocated * COALESCE(sp.cost_price, p.cost_price))
                FILTER (WHERE COALESCE(sp.cost_price, p.cost_price) IS NOT NULL) AS cogs,
              SUM(oi.subtotal * LEAST(a.quantity_allocated / NULLIF(oi.quantity, 0), 1))
                FILTER (WHERE COALESCE(sp.cost_price, p.cost_price) IS NOT NULL) AS costed_revenue
         FROM facts f
         JOIN order_items oi ON oi.order_id = f.id
         JOIN order_item_inventory_allocations a ON a.order_item_id = oi.id
         JOIN procurement_receipt_items ri ON ri.inventory_lot_id = a.inventory_lot_id
         JOIN procurement_supply_order_items si ON si.id = ri.supply_order_item_id
         JOIN procurement_supply_orders so ON so.id = si.supply_order_id
         LEFT JOIN products p       ON p.id  = oi.product_id
         LEFT JOIN shop_products sp ON sp.id = oi.shop_product_id
        WHERE oi.product_id IS NOT NULL
        GROUP BY so.vendor_id, oi.product_id`,
      params
    )
    return rows.map((r) => ({
      vendor_id: r.vendor_id, product_id: r.product_id, name: r.name, image: r.image || null,
      revenue: num(r.revenue), cogs: num(r.cogs), costed_revenue: num(r.costed_revenue),
    }))
  }

  /** Products bought from one vendor above what other vendors charge (last 90 days). */
  async vendorPriceGaps(shopId) {
    const { rows } = await query(
      `WITH items AS (
         SELECT so.vendor_id, v.name AS vendor_name, si.product_id, si.item_name,
                SUM(si.agreed_quantity) AS qty, SUM(si.agreed_line_total) AS total
           FROM procurement_supply_order_items si
           JOIN procurement_supply_orders so ON so.id = si.supply_order_id
           JOIN vendors v ON v.id = so.vendor_id
          WHERE so.deleted_at IS NULL AND so.status NOT IN ('CANCELLED', 'REJECTED_AT_RECEIPT')
            AND so.created_at >= NOW() - INTERVAL '90 days'
            AND si.product_id IS NOT NULL AND si.agreed_quantity > 0
            AND ($1::uuid IS NULL OR so.shop_id = $1)
          GROUP BY so.vendor_id, v.name, si.product_id, si.item_name
       ),
       priced AS (
         SELECT *, total / qty AS unit_price,
                SUM(total) OVER (PARTITION BY product_id) AS p_total,
                SUM(qty)   OVER (PARTITION BY product_id) AS p_qty,
                COUNT(*)   OVER (PARTITION BY product_id) AS vendors
           FROM items
       )
       SELECT vendor_id, vendor_name, product_id, item_name, qty, unit_price,
              (p_total - total) / NULLIF(p_qty - qty, 0) AS peer_price
         FROM priced
        WHERE vendors >= 2
        ORDER BY (unit_price - (p_total - total) / NULLIF(p_qty - qty, 0)) * qty DESC NULLS LAST
        LIMIT 20`,
      [shopId]
    )
    return rows.map((r) => ({
      vendor_id: r.vendor_id, vendor_name: r.vendor_name, product_id: r.product_id,
      name: r.item_name, qty: num(r.qty), unit_price: num(r.unit_price), peer_price: num(r.peer_price),
    }))
  }

  /**
   * Discount-heavy orders, and orders that lost money WITHOUT being refunded
   * (refund losses are reported through the product return-rate rule instead).
   */
  async discountHealth(params) {
    const { rows } = await query(
      `WITH ${FACTS_CTE}
       SELECT COUNT(*) FILTER (WHERE subtotal > 0 AND discount >= subtotal * 0.25)::int AS heavy_orders,
              COALESCE(SUM(discount) FILTER (WHERE subtotal > 0 AND discount >= subtotal * 0.25), 0) AS heavy_discount,
              COUNT(*) FILTER (WHERE costed AND refund = 0 AND ${CONTRIB} < 0)::int AS loss_orders,
              COALESCE(-SUM(${CONTRIB}) FILTER (WHERE costed AND refund = 0 AND ${CONTRIB} < 0), 0) AS loss_amount,
              COALESCE(SUM(discount) FILTER (WHERE costed AND refund = 0 AND ${CONTRIB} < 0), 0) AS loss_discount
         FROM facts`,
      params
    )
    const r = rows[0]
    return {
      heavy_orders: r.heavy_orders, heavy_discount: num(r.heavy_discount),
      loss_orders: r.loss_orders, loss_amount: num(r.loss_amount), loss_discount: num(r.loss_discount),
    }
  }

  async shopOptions() {
    const { rows } = await query(
      `SELECT id, name FROM shops WHERE deleted_at IS NULL ORDER BY name ASC`
    )
    return rows
  }

  async pincodeOptions(shopId) {
    const { rows } = await query(
      `SELECT BTRIM(o.delivery_address->>'pincode') AS pincode, COUNT(*)::int AS n
         FROM orders o
        WHERE o.delivery_address ? 'pincode'
          AND NULLIF(BTRIM(o.delivery_address->>'pincode'), '') IS NOT NULL
          AND ($1::uuid IS NULL OR o.shop_id = $1)
        GROUP BY 1 ORDER BY n DESC LIMIT 60`,
      [shopId]
    )
    return rows.map((r) => r.pincode)
  }
}
