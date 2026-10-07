import { logger } from '../../config/logger.js'
import { getClient, query } from '../../config/database.js'
import { emitInTx } from '../../utils/audit-log.js'
import { ShopTransactionsRepository } from '../shop-transactions/shop-transactions.repository.js'
import {
  LedgerWriteService,
  ShopTransactionsService,
} from '../shop-transactions/shop-transactions.service.js'

/**
 * Recalculation Service — task 8.10.
 *
 * Posts ADJUSTMENT rows referencing `corrected_transaction_id` rather than
 * UPDATE-ing existing rows (append-only ledger invariant). After posting
 * the adjustment, recomputes `net_revenue` and `payout_amount` on the
 * affected `shop_financials` row.
 *
 * This preserves the immutable audit trail while allowing corrections.
 */
export class RecalculationService {
  /**
   * @param {object} [deps]
   * @param {LedgerWriteService} [deps.ledgerWriteService]
   */
  constructor(deps = {}) {
    if (deps.ledgerWriteService) {
      this.ledger = deps.ledgerWriteService
    } else {
      const txRepo = new ShopTransactionsRepository()
      const readService = new ShopTransactionsService(txRepo)
      this.ledger = new LedgerWriteService(txRepo, { readService })
    }
  }

  /**
   * Post an ADJUSTMENT row that corrects a previous transaction.
   * The adjustment references the original transaction via metadata.
   *
   * After posting, recomputes net_revenue and payout_amount on the
   * affected shop_financials row (if one exists for the period).
   *
   * @param {object} params
   * @param {string} params.shopId
   * @param {string} params.correctedTransactionId - the original tx being corrected
   * @param {number} params.adjustmentAmount - positive = credit adjustment, negative not allowed (use separate debit)
   * @param {string} params.reason - human-readable reason
   * @param {string|null} [params.createdBy] - actor UUID
   * @returns {Promise<{adjustment: object, financialUpdated: boolean}>}
   */
  async postAdjustment(params) {
    const { shopId, correctedTransactionId, adjustmentAmount, reason, createdBy = null } = params

    if (!shopId || !correctedTransactionId || !adjustmentAmount || adjustmentAmount <= 0) {
      throw new Error('RecalculationService.postAdjustment: shopId, correctedTransactionId, and positive adjustmentAmount required')
    }

    const client = await getClient()
    let financialUpdated = false

    try {
      await client.query('BEGIN')

      // Post the ADJUSTMENT entry (CREDIT — adds back to balance)
      const adjustment = await this.ledger.append(client, {
        shopId,
        type: 'ADJUSTMENT',
        amount: adjustmentAmount,
        referenceType: 'ADJUSTMENT',
        referenceId: correctedTransactionId,
        description: `Adjustment: ${reason}`,
        createdBy,
      })

      // Update metadata with corrected_transaction_id reference
      await client.query(
        `UPDATE shop_transactions
            SET metadata = $2::jsonb
          WHERE id = $1`,
        [
          adjustment.id,
          JSON.stringify({ corrected_transaction_id: correctedTransactionId, reason }),
        ]
      )

      // Find the original transaction to determine which period to recompute
      const { rows: origRows } = await client.query(
        `SELECT shop_id, created_at
           FROM shop_transactions
          WHERE id = $1 AND shop_id = $2`,
        [correctedTransactionId, shopId]
      )

      if (origRows.length > 0) {
        const origDate = origRows[0].created_at
        const dateStr = origDate instanceof Date
          ? `${origDate.getUTCFullYear()}-${String(origDate.getUTCMonth() + 1).padStart(2, '0')}-${String(origDate.getUTCDate()).padStart(2, '0')}`
          : String(origDate).slice(0, 10)

        // Recompute net_revenue and payout_amount on the affected daily row
        const { rowCount } = await client.query(
          `UPDATE shop_financials
              SET net_revenue = net_revenue + $3,
                  payout_amount = payout_amount + $3,
                  updated_at = NOW()
            WHERE shop_id = $1
              AND period_type = 'DAILY'
              AND period_start = $2::date
              AND payout_status NOT IN ('PROCESSING', 'PAID')`,
          [shopId, dateStr, adjustmentAmount]
        )

        financialUpdated = rowCount > 0
      }

      await client.query('COMMIT')

      logger.info(
        {
          shopId,
          correctedTransactionId,
          adjustmentAmount,
          financialUpdated,
          action: 'recalculation_adjustment_posted',
        },
        'Recalculation adjustment posted'
      )

      return { adjustment, financialUpdated }
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* ignore */ }
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Recompute net_revenue and payout_amount for a shop's daily financial
   * row by re-summing all transactions for that day.
   *
   * Used when multiple adjustments have been posted and the incremental
   * approach may have drifted.
   *
   * @param {string} shopId
   * @param {string} dateStr - YYYY-MM-DD
   * @returns {Promise<{updated: boolean, row: object|null}>}
   */
  async recomputeDaily(shopId, dateStr) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      // Lock the financial row
      const { rows: finRows } = await client.query(
        `SELECT id, gross_revenue, platform_commission, delivery_costs, refund_amount
           FROM shop_financials
          WHERE shop_id = $1
            AND period_type = 'DAILY'
            AND period_start = $2::date
          FOR UPDATE`,
        [shopId, dateStr]
      )

      if (finRows.length === 0) {
        await client.query('ROLLBACK')
        return { updated: false, row: null }
      }

      const fin = finRows[0]

      // Sum all ADJUSTMENT amounts for this shop on this day
      const { rows: adjRows } = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric(12,2) AS total_adjustments
           FROM shop_transactions
          WHERE shop_id = $1
            AND type = 'ADJUSTMENT'
            AND created_at >= $2::date
            AND created_at < ($2::date + INTERVAL '1 day')`,
        [shopId, dateStr]
      )

      const totalAdjustments = Number(adjRows[0]?.total_adjustments) || 0
      const gross = Number(fin.gross_revenue) || 0
      const commission = Number(fin.platform_commission) || 0
      const delivery = Number(fin.delivery_costs) || 0
      const refund = Number(fin.refund_amount) || 0

      // net_revenue = gross - commission - delivery - refund + adjustments
      const netRevenue = Math.round((gross - commission - delivery - refund + totalAdjustments) * 100) / 100

      const { rows: updated } = await client.query(
        `UPDATE shop_financials
            SET net_revenue = $2,
                payout_amount = $2,
                updated_at = NOW()
          WHERE id = $1
          RETURNING id, shop_id, net_revenue, payout_amount`,
        [fin.id, netRevenue]
      )

      await client.query('COMMIT')

      logger.info(
        { shopId, dateStr, netRevenue, action: 'recalculation_daily_recomputed' },
        'Daily financial row recomputed'
      )

      return { updated: true, row: updated[0] || null }
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* ignore */ }
      throw err
    } finally {
      client.release()
    }
  }
}
