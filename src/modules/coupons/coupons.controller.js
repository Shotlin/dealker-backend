import { success, error } from '../../utils/apiResponse.js'
import { getOffsetLimit, buildPagination } from '../../utils/paginate.js'
import { ERROR_CODES, httpStatusFor } from '../../constants/errors.js'

/**
 * Coupons controller — thin HTTP layer
 */
export class CouponsController {
  constructor(service, cartService) {
    this.service = service
    this.cartService = cartService
  }

  /**
   * Extract actor context from request for audit and scope enforcement.
   */
  _actorCtx(request) {
    return {
      userId: request.user?.id ?? null,
      role: request.user?.role ?? null,
      platformRole: request.user?.platform_role ?? request.user?.platformRole ?? null,
      shopRole: request.user?.shopRole ?? request.user?.shop_role ?? null,
      shopId: request.shopId ?? request.user?.shopId ?? request.user?.shop_id ?? null,
      permissions: request.user?.permissions ?? [],
      ip: request.ip ?? null,
      userAgent: request.headers?.['user-agent'] ?? null,
    }
  }

  /** POST /validate */
  async validate(request, reply) {
    // Cart items are read fresh from the server-side cart (not trusted from
    // the client) so a category/product-scoped coupon can be checked
    // against what's actually there — same reasoning as orders.service.js,
    // just for the pre-checkout preview rather than the final placement.
    // A cart spanning multiple shops is still allowed to preview here (this
    // endpoint doesn't place an order); every line across shops is passed
    // through so a scoped coupon at least gets an accurate match instead of
    // being evaluated against nothing.
    const cart = await this.cartService.getCart(request.user.id)
    // Exclude out-of-stock/delisted lines — cart.items includes them (for
    // the cart screen to render an "out of stock" notice) but they can't
    // actually be purchased, so a scoped coupon must not count their price
    // toward the matching subtotal.
    const fulfillableItems = cart.items.filter(
      (i) => i.isAvailable && i.stockQuantity >= i.quantity
    )
    const result = await this.service.validate(
      request.user.id,
      request.body.code,
      request.body.cartTotal,
      fulfillableItems
    )
    if (!result.valid) {
      return reply.code(400).send(error(result.message, result.code || 'INVALID_COUPON'))
    }
    return reply.code(200).send(success(result, 'Coupon is valid'))
  }

  /** GET /available */
  async available(request, reply) {
    const coupons = await this.service.getAvailable(request.user.id)
    return reply.code(200).send(success(coupons, 'Available coupons'))
  }

  /** GET / — Admin */
  async listAll(request, reply) {
    const { offset, limit } = getOffsetLimit(request.query)
    const result = await this.service.listAll({ offset, limit })
    const pagination = buildPagination({
      page: request.query.page || 1,
      limit,
      total: result.total,
    })
    return reply.code(200).send(success(result.data, 'Coupons fetched', { pagination }))
  }

  /** POST / — Admin (task 9.2: scope enforcement) */
  async create(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.create(request.body, actor)

    if (!result.success) {
      const httpCode = httpStatusFor(result.code) || 400
      return reply.code(httpCode).send(error(result.message, result.code || 'DUPLICATE'))
    }
    return reply.code(201).send(success(result.coupon, 'Coupon created'))
  }

  /** PUT /:id — Admin */
  async update(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.update(request.params.id, request.body, actor)

    if (!result.success) {
      const code = result.message === 'Coupon not found' ? 404 : 400
      return reply.code(code).send(error(result.message, code === 404 ? 'NOT_FOUND' : 'DUPLICATE'))
    }
    return reply.code(200).send(success(result.coupon, 'Coupon updated'))
  }

  /** GET /:id/target-users — Admin */
  async getTargetUsers(request, reply) {
    const users = await this.service.getTargetUsers(request.params.id)
    return reply.code(200).send(success(users, 'Coupon target users fetched'))
  }

  /** GET /:id/analytics — Admin */
  async getAnalytics(request, reply) {
    const analytics = await this.service.getAnalytics(request.params.id)
    if (!analytics) {
      return reply.code(404).send(error('Coupon not found', 'NOT_FOUND'))
    }
    return reply.code(200).send(success(analytics, 'Coupon analytics fetched'))
  }

  /** DELETE /:id — Admin */
  async delete(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.delete(request.params.id, actor)

    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(null, 'Coupon deleted'))
  }
}
