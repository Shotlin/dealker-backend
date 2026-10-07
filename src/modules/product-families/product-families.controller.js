import { success, error } from '../../utils/apiResponse.js'

export class ProductFamiliesController {
  constructor(service) {
    this.service = service
  }

  async list(request, reply) {
    const result = await this.service.list(request.validatedQuery)
    return reply.code(200).send(
      success(result.items, 'Product families fetched', {
        pagination: { page: result.page, limit: result.limit, total: result.total, totalPages: Math.ceil(result.total / result.limit) },
      })
    )
  }

  async getById(request, reply) {
    const family = await this.service.getById(request.validatedParams.id)
    if (!family) {
      return reply.code(404).send(error('Product family not found', 'NOT_FOUND'))
    }
    return reply.code(200).send(success(family, 'Product family fetched'))
  }

  async create(request, reply) {
    const result = await this.service.create(request.validatedBody)
    if (!result.success) {
      return reply.code(409).send(error(result.message, result.code))
    }
    return reply.code(201).send(success(result.data, 'Product family created'))
  }

  async update(request, reply) {
    const result = await this.service.update(request.validatedParams.id, request.validatedBody)
    if (!result.success) {
      const status = result.code === 'NOT_FOUND' ? 404 : 409
      return reply.code(status).send(error(result.message, result.code))
    }
    return reply.code(200).send(success(result.data, 'Product family updated'))
  }

  async deactivate(request, reply) {
    const result = await this.service.deactivate(request.validatedParams.id)
    if (!result.success) {
      return reply.code(404).send(error(result.message, result.code))
    }
    return reply.code(200).send(success(result.data, 'Product family deactivated'))
  }

  /** GET /:id/options — All products linked to this family (admin only) */
  async listOptions(request, reply) {
    const result = await this.service.listOptions(request.validatedParams.id)
    if (!result) {
      return reply.code(404).send(error('Product family not found', 'NOT_FOUND'))
    }
    return reply.code(200).send(success(result, 'Family options fetched'))
  }
}
