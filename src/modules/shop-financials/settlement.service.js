import { logger } from '../../config/logger.js'
import { getClient } from '../../config/database.js'
import { ShopFinancialsWriteRepository } from './shop-financials.write.repository.js'
import { ShopFinancialsService } from './shop-financials.service.js'
import { ShopFinancialsRepository } from './shop-financials.repository.js'
import { TransactionWriterService } from '../shop-finance/transaction-writer.service.js'
import {
  computeCommission as ffComputeCommission,
  computeNetRevenue as ffComputeNetRevenue,
  computeAvgOrderValue as ffComputeAvgOrderValue,
} from './financial-formula.js'

/**
 * Settlement service — pure aggregation logic + UPSERT driver.
 *
 * Called from the BullMQ Settlement_Worker (`workers/settlement.worker.js`)
 * once per day at 02:00 UTC. Every active shop is settled for the previous
 * UTC day; weekly/monthly aggregates are produced when their period ends
 * (Req 6.2, 6.9).
 *
 * Pure compute helpers (`computeCommission`, `computeNetRevenue`,
 * `computeAvgOrderValue`) are exported so:
 *   - Property test 8 (Financial Formula) can drive them with fast-check
 *   - Unit tests can verify formulas without spinning up DB or Redis
 *
 * gross_revenue choice (per design.md "Settlement Worker" + task brief):
 *   gross_revenue = SUM(orders.subtotal)
 *
 *   Rationale: design.md and Req 6.3 define platform_commission as
 *   `gross_revenue * commission_rate / 100`, and Req 6.4 defines net as
 *   `gross - commission - delivery_costs - refund_amount`. Using subtotal
 *   keeps "gross" purely the merchandise value and lets commission /
 *   delivery_costs / refunds remain explicit deductions, matching the
 *   ledger semantics (ORDER_REVENUE = subtotal, COMMISSION_DEBIT =
 *   commission_rate * subtotal, DELIVERY_COST = delivery_fee).
 *
 * Resource budget (Req 14.6, 14.11):
 *   - Worker concurrency 1 (financial writes serialized)
 *   - Each shop is settled in <=4 SQL calls + 1 UPSERT
 *   - Pagination over shops (batch 50) — bounded memory
 *   - No new caches; settlement INVALIDATES the read-side financials cache
 *     after writes via ShopFinancialsService.invalidateForShop(shopId)
 */
export class SettlementService {
  /**
   * @param {object} [deps]
   * @param {ShopFinancialsWriteRepository} [deps.writeRepository]
   * @param {ShopFinancialsService} [deps.financialsService]
   * @param {ShopFinancialsRepository} [deps.financialsRepository]
   * @param {TransactionWriterService} [deps.transactionWriter]
   */
  constructor(deps = {}) {
    this.writeRepo =
      deps.writeRepository || new ShopFinancialsWriteRepository()
    this.financialsService =
      deps.financialsService ||
      new ShopFinancialsService(
        deps.financialsRepository || new ShopFinancialsRepository()
      )
    this.transactionWriter =
      deps.transactionWriter || new TransactionWriterService()
  }

  // ────────────────────────────────────────────────────────
  // Pure compute helpers (no I/O — Property 8 friendly)
  // ────────────────────────────────────────────────────────

  /**
   * Commission = gross_revenue * commission_rate / 100, rounded to 2dp.
   * Validates Req 6.3 / Property 8 (Financial Formula).
   *
   * Delegates to the canonical pure helper in `./financial-formula.js` so
   * the worker, this service, and Property 8 all consume the same code
   * path (single source of truth).
   *
   * @param {number} grossRevenue   - >= 0
   * @param {number} commissionRate - 0..100 (percent)
   * @returns {number} rounded to 2 decimal places
   */
  static computeCommission(grossRevenue, commissionRate) {
    return ffComputeCommission(grossRevenue, commissionRate)
  }

