import { success, error } from '../../utils/apiResponse.js'
import {
  listShopTransactionsQuerySchema,
  shopTransactionIdParamSchema,
} from './shop-transactions.schema.js'

/**
 * Shop Transactions controller — thin HTTP layer.
 *
 * READ-ONLY by design (Requirement 7.4): no create/update/delete handlers
 * exist on this controller, and the routes plugin only mounts GET endpoints.
 *
 * Shop scope is set by `requireShopScope` on every route; we read
 * `request.shopId` here. Cross-shop access is rejected at the middleware
 * (Property 17, Requirements 2.9 / 13.6).
 */
export class ShopTransactionsController {
  constructor(service) {
    if (!service) {
      throw new TypeError('ShopTransactionsController requires a service')
    }
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
      case 'SHOP_TRANSACTION_NOT_FOUND':
        return 404
      case 'UNAUTHORIZED':
        return 401
      case 'FORBIDDEN':
        return 403
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
  // GET / — Paginated list of ledger entries (Req 7.1, 7.2)
  // ────────────────────────────────────────────────────────
  async list(request, reply) {
    if (!request.shopId) return this._missingShopReply(reply)

    const auth = this.service.authorizeRead(this._actor(request))
    if (!auth.ok) {
      return reply
        .code(this._statusForCode(auth.code))
        .send(error(auth.message, auth.code))
    }

    const parsed = listShopTransactionsQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    // from/to bounds: if both supplied, `from` must be <= `to`.
    if (parsed.data.from && parsed.data.to && parsed.data.from > parsed.data.to) {
      return reply
        .code(400)
        .send(error('from must be on or before to', 'VALIDATION_ERROR'))
    }

    const result = await this.service.list(request.shopId, parsed.data)
    return reply.code(200).send(success(result, 'Shop transactions fetched'))
  }

  // ────────────────────────────────────────────────────────
  // GET /balance — Current shop balance (Req 7.7, 7.8)
  // ────────────────────────────────────────────────────────
  async getBalance(request, reply) {
    if (!request.shopId) return this._missingShopReply(reply)

    const auth = this.service.authorizeRead(this._actor(request))
    if (!auth.ok) {
      return reply
        .code(this._statusForCode(auth.code))
        .send(error(auth.message, auth.code))
    }

    const result = await this.service.getCurrentBalance(request.shopId)
    return reply
      .code(200)
      .send(
        success(
          { shop_id: request.shopId, ...result },
          'Shop balance fetched'
        )
      )
  }

  // ────────────────────────────────────────────────────────
  // GET /:id — Single ledger entry (scoped)
  // ────────────────────────────────────────────────────────
  async getOne(request, reply) {
    if (!request.shopId) return this._missingShopReply(reply)

    const auth = this.service.authorizeRead(this._actor(request))
    if (!auth.ok) {
      return reply
        .code(this._statusForCode(auth.code))
        .send(error(auth.message, auth.code))
    }

    const paramsParsed = shopTransactionIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error('Invalid transaction ID format', 'VALIDATION_ERROR'))
    }

    const record = await this.service.getById(
      request.shopId,
      paramsParsed.data.id
    )
    if (!record) {
      return reply
        .code(404)
        .send(error('Shop transaction not found', 'SHOP_TRANSACTION_NOT_FOUND'))
    }

    return reply.code(200).send(success(record, 'Shop transaction fetched'))
  }
}
