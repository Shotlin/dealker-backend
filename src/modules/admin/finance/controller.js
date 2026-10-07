import { success, error } from '../../../utils/apiResponse.js'
import {
  listShopsQuerySchema,
  shopTransactionsQuerySchema,
  shopFinancialsQuerySchema,
  shopIdParamSchema,
  markPaidParamSchema,
  payoutReportQuerySchema,
  comparisonQuerySchema,
  runSettlementSchema,
  listTransactionsFlatQuerySchema,
  listFinancialsFlatQuerySchema,
  financialIdParamSchema,
} from './schema.js'

/**
 * Admin Finance controller — HQ-scoped finance endpoints (task 8.9).
 * Request/response handling only; delegates to service.
 */
export class AdminFinanceController {
  /**
   * @param {import('./service.js').AdminFinanceService} service
   */
  constructor(service) {
    this.service = service
  }

  /** GET /shops */
  async listShops(request, reply) {
    const parsed = listShopsQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      const detail = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
      return reply.code(400).send(error(detail, 'VALIDATION_ERROR'))
    }

    const result = await this.service.listShops(parsed.data)
    return reply.code(200).send(success(result.items, 'Shops retrieved', {
      total: result.total,
      page: parsed.data.page,
      limit: parsed.data.limit,
    }))
  }

  /** GET /shops/:shopId/transactions */
  async listShopTransactions(request, reply) {
    const paramParsed = shopIdParamSchema.safeParse(request.params)
    if (!paramParsed.success) {
      return reply.code(400).send(error('Invalid shopId', 'VALIDATION_ERROR'))
    }

    const parsed = shopTransactionsQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      const detail = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
      return reply.code(400).send(error(detail, 'VALIDATION_ERROR'))
    }

    const result = await this.service.listShopTransactions(paramParsed.data.shopId, parsed.data)
    return reply.code(200).send(success(result.items, 'Transactions retrieved', {
      total: result.total,
      page: parsed.data.page,
      limit: parsed.data.limit,
    }))
  }

  /** GET /shops/:shopId/financials */
  async listShopFinancials(request, reply) {
    const paramParsed = shopIdParamSchema.safeParse(request.params)
    if (!paramParsed.success) {
      return reply.code(400).send(error('Invalid shopId', 'VALIDATION_ERROR'))
    }

    const parsed = shopFinancialsQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      const detail = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
      return reply.code(400).send(error(detail, 'VALIDATION_ERROR'))
    }

    const result = await this.service.listShopFinancials(paramParsed.data.shopId, parsed.data)
    return reply.code(200).send(success(result.items, 'Financials retrieved', {
      total: result.total,
      page: parsed.data.page,
      limit: parsed.data.limit,
    }))
  }

  /** GET /transactions — HQ-wide flat view, optional ?shop_id= filter */
  async listTransactions(request, reply) {
    const parsed = listTransactionsFlatQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      const detail = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
      return reply.code(400).send(error(detail, 'VALIDATION_ERROR'))
    }

    const result = await this.service.listTransactions(parsed.data)
    return reply.code(200).send(success({
      transactions: result.items,
      total: result.total,
      page: parsed.data.page,
      limit: parsed.data.limit,
    }, 'Transactions retrieved'))
  }

  /** GET /financials — HQ-wide flat view, optional ?shop_id= filter */
  async listFinancials(request, reply) {
    const parsed = listFinancialsFlatQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      const detail = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
      return reply.code(400).send(error(detail, 'VALIDATION_ERROR'))
    }

    const result = await this.service.listFinancials(parsed.data)
    return reply.code(200).send(success({
      financials: result.items,
      total: result.total,
      page: parsed.data.page,
      limit: parsed.data.limit,
    }, 'Financials retrieved'))
  }

  /** POST /financials/:id/mark-paid — flat, no shopId required */
  async markPaidFlat(request, reply) {
    const paramParsed = financialIdParamSchema.safeParse(request.params)
    if (!paramParsed.success) {
      return reply.code(400).send(error('Invalid id', 'VALIDATION_ERROR'))
    }

    const actorId = request.user?.id || null
    const result = await this.service.markPaidById(paramParsed.data.id, actorId)
    if (!result.ok) {
      const status = result.code === 'NOT_FOUND' ? 404 : 409
      return reply.code(status).send(error(result.message, result.code))
    }

    return reply.code(200).send(success(result.row, 'Payout marked as paid'))
  }

  /** POST /shops/:shopId/payouts/:periodId/mark-paid */
  async markPaid(request, reply) {
    const paramParsed = markPaidParamSchema.safeParse(request.params)
    if (!paramParsed.success) {
      return reply.code(400).send(error('Invalid params', 'VALIDATION_ERROR'))
    }

    const { shopId, periodId } = paramParsed.data
    const actorId = request.user?.id || null

    const result = await this.service.markPaid(shopId, periodId, actorId)
    if (!result.ok) {
      const status = result.code === 'NOT_FOUND' ? 404 : 409
      return reply.code(status).send(error(result.message, result.code))
    }

    return reply.code(200).send(success(result.row, 'Payout marked as paid'))
  }

  /** GET /payout-report (CSV) */
  async payoutReport(request, reply) {
    const parsed = payoutReportQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      const detail = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
      return reply.code(400).send(error(detail, 'VALIDATION_ERROR'))
    }

    const rows = await this.service.getPayoutReport(parsed.data)

    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', 'attachment; filename="payout-report.csv"')

    const csvHeader = 'id,shop_id,shop_name,period_type,period_start,period_end,gross_revenue,net_revenue,payout_amount,payout_status,payout_ref,paid_at\n'
    let csvBody = csvHeader

    for (const row of rows) {
      csvBody += [
        row.id,
        row.shop_id,
        row.shop_name || '',
        row.period_type,
        row.period_start,
        row.period_end,
        row.gross_revenue,
        row.net_revenue,
        row.payout_amount,
        row.payout_status,
        row.payout_ref || '',
        row.paid_at ? new Date(row.paid_at).toISOString() : '',
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',') + '\n'
    }

    return reply.send(csvBody)
  }

  /** POST /settlement/run */
  async runSettlement(request, reply) {
    const parsed = runSettlementSchema.safeParse(request.body || {})
    if (!parsed.success) {
      const detail = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
      return reply.code(400).send(error(detail, 'VALIDATION_ERROR'))
    }

    const actorId = request.user?.id || null
    const result = await this.service.runSettlementNow({ ...parsed.data, actorId })
    return reply.code(200).send(success(result, 'Settlement run complete'))
  }

  /** GET /comparison */
  async comparison(request, reply) {
    const parsed = comparisonQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      const detail = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
      return reply.code(400).send(error(detail, 'VALIDATION_ERROR'))
    }

    const result = await this.service.getComparison(parsed.data)
    return reply.code(200).send(success(result.items, 'Comparison retrieved', {
      total: result.total,
      page: parsed.data.page,
      limit: parsed.data.limit,
    }))
  }
}
