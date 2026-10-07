import { query, getClient } from '../../config/database.js'

/**
 * Shop Financials WRITE repository — write-side SQL for shop_financials.
 *
 * The read repository (`shop-financials.repository.js`) is read-only by
 * design and is the only thing the HTTP layer talks to. Writes are the
 * exclusive responsibility of the Settlement_Worker (Req 6.2) and the
 * Payout_Worker (Req 8.x). Splitting writes into a separate module keeps
 * the read repository simple to reason about (no surprise mutations) and
 * gives workers a focused, testable surface.
 *
 * Conventions (project-standards.md):
 *   - All queries are parameterized ($1, $2…)
 *   - No SELECT * — column projection always explicit
 *   - All multi-row writes execute inside an explicit transaction so
 *     retries by BullMQ never leave the table partially updated
 *
 * Idempotency: every UPSERT keys on the
 *   uq_shop_financials_shop_period (shop_id, period_type, period_start)
 * unique constraint added by migration 034. Re-running a settlement for
 * the same period overwrites the same row instead of creating duplicates.
 */
export class ShopFinancialsWriteRepository {
  /**
   * Columns the write repository ever returns. Kept narrow on purpose —
   * callers that need full row shape should use the read repository.
   */
  static RETURN_COLUMNS = `
    id, shop_id, period_type, period_start, period_end,
    gross_revenue, net_revenue, total_orders, avg_order_value,
    platform_commission, delivery_costs, refund_amount,
    payout_amount, payout_status, attempt_count,
    created_at, updated_at
  `

  /**
   * UPSERT a shop_financials row for one (shop_id, period_type,
   * period_start) tuple. Uses ON CONFLICT to make the operation idempotent
   * under BullMQ retries (Req 6.7).
   *
   * payout_status / payout_ref / paid_at / failure_reason / attempt_count
   * are intentionally NOT touched on UPDATE — those fields belong to the
   * Payout_Worker's state machine and overwriting them here would erase
   * payout progress when a refund-driven recompute lands later.
   *
   * @param {object} fields - Aggregated values for the period
   * @param {import('pg').PoolClient} [client] - Optional transaction client
   * @returns {Promise<object>} - Upserted row
   */
  async upsert(fields, client) {
    const runner = client || (await getClient())
    const ownsClient = !client
    try {
      if (ownsClient) await runner.query('BEGIN')

      const { rows } = await runner.query(
        `INSERT INTO shop_financials (
           shop_id, period_type, period_start, period_end,
           gross_revenue, net_revenue, total_orders, avg_order_value,
           platform_commission, delivery_costs, refund_amount,
           payout_amount
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7, $8,
           $9, $10, $11,
           $12
         )
         ON CONFLICT ON CONSTRAINT uq_shop_financials_shop_period
         DO UPDATE SET
           period_end          = EXCLUDED.period_end,
           gross_revenue       = EXCLUDED.gross_revenue,
           net_revenue         = EXCLUDED.net_revenue,
           total_orders        = EXCLUDED.total_orders,
           avg_order_value     = EXCLUDED.avg_order_value,
           platform_commission = EXCLUDED.platform_commission,
           delivery_costs      = EXCLUDED.delivery_costs,
           refund_amount       = EXCLUDED.refund_amount,
           payout_amount       = EXCLUDED.payout_amount,
           updated_at          = NOW()
         RETURNING ${ShopFinancialsWriteRepository.RETURN_COLUMNS}`,
        [
          fields.shopId,
          fields.periodType,
          fields.periodStart,
          fields.periodEnd,
          fields.grossRevenue,
          fields.netRevenue,
          fields.totalOrders,
          fields.avgOrderValue,
          fields.platformCommission,
          fields.deliveryCosts,
          fields.refundAmount,
          fields.payoutAmount,
        ]
      )

      if (ownsClient) await runner.query('COMMIT')
      return rows[0]
    } catch (err) {
      if (ownsClient) {
        try {
          await runner.query('ROLLBACK')
        } catch {
          /* ignore — surface original error */
        }
      }
      throw err
    } finally {
      if (ownsClient) runner.release()
    }
  }