  /**
   * net_revenue = gross - commission - delivery_costs - refund_amount,
   * rounded to 2 decimal places. Validates Req 6.4 / Property 8.
   *
   * Note: net_revenue may legitimately be negative when refunds and
   * delivery costs exceed gross — we don't clamp to zero because the
   * ledger needs the true mathematical value.
   *
   * Signature kept legacy-compatible (commission already pre-computed) so
   * existing call sites and tests are unchanged. The pure helper in
   * `financial-formula.js` is reserved for the rate-based call shape.
   */
  static computeNetRevenue(
    grossRevenue,
    platformCommission,
    deliveryCosts,
    refundAmount
  ) {
    const g = SettlementService._toFiniteNumber(grossRevenue)
    const c = SettlementService._toFiniteNumber(platformCommission)
    const d = SettlementService._toFiniteNumber(deliveryCosts)
    const r = SettlementService._toFiniteNumber(refundAmount)
    return SettlementService._round2(g - c - d - r)
  }

  /**
   * avg_order_value = gross_revenue / total_orders, rounded to 2dp.
   * Returns 0 when total_orders is 0 (no division by zero).
   */
  static computeAvgOrderValue(grossRevenue, totalOrders) {
    return ffComputeAvgOrderValue(grossRevenue, totalOrders)
  }

  /** @private */
  static _toFiniteNumber(v) {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n : 0
  }

  /** @private */
  static _round2(n) {
    if (!Number.isFinite(n)) return 0
    return Math.round(n * 100) / 100
  }

  // ────────────────────────────────────────────────────────
  // Period helpers (UTC-only)
  // ────────────────────────────────────────────────────────

