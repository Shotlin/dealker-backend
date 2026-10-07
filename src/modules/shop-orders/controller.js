import { error, success } from '../../utils/apiResponse.js'
import { ERROR_CODES, httpStatusFor } from '../../constants/errors.js'
import {
  listOrdersQuerySchema,
  exportOrdersQuerySchema,
  orderIdParamSchema,
  assignRiderBodySchema,
  cancelOrderBodySchema,
  refundOrderBodySchema,
  ridersQuerySchema,
} from './schema.js'

/**
 * Shop Orders controller — Zod-validates request shape and translates
 * service results into the canonical `{ success, message, data, code }`
 * response envelope. No business logic lives here; everything is
 * delegated to the service.
 *
 * Design source: §6.5 of the multi-vendor-system spec.
 */

/**
 * Format a Zod error tree into a single-line message.
 */
function formatZodIssues(zodError) {
  return zodError.issues
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ')
}

/**
 * Map a service-thrown error to the canonical envelope. Service errors
 * carry `{ code, message, statusCode }`; everything else falls through
 * as a 500 INTERNAL_ERROR.
 */
function sendServiceError(reply, err) {
  if (err && err.code && err.statusCode) {
    return reply.code(err.statusCode).send(error(err.message, err.code))
  }
  if (err && err.code) {
    const status = httpStatusFor(err.code) ?? 500
    return reply.code(status).send(error(err.message || 'Error', err.code))
  }
  reply.request?.log?.error({ err }, 'shop-orders unexpected error')
  return reply
    .code(500)
    .send(error('Internal server error', ERROR_CODES.INTERNAL_ERROR))
}

/**
 * Build the actor metadata object passed to the service so audit rows
 * carry the requester's identity, role, IP, and user-agent.
 */
function actorFrom(request) {
  const u = request.user || {}
  return {
    id: u.id || null,
    role: u.role || null,
    platform_role: u.platform_role || null,
    shopRole: u.shopRole || u.shop_role || null,
    ip: request.ip || null,
    userAgent: request.headers?.['user-agent'] || null,
  }
}

export class ShopOrdersController {
  constructor(service) {
    this.service = service
  }

  // ─── Listing ────────────────────────────────────────────────────

