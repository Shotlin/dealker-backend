import { ShopFinancialsController } from './shop-financials.controller.js'
import { ShopFinancialsService } from './shop-financials.service.js'
import { ShopFinancialsRepository } from './shop-financials.repository.js'
import { PayoutService } from './payout.service.js'
import { payoutQueue } from '../../config/bullmq.js'
import { requireShopScope } from '../../middlewares/shop-scope.js'
import { success, error } from '../../utils/apiResponse.js'

/**
 * Shop Financials routes plugin.
 * Prefix: /api/v1/shop-financials
 *
 * Read-only: writes are owned by the Settlement_Worker (task 9.1) and
 * Payout_Worker (task 9.2). This module exposes paginated list + single-record
 * reads only.
 *
 * Authorization model (design.md role table, Requirements 6.1, 6.5, 6.6):
 *   - All routes require a valid JWT (fastify.authenticate)
 *   - Shop scope is derived by `requireShopScope({ requireShop: true })`
 *     (JWT shop_id, or X-Shop-Id header for platform Super Admins).
 *   - Read access requires platform ADMIN OR shop staff with role
 *     SHOP_ADMIN | SHOP_MANAGER. Explicitly NOT SHOP_STAFF or SHOP_VIEWER —
 *     financial visibility maps to the `view_financials` permission, which
 *     in the design.md role table is granted only to Shop_Admin and
 *     Shop_Manager.
 *   - Cross-shop access is blocked by `requireShopScope` (which checks the
 *     staff record is active for the JWT shop_id) and by the
 *     `WHERE shop_id = $1` filter on every query — non-matching JWT shop ids
 *     surface as SHOP_SCOPE_MISMATCH from the middleware (Property 17).
 */
export default async function shopFinancialsRoutes(fastify) {
  const repository = new ShopFinancialsRepository()
  const service = new ShopFinancialsService(repository)
  const controller = new ShopFinancialsController(service)

  // ── Role guard — read access only ───────────────────────
  // Defence-in-depth: the service repeats this check via `authorizeRead`.
  const canRead = async function requireFinancialsReadAccess(request, reply) {
    const role = request.user?.role
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (role === 'ADMIN') return
    if (shopRole === 'SHOP_ADMIN' || shopRole === 'SHOP_MANAGER') return
    return reply.code(403).send({
      success: false,
      message:
        'Forbidden — Shop Admin, Shop Manager, or Super Admin access required',
      code: 'FORBIDDEN',
    })
  }

  const shopScope = requireShopScope({ requireShop: true })
  const readPreHandlers = [fastify.authenticate, shopScope, canRead]

  // ── GET / — List shop financials (paginated + filterable) ─
  fastify.get(
    '/',
    {
      schema: {
        tags: ['Shop Financials'],
        summary: 'List shop financials [Shop Admin / Shop Manager / Super Admin]',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            period_type: {
              type: 'string',
              enum: ['DAILY', 'WEEKLY', 'MONTHLY'],
            },
            from: {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            },
            to: {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            },
            payout_status: {
              type: 'string',
              enum: ['PENDING', 'PROCESSING', 'PAID', 'HELD'],
            },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
      preHandler: readPreHandlers,
    },
    controller.list.bind(controller)
  )

  // ── GET /:id — Single record (shop-scoped) ──────────────
  fastify.get(
    '/:id',
    {
      schema: {
        tags: ['Shop Financials'],
        summary:
          'Get shop financial by ID [Shop Admin / Shop Manager / Super Admin]',
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

  // ────────────────────────────────────────────────────────
  // Admin payout hold/release (Req 8.7)
  // ────────────────────────────────────────────────────────
  //
  // Both endpoints are platform Super Admin only — Shop Admins may not
  // hold or release their own payouts. The PayoutService writes a single
  // guarded UPDATE that wraps SELECT FOR UPDATE in a transaction, so
  // these handlers stay thin.
  //
  // Why these run on the API process (not the worker): the action is a
  // direct admin response — the user expects the response to reflect the
  // outcome. The Payout_Worker `set-hold` / `release-hold` job types are
  // available for fan-out scenarios (bulk holds, scheduled releases) but
  // the synchronous endpoints below are the day-to-day surface.
  const payoutService = new PayoutService({
    financialsService: service,
    queue: payoutQueue,
  })

  const requireSuperAdmin = async function ensureSuperAdmin(request, reply) {
    if (request.user?.role === 'ADMIN') return
    return reply
      .code(403)
      .send(error('Super Admin role required', 'FORBIDDEN'))
  }

  const adminPayoutPreHandlers = [fastify.authenticate, requireSuperAdmin]

  const idParamSchema = {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  }

  function statusForPayoutCode(code) {
    switch (code) {
      case 'SHOP_FINANCIAL_NOT_FOUND':
        return 404
      case 'PAYOUT_INVALID_STATE':
        return 409
      case 'VALIDATION_ERROR':
        return 400
      case 'FORBIDDEN':
        return 403
      default:
        return 400
    }
  }

  fastify.post(
    '/:id/payout-hold',
    {
      schema: {
        tags: ['Shop Financials'],
        summary: 'Set payout to HELD [Super Admin]',
        security: [{ bearerAuth: [] }],
        params: idParamSchema,
      },
      preHandler: adminPayoutPreHandlers,
    },
    async function payoutHoldHandler(request, reply) {
      const { id } = request.params
      const result = await payoutService.setHold(id, request.user?.id || null)
      if (!result.ok) {
        return reply
          .code(statusForPayoutCode(result.code))
          .send(error(result.message, result.code))
      }
      return reply.code(200).send(success(result.row, 'Payout held'))
    }
  )

  fastify.post(
    '/:id/payout-release',
    {
      schema: {
        tags: ['Shop Financials'],
        summary: 'Release HELD payout back to PENDING [Super Admin]',
        security: [{ bearerAuth: [] }],
        params: idParamSchema,
      },
      preHandler: adminPayoutPreHandlers,
    },
    async function payoutReleaseHandler(request, reply) {
      const { id } = request.params
      const result = await payoutService.releaseHold(
        id,
        request.user?.id || null
      )
      if (!result.ok) {
        return reply
          .code(statusForPayoutCode(result.code))
          .send(error(result.message, result.code))
      }
      return reply.code(200).send(success(result.row, 'Payout released'))
    }
  )
}