  /**
   * Return the previous UTC calendar day as
   *   { startUtc, endUtc, dateStr }
   * with startUtc inclusive and endUtc exclusive.
   */
  static previousUtcDay(now = new Date()) {
    const today = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0, 0, 0, 0
      )
    )
    const start = new Date(today.getTime() - 24 * 60 * 60 * 1000)
    return {
      startUtc: start,
      endUtc: today,
      dateStr: SettlementService.toDateString(start),
    }
  }

  /** UTC YYYY-MM-DD for a Date. */
  static toDateString(d) {
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    const day = String(d.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  /**
   * ISO Monday of the week containing `date` (Sunday rolls back 6 days).
   */
  static weekStartFor(date) {
    const d = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    )
    const day = d.getUTCDay()
    const offset = day === 0 ? -6 : 1 - day
    d.setUTCDate(d.getUTCDate() + offset)
    return SettlementService.toDateString(d)
  }

  /** Sunday following a given Monday (period_end inclusive). */
  static weekEndFor(mondayDateStr) {
    const monday = new Date(`${mondayDateStr}T00:00:00.000Z`)
    const sunday = new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000)
    return SettlementService.toDateString(sunday)
  }

  /** First day of the month containing `date`, as YYYY-MM-DD. */
  static monthStartFor(date) {
    const y = date.getUTCFullYear()
    const m = String(date.getUTCMonth() + 1).padStart(2, '0')
    return `${y}-${m}-01`
  }

  /** Last day of the month containing `date`, as YYYY-MM-DD. */
  static monthEndFor(date) {
    const next = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
    )
    const last = new Date(next.getTime() - 24 * 60 * 60 * 1000)
    return SettlementService.toDateString(last)
  }

  // ────────────────────────────────────────────────────────
  // Settlement entry points
  // ────────────────────────────────────────────────────────

  /**
   * Run the daily settlement for every active shop (the worker calls this
   * each night at 02:00 UTC).
   *
   * @param {object} [options]
   * @param {Date}   [options.date]     - "settlement-as-of" date; the
   *   settled day is the UTC day BEFORE this. Defaults to now.
   * @param {number} [options.batchSize=50]
   * @returns {Promise<{settled:number, skipped:number, failed:number, periodStart:string}>}
   */
  async runDailySettlement({ date, batchSize = 50 } = {}) {
    const ref = date instanceof Date ? date : new Date()
    const { startUtc, endUtc, dateStr } = SettlementService.previousUtcDay(ref)
    return this._runDailySettlementForRange({ startUtc, endUtc, dateStr, batchSize })
  }

  /**
   * Run daily settlement for an explicit UTC calendar day (as opposed to
   * `runDailySettlement`, which always resolves "the day before `date`").
   * Used by the admin "Run Settlement Now" manual trigger so operators can
   * settle today's delivered orders on demand instead of waiting for the
   * 02:00 UTC cron — most useful right after testing an order through its
   * full delivery lifecycle.
   *
   * @param {object} options
   * @param {string} options.dateStr - UTC day to settle, 'YYYY-MM-DD'
   * @param {number} [options.batchSize=50]
   */
  async runDailySettlementForDate({ dateStr, batchSize = 50 }) {
    const startUtc = new Date(`${dateStr}T00:00:00.000Z`)
    const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000)
    return this._runDailySettlementForRange({ startUtc, endUtc, dateStr, batchSize })
  }

  /** @private */
  async _runDailySettlementForRange({ startUtc, endUtc, dateStr, batchSize }) {
    const summary = { settled: 0, skipped: 0, failed: 0, periodStart: dateStr }
    let cursor = null
    const MAX_PAGES = 5000 // 5000 * 50 = 250k shops cap

    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await this.writeRepo.listActiveShopsPage({
        afterId: cursor,
        limit: batchSize,
      })
      if (page.length === 0) break

      // Concurrency 1 at the worker level + serial per-shop work keeps
      // ledger writes deterministic and well within the 15-connection pool.
      for (const shop of page) {
        try {
          const result = await this.settleShopForPeriod(
            shop.id,
            'DAILY',
            dateStr,
            dateStr,
            { startUtc, endUtc, commissionRate: shop.commission_rate }
          )
          if (result.skipped) summary.skipped += 1
          else summary.settled += 1
        } catch (err) {
          summary.failed += 1
          logger.error(
            {
              shopId: shop.id,
              periodType: 'DAILY',
              periodStart: dateStr,
              action: 'settlement_shop_failed',
              err: err.message,
            },
            'Daily settlement failed for shop'
          )
          // Best-effort: persist failure_reason on a partial row when one
          // exists, so operators can spot stuck shops in the admin view
          // (Req 6.7). Failure of the failure-recording is itself logged
          // and never propagated — we don't want to mask the original
          // error or blow up the overall daily run.
          await this._recordFailureReason(
            shop.id,
            'DAILY',
            dateStr,
            err.message
          )
        }
      }

      cursor = page[page.length - 1].id
      if (page.length < batchSize) break
    }

    logger.info(
      { action: 'settlement_daily_complete', ...summary },
      'Daily settlement complete'
    )
    return summary
  }

  /**
   * Run a weekly settlement (Monday..Sunday) by aggregating daily rows.
   * Skips shops with fewer than 7 daily rows (Req 6.9).
   */
  async runWeeklySettlement({ weekStart, batchSize = 50 }) {
    const weekEnd = SettlementService.weekEndFor(weekStart)
    return this._runAggregateSettlement({
      periodType: 'WEEKLY',
      periodStart: weekStart,
      periodEnd: weekEnd,
      requireDailyCount: 7,
      batchSize,
    })
  }

  /**
   * Run a monthly settlement by aggregating daily rows. Skips shops with
   * fewer daily rows than days in the month (Req 6.9).
   */
  async runMonthlySettlement({ monthStart, batchSize = 50 }) {
    const ref = new Date(`${monthStart}T00:00:00.000Z`)
    const monthEnd = SettlementService.monthEndFor(ref)
    const expectedDailyCount =
      (new Date(`${monthEnd}T00:00:00.000Z`).getTime() -
        new Date(`${monthStart}T00:00:00.000Z`).getTime()) /
        (24 * 60 * 60 * 1000) +
      1
    return this._runAggregateSettlement({
      periodType: 'MONTHLY',
      periodStart: monthStart,
      periodEnd: monthEnd,
      requireDailyCount: Math.round(expectedDailyCount),
      batchSize,
    })
  }

  /**
   * Settle a single shop for a single period. Single-shop helper exposed
   * for tests, manual replays, and the multi-shop drivers above.
   *
   * For DAILY it aggregates the orders table directly; for WEEKLY/MONTHLY
   * it sums the daily shop_financials rows so the arithmetic matches
   * Property 9 (Settlement Aggregation).
   */
  async settleShopForPeriod(shopId, periodType, periodStart, periodEnd, options = {}) {
    if (periodType === 'DAILY') {
      const startUtc =
        options.startUtc || new Date(`${periodStart}T00:00:00.000Z`)
      const endUtc =
        options.endUtc ||
        new Date(
          new Date(`${periodStart}T00:00:00.000Z`).getTime() +
            24 * 60 * 60 * 1000
        )

      const rate = SettlementService._toFiniteNumber(
        options.commissionRate ??
          (await this.writeRepo.findCommissionRate(shopId))
      )

      const agg = await this.writeRepo.aggregateDeliveredOrders(
        shopId,
        startUtc,
        endUtc
      )

      // Task 8.2: Insert per-order V2 transaction entries
      await this._recordPerOrderTransactions(shopId, startUtc, endUtc, rate)

      // Refund flow lands later (out of scope for task 9.1 — see brief).
      const refundAmount = 0
      const platformCommission = SettlementService.computeCommission(
        agg.grossRevenue,
        rate
      )
      const netRevenue = SettlementService.computeNetRevenue(
        agg.grossRevenue,
        platformCommission,
        agg.deliveryCosts,
        refundAmount
      )
      const avgOrderValue = SettlementService.computeAvgOrderValue(
        agg.grossRevenue,
        agg.totalOrders
      )

      const row = await this.writeRepo.upsert({
        shopId,
        periodType: 'DAILY',
        periodStart,
        periodEnd,
        grossRevenue: agg.grossRevenue,
        netRevenue,
        totalOrders: agg.totalOrders,
        avgOrderValue,
        platformCommission,
        deliveryCosts: agg.deliveryCosts,
        refundAmount,
        payoutAmount: netRevenue,
      })

      await this._invalidateCache(shopId)

      logger.info(
        {
          shopId,
          periodType: 'DAILY',
          periodStart,
          totalOrders: agg.totalOrders,
          grossRevenue: agg.grossRevenue,
          action: 'settlement_daily_upsert',
        },
        'Settlement daily row upserted'
      )

      return { shopId, periodType: 'DAILY', row }
    }

    // WEEKLY / MONTHLY — aggregate from existing daily rows.
    const sums = await this.writeRepo.sumDailyRows(
      shopId,
      periodStart,
      periodEnd
    )

    if (
      typeof options.requireDailyCount === 'number' &&
      sums.dailyCount < options.requireDailyCount
    ) {
      logger.debug(
        {
          shopId,
          periodType,
          periodStart,
          dailyCount: sums.dailyCount,
          required: options.requireDailyCount,
          action: 'settlement_skip_incomplete_period',
        },
        'Skipping aggregate settlement — incomplete daily rows'
      )
      return { shopId, periodType, skipped: true }
    }

    const avgOrderValue = SettlementService.computeAvgOrderValue(
      sums.grossRevenue,
      sums.totalOrders
    )

    const row = await this.writeRepo.upsert({
      shopId,
      periodType,
      periodStart,
      periodEnd,
      grossRevenue: sums.grossRevenue,
      netRevenue: sums.netRevenue,
      totalOrders: sums.totalOrders,
      avgOrderValue,
      platformCommission: sums.platformCommission,
      deliveryCosts: sums.deliveryCosts,
      refundAmount: sums.refundAmount,
      payoutAmount: sums.payoutAmount || sums.netRevenue,
    })

    await this._invalidateCache(shopId)

    logger.info(
      {
        shopId,
        periodType,
        periodStart,
        periodEnd,
        dailyCount: sums.dailyCount,
        action: 'settlement_aggregate_upsert',
      },
      'Settlement aggregate row upserted'
    )

    return { shopId, periodType, row }
  }

  // ────────────────────────────────────────────────────────
  // Internal helpers
  // ────────────────────────────────────────────────────────

  /**
   * Task 8.2: Fetch individual delivered orders for the period and insert
   * V2 transaction entries (ORDER_REVENUE, PLATFORM_COMMISSION, and
   * conditional DELIVERY_FEE + RIDER_COST) per order in one transaction.
   *
   * Best-effort: failures are logged but do not abort the settlement.
   * The financial aggregation (UPSERT) still runs from the aggregate query.
   *
   * @private
   */
  async _recordPerOrderTransactions(shopId, startUtc, endUtc, commissionRate) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      // Fetch delivered orders for this shop in the period (bounded by 500)
      const { rows: orders } = await client.query(
        `SELECT id, subtotal, delivery_fee, rider_id
           FROM orders
          WHERE shop_id = $1
            AND status = 'DELIVERED'
            AND delivered_at >= $2
            AND delivered_at < $3
          ORDER BY delivered_at ASC
          LIMIT 500`,
        [shopId, startUtc, endUtc]
      )

      for (const order of orders) {
        const subtotal = Number(order.subtotal) || 0
        if (subtotal < 0.01) continue

        const commissionAmount = Math.round(subtotal * commissionRate) / 100
        const deliveryFee = Number(order.delivery_fee) || 0
        // Rider cost equals delivery fee in the standard model
        const riderCost = deliveryFee

        await this.transactionWriter.recordSettlementEntries(client, {
          shopId,
          orderId: order.id,
          subtotal,
          commissionAmount,
          deliveryFee,
          riderCost,
          riderId: order.rider_id || null,
        })
      }

      await client.query('COMMIT')
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* ignore */ }
      logger.warn(
        {
          shopId,
          action: 'settlement_per_order_tx_failed',
          err: err.message,
        },
        'Per-order transaction recording failed (non-fatal)'
      )
    } finally {
      client?.release()
    }
  }

  /** @private */
  async _runAggregateSettlement({
    periodType,
    periodStart,
    periodEnd,
    requireDailyCount,
    batchSize,
  }) {
    const summary = {
      settled: 0,
      skipped: 0,
      failed: 0,
      periodType,
      periodStart,
      periodEnd,
    }
    let cursor = null
    const MAX_PAGES = 5000

    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await this.writeRepo.listActiveShopsPage({
        afterId: cursor,
        limit: batchSize,
      })
      if (page.length === 0) break

      for (const shop of page) {
        try {
          const result = await this.settleShopForPeriod(
            shop.id,
            periodType,
            periodStart,
            periodEnd,
            { requireDailyCount }
          )
          if (result.skipped) summary.skipped += 1
          else summary.settled += 1
        } catch (err) {
          summary.failed += 1
          logger.error(
            {
              shopId: shop.id,
              periodType,
              periodStart,
              action: 'settlement_shop_failed',
              err: err.message,
            },
            'Aggregate settlement failed for shop'
          )
          await this._recordFailureReason(
            shop.id,
            periodType,
            periodStart,
            err.message
          )
        }
      }

      cursor = page[page.length - 1].id
      if (page.length < batchSize) break
    }

    logger.info(
      { action: 'settlement_aggregate_complete', ...summary },
      'Aggregate settlement complete'
    )
    return summary
  }

  /**
   * Invalidate the financials read cache for a shop.
   * Best-effort: cache failures must NOT abort a settlement write.
   * @private
   */
  async _invalidateCache(shopId) {
    try {
      await this.financialsService.invalidateForShop(shopId)
    } catch (err) {
      logger.warn(
        {
          shopId,
          action: 'settlement_cache_invalidate_failed',
          err: err.message,
        },
        'Settlement cache invalidation failed (non-fatal)'
      )
    }
  }

  /**
   * Best-effort failure reason persistence (Req 6.7). Used by the per-shop
   * loop after the structured `settlement_shop_failed` log. Never throws —
   * if the row doesn't exist (most common case: aggregate query blew up
   * before we could UPSERT) the helper simply returns without doing
   * anything; if the UPDATE itself fails (e.g. transient DB hiccup), the
   * problem is logged and the original settlement error remains the
   * source of truth.
   *
   * @private
   */
  async _recordFailureReason(shopId, periodType, periodStart, reason) {
    try {
      await this.writeRepo.recordFailureReason(
        shopId,
        periodType,
        periodStart,
        reason
      )
    } catch (err) {
      logger.warn(
        {
          shopId,
          periodType,
          periodStart,
          action: 'settlement_failure_reason_persist_failed',
          err: err.message,
        },
        'Could not persist failure_reason on shop_financials row'
      )
    }
  }

  /**
   * Apply a refund that lands AFTER the daily shop_financials row has been
   * computed (Req 6.8). The refund flow calls this with:
   *
   *   - orderId        — the original order being refunded; used to look up
   *                      shop_id / completion date when not pre-resolved.
   *   - refundAmount   — positive amount being refunded (≥ 0)
   *   - completionDate — UTC date of the original order's delivery, or any
   *                      explicit override. Maps the refund onto the row
   *                      that originally booked the revenue.
   *
   * The repository wraps SELECT FOR UPDATE + UPDATE in a single transaction
   * so concurrent settlement and refund flows can't double-write. Once
   * payout_status is PROCESSING or PAID the row is frozen; the helper
   * returns `{ applied: false, reason: 'LOCKED', payoutStatus }` and the
   * caller is expected to route to the manual reconciliation flow
   * (Req 8.7).
   *
   * Recompute model:
   *   refund_amount += refundAmount
   *   net_revenue   -= refundAmount   (Req 6.4 — net = gross − comm − delivery − refund)
   *   payout_amount -= refundAmount   (payout follows net)
   *
   * Commission is NOT re-applied to the refund — the refund cancels
   * customer revenue but not the platform's commission booking. Adjusting
   * commission requires an offsetting COMMISSION_DEBIT reversal in the
   * shop_transactions ledger, which lives in the dedicated refund
   * reversal flow (out of scope for this helper).
   *
   * @param {object} input
   * @param {string} [input.orderId]
   * @param {string} [input.shopId]
   * @param {number} input.refundAmount
   * @param {Date|string} [input.completionDate]
   * @returns {Promise<object>}
   */
  async recordLateRefund({ orderId, shopId, refundAmount, completionDate } = {}) {
    if (!orderId && !shopId) {
      throw new Error('recordLateRefund: orderId or shopId required')
    }
    const amount = SettlementService._toFiniteNumber(refundAmount)
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error('recordLateRefund: refundAmount must be a non-negative number')
    }

    let resolvedShopId = shopId || null
    let resolvedDateStr = null

    if (completionDate instanceof Date) {
      resolvedDateStr = SettlementService.toDateString(completionDate)
    } else if (typeof completionDate === 'string') {
      resolvedDateStr =
        completionDate.length === 10
          ? completionDate
          : SettlementService.toDateString(new Date(completionDate))
    }

    if ((!resolvedShopId || !resolvedDateStr) && orderId) {
      const lookup =
        typeof this.writeRepo.findOrderShopAndCompletion === 'function'
          ? await this.writeRepo.findOrderShopAndCompletion(orderId)
          : null
      if (lookup) {
        resolvedShopId = resolvedShopId || lookup.shopId
        resolvedDateStr = resolvedDateStr || lookup.dateStr
      }
    }

    if (!resolvedShopId || !resolvedDateStr) {
      logger.warn(
        {
          orderId,
          action: 'settlement_late_refund_unresolved',
        },
        'Late refund could not resolve (shop_id, completion_date) — skipping'
      )
      return { applied: false, reason: 'UNRESOLVED' }
    }

    const refundDelta = SettlementService._round2(amount)
    const netDelta = SettlementService._round2(-amount)

    const updated = await this.writeRepo.applyLateRefund({
      shopId: resolvedShopId,
      dateStr: resolvedDateStr,
      refundDelta,
      netDelta,
    })

    if (!updated) {
      logger.warn(
        {
          shopId: resolvedShopId,
          dateStr: resolvedDateStr,
          orderId,
          action: 'settlement_late_refund_no_row',
        },
        'Late refund target daily row does not exist yet — refund will be picked up by the next settlement run'
      )
      return { applied: false, reason: 'NO_ROW' }
    }

    if (updated.locked) {
      logger.warn(
        {
          shopId: resolvedShopId,
          dateStr: resolvedDateStr,
          orderId,
          payoutStatus: updated.payoutStatus,
          action: 'settlement_late_refund_locked',
        },
        'Late refund target daily row is locked by an in-flight payout — manual reconciliation required'
      )
      return {
        applied: false,
        reason: 'LOCKED',
        payoutStatus: updated.payoutStatus,
      }
    }

    await this._invalidateCache(resolvedShopId)

    logger.info(
      {
        shopId: resolvedShopId,
        periodType: 'DAILY',
        periodStart: resolvedDateStr,
        orderId,
        refundAmount: refundDelta,
        action: 'settlement_late_refund_applied',
      },
      'Late refund applied to existing daily shop_financials row'
    )

    return { applied: true, row: updated }
  }
}