  /**
   * Aggregate DELIVERED orders for a single shop within a half-open
   * `[periodStart, periodEnd)` UTC window.
   *
   * gross_revenue uses `subtotal` to match the design.md "gross revenue"
   * definition — the customer-facing pre-fee value of products sold. The
   * fee/cost breakdown is captured separately (delivery_costs comes from
   * delivery_fee; platform commission is computed downstream from the
   * shop's commission_rate).
   *
   * Uses the existing index on (shop_id, status, created_at DESC) — note
   * the WHERE filters by status and shop_id which the index can serve;
   * delivered_at is filtered after the index narrows the candidate set.
   *
   * @param {string} shopId
   * @param {Date|string} periodStart - Inclusive (UTC)
   * @param {Date|string} periodEnd   - Exclusive (UTC)
   * @returns {Promise<{grossRevenue: number, totalOrders: number, deliveryCosts: number}>}
   */
  async aggregateDeliveredOrders(shopId, periodStart, periodEnd) {
    const { rows } = await query(
      `SELECT
         COUNT(*)::int                                AS total_orders,
         COALESCE(SUM(subtotal), 0)::numeric(12,2)    AS gross_revenue,
         COALESCE(SUM(delivery_fee), 0)::numeric(10,2) AS delivery_costs
       FROM orders
       WHERE shop_id = $1
         AND status = 'DELIVERED'
         AND delivered_at >= $2
         AND delivered_at < $3`,
      [shopId, periodStart, periodEnd]
    )
    const r = rows[0] || {}
    return {
      totalOrders: Number(r.total_orders) || 0,
      grossRevenue: Number(r.gross_revenue) || 0,
      deliveryCosts: Number(r.delivery_costs) || 0,
    }
  }

  /**
   * Sum the existing DAILY shop_financials rows that fall within
   * `[periodStart, periodEnd]` (inclusive, by period_start). Used by the
   * weekly/monthly aggregation paths so we don't re-walk the orders table
   * for periods that have already been settled (Req 6.9).
   *
   * Returns the count of daily rows found alongside the sums so the caller
   * can decide whether to settle (e.g., only when 7 daily rows exist for
   * a week).
   *
   * @param {string} shopId
   * @param {string} periodStart - YYYY-MM-DD (inclusive)
   * @param {string} periodEnd   - YYYY-MM-DD (inclusive)
   * @returns {Promise<object>}
   */
  async sumDailyRows(shopId, periodStart, periodEnd) {
    const { rows } = await query(
      `SELECT
         COUNT(*)::int                                       AS daily_count,
         COALESCE(SUM(gross_revenue), 0)::numeric(12,2)      AS gross_revenue,
         COALESCE(SUM(total_orders), 0)::int                 AS total_orders,
         COALESCE(SUM(platform_commission), 0)::numeric(12,2) AS platform_commission,
         COALESCE(SUM(delivery_costs), 0)::numeric(12,2)     AS delivery_costs,
         COALESCE(SUM(refund_amount), 0)::numeric(12,2)      AS refund_amount,
         COALESCE(SUM(net_revenue), 0)::numeric(12,2)        AS net_revenue,
         COALESCE(SUM(payout_amount), 0)::numeric(12,2)      AS payout_amount
       FROM shop_financials
       WHERE shop_id = $1
         AND period_type = 'DAILY'
         AND period_start >= $2::date
         AND period_start <= $3::date`,
      [shopId, periodStart, periodEnd]
    )
    const r = rows[0] || {}
    return {
      dailyCount: Number(r.daily_count) || 0,
      grossRevenue: Number(r.gross_revenue) || 0,
      totalOrders: Number(r.total_orders) || 0,
      platformCommission: Number(r.platform_commission) || 0,
      deliveryCosts: Number(r.delivery_costs) || 0,
      refundAmount: Number(r.refund_amount) || 0,
      netRevenue: Number(r.net_revenue) || 0,
      payoutAmount: Number(r.payout_amount) || 0,
    }
  }

  /**
   * Page through active, non-deleted shops (by id). Keyset cursor over
   * shops.id keeps memory bounded on the 2-core/4GB target — never load
   * all shops into memory at once.
   *
   * @param {object} options
   * @param {string|null} [options.afterId] - Cursor (shop UUID); null for first page
   * @param {number} [options.limit=50]
   * @returns {Promise<Array<{id: string, commission_rate: number|string}>>}
   */
  async listActiveShopsPage({ afterId = null, limit = 50 } = {}) {
    const params = []
    let where = 'is_active = true AND deleted_at IS NULL'
    let idx = 1

    if (afterId) {
      where += ` AND id > $${idx++}`
      params.push(afterId)
    }

    params.push(limit)

    const { rows } = await query(
      `SELECT id, commission_rate
         FROM shops
        WHERE ${where}
        ORDER BY id ASC
        LIMIT $${idx}`,
      params
    )
    return rows
  }

