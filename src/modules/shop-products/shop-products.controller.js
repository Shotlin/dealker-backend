import { success, error } from '../../utils/apiResponse.js'
import {
  createShopProductSchema,
  updateShopProductSchema,
  stockUpdateSchema,
  listShopProductsQuerySchema,
  shopProductIdParamSchema,
  shopProductRouteParamsSchema,
  adjustStockSchema,
  shopIdOnlyParamSchema,
  lookupInventoryLotsQuerySchema,
  bulkPriceUpdateSchema,
  listStockMovementsQuerySchema,
  approveShopProductSchema,
  rejectShopProductSchema,
  adminShopProductIdParamSchema,
  manualCreateProductSchema,
} from './shop-products.schema.js'
import { ERROR_CODES, httpStatusFor } from '../../constants/errors.js'
import { env } from '../../config/env.js'

/**
 * Shop Products controller — thin HTTP layer.
 * Handles request/response shape only and delegates to the service.
 *
 * Shop scope is set by the `requireShopScope` preHandler on every route that
 * mounts this controller; here we just read `request.shopId`.
 */
export class ShopProductsController {
  constructor(service, manualCreateService = null) {
    this.service = service
    this.manualCreateService = manualCreateService
  }

  /**
   * Build the actor object used by the service for authz checks.
   * Resolves both kebab and camel case shop role keys so we don't accidentally
   * break when the JWT shape evolves between auth tasks.
   * @private
   */
  _actor(request) {
    return {
      id: request.user?.id,
      role: request.user?.role,
      shopRole: request.user?.shopRole || request.user?.shop_role,
      platformRole:
        request.user?.platformRole || request.user?.platform_role || null,
      ip: request.ip || null,
      userAgent: request.headers?.['user-agent'] || null,
    }
  }

  /** @private */
  _statusForCode(code) {
    switch (code) {
      case 'SHOP_PRODUCT_NOT_FOUND':
      case ERROR_CODES.PRODUCT_NOT_FOUND:
        return 404
      case 'UNAUTHORIZED':
      case ERROR_CODES.UNAUTHORIZED:
        return 401
      case 'FORBIDDEN':
      case ERROR_CODES.PERMISSION_DENIED:
        return 403
      case 'SHOP_PRODUCT_DUPLICATE':
        return 409
      case ERROR_CODES.STOCK_NEGATIVE_FORBIDDEN:
        return 409
      case ERROR_CODES.MASTER_PRODUCT_EXISTS:
        return 409
      case ERROR_CODES.VALIDATION_ERROR:
        return 400
      case ERROR_CODES.FEATURE_DISABLED:
        return 503
      default:
        // Codes the canonical errors.js knows about (e.g. SHOP_NOT_ASSIGNED)
        // resolve via httpStatusFor; everything else (legacy local codes
        // like SALE_PRICE_INVALID, INSUFFICIENT_STOCK, NEGATIVE_STOCK,
        // INVALID_STOCK_VALUE, SHOP_ID_REQUIRED) falls back to 400.
        return code && httpStatusFor(code) !== 500 ? httpStatusFor(code) : 400
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
  // POST / — Create a shop_product
  // ────────────────────────────────────────────────────────
  async create(request, reply) {
    if (!request.shopId) return this._missingShopReply(reply)

    const parsed = createShopProductSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.create(
      request.shopId,
      parsed.data,
      this._actor(request)
    )

    if (!result.success) {
      const body = error(result.message, result.code)
      // Duplicate-add case: the dashboard needs the existing row's id to
      // offer a direct "edit existing product" link instead of a dead-end
      // error. Left out of the shared `error()` helper (used by every
      // other endpoint) so this one extra field doesn't ripple elsewhere.
      if (result.code === 'SHOP_PRODUCT_DUPLICATE' && result.existingId) {
        body.existingId = result.existingId
      }
      return reply.code(this._statusForCode(result.code)).send(body)
    }

    return reply.code(201).send(success(result.data, 'Shop product created'))
  }

  // ────────────────────────────────────────────────────────
  // GET / — List shop_products (paginated, filterable)
  // ────────────────────────────────────────────────────────
  async list(request, reply) {
    if (!request.shopId) return this._missingShopReply(reply)

    const parsed = listShopProductsQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.list(request.shopId, parsed.data)
    return reply.code(200).send(success(result, 'Shop products fetched'))
  }

  // ────────────────────────────────────────────────────────
  // GET /:id — Get a single shop_product
  // ────────────────────────────────────────────────────────
  async getOne(request, reply) {
    if (!request.shopId) return this._missingShopReply(reply)

    const paramsParsed = shopProductIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error('Invalid shop product ID format', 'VALIDATION_ERROR'))
    }

    const record = await this.service.getById(
      request.shopId,
      paramsParsed.data.id
    )
    if (!record) {
      return reply
        .code(404)
        .send(error('Shop product not found', 'SHOP_PRODUCT_NOT_FOUND'))
    }

    return reply.code(200).send(success(record, 'Shop product fetched'))
  }

