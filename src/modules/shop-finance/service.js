import { logger } from '../../config/logger.js'
import { ShopFinanceRepository } from './repository.js'

/**
 * Shop Finance service — store-scoped finance operations (task 8.8).
 * Wraps repository calls with business logic and logging.
 */
export class ShopFinanceService {
  /**
   * @param {ShopFinanceRepository} repository
   */
  constructor(repository) {
    if (!repository) {
      throw new TypeError('ShopFinanceService requires a repository')
    }
    this.repo = repository
  }

  /**
   * List transactions for a shop (paginated).
   */
  async listTransactions(shopId, filters) {
    const { items, total } = await this.repo.findTransactions({
      shopId,
      page: filters.page,
      limit: filters.limit,
      type: filters.type,
      direction: filters.direction,
      from: filters.from,
      to: filters.to,
      order_id: filters.order_id,
    })

    return { items, total, page: filters.page, limit: filters.limit }
  }

  /**
   * List financials for a shop (paginated).
   */
  async listFinancials(shopId, filters) {
    const { items, total } = await this.repo.findFinancials({
      shopId,
      page: filters.page,
      limit: filters.limit,
      period_type: filters.period_type,
      from: filters.from,
      to: filters.to,
      payout_status: filters.payout_status,
    })

    return { items, total, page: filters.page, limit: filters.limit }
  }

  /**
   * Export transactions as CSV rows (max 10000).
   */
  async exportTransactions(shopId, filters) {
    const rows = await this.repo.findTransactionsForExport({
      shopId,
      type: filters.type,
      direction: filters.direction,
      from: filters.from,
      to: filters.to,
      order_id: filters.order_id,
      limit: filters.limit,
    })

    logger.info(
      { shopId, rowCount: rows.length, action: 'shop_finance_export' },
      'Shop finance CSV export'
    )

    return rows
  }
}
