import { ShopTransactionsController } from './shop-transactions.controller.js'
import {
  ShopTransactionsService,
  LedgerWriteService,
} from './shop-transactions.service.js'
import { ShopTransactionsRepository } from './shop-transactions.repository.js'
import { TRANSACTION_TYPES, REFERENCE_TYPES } from './shop-transactions.schema.js'
import { requireShopScope } from '../../middlewares/shop-scope.js'

/**
 * Shop Transactions routes plugin.
 * Prefix: /api/v1/shop-transactions
 *
 * READ-ONLY at the API layer (Requirement 7.4): the platform MUST NOT expose
 * any endpoint that creates, updates, or deletes shop_transactions records.
 * This file deliberately registers GET routes only. Internal callers (orders,
 * refunds, payouts) write through `LedgerWriteService.append()` instead.
 *
 * Authorization model:
 *   - All routes require a valid JWT (fastify.authenticate)
 *   - Shop scope is derived by `requireShopScope({ requireShop: true })`
 *     so customers and riders cannot reach these endpoints. Cross-shop
 *     access is rejected by middleware (Requirement 13.6, Property 17).
 *   - Read access: platform ADMIN OR shop staff with SHOP_ADMIN | SHOP_MANAGER
 *     role for the active shop (the service repeats this check defensively).
 *
 * Caching: 60s TTL on list/balance reads, invalidated on every append by
 * `LedgerWriteService` when constructed with the read service.
 */
export default async function shopTransactionRoutes(fastify) {
  const repository = new ShopTransactionsRepository()
  const service = new ShopTransactionsService(repository)
  const controller = new ShopTransactionsController(service)

  // Defence-in-depth role guard at the routing layer (the service repeats it).
  const canRead = async function requireShopReadAccess(request, reply) {
    const role = request.user?.role
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (role === 'ADMIN') return
    if (shopRole === 'SHOP_ADMIN' || shopRole === 'SHOP_MANAGER') return
    return reply.code(403).send({
      success: false,
      message: 'Forbidden — Shop Admin, Shop Manager, or Super Admin access required',
      code: 'FORBIDDEN',
    })
  }

  const shopScope = requireShopScope({ requireShop: true })
  const readPreHandlers = [fastify.authenticate, shopScope, canRead]

  // ── GET / — Paginated, filterable ledger history ───────
  fastify.get(
    '/',
    {
      schema: {
        tags: ['Shop Transactions'],
        summary: 'List shop ledger entries [Shop Manager+]',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            type: { type: 'string', enum: TRANSACTION_TYPES },
            reference_type: { type: 'string', enum: REFERENCE_TYPES },
            reference_id: { type: 'string', format: 'uuid' },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
          },
        },
      },
      preHandler: readPreHandlers,
    },
    controller.list.bind(controller)
  )

  // ── GET /balance — Current balance for the active shop ─
  fastify.get(
    '/balance',
    {
      schema: {
        tags: ['Shop Transactions'],
        summary: 'Get current ledger balance [Shop Manager+]',
        security: [{ bearerAuth: [] }],
      },
      preHandler: readPreHandlers,
    },
    controller.getBalance.bind(controller)
  )

  // ── GET /:id — Single ledger entry (scoped) ────────────
  fastify.get(
    '/:id',
    {
      schema: {
        tags: ['Shop Transactions'],
        summary: 'Get a single ledger entry by id [Shop Manager+]',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: readPreHandlers,
    },
    controller.getOne.bind(controller)
  )

  // NOTE: NO POST / PATCH / PUT / DELETE handlers exist on this plugin.
  // Append-only invariant per Requirement 7.4 / 15.1.
}

// Re-export the public service classes so other modules (orders, refunds,
// payouts) can construct a `LedgerWriteService` wired to the same repository.
export {
  ShopTransactionsService,
  LedgerWriteService,
  ShopTransactionsRepository,
}

/**
 * Factory helper: build a `LedgerWriteService` instance backed by a fresh
 * repository and the shared `ShopTransactionsService` (so cache invalidation
 * is wired). Other modules can use this to avoid duplicating wiring logic.
 *
 * @returns {{ ledger: LedgerWriteService, reads: ShopTransactionsService, repo: ShopTransactionsRepository }}
 */
export function createLedgerWriter() {
  const repo = new ShopTransactionsRepository()
  const reads = new ShopTransactionsService(repo)
  const ledger = new LedgerWriteService(repo, { readService: reads })
  return { ledger, reads, repo }
}
