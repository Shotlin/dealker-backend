import { query } from '../../../config/database.js'

/**
 * Admin Finance repository — HQ-scoped finance SQL (task 8.9).
 * All queries parameterized, no SELECT *, pagination enforced.
 */
export class AdminFinanceRepository {
  static SHOP_COLUMNS = `
    s.id, s.name, s.commission_rate, s.is_active,
    s.bank_account_number, s.bank_ifsc, s.bank_name, s.bank_holder_name
  `

  static TX_COLUMNS = `
    id, shop_id, type, amount, balance_after,
    reference_type, reference_id, description,
    direction, status, metadata, rider_id, order_id,
    created_by, created_at
  `

  static FIN_COLUMNS = `
    sf.id, sf.shop_id, sf.period_type, sf.period_start, sf.period_end,
    sf.gross_revenue, sf.net_revenue, sf.total_orders, sf.avg_order_value,
    sf.platform_commission, sf.delivery_costs, sf.refund_amount,
    sf.payout_amount, sf.payout_status, sf.payout_ref,
    sf.paid_at, sf.failure_reason, sf.attempt_count,
    sf.created_at, sf.updated_at
  `

  /**
   * List shops with finance summary (paginated).
   */
  async findShops({ page = 1, limit = 20, search, has_pending_payout }) {
    const offset = (page - 1) * limit
    const conditions = ['s.deleted_at IS NULL']
    const params = []
    let idx = 1

    if (search) {
      conditions.push(`s.name ILIKE $${idx++}`)
      params.push(`%${search}%`)
    }

    if (has_pending_payout === true) {
      conditions.push(`EXISTS (
        SELECT 1 FROM shop_financials sf2
        WHERE sf2.shop_id = s.id AND sf2.payout_status = 'PENDING'
      )`)
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ${AdminFinanceRepository.SHOP_COLUMNS}
           FROM shops s
          WHERE ${where}
          ORDER BY s.name ASC
          LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
           FROM shops s
          WHERE ${where}`,
        params
      ),
    ])

    return {
      items: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }

  /**
   * Transactions for a specific shop (HQ view, paginated).
   */
  async findShopTransactions({ shopId, page = 1, limit = 20, type, direction, from, to }) {
    const offset = (page - 1) * limit
    const conditions = ['shop_id = $1']
    const params = [shopId]
    let idx = 2

    if (type) {
      conditions.push(`type = $${idx++}`)
      params.push(type)
    }
    if (direction) {
      conditions.push(`direction = $${idx++}`)
      params.push(direction)
    }
    if (from instanceof Date) {
      conditions.push(`created_at >= $${idx++}`)
      params.push(from)
    }
    if (to instanceof Date) {
      conditions.push(`created_at < $${idx++}`)
      params.push(to)
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ${AdminFinanceRepository.TX_COLUMNS}
           FROM shop_transactions
          WHERE ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
           FROM shop_transactions
          WHERE ${where}`,
        params
      ),
    ])

    return {
      items: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }

  /**
   * Financials for a specific shop (HQ view, paginated).
   */
  async findShopFinancials({ shopId, page = 1, limit = 20, period_type, from, to, payout_status }) {
    const offset = (page - 1) * limit
    const conditions = ['sf.shop_id = $1']
    const params = [shopId]
    let idx = 2

    if (period_type) {
      conditions.push(`sf.period_type = $${idx++}`)
      params.push(period_type)
    }
    if (from) {
      conditions.push(`sf.period_start >= $${idx++}::date`)
      params.push(from)
    }
    if (to) {
      conditions.push(`sf.period_start <= $${idx++}::date`)
      params.push(to)
    }
    if (payout_status) {
      conditions.push(`sf.payout_status = $${idx++}`)
      params.push(payout_status)
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ${AdminFinanceRepository.FIN_COLUMNS}
           FROM shop_financials sf
          WHERE ${where}
          ORDER BY sf.period_start DESC
          LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
           FROM shop_financials sf
          WHERE ${where}`,
        params
      ),
    ])

    return {
      items: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }

  /**
   * Find a single shop_financials row by id and shopId (for mark-paid).
   */
  async findFinancialByIdAndShop(periodId, shopId) {
    const { rows } = await query(
      `SELECT id, shop_id, payout_status, payout_amount, period_start, period_end
         FROM shop_financials
        WHERE id = $1 AND shop_id = $2`,
      [periodId, shopId]
    )
    return rows[0] || null
  }

  /**
   * Find a single shop_financials row by id only (no shopId scoping) — used
   * by the HQ-wide flat mark-paid endpoint, which doesn't know the shopId
   * up front (the dashboard's cross-shop Financials tab only has the row id).
   */
  async findFinancialById(periodId) {
    const { rows } = await query(
      `SELECT id, shop_id, payout_status, payout_amount, period_start, period_end
         FROM shop_financials
        WHERE id = $1`,
      [periodId]
    )
    return rows[0] || null
  }

  /**
   * Transactions across ALL shops (HQ-wide flat view), optionally filtered
   * to one shop. Backs the dashboard's Transactions tab, which shows every
   * shop's ledger in one table with an optional shop filter dropdown —
   * distinct from findShopTransactions() above, which always requires one.
   */
  async findTransactions({ page = 1, limit = 20, shop_id, type, direction, startDate, endDate }) {
    const offset = (page - 1) * limit
    const conditions = []
    const params = []
    let idx = 1

    if (shop_id) {
      conditions.push(`t.shop_id = $${idx++}`)
      params.push(shop_id)
    }
    if (type) {
      conditions.push(`t.type = $${idx++}`)
      params.push(type)
    }
    if (direction) {
      conditions.push(`t.direction = $${idx++}`)
      params.push(direction)
    }
    if (startDate) {
      conditions.push(`t.created_at >= $${idx++}::timestamptz`)
      params.push(startDate)
    }
    if (endDate) {
      conditions.push(`t.created_at < $${idx++}::timestamptz`)
      params.push(endDate)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const txColumns = AdminFinanceRepository.TX_COLUMNS.split(',')
      .map((c) => `t.${c.trim()}`)
      .join(', ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ${txColumns}, s.name AS shop_name
           FROM shop_transactions t
           JOIN shops s ON s.id = t.shop_id
          ${where}
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
           FROM shop_transactions t
          ${where}`,
        params
      ),
    ])

    return {
      items: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }

  /**
   * Financials across ALL shops (HQ-wide flat view), optionally filtered to
   * one shop. Backs the dashboard's Financials tab (same cross-shop-table +
   * optional-filter shape as findTransactions above).
   */
  async findFinancials({ page = 1, limit = 20, shop_id, period_type, payout_status, startDate, endDate }) {
    const offset = (page - 1) * limit
    const conditions = []
    const params = []
    let idx = 1

    if (shop_id) {
      conditions.push(`sf.shop_id = $${idx++}`)
      params.push(shop_id)
    }
    if (period_type) {
      conditions.push(`sf.period_type = $${idx++}`)
      params.push(period_type)
    }
    if (payout_status) {
      conditions.push(`sf.payout_status = $${idx++}`)
      params.push(payout_status)
    }
    if (startDate) {
      conditions.push(`sf.period_start >= $${idx++}::date`)
      params.push(startDate)
    }
    if (endDate) {
      conditions.push(`sf.period_start <= $${idx++}::date`)
      params.push(endDate)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const [dataResult, countResult] = await Promise.all([
      query(
        // Aliased to the dashboard's HQFinancial shape (total_revenue /
        // commission_amount) — distinct from FIN_COLUMNS' raw
        // gross_revenue / platform_commission names used elsewhere.
        `SELECT sf.id, sf.shop_id, sf.period_type, sf.period_start, sf.period_end,
                sf.gross_revenue AS total_revenue,
                sf.net_revenue, sf.total_orders, sf.avg_order_value,
                sf.platform_commission AS commission_amount,
                sf.delivery_costs, sf.refund_amount,
                sf.payout_amount, sf.payout_status, sf.payout_ref,
                sf.paid_at, sf.failure_reason, sf.attempt_count,
                sf.created_at, sf.updated_at, s.name AS shop_name
           FROM shop_financials sf
           JOIN shops s ON s.id = sf.shop_id
          ${where}
          ORDER BY sf.period_start DESC
          LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
           FROM shop_financials sf
          ${where}`,
        params
      ),
    ])

    return {
      items: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }

  /**
   * Payout report for CSV export (max 10000 rows).
   */
  async findPayoutReport({ from, to, payout_status, limit = 10000 }) {
    const conditions = []
    const params = []
    let idx = 1

    if (from) {
      conditions.push(`sf.period_start >= $${idx++}::date`)
      params.push(from)
    }
    if (to) {
      conditions.push(`sf.period_start <= $${idx++}::date`)
      params.push(to)
    }
    if (payout_status) {
      conditions.push(`sf.payout_status = $${idx++}`)
      params.push(payout_status)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const cappedLimit = Math.min(limit, 10000)

    const { rows } = await query(
      `SELECT sf.id, sf.shop_id, s.name AS shop_name,
              sf.period_type, sf.period_start, sf.period_end,
              sf.gross_revenue, sf.net_revenue, sf.payout_amount,
              sf.payout_status, sf.payout_ref, sf.paid_at
         FROM shop_financials sf
         JOIN shops s ON s.id = sf.shop_id
        ${where}
        ORDER BY sf.period_start DESC, s.name ASC
        LIMIT $${idx}`,
      [...params, cappedLimit]
    )

    return rows
  }

  /**
   * Comparison view — aggregate financials per shop for a period range.
   */
  async findComparison({ period_type, from, to, page = 1, limit = 20 }) {
    const offset = (page - 1) * limit

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT sf.shop_id, s.name AS shop_name,
                SUM(sf.gross_revenue)::numeric(12,2) AS total_gross,
                SUM(sf.net_revenue)::numeric(12,2) AS total_net,
                SUM(sf.total_orders)::int AS total_orders,
                SUM(sf.platform_commission)::numeric(12,2) AS total_commission,
                SUM(sf.payout_amount)::numeric(12,2) AS total_payout
           FROM shop_financials sf
           JOIN shops s ON s.id = sf.shop_id
          WHERE sf.period_type = $1
            AND sf.period_start >= $2::date
            AND sf.period_start <= $3::date
          GROUP BY sf.shop_id, s.name
          ORDER BY total_gross DESC
          LIMIT $4 OFFSET $5`,
        [period_type, from, to, limit, offset]
      ),
      query(
        `SELECT COUNT(DISTINCT sf.shop_id)::int AS total
           FROM shop_financials sf
          WHERE sf.period_type = $1
            AND sf.period_start >= $2::date
            AND sf.period_start <= $3::date`,
        [period_type, from, to]
      ),
    ])

    return {
      items: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }
}