  async list(request, reply) {
    const parsed = listOrdersQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(error(formatZodIssues(parsed.error), ERROR_CODES.VALIDATION_ERROR))
    }
    if (!request.shopId) {
      return reply
        .code(400)
        .send(error('Shop scope required', ERROR_CODES.SHOP_SCOPE_REQUIRED))
    }
    try {
      const result = await this.service.list(request.shopId, parsed.data)
      return reply.code(200).send(success(result, 'Orders fetched'))
    } catch (err) {
      return sendServiceError(reply, err)
    }
  }

  async getOne(request, reply) {
    const params = orderIdParamSchema.safeParse(request.params)
    if (!params.success) {
      return reply
        .code(400)
        .send(error(formatZodIssues(params.error), ERROR_CODES.VALIDATION_ERROR))
    }
    if (!request.shopId) {
      return reply
        .code(400)
        .send(error('Shop scope required', ERROR_CODES.SHOP_SCOPE_REQUIRED))
    }
    try {
      const order = await this.service.getById(
        request.shopId,
        params.data.orderId
      )
      if (!order) {
        return reply.code(404).send(error('Order not found', 'ORDER_NOT_FOUND'))
      }
      return reply.code(200).send(success({ order }, 'Order fetched'))
    } catch (err) {
      return sendServiceError(reply, err)
    }
  }

  // ─── State transitions ──────────────────────────────────────────

  async confirm(request, reply) {
    return this._runTransition(request, reply, 'CONFIRMED')
  }

  async preparing(request, reply) {
    return this._runTransition(request, reply, 'PREPARING')
  }

  async packed(request, reply) {
    return this._runTransition(request, reply, 'PACKED')
  }

  async _runTransition(request, reply, toStatus) {
    const params = orderIdParamSchema.safeParse(request.params)
    if (!params.success) {
      return reply
        .code(400)
        .send(error(formatZodIssues(params.error), ERROR_CODES.VALIDATION_ERROR))
    }
    if (!request.shopId) {
      return reply
        .code(400)
        .send(error('Shop scope required', ERROR_CODES.SHOP_SCOPE_REQUIRED))
    }
    try {
      const order = await this.service.transition(
        request.shopId,
        params.data.orderId,
        toStatus,
        actorFrom(request)
      )
      return reply
        .code(200)
        .send(success({ order }, `Order ${toStatus.toLowerCase()}`))
    } catch (err) {
      return sendServiceError(reply, err)
    }
  }

  // ─── Assign rider ───────────────────────────────────────────────

  async assignRider(request, reply) {
    const params = orderIdParamSchema.safeParse(request.params)
    if (!params.success) {
      return reply
        .code(400)
        .send(error(formatZodIssues(params.error), ERROR_CODES.VALIDATION_ERROR))
    }
    const body = assignRiderBodySchema.safeParse(request.body)
    if (!body.success) {
      return reply
        .code(400)
        .send(error(formatZodIssues(body.error), ERROR_CODES.VALIDATION_ERROR))
    }
    if (!request.shopId) {
      return reply
        .code(400)
        .send(error('Shop scope required', ERROR_CODES.SHOP_SCOPE_REQUIRED))
    }
    try {
      const result = await this.service.assignRider(
        request.shopId,
        params.data.orderId,
        body.data.rider_id,
        actorFrom(request)
      )
      return reply.code(200).send(success(result, 'Rider assigned'))
    } catch (err) {
      return sendServiceError(reply, err)
    }
  }

  // ─── Cancel ─────────────────────────────────────────────────────

  async cancel(request, reply) {
    const params = orderIdParamSchema.safeParse(request.params)
    if (!params.success) {
      return reply
        .code(400)
        .send(error(formatZodIssues(params.error), ERROR_CODES.VALIDATION_ERROR))
    }
    const body = cancelOrderBodySchema.safeParse(request.body)
    if (!body.success) {
      return reply
        .code(400)
        .send(error(formatZodIssues(body.error), ERROR_CODES.VALIDATION_ERROR))
    }
    if (!request.shopId) {
      return reply
        .code(400)
        .send(error('Shop scope required', ERROR_CODES.SHOP_SCOPE_REQUIRED))
    }
    try {
      const order = await this.service.cancel(
        request.shopId,
        params.data.orderId,
        body.data.reason,
        actorFrom(request)
      )
      return reply.code(200).send(success({ order }, 'Order cancelled'))
    } catch (err) {
      return sendServiceError(reply, err)
    }
  }

  // ─── Refund ─────────────────────────────────────────────────────

  async refund(request, reply) {
    const params = orderIdParamSchema.safeParse(request.params)
    if (!params.success) {
      return reply
        .code(400)
        .send(error(formatZodIssues(params.error), ERROR_CODES.VALIDATION_ERROR))
    }
    const body = refundOrderBodySchema.safeParse(request.body)
    if (!body.success) {
      return reply
        .code(400)
        .send(error(formatZodIssues(body.error), ERROR_CODES.VALIDATION_ERROR))
    }
    if (!request.shopId) {
      return reply
        .code(400)
        .send(error('Shop scope required', ERROR_CODES.SHOP_SCOPE_REQUIRED))
    }
    try {
      const result = await this.service.refund(
        request.shopId,
        params.data.orderId,
        body.data,
        actorFrom(request)
      )
      return reply.code(200).send(success(result, 'Order refunded'))
    } catch (err) {
      return sendServiceError(reply, err)
    }
  }

  // ─── Packing slip ───────────────────────────────────────────────

  async packingSlip(request, reply) {
    const params = orderIdParamSchema.safeParse(request.params)
    if (!params.success) {
      return reply
        .code(400)
        .send(error(formatZodIssues(params.error), ERROR_CODES.VALIDATION_ERROR))
    }
    if (!request.shopId) {
      return reply
        .code(400)
        .send(error('Shop scope required', ERROR_CODES.SHOP_SCOPE_REQUIRED))
    }
    try {
      const html = await this.service.packingSlipHtml(
        request.shopId,
        params.data.orderId
      )
      if (!html) {
        return reply
          .code(404)
          .send(error('Order not found', 'ORDER_NOT_FOUND'))
      }
      return reply
        .code(200)
        .header('Content-Type', 'text/html; charset=utf-8')
        .header(
          'Content-Disposition',
          `inline; filename="packing-slip-${params.data.orderId}.html"`
        )
        .send(html)
    } catch (err) {
      return sendServiceError(reply, err)
    }
  }

  // ─── CSV export ─────────────────────────────────────────────────

  async exportCsv(request, reply) {
    const parsed = exportOrdersQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(error(formatZodIssues(parsed.error), ERROR_CODES.VALIDATION_ERROR))
    }
    if (!request.shopId) {
      return reply
        .code(400)
        .send(error('Shop scope required', ERROR_CODES.SHOP_SCOPE_REQUIRED))
    }

    const filename = `shop-orders-${request.shopId}-${Date.now()}.csv`
    reply.raw.statusCode = 200
    reply.raw.setHeader('Content-Type', 'text/csv; charset=utf-8')
    reply.raw.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`
    )

    try {
      await this.service.streamExportCsv(request.shopId, parsed.data, reply.raw)
      reply.raw.end()
      // Tell Fastify we've already taken over the response.
      return reply
    } catch (err) {
      // Headers are already sent; just terminate the response. The error
      // is logged via the request logger so the operator can debug.
      request.log?.error(
        { err, shopId: request.shopId, action: 'shop_orders_export' },
        'CSV export stream failed'
      )
      try {
        reply.raw.end()
      } catch {
        /* ignore */
      }
      return reply
    }
  }

  // ─── Riders for shop ────────────────────────────────────────────

  async listRiders(request, reply) {
    const parsed = ridersQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(error(formatZodIssues(parsed.error), ERROR_CODES.VALIDATION_ERROR))
    }
    if (!request.shopId) {
      return reply
        .code(400)
        .send(error('Shop scope required', ERROR_CODES.SHOP_SCOPE_REQUIRED))
    }
    try {
      const result = await this.service.listAssignedRidersForShop(
        request.shopId,
        parsed.data
      )
      return reply.code(200).send(success(result, 'Riders fetched'))
    } catch (err) {
      return sendServiceError(reply, err)
    }
  }
}
