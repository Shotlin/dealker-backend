import { AdminFinanceController } from './controller.js'
import { AdminFinanceService } from './service.js'
import { AdminFinanceRepository } from './repository.js'

/**
 * Admin Finance routes — HQ-scoped finance endpoints (task 8.9).
 * Prefix: /api/v1/admin/finance
 *
 * All routes require:
 *   - Valid JWT (fastify.authenticate)
 *   - finance.global_view permission (ADMIN role)
 *   - mark-paid additionally requires shop_financials.mark_paid
 */
export default async function adminFinanceRoutes(fastify) {
  const repository = new AdminFinanceRepository()
  const service = new AdminFinanceService(repository)
  const controller = new AdminFinanceController(service)

  // Permission guard: finance.global_view (ADMIN / HQ_FINANCE)
  const requireGlobalView = async function (request, reply) {
    const role = request.user?.role
    if (role === 'ADMIN') return
    return reply.code(403).send({
      success: false,
      message: 'Forbidden — finance.global_view permission required',
      code: 'FORBIDDEN',
    })
  }

  // Permission guard: shop_financials.mark_paid (ADMIN only)
  const requireMarkPaid = async function (request, reply) {
    const role = request.user?.role
    if (role === 'ADMIN') return
    return reply.code(403).send({
      success: false,
      message: 'Forbidden — shop_financials.mark_paid permission required',
      code: 'FORBIDDEN',
    })
  }

  const readPreHandlers = [fastify.authenticate, requireGlobalView]
  const markPaidPreHandlers = [fastify.authenticate, requireMarkPaid]

  // GET /shops — list shops with finance overview
  fastify.get('/shops', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'List shops [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: readPreHandlers,
  }, controller.listShops.bind(controller))

  // GET /transactions — HQ-wide flat view across all shops (optional
  // ?shop_id= filter). Backs the dashboard's Transactions tab, which shows
  // every shop in one table rather than requiring a shopId up front.
  fastify.get('/transactions', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'List transactions across all shops [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: readPreHandlers,
  }, controller.listTransactions.bind(controller))

  // GET /financials — HQ-wide flat view across all shops (optional
  // ?shop_id= filter). Backs the dashboard's Financials tab.
  fastify.get('/financials', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'List financials across all shops [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: readPreHandlers,
  }, controller.listFinancials.bind(controller))

  // POST /financials/:id/mark-paid — flat, no shopId required
  fastify.post('/financials/:id/mark-paid', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'Mark payout as paid by id [shop_financials.mark_paid]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: markPaidPreHandlers,
  }, controller.markPaidFlat.bind(controller))

  // GET /shops/:shopId/transactions — shop transactions (HQ view)
  fastify.get('/shops/:shopId/transactions', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'Shop transactions [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: readPreHandlers,
  }, controller.listShopTransactions.bind(controller))

  // GET /shops/:shopId/financials — shop financials (HQ view)
  fastify.get('/shops/:shopId/financials', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'Shop financials [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: readPreHandlers,
  }, controller.listShopFinancials.bind(controller))

  // POST /shops/:shopId/payouts/:periodId/mark-paid
  fastify.post('/shops/:shopId/payouts/:periodId/mark-paid', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'Mark payout as paid [shop_financials.mark_paid]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: markPaidPreHandlers,
  }, controller.markPaid.bind(controller))

  // GET /payout-report — CSV export (max 10000 rows)
  fastify.get('/payout-report', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'Payout report CSV [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: readPreHandlers,
  }, controller.payoutReport.bind(controller))

  // POST /settlement/run — manually trigger DAILY settlement on demand
  // (skips waiting for the 02:00 UTC cron; used by operators to verify a
  // just-delivered test order actually produced financials/transactions)
  fastify.post('/settlement/run', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'Run settlement now [shop_financials.mark_paid]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: markPaidPreHandlers,
  }, controller.runSettlement.bind(controller))

  // GET /comparison — shop comparison view
  fastify.get('/comparison', {
    schema: {
      tags: ['Admin Finance'],
      summary: 'Shop comparison [finance.global_view]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: readPreHandlers,
  }, controller.comparison.bind(controller))
}
