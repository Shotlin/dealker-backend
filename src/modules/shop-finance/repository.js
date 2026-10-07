import { query } from '../../config/database.js'

/**
 * Shop Finance repository — read-only SQL for store-scoped finance views.
 * Task 8.8: transactions, financials, and CSV export.
 *
 * Conventions:
 *   - No SELECT * — columns named explicitly
 *   - Parameterized queries ($1, $2…)
 *   - Pagination enforced (max 100 for list, max 10000 for export)
 */
export class ShopFinanceRepository {
  static TX_COLUMNS = `
    id, shop_id, type, amount, balance_after,
    reference_type, reference_id, description,
    direction, status, metadata, rider_id, order_id,
    created_by, created_at
  `

  static FIN_COLUMNS = `
    id, shop_id, period_type, period_start, period_end,
    gross_revenue, net_revenue, total_orders, avg_order_value,
    platform_commission, delivery_costs, refund_amount,
    payout_amount, payout_status, payout_ref,
    paid_at, failure_reason, attempt_count,
    created_at, updated_at
  `

  /**
   * Paginated transactions for a shop with optional filters.
   */
  async findTransactions({ shopId, page = 1, limit = 20, type, direction, from, to, order_id }) {
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
    if (order_id) {
      conditions.push(`order_id = $${idx++}`)
      params.push(order_id)
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ${ShopFinanceRepository.TX_COLUMNS}
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
   * Paginated financials for a shop with optional filters.
   */
  async findFinancials({ shopId, page = 1, limit = 20, period_type, from, to, payout_status }) {
    const offset = (page - 1) * limit
    const conditions = ['shop_id = $1']
    const params = [shopId]
    let idx = 2

    if (period_type) {
      conditions.push(`period_type = $${idx++}`)
      params.push(period_type)
    }
    if (from) {
      conditions.push(`period_start >= $${idx++}::date`)
      params.push(from)
    }
    if (to) {
      conditions.push(`period_start <= $${idx++}::date`)
      params.push(to)
    }
    if (payout_status) {
      conditions.push(`payout_status = $${idx++}`)
      params.push(payout_status)
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ${ShopFinanceRepository.FIN_COLUMNS}
           FROM shop_financials
          WHERE ${where}
          ORDER BY period_start DESC, period_type ASC
          LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
           FROM shop_financials
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
   * Fetch transactions for CSV export (max 10000 rows).
   */
  async findTransactionsForExport({ shopId, type, direction, from, to, order_id, limit = 10000 }) {
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
    if (order_id) {
      conditions.push(`order_id = $${idx++}`)
      params.push(order_id)
    }

    const where = conditions.join(' AND ')
    const cappedLimit = Math.min(limit, 10000)

    const { rows } = await query(
      `SELECT ${ShopFinanceRepository.TX_COLUMNS}
         FROM shop_transactions
        WHERE ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $${idx}`,
      [...params, cappedLimit]
    )

    return rows
  }
}
