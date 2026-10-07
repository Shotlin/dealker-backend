import { ShopFinanceController } from './controller.js'
import { ShopFinanceService } from './service.js'
import { ShopFinanceRepository } from './repository.js'
import { requireShopScope } from '../../middlewares/shop-scope.js'

/**
 * Shop Finance routes — store-scoped finance endpoints (task 8.8).
 * Prefix: /api/v1/shop-finance
 *
 * All routes require:
 *   - Valid JWT (fastify.authenticate)
 *   - Shop scope (requireShopScope)
 *   - Permission: shop_financials.view
 */
export default async function shopFinanceRoutes(fastify) {
  const repository = new ShopFinanceRepository()
  const service = new ShopFinanceService(repository)
  const controller = new ShopFinanceController(service)

  const shopScope = requireShopScope({ requireShop: true })

  // Permission guard: shop_financials.view
  const requireFinanceView = async function (request, reply) {
    const role = request.user?.role
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (role === 'ADMIN') return
    if (shopRole === 'SHOP_ADMIN' || shopRole === 'SHOP_MANAGER') return
    return reply.code(403).send({
      success: false,
      message: 'Forbidden — shop_financials.view permission required',
      code: 'FORBIDDEN',
    })
  }

  const preHandlers = [fastify.authenticate, shopScope, requireFinanceView]

  // GET /transactions — paginated transaction list
  fastify.get('/transactions', {
    schema: {
      tags: ['Shop Finance'],
      summary: 'List shop transactions [shop_financials.view]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: preHandlers,
  }, controller.listTransactions.bind(controller))

  // GET /financials — paginated financials
  fastify.get('/financials', {
    schema: {
      tags: ['Shop Finance'],
      summary: 'List shop financials [shop_financials.view]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: preHandlers,
  }, controller.listFinancials.bind(controller))

  // GET /export — CSV export (max 10000 rows)
  fastify.get('/export', {
    schema: {
      tags: ['Shop Finance'],
      summary: 'Export shop transactions CSV [shop_financials.view]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: preHandlers,
  }, controller.exportCsv.bind(controller))
}