  /**
   * Look up a single shop's commission_rate (excludes soft-deleted).
   * Used by the SettlementService as a fallback when the caller does not
   * pre-populate the rate from the page result.
   *
   * @param {string} shopId
   * @returns {Promise<number>} commission_rate or 0 if shop missing
   */
  async findCommissionRate(shopId) {
    const { rows } = await query(
      `SELECT commission_rate
         FROM shops
        WHERE id = $1 AND deleted_at IS NULL`,
      [shopId]
    )
    return Number(rows[0]?.commission_rate) || 0
  }

  /**
   * Resolve `(shop_id, completion_date)` for a refund landing on an
   * existing order (Req 6.8). The completion date is taken from
   * `delivered_at` (UTC) when present and falls back to `created_at`
   * for orders that completed without a recorded delivery timestamp.
   *
   * Parameterized, single-row, indexed by orders PK — O(log n).
   *
   * @param {string} orderId
   * @returns {Promise<{shopId: string|null, dateStr: string|null}|null>}
   */
  async findOrderShopAndCompletion(orderId) {
    const { rows } = await query(
      `SELECT shop_id,
              (COALESCE(delivered_at, created_at) AT TIME ZONE 'UTC')::date
                AS completion_date
         FROM orders
        WHERE id = $1`,
      [orderId]
    )
    if (rows.length === 0) return null
    const row = rows[0]
    if (!row.shop_id || !row.completion_date) {
      return { shopId: row.shop_id || null, dateStr: null }
    }
    const cd = row.completion_date
    const dateStr =
      cd instanceof Date
        ? `${cd.getUTCFullYear()}-${String(cd.getUTCMonth() + 1).padStart(2, '0')}-${String(cd.getUTCDate()).padStart(2, '0')}`
        : String(cd).slice(0, 10)
    return { shopId: row.shop_id, dateStr }
  }

  /**
   * Persist a failure reason on an existing shop_financials row (Req 6.7).
   * No-op if the row does not exist — settlement only writes a row when
   * aggregation succeeds, so failure reasons are recorded only when we
   * have already partially settled the shop and a later step blew up
   * (e.g. cache invalidation, refund recompute, payout state transition).
   *
   * Bumps `attempt_count` so operators can spot the most-retried rows in
   * the admin financials view.
   *
   * @param {string} shopId
   * @param {string} periodType
   * @param {string} periodStart - YYYY-MM-DD
   * @param {string} reason
   * @returns {Promise<boolean>} true if a row was updated
   */
  async recordFailureReason(shopId, periodType, periodStart, reason) {
    const { rowCount } = await query(
      `UPDATE shop_financials
          SET failure_reason = $4,
              attempt_count  = attempt_count + 1,
              updated_at     = NOW()
        WHERE shop_id      = $1
          AND period_type  = $2
          AND period_start = $3::date`,
      [shopId, periodType, periodStart, reason]
    )
    return rowCount > 0
  }

  /**
   * Look up the daily shop_financials row for the (shop, completion-date)
   * tuple that a refund needs to amend (Req 6.8).
   *
   * @param {string} shopId
   * @param {string} dateStr - YYYY-MM-DD UTC of the original order's completion
   * @returns {Promise<object|null>}
   */
  async findDailyForShop(shopId, dateStr) {
    const { rows } = await query(
      `SELECT id, shop_id, period_type, period_start, period_end,
              gross_revenue, net_revenue, total_orders, avg_order_value,
              platform_commission, delivery_costs, refund_amount,
              payout_amount, payout_status
         FROM shop_financials
        WHERE shop_id      = $1
          AND period_type  = 'DAILY'
          AND period_start = $2::date`,
      [shopId, dateStr]
    )
    return rows[0] || null
  }