  // ────────────────────────────────────────────────────────
  // GET /:id/inventory-lots — Vendor batch breakdown backing this
  // shop_product's stock (see ShopProductsService#getInventoryLots)
  // ────────────────────────────────────────────────────────

  // ────────────────────────────────────────────────────────
  // PATCH /:id — Update non-stock fields
  // ────────────────────────────────────────────────────────
  async update(request, reply) {
    if (!request.shopId) return this._missingShopReply(reply)

    const paramsParsed = shopProductIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error('Invalid shop product ID format', 'VALIDATION_ERROR'))
    }

    const bodyParsed = updateShopProductSchema.safeParse(request.body)
    if (!bodyParsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(bodyParsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.update(
      request.shopId,
      paramsParsed.data.id,
      bodyParsed.data,
      this._actor(request)
    )

    if (!result.success) {
      return reply
        .code(this._statusForCode(result.code))
        .send(error(result.message, result.code))
    }

    return reply.code(200).send(success(result.data, 'Shop product updated'))
  }

  // ────────────────────────────────────────────────────────
  // PATCH /:id/stock — Stock update (FOR UPDATE row lock)
  // ────────────────────────────────────────────────────────
  async updateStock(request, reply) {
    if (!request.shopId) return this._missingShopReply(reply)

    const paramsParsed = shopProductIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error('Invalid shop product ID format', 'VALIDATION_ERROR'))
    }

    const bodyParsed = stockUpdateSchema.safeParse(request.body)
    if (!bodyParsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(bodyParsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.updateStock(
      request.shopId,
      paramsParsed.data.id,
      bodyParsed.data,
      this._actor(request)
    )

    if (!result.success) {
      return reply
        .code(this._statusForCode(result.code))
        .send(error(result.message, result.code))
    }

    return reply
      .code(200)
      .send(
        success(
          { shopProduct: result.data, prev: result.prev },
          'Stock updated'
        )
      )
  }

  // ────────────────────────────────────────────────────────
  // DELETE /:id — Soft-delete
  // ────────────────────────────────────────────────────────
  async delete(request, reply) {
    if (!request.shopId) return this._missingShopReply(reply)

    const paramsParsed = shopProductIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error('Invalid shop product ID format', 'VALIDATION_ERROR'))
    }

    const result = await this.service.delete(
      request.shopId,
      paramsParsed.data.id,
      this._actor(request)
    )

    if (!result.success) {
      return reply
        .code(this._statusForCode(result.code))
        .send(error(result.message, result.code))
    }

    return reply.code(200).send(success(null, 'Shop product deleted'))
  }

  // ────────────────────────────────────────────────────────
  // POST /api/v1/shops/:shopId/products/:productId/adjust-stock
  // (R23.8, R23.9, R23.14)
  // ────────────────────────────────────────────────────────
  async adjustStock(request, reply) {
    // Permission `shop_products.update` and shop scope are gated at
    // the route layer (requirePermission + requireShopScope).
    const shopId = request.shopId || request.params?.shopId
    if (!shopId) return this._missingShopReply(reply)

    const paramsParsed = shopProductRouteParamsSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(paramsParsed.error), 'VALIDATION_ERROR'))
    }

    const bodyParsed = adjustStockSchema.safeParse(request.body)
    if (!bodyParsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(bodyParsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.adjustStock(
      paramsParsed.data.shopId,
      paramsParsed.data.productId,
      bodyParsed.data,
      this._actor(request)
    )

    if (!result.success) {
      return reply
        .code(this._statusForCode(result.code))
        .send(error(result.message, result.code))
    }

    return reply
      .code(200)
      .send(
        success(
          { shopProduct: result.data, movement: result.movement },
          'Stock adjusted'
        )
      )
  }

  // ────────────────────────────────────────────────────────
  // POST /api/v1/shops/:shopId/products/:productId/inventory-lots/manual
  // Manual vendor-batch backfill (see ShopProductsService#createManualInventoryLot)
  // ────────────────────────────────────────────────────────

  // ────────────────────────────────────────────────────────
  // GET /api/v1/shops/:shopId/products/lookup-inventory-lots?productId=…
  // "Add Product to Shop" counterpart to getInventoryLots — see
  // ShopProductsService#getInventoryLotsForProduct.
  // ────────────────────────────────────────────────────────

  // ────────────────────────────────────────────────────────
  // POST /api/v1/shops/:shopId/products/bulk-price-update (R23.12)
  // ────────────────────────────────────────────────────────
  async bulkPriceUpdate(request, reply) {
    // Permission `shop_products.bulk_update` gated at the route layer.
    const shopId = request.shopId || request.params?.shopId
    if (!shopId) return this._missingShopReply(reply)

    const bodyParsed = bulkPriceUpdateSchema.safeParse(request.body)
    if (!bodyParsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(bodyParsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.bulkPriceUpdate(
      shopId,
      bodyParsed.data,
      this._actor(request)
    )

    if (!result.success) {
      return reply
        .code(this._statusForCode(result.code))
        .send(error(result.message, result.code))
    }

    return reply
      .code(200)
      .send(success(result.data, 'Bulk price update applied'))
  }

  // ────────────────────────────────────────────────────────
  // GET /api/v1/shops/:shopId/stock-movements (R23.5)
  // ────────────────────────────────────────────────────────
  async listStockMovements(request, reply) {
    // Permission `shop_products.view` gated at the route layer.
    const shopId = request.shopId || request.params?.shopId
    if (!shopId) return this._missingShopReply(reply)

    const queryParsed = listStockMovementsQuerySchema.safeParse(request.query)
    if (!queryParsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(queryParsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.listStockMovements(
      shopId,
      queryParsed.data
    )
    return reply.code(200).send(success(result, 'Stock movements fetched'))
  }

  // ────────────────────────────────────────────────────────
  // POST /api/v1/admin/shop-products/:id/approve (R23.10)
  // ────────────────────────────────────────────────────────
  async approve(request, reply) {
    // Feature flag gate (R23.10) — when OFF, return 503 FEATURE_DISABLED
    // before doing any work so callers can detect the gate without
    // probing route existence.
    if (!env.MULTI_VENDOR_PRODUCT_APPROVAL) {
      return reply.code(503).send(
        error(
          'Product approval workflow is disabled (MULTI_VENDOR_PRODUCT_APPROVAL=false)',
          ERROR_CODES.FEATURE_DISABLED
        )
      )
    }

    // Permission `shop_products.approve` (HQ-only) gated at the route layer.
    const paramsParsed = adminShopProductIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error('Invalid shop product ID format', 'VALIDATION_ERROR'))
    }

    // Approve has no body fields but we still validate to reject unknowns.
    const bodyParsed = approveShopProductSchema.safeParse(request.body || {})
    if (!bodyParsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(bodyParsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.approve(
      paramsParsed.data.id,
      this._actor(request)
    )

    if (!result.success) {
      return reply
        .code(this._statusForCode(result.code))
        .send(error(result.message, result.code))
    }

    return reply
      .code(200)
      .send(success(result.data, 'Shop product approved'))
  }

  // ────────────────────────────────────────────────────────
  // POST /api/v1/admin/shop-products/:id/reject (R23.11)
  // ────────────────────────────────────────────────────────
  async reject(request, reply) {
    if (!env.MULTI_VENDOR_PRODUCT_APPROVAL) {
      return reply.code(503).send(
        error(
          'Product approval workflow is disabled (MULTI_VENDOR_PRODUCT_APPROVAL=false)',
          ERROR_CODES.FEATURE_DISABLED
        )
      )
    }

    const paramsParsed = adminShopProductIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply
        .code(400)
        .send(error('Invalid shop product ID format', 'VALIDATION_ERROR'))
    }

    const bodyParsed = rejectShopProductSchema.safeParse(request.body)
    if (!bodyParsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(bodyParsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.service.reject(
      paramsParsed.data.id,
      bodyParsed.data.reason,
      this._actor(request)
    )

    if (!result.success) {
      return reply
        .code(this._statusForCode(result.code))
        .send(error(result.message, result.code))
    }

    return reply
      .code(200)
      .send(success(result.data, 'Shop product rejected'))
  }

  // ────────────────────────────────────────────────────────
  // POST /api/v1/shops/:shopId/products/manual (R23.15–R23.24)
  // ────────────────────────────────────────────────────────
  async manualCreate(request, reply) {
    // Shop scope resolved by requireShopScope preHandler (JWT > X-Shop-Id > :shopId)
    const shopId = request.shopId || request.params?.shopId
    if (!shopId) return this._missingShopReply(reply)

    const bodyParsed = manualCreateProductSchema.safeParse(request.body)
    if (!bodyParsed.success) {
      return reply
        .code(400)
        .send(error(this._formatZodErrors(bodyParsed.error), 'VALIDATION_ERROR'))
    }

    const result = await this.manualCreateService.manualCreate(
      shopId,
      bodyParsed.data,
      this._actor(request)
    )

    if (!result.success) {
      const status = this._statusForCode(result.code)
      const payload = error(result.message, result.code)
      // R23.16: include existing_product_id on 409 so Dashboard can
      // offer to attach the existing master product instead.
      if (result.existing_product_id) {
        payload.existing_product_id = result.existing_product_id
      }
      return reply.code(status).send(payload)
    }

    return reply
      .code(201)
      .send(success(result.data, 'Product created manually'))
  }
}
