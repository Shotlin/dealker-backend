import { success, error } from '../../utils/apiResponse.js'
import {
  createShopSchema,
  updateShopSchema,
  listShopsQuerySchema,
  shopIdParamSchema,
} from './shops.schema.js'

/**
 * Shops controller — thin HTTP layer
 * Handles request/response only, delegates to service
 */
export class ShopsController {
  constructor(service) {
    this.service = service
  }

  /**
   * POST / — Create a new shop
   */
  async create(request, reply) {
    const parsed = createShopSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(error(
        parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; '),
        'VALIDATION_ERROR'
      ))
    }

    const shop = await this.service.create(parsed.data, request.user.id)
    return reply.code(201).send(success(shop, 'Shop created'))
  }

  /**
   * GET / — List shops with filters and pagination
   */
  async list(request, reply) {
    const parsed = listShopsQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send(error(
        parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; '),
        'VALIDATION_ERROR'
      ))
    }

    const result = await this.service.list(parsed.data)
    return reply.code(200).send(success(result, 'Shops fetched'))
  }

  /**
   * GET /:id — Get single shop by ID
   */
  async getOne(request, reply) {
    const paramsParsed = shopIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply.code(400).send(error('Invalid shop ID format', 'VALIDATION_ERROR'))
    }

    const shop = await this.service.getById(paramsParsed.data.id)
    if (!shop) {
      return reply.code(404).send(error('Shop not found', 'SHOP_NOT_FOUND'))
    }

    return reply.code(200).send(success(shop, 'Shop fetched'))
  }

  /**
   * PATCH /:id — Update shop
   */
  async update(request, reply) {
    const paramsParsed = shopIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply.code(400).send(error('Invalid shop ID format', 'VALIDATION_ERROR'))
    }

    const bodyParsed = updateShopSchema.safeParse(request.body)
    if (!bodyParsed.success) {
      return reply.code(400).send(error(
        bodyParsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; '),
        'VALIDATION_ERROR'
      ))
    }

    const result = await this.service.update(
      paramsParsed.data.id,
      bodyParsed.data,
      request.user.id,
      {
        ip: request.ip,
        userAgent: request.headers?.['user-agent'] || null,
        actorRole:
          request.user?.platform_role ||
          request.user?.shopRole ||
          request.user?.role ||
          null,
      }
    )

    if (!result.success) {
      return reply.code(404).send(error(result.message, result.code))
    }

    return reply.code(200).send(success(result.shop, 'Shop updated'))
  }

  /**
   * DELETE /:id — Soft-delete shop
   */
  async delete(request, reply) {
    const paramsParsed = shopIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply.code(400).send(error('Invalid shop ID format', 'VALIDATION_ERROR'))
    }

    const result = await this.service.delete(paramsParsed.data.id, request.user.id)

    if (!result.success) {
      return reply.code(404).send(error(result.message, result.code))
    }

    return reply.code(200).send(success(null, 'Shop deleted successfully'))
  }
}