  /**
   * Apply a late-arriving refund to an existing daily row in a single
   * transaction with SELECT FOR UPDATE (Req 6.8, 14.8).
   *
   * Recomputes net_revenue and payout_amount additively (refund_amount +=
   * delta, net/payout += signedNetDelta) and rejects any update that would
   * mutate a row already in PROCESSING or PAID state — once payout has
   * advanced, money is committed and the refund must be reconciled out of
   * band by a Super Admin (Req 8.7 release flow).
   *
   * @param {object} input
   * @param {string} input.shopId
   * @param {string} input.dateStr      - YYYY-MM-DD UTC
   * @param {number} input.refundDelta  - Amount added to refund_amount (≥ 0)
   * @param {number} input.netDelta     - Signed delta applied to net_revenue and payout_amount
   * @returns {Promise<object|null>} updated row, `{locked:true, payoutStatus}` when frozen, or null
   */
  async applyLateRefund({ shopId, dateStr, refundDelta, netDelta }) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows: lockRows } = await client.query(
        `SELECT id, payout_status, refund_amount, net_revenue, payout_amount
           FROM shop_financials
          WHERE shop_id      = $1
            AND period_type  = 'DAILY'
            AND period_start = $2::date
          FOR UPDATE`,
        [shopId, dateStr]
      )
      if (lockRows.length === 0) {
        await client.query('ROLLBACK')
        return null
      }

      const current = lockRows[0]
      if (
        current.payout_status === 'PROCESSING' ||
        current.payout_status === 'PAID'
      ) {
        await client.query('ROLLBACK')
        return { locked: true, payoutStatus: current.payout_status }
      }

      const { rows } = await client.query(
        `UPDATE shop_financials
            SET refund_amount = refund_amount + $2,
                net_revenue   = net_revenue + $3,
                payout_amount = payout_amount + $3,
                updated_at    = NOW()
          WHERE id = $1
          RETURNING ${ShopFinancialsWriteRepository.RETURN_COLUMNS}`,
        [current.id, refundDelta, netDelta]
      )

      await client.query('COMMIT')
      return rows[0]
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore — surface original error */
      }
      throw err
    } finally {
      client.release()
    }
  }

  // ════════════════════════════════════════════════════════
  // PAYOUT HELPERS (Task 9.2 — Requirements 8.1–8.7)
  // ════════════════════════════════════════════════════════
  //
  // Conventions:
  //   - Reads use the global pool (`query`); writes that must coordinate
  //     with the ledger take a transactional `client` from the caller so
  //     the row lock, status transition, and shop_transactions append all
  //     commit (or roll back) together.
  //   - All queries are parameterized; no string concatenation.
  //   - WHERE clauses align with the migration-defined indexes:
  //       * findPendingPayouts → idx_shop_financials_payout_status_pending
  //         (partial index on PENDING) + bounded keyset by id.
  //       * lockFinancialById → primary key.

  /**
   * Page through PENDING shop_financials rows whose period has ended on or
   * before `asOfDate` (Req 8.1). Keyset cursor over the row id keeps memory
   * bounded — we never load all candidates into memory.
   *
   * Selects only the columns the worker needs (id, shop_id, payout_status,
   * payout_amount, attempt_count, period_start, period_end) — projection is
   * narrow on purpose so the worker's hot loop stays small.
   *
   * @param {object} options
   * @param {string} options.asOfDate - YYYY-MM-DD (UTC); period_end <= asOfDate
   * @param {string|null} [options.afterId=null]
   * @param {number} [options.limit=50]
   * @returns {Promise<Array<object>>}
   */
  async findPendingPayouts({ asOfDate, afterId = null, limit = 50 }) {
    if (!asOfDate) {
      throw new Error('findPendingPayouts: asOfDate is required (YYYY-MM-DD)')
    }
    const params = [asOfDate]
    let where = `payout_status = 'PENDING' AND period_end <= $1::date`
    let idx = 2

    if (afterId) {
      where += ` AND id > $${idx++}`
      params.push(afterId)
    }

    params.push(limit)

    const { rows } = await query(
      `SELECT id, shop_id, payout_status, payout_amount,
              attempt_count, period_type, period_start, period_end
         FROM shop_financials
        WHERE ${where}
        ORDER BY id ASC
        LIMIT $${idx}`,
      params
    )
    return rows
  }

  /**
   * SELECT FOR UPDATE on a single shop_financials row by id, inside the
   * caller's transaction. Returns the locked row (or null when missing).
   *
   * Caller MUST already own a transactional client (BEGIN issued) and is
   * responsible for COMMIT/ROLLBACK.
   *
   * @param {import('pg').PoolClient} client
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async lockFinancialById(client, id) {
    if (!client || typeof client.query !== 'function') {
      throw new TypeError(
        'lockFinancialById requires a transactional pg client'
      )
    }
    const { rows } = await client.query(
      `SELECT id, shop_id, period_type, period_start, period_end,
              gross_revenue, net_revenue, total_orders, avg_order_value,
              platform_commission, delivery_costs, refund_amount,
              payout_amount, payout_status, payout_ref,
              paid_at, failure_reason, attempt_count
         FROM shop_financials
        WHERE id = $1
        FOR UPDATE`,
      [id]
    )
    return rows[0] || null
  }

  /**
   * Guarded payout_status transition (Req 8.2, 8.5, 8.7). Updates only when
   * the current status is in `fromStatuses`, returning the updated row or
   * null when the guard fails. Optional `extras` allow the caller to set
   * paid_at / payout_ref / failure_reason as part of the same UPDATE so the
   * transition lands atomically.
   *
   * @param {import('pg').PoolClient} client
   * @param {string} id - shop_financials.id
   * @param {string[]} fromStatuses - allowed current states
   * @param {string} toStatus - target state
   * @param {object} [extras]
   * @param {Date|null} [extras.paidAt]
   * @param {string|null} [extras.payoutRef]
   * @param {string|null} [extras.failureReason]
   * @param {boolean} [extras.clearFailureReason]
   * @returns {Promise<object|null>} updated row, or null if guard failed
   */
  async transitionPayoutStatus(
    client,
    id,
    fromStatuses,
    toStatus,
    extras = {}
  ) {
    if (!client || typeof client.query !== 'function') {
      throw new TypeError(
        'transitionPayoutStatus requires a transactional pg client'
      )
    }
    if (!Array.isArray(fromStatuses) || fromStatuses.length === 0) {
      throw new Error(
        'transitionPayoutStatus requires a non-empty fromStatuses array'
      )
    }
    if (!toStatus) {
      throw new Error('transitionPayoutStatus requires a toStatus')
    }

    // Build an `IN ($2,$3,…)` clause with a bounded number of placeholders.
    const fromPlaceholders = fromStatuses
      .map((_, i) => `$${i + 3}`)
      .join(', ')
    const params = [id, toStatus, ...fromStatuses]
    let setClause =
      `payout_status = $2,
              updated_at    = NOW()`

    let pIdx = params.length + 1
    if (extras.paidAt) {
      setClause += `,\n              paid_at = $${pIdx++}`
      params.push(extras.paidAt)
    }
    if (extras.payoutRef !== undefined && extras.payoutRef !== null) {
      setClause += `,\n              payout_ref = $${pIdx++}`
      params.push(extras.payoutRef)
    }
    if (extras.clearFailureReason) {
      setClause += `,\n              failure_reason = NULL`
    } else if (
      extras.failureReason !== undefined &&
      extras.failureReason !== null
    ) {
      setClause += `,\n              failure_reason = $${pIdx++}`
      params.push(extras.failureReason)
    }

    const { rows } = await client.query(
      `UPDATE shop_financials
          SET ${setClause}
        WHERE id = $1
          AND payout_status IN (${fromPlaceholders})
        RETURNING ${ShopFinancialsWriteRepository.RETURN_COLUMNS}`,
      params
    )
    return rows[0] || null
  }

  /**
   * Increment attempt_count for a shop_financials row inside the caller's
   * transaction. Used by the Payout_Worker on transient disbursement
   * failures (Req 8.5).
   *
   * Returns the new attempt_count (so the caller can decide whether to set
   * HELD on the next iteration without an extra SELECT).
   *
   * @param {import('pg').PoolClient} client
   * @param {string} id
   * @returns {Promise<number>} new attempt_count
   */
  async incrementAttemptCount(client, id) {
    if (!client || typeof client.query !== 'function') {
      throw new TypeError(
        'incrementAttemptCount requires a transactional pg client'
      )
    }
    const { rows } = await client.query(
      `UPDATE shop_financials
          SET attempt_count = attempt_count + 1,
              updated_at    = NOW()
        WHERE id = $1
        RETURNING attempt_count`,
      [id]
    )
    return rows[0] ? Number(rows[0].attempt_count) : 0
  }

  /**
   * Read bank details for a shop on the caller's transactional client.
   * Used by the Payout_Worker to enforce Req 8.6 — any null/empty value
   * here blocks the payout and routes the row to HELD.
   *
   * Excludes soft-deleted shops (deleted_at IS NOT NULL).
   *
   * @param {import('pg').PoolClient} client
   * @param {string} shopId
   * @returns {Promise<{
   *   bank_account_number: string|null,
   *   bank_ifsc: string|null,
   *   bank_name: string|null,
   *   bank_holder_name: string|null
   * }|null>}
   */
  async findShopBankDetails(client, shopId) {
    if (!client || typeof client.query !== 'function') {
      throw new TypeError(
        'findShopBankDetails requires a transactional pg client'
      )
    }
    const { rows } = await client.query(
      `SELECT bank_account_number, bank_ifsc, bank_name, bank_holder_name
         FROM shops
        WHERE id = $1
          AND deleted_at IS NULL`,
      [shopId]
    )
    return rows[0] || null
  }

  /**
   * Single-row fetch of shop_financials.id (used by admin hold/release flow
   * to confirm existence before enqueueing a job).
   *
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findFinancialById(id) {
    const { rows } = await query(
      `SELECT id, shop_id, payout_status, attempt_count
         FROM shop_financials
        WHERE id = $1`,
      [id]
    )
    return rows[0] || null
  }
}
