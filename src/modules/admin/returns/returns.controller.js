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

  // ── Return journey: pickup (Shiprocket / Porter / self), QC report + price revision, policy ──
  async #run(reply, fn, message) {
    try {
      return reply.code(200).send(success(await fn(), message))
    } catch (err) {
      return this.#fail(reply, err)
    }
  }

  journey(request, reply) {
    return this.#run(reply, () => this.service.journey.adminJourney(request.params.id, request.shopId || null), 'Return journey fetched')
  }

  savePickup(request, reply) {
    return this.#run(reply, () => this.service.journey.savePickup(request.params.id, request.body, this.#actor(request)), 'Pickup saved')
  }

  setPickupStatus(request, reply) {
    return this.#run(reply, () => this.service.journey.setPickupStatus(request.params.id, request.body.status, request.body.note, this.#actor(request)), 'Pickup status updated')
  }

  syncPickup(request, reply) {
    return this.#run(reply, () => this.service.journey.syncPickup(request.params.id, this.#actor(request)), 'Pickup status synced')
  }

  saveQc(request, reply) {
    return this.#run(reply, () => this.service.journey.saveQc(request.params.id, request.body, this.#actor(request)), 'QC report saved')
  }

  getPolicy(request, reply) {
    return this.#run(reply, () => this.service.journey.getSettings(), 'Return policy fetched')
  }

  savePolicy(request, reply) {
    return this.#run(reply, () => this.service.journey.updateSettings(request.body, this.#actor(request)), 'Return policy saved')
  }
}
