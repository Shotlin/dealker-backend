import { success, error } from '../../utils/apiResponse.js'
import {
  listShopFinancialsQuerySchema,
  shopFinancialIdParamSchema,
} from './shop-financials.schema.js'

/**
 * Shop Financials controller — thin HTTP layer.
 *
 * Responsibilities:
 *   - Validate query/path inputs with Zod schemas
 *   - Delegate to ShopFinancialsService
 *   - Translate service result codes to HTTP status codes
 *
 * Shop scope is set by the `requireShopScope({ requireShop: true })`
 * preHandler on every route — here we just read `request.shopId`.
 *
 * Authorization is enforced twice (defence in depth):
 *   1. Route preHandlers gate by role
 *   2. Service `authorizeRead` re-checks the same decision so service-layer
 *      callers (workers, tests) cannot bypass the rule.
 */
export class ShopFinancialsController {
  constructor(service) {
    this.service = service
  }

  /** @private */
  _actor(request) {
    return {
      id: request.user?.id,
      role: request.user?.role,
      shopRole: request.user?.shopRole || request.user?.shop_role,
    }
  }

  /** @private */
  _statusForCode(code) {
    switch (code) {
      case 'SHOP_FINANCIAL_NOT_FOUND':
        return 404
      case 'UNAUTHORIZED':
        return 401
      case 'FORBIDDEN':
        return 403
      case 'VALIDATION_ERROR':
      case 'SHOP_ID_REQUIRED':
        return 400
      default:
        return 400
    }
  }

  /** @private */
  _formatZodErrors(zodError) {
    return zodError.errors
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ')
  }

  /** @private */
  _missingShopReply(reply) {
    return reply
      .code(400)
      .send(
        error(
          'shop_id is required (JWT or X-Shop-Id header)',
          'SHOP_ID_REQUIRED'
        )
      )
  }

  // ────────────────────────────────────────────────────────
  // GET / — List shop_financials (paginated, filterable)
  // ────────────────────────────────────────────────────────
  async list(request, reply) {
    if (!request.shopId) return this._missingShopReply(reply)

    const auth = this.service.authorizeRead(this._actor(request))
    if (!auth.ok) {
      return reply
        .code(this._statusForCode(auth.code))
        .send(error(auth.message, auth.code))
    }

    const parsed = listShopFinancialsQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.list(request.shopId, parsed.data)
    return reply.code(200).send(success(result, 'Shop financials fetched'))
  }

  // ────────────────────────────────────────────────────────
  // GET /:id — Single shop_financials record (scope-checked)
  // ────────────────────────────────────────────────────────
  async getOne(request, reply) {
    if (!request.shopId) return this._missingShopReply(reply)

    const auth = this.service.authorizeRead(this._actor(request))
    if (!auth.ok) {
      return reply
        .code(this._statusForCode(auth.code))
        .send(error(auth.message, auth.code))
    }

    const paramsParsed = shopFinancialIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error('Invalid shop financial ID format', 'VALIDATION_ERROR'))
    }

    const record = await this.service.getById(
      request.shopId,
      paramsParsed.data.id
    )
    if (!record) {
      return reply
        .code(404)
        .send(error('Shop financial not found', 'SHOP_FINANCIAL_NOT_FOUND'))
    }

    return reply.code(200).send(success(record, 'Shop financial fetched'))
  }
}
