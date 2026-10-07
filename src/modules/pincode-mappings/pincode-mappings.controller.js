import { success, error } from '../../utils/apiResponse.js'

export class PincodeMappingsController {
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

  /** GET / — Admin */
  async list(request, reply) {
    const mappings = await this.service.listAll()
    return reply.code(200).send(success(mappings, 'Pincode mappings fetched'))
  }

  /** POST / — Admin */
  async create(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.create(request.body, actor)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    }
    return reply.code(201).send(success(result.mapping, 'Pincode mapping created'))
  }

  /** PUT /:id — Admin */
  async update(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.update(request.params.id, request.body, actor)
    if (!result.success) {
      const status = result.message === 'Mapping not found' ? 404 : 400
      return reply.code(status).send(error(result.message, status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR'))
    }
    return reply.code(200).send(success(result.mapping, 'Pincode mapping updated'))
  }

  /** DELETE /:id — Admin */
  async remove(request, reply) {
    const actor = this._actorCtx(request)
    const result = await this.service.remove(request.params.id, actor)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'NOT_FOUND'))
    }
    return reply.code(200).send(success(null, 'Pincode mapping deleted'))
  }
}
