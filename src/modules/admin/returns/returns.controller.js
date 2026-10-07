import { success, error } from '../../../utils/apiResponse.js'

/**
 * Thin HTTP layer over RefundRequestsService. Business errors thrown by the
 * service carry `statusCode`/`code`; anything else is a real 5xx and is left
 * to the global error handler.
 */
export class ReturnsController {
  constructor(service) {
    this.service = service
  }

  #actor(request, extra = {}) {
    return {
      userId: request.user.id,
      role: 'ADMIN',
      shopId: request.shopId || null,
      ip: request.ip,
      ...extra,
    }
  }

  #fail(reply, err) {
    const status = err?.statusCode
    if (!status || status >= 500) throw err
    return reply.code(status).send(error(err.message, err.code || 'REFUND_ERROR'))
  }

  /** GET / */
  async list(request, reply) {
    const { rows, pagination } = await this.service.list({
      ...request.query,
      // A shop-scoped caller can only ever see their own shop's requests.
      shopId: request.shopId || undefined,
    })
    return reply.code(200).send(success(rows, 'Return requests fetched', { pagination }))
  }

  /** GET /:id */
  async getDetail(request, reply) {
    try {
      const row = await this.service.getDetail(request.params.id, request.shopId || null)
      if (!row) return reply.code(404).send(error('Return request not found', 'NOT_FOUND'))
      return reply.code(200).send(success(row, 'Return request fetched'))
    } catch (err) {
      return this.#fail(reply, err)
    }
  }

  /** POST / — admin files a request on a customer's behalf */
  async create(request, reply) {
    try {
      const b = request.body
      const row = await this.service.create({
        orderId: b.orderId,
        itemScope: b.scope === 'ITEMS' ? 'SPECIFIC' : 'ALL',
        itemIndexes: b.itemIndexes,
        productIds: b.productIds,
        description: b.reason,
        refundDestination: b.refundDestination,
        adminNotes: b.adminNotes,
      }, this.#actor(request))
      reply.code(201)
      return success(row, 'Return request created')
    } catch (err) {
      return this.#fail(reply, err)
    }
  }

  /** POST /:id/approve */
  async approve(request, reply) {
    try {
      const row = await this.service.approve(request.params.id, this.#actor(request, {
        adminNotes: request.body?.adminNotes,
        refundTo: request.body?.refundTo,
      }))
      return reply.code(200).send(success(row, 'Return request approved and refunded'))
    } catch (err) {
      return this.#fail(reply, err)
    }
  }

  /** POST /:id/reject */
  async reject(request, reply) {
    try {
      const row = await this.service.reject(request.params.id, this.#actor(request, { adminNotes: request.body?.adminNotes }))
      return reply.code(200).send(success(row, 'Return request rejected'))
    } catch (err) {
      return this.#fail(reply, err)
    }
  }

  /** POST /:id/cancel */
  async cancel(request, reply) {
    try {
      const row = await this.service.cancel(request.params.id, this.#actor(request, { adminNotes: request.body?.adminNotes }))
      return reply.code(200).send(success(row, 'Return request cancelled'))
    } catch (err) {
      return this.#fail(reply, err)
    }
  }
}
