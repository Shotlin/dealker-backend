import { ShopsController } from './shops.controller.js'
import { ShopsService } from './shops.service.js'
import { ShopsRepository } from './shops.repository.js'

/**
 * Shops routes plugin
 * Prefix: /api/v1/shops
 * Access: Super Admin only (ADMIN role)
 */
export default async function shopRoutes(fastify) {
  const repository = new ShopsRepository()
  const service = new ShopsService(repository)
  const controller = new ShopsController(service)

  // All shop routes require authentication + ADMIN role
  const adminPreHandlers = [fastify.authenticate, fastify.authorize(['ADMIN'])]

  // POST / — Create shop (rate limited: 5 per minute)
  fastify.post('/', {
    schema: {
      tags: ['Shops'],
      summary: 'Create a new shop [Super Admin]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: adminPreHandlers,
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
  }, controller.create.bind(controller))

  // GET / — List shops (paginated, filterable)
  fastify.get('/', {
    schema: {
      tags: ['Shops'],
      summary: 'List shops with filters [Super Admin]',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          city: { type: 'string', maxLength: 100 },
          is_active: { type: 'string', enum: ['true', 'false'] },
          search: { type: 'string', maxLength: 200 },
          include_deleted: { type: 'string', enum: ['true', 'false'] },
        },
      },
    },
    preHandler: adminPreHandlers,
  }, controller.list.bind(controller))

  // GET /:id — Get single shop
  fastify.get('/:id', {
    schema: {
      tags: ['Shops'],
      summary: 'Get shop by ID [Super Admin]',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
    preHandler: adminPreHandlers,
  }, controller.getOne.bind(controller))

  // PATCH /:id — Update shop
  fastify.patch('/:id', {
    schema: {
      tags: ['Shops'],
      summary: 'Update shop [Super Admin]',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
    preHandler: adminPreHandlers,
  }, controller.update.bind(controller))

  // DELETE /:id — Soft-delete shop
  fastify.delete('/:id', {
    schema: {
      tags: ['Shops'],
      summary: 'Delete shop (soft delete) [Super Admin]',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
    preHandler: adminPreHandlers,
  }, controller.delete.bind(controller))
}
