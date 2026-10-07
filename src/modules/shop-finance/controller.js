import { success, error } from '../../utils/apiResponse.js'
import {
  listTransactionsQuerySchema,
  financialsQuerySchema,
  exportQuerySchema,
} from './schema.js'

/**
 * Shop Finance controller — store-scoped finance endpoints (task 8.8).
 * Handles request/response only; delegates business logic to service.
 */
export class ShopFinanceController {
  /**
   * @param {import('./service.js').ShopFinanceService} service
   */
  constructor(service) {
    this.service = service
  }

  /**
   * GET /transactions — paginated transaction list for the shop.
   */
  async listTransactions(request, reply) {
    const shopId = request.shopId
    if (!shopId) {
      return reply.code(403).send(error('Shop scope required', 'SHOP_SCOPE_REQUIRED'))
    }

    const parsed = listTransactionsQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      const detail = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
      return reply.code(400).send(error(detail, 'VALIDATION_ERROR'))
    }

    const result = await this.service.listTransactions(shopId, parsed.data)
    return reply.code(200).send(success(result.items, 'Transactions retrieved', {
      total: result.total,
      page: result.page,
      limit: result.limit,
    }))
  }

  /**
   * GET /financials — paginated financials for the shop.
   */
  async listFinancials(request, reply) {
    const shopId = request.shopId
    if (!shopId) {
      return reply.code(403).send(error('Shop scope required', 'SHOP_SCOPE_REQUIRED'))
    }

    const parsed = financialsQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      const detail = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
      return reply.code(400).send(error(detail, 'VALIDATION_ERROR'))
    }

    const result = await this.service.listFinancials(shopId, parsed.data)
    return reply.code(200).send(success(result.items, 'Financials retrieved', {
      total: result.total,
      page: result.page,
      limit: result.limit,
    }))
  }

  /**
   * GET /export — CSV export of transactions (max 10000 rows, streamed).
   */
  async exportCsv(request, reply) {
    const shopId = request.shopId
    if (!shopId) {
      return reply.code(403).send(error('Shop scope required', 'SHOP_SCOPE_REQUIRED'))
    }

    const parsed = exportQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      const detail = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
      return reply.code(400).send(error(detail, 'VALIDATION_ERROR'))
    }

    const rows = await this.service.exportTransactions(shopId, parsed.data)

    // Stream CSV response
    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="transactions-${shopId}.csv"`)

    const csvHeader = 'id,type,direction,amount,balance_after,reference_type,reference_id,order_id,status,created_at\n'
    let csvBody = csvHeader

    for (const row of rows) {
      csvBody += [
        row.id,
        row.type,
        row.direction || '',
        row.amount,
        row.balance_after,
        row.reference_type || '',
        row.reference_id || '',
        row.order_id || '',
        row.status || '',
        row.created_at ? new Date(row.created_at).toISOString() : '',
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',') + '\n'
    }

    return reply.send(csvBody)
  }
}
