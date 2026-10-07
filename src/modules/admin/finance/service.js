import { logger } from '../../../config/logger.js'
import { getClient } from '../../../config/database.js'
import { emitInTx } from '../../../utils/audit-log.js'
import { AdminFinanceRepository } from './repository.js'
import { SettlementService } from '../../shop-financials/settlement.service.js'

/**
 * Admin Finance service — HQ-scoped finance operations (task 8.9).
 * Handles mark-paid transitions and delegates reads to repository.
 */
export class AdminFinanceService {
  /**
   * @param {AdminFinanceRepository} repository
   * @param {SettlementService} [settlementService]
   */
  constructor(repository, settlementService) {
    if (!repository) {
      throw new TypeError('AdminFinanceService requires a repository')
    }
    this.repo = repository
    this.settlementService = settlementService || new SettlementService()
  }

  async listShops(filters) {
    return this.repo.findShops(filters)
  }

  async listShopTransactions(shopId, filters) {
    return this.repo.findShopTransactions({ shopId, ...filters })
  }

  async listShopFinancials(shopId, filters) {
    return this.repo.findShopFinancials({ shopId, ...filters })
  }

  /**
   * Mark a shop_financials period as PAID (task 8.9).
   * Requires shop_financials.mark_paid permission.
   * Emits payout_marked_paid audit (task 8.11).
   */
  async markPaid(shopId, periodId, actorId) {
    const row = await this.repo.findFinancialByIdAndShop(periodId, shopId)
    if (!row) {
      return { ok: false, code: 'NOT_FOUND', message: 'Financial period not found' }
    }
    return this._transitionToPaid(row, actorId)
  }

  /**
   * Mark a shop_financials period as PAID by id alone, no shopId required.
   * Backs the dashboard's flat cross-shop Financials tab, which only has
   * the row id on hand (unlike the shop-scoped mark-paid route above).
   */
  async markPaidById(periodId, actorId) {
    const row = await this.repo.findFinancialById(periodId)
    if (!row) {
      return { ok: false, code: 'NOT_FOUND', message: 'Financial period not found' }
    }
    return this._transitionToPaid(row, actorId)
  }

  /** @private */
  async _transitionToPaid(row, actorId) {
    const { id: periodId, shop_id: shopId } = row

    if (row.payout_status === 'PAID') {
      return { ok: false, code: 'ALREADY_PAID', message: 'Period already marked as paid' }
    }

    if (row.payout_status !== 'PENDING' && row.payout_status !== 'PROCESSING') {
      return {
        ok: false,
        code: 'INVALID_STATE',
        message: `Cannot mark as paid from status: ${row.payout_status}`,
      }
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows } = await client.query(
        `UPDATE shop_financials
            SET payout_status = 'PAID',
                paid_at = NOW(),
                updated_at = NOW()
          WHERE id = $1
            AND shop_id = $2
            AND payout_status IN ('PENDING', 'PROCESSING')
          RETURNING id, shop_id, payout_status, payout_amount, period_start, period_end`,
        [periodId, shopId]
      )

      if (rows.length === 0) {
        await client.query('ROLLBACK')
        return { ok: false, code: 'INVALID_STATE', message: 'State transition failed' }
      }

      // Task 8.11: emit payout_marked_paid audit
      await emitInTx(client, 'payout_marked_paid', {
        actor_user_id: actorId,
        actor_role: 'ADMIN',
        actor_shop_id: null,
        target_type: 'shop_financial',
        target_id: periodId,
        before: { payout_status: row.payout_status },
        after: { payout_status: 'PAID', shop_id: shopId },
      })

      await client.query('COMMIT')

      logger.info(
        { shopId, periodId, actorId, action: 'payout_marked_paid' },
        'Payout marked as paid by admin'
      )

      return { ok: true, row: rows[0] }
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* ignore */ }
      throw err
    } finally {
      client.release()
    }
  }

  async getPayoutReport(filters) {
    const rows = await this.repo.findPayoutReport(filters)
    logger.info(
      { rowCount: rows.length, action: 'admin_payout_report_export' },
      'Admin payout report CSV export'
    )
    return rows
  }

  async getComparison(filters) {
    return this.repo.findComparison(filters)
  }

  /**
   * Transactions across all shops (HQ-wide flat view), optionally filtered
   * to one shop via `filters.shop_id`. Backs the dashboard's Transactions
   * tab.
   */
  async listTransactions(filters) {
    return this.repo.findTransactions(filters)
  }

  /**
   * Financials across all shops (HQ-wide flat view), optionally filtered
   * to one shop via `filters.shop_id`. Backs the dashboard's Financials
   * tab.
   */
  async listFinancials(filters) {
    return this.repo.findFinancials(filters)
  }

  /**
   * Manually trigger DAILY settlement on demand, bypassing the 02:00 UTC
   * cron wait. Primarily for operators verifying that a just-delivered
   * order actually produced shop_financials / shop_transactions rows,
   * without needing to wait for the nightly worker.
   *
   * - `shopId` given: settle only that shop.
   * - `shopId` omitted: settle every active shop for the period (mirrors
   *   the nightly cron's per-shop loop, just for an admin-chosen day).
   * - `periodDate` defaults to today (UTC) — the day an admin is most
   *   likely to want settled right after a test order.
   */
  async runSettlementNow({ shopId, periodDate, actorId } = {}) {
    const dateStr = periodDate || SettlementService.toDateString(new Date())

    if (shopId) {
      const startUtc = new Date(`${dateStr}T00:00:00.000Z`)
      const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000)
      const result = await this.settlementService.settleShopForPeriod(
        shopId,
        'DAILY',
        dateStr,
        dateStr,
        { startUtc, endUtc }
      )
      logger.info(
        { shopId, periodDate: dateStr, actorId, action: 'admin_manual_settlement_shop' },
        'Manual settlement triggered for a single shop'
      )
      return { mode: 'SINGLE_SHOP', shopId, periodStart: dateStr, result }
    }

    const summary = await this.settlementService.runDailySettlementForDate({
      dateStr,
    })
    logger.info(
      { periodDate: dateStr, actorId, action: 'admin_manual_settlement_all', ...summary },
      'Manual settlement triggered for all active shops'
    )
    return { mode: 'ALL_SHOPS', periodStart: dateStr, summary }
  }
}
