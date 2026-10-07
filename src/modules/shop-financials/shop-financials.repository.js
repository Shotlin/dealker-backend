import { query } from '../../config/database.js'

/**
 * Shop Financials repository — read-only SQL for shop_financials.
 *
 * Conventions (project-standards.md):
 *   - NEVER `SELECT *` — every column is named explicitly
 *   - All queries use parameterized placeholders ($1, $2…)
 *   - This module is READ-ONLY. All writes happen in the Settlement_Worker
 *     (task 9.1) and Payout_Worker (task 9.2), which use their own
 *     transactional repositories.
 *
 * Supporting indexes (migration 034_shop_financials.sql):
 *   - idx_shop_financials_shop_period_start
 *       (shop_id, period_type, period_start DESC)
 *   - idx_shop_financials_payout_status_pending
 *       (payout_status) WHERE payout_status='PENDING'
 *   - uq_shop_financials_shop_period (shop_id, period_type, period_start)
 */
export class ShopFinancialsRepository {
  /**
   * Column projection — kept in one place so list/get queries stay aligned.
   * Note: paid_at/failure_reason are payout-side fields populated by the
   * Payout_Worker; surfacing them here gives shop admins visibility into
   * payout state without an extra join.
   */
  static SELECT_COLUMNS = `
    id, shop_id,
    period_type, period_start, period_end,
    gross_revenue, net_revenue,
    total_orders, avg_order_value,
    platform_commission, delivery_costs, refund_amount,
    payout_amount, payout_status, payout_ref,
    paid_at, failure_reason, attempt_count,
    created_at, updated_at
  `

  /**
   * Find a single shop_financials record scoped to a shop.
   *
   * @param {string} id - shop_financial UUID
   * @param {string} shopId - Shop UUID for scope enforcement
   * @returns {Promise<object|null>}
   */
  async findById(id, shopId) {
    const { rows } = await query(
      `SELECT ${ShopFinancialsRepository.SELECT_COLUMNS}
         FROM shop_financials
        WHERE id = $1 AND shop_id = $2`,
      [id, shopId]
    )
    return rows[0] || null
  }

  /**
   * List shop_financials for a shop with pagination and optional filters.
   *
   * Filters:
   *   - period_type   : exact match (DAILY | WEEKLY | MONTHLY)
   *   - from / to     : inclusive period_start range (DATE comparison)
   *   - payout_status : exact match (PENDING | PROCESSING | PAID | HELD)
   *
   * Ordered by period_start DESC to match
   *   idx_shop_financials_shop_period_start.
   *
   * @param {object} filters
   * @param {string} filters.shopId       - Required shop scope
   * @param {number} [filters.page=1]
   * @param {number} [filters.limit=20]
   * @param {string} [filters.period_type]
   * @param {string} [filters.from]       - YYYY-MM-DD inclusive
   * @param {string} [filters.to]         - YYYY-MM-DD inclusive
   * @param {string} [filters.payout_status]
   * @returns {Promise<{items: Array<object>, total: number}>}
   */
  async findMany({
    shopId,
    page = 1,
    limit = 20,
    period_type,
    from,
    to,
    payout_status,
  }) {
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

    // Run list + count in parallel; both share the same param array up to the
    // count's index (limit/offset are list-only and added after).
    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ${ShopFinancialsRepository.SELECT_COLUMNS}
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
}
