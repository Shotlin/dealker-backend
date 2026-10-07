import { success, error } from '../../utils/apiResponse.js'

export class CartMilestonesController {
  constructor(service) {
    this.service = service
  }

  _actorCtx(request) {
    return {
      userId: request.user?.id ?? null,
      role: request.user?.role ?? null,
      platformRole: request.user?.platform_role ?? request.user?.platformRole ?? null,
      ip: request.ip ?? null,
      userAgent: request.headers?.['user-agent'] ?? null,
    }
  }

  /** GET /progress?cartTotal= — customer-facing, powers the Smart Bottom Bar */
  async progress(request, reply) {
    const cartTotal = Number(request.query.cartTotal || 0)
    const progress = await this.service.getProgress(request.user.id, cartTotal)
    return reply.code(200).send(success(progress, 'Cart milestone progress'))
  }

  /** GET / — Admin */
  async listAll(request, reply) {
    const milestones = await this.service.listAll()
    return reply.code(200).send(success(milestones, 'Cart milestones fetched'))
  }

  /** POST / — Admin */
  async create(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.create(request.body, actor)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    }
    return reply.code(201).send(success(result.milestone, 'Cart milestone created'))
  }

  /** PATCH /:id — Admin */
  async update(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.update(request.params.id, request.body, actor)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(result.milestone, 'Cart milestone updated'))
  }

  /** DELETE /:id — Admin */
  async delete(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.delete(request.params.id, actor)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(null, 'Cart milestone deleted'))
  }
}
