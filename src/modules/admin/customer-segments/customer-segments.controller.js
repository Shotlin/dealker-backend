import { success, error } from '../../../utils/apiResponse.js'

export class CustomerSegmentsController {
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

  /** GET / */
  async list(request, reply) {
    const segments = await this.service.list()
    return reply.code(200).send(success(segments, 'Customer segments fetched'))
  }

  /** GET /:id */
  async getDetail(request, reply) {
    const segment = await this.service.getDetail(request.params.id)
    if (!segment) {
      return reply.code(404).send(error('Segment not found', 'NOT_FOUND'))
    }
    return reply.code(200).send(success(segment, 'Customer segment fetched'))
  }

  /** POST / */
  async create(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.create(request.body, actor)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    }
    return reply.code(201).send(success(result.segment, 'Customer segment created'))
  }

  /** PATCH /:id */
  async update(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.update(request.params.id, request.body, actor)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(result.segment, 'Customer segment updated'))
  }

  /** DELETE /:id */
  async delete(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.delete(request.params.id, actor)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(null, 'Customer segment deleted'))
  }

  /** GET /:id/members */
  async getMembers(request, reply) {
    const { page, limit } = request.query
    const data = await this.service.getMembers(request.params.id, { page, limit })
    return reply.code(200).send(success(data.members, 'Segment members fetched', { pagination: data.pagination }))
  }

  /** POST /:id/members */
  async addMembers(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.addMembers(request.params.id, request.body.userIds, actor)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    }
    return reply.code(200).send(success({ addedCount: result.addedCount }, 'Members added to segment'))
  }

  /** DELETE /:id/members/:userId */
  async removeMember(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.removeMember(request.params.id, request.params.userId, actor)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(null, 'Member removed from segment'))
  }

  /** GET /:id/search-candidates */
  async searchCandidates(request, reply) {
    const candidates = await this.service.searchCandidates(request.query.q, { limit: request.query.limit })
    return reply.code(200).send(success(candidates, 'Candidates fetched'))
  }
}
