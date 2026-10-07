import { ProductFamiliesController } from './product-families.controller.js'
import { ProductFamiliesService } from './product-families.service.js'
import { ProductFamiliesRepository } from './product-families.repository.js'
import {
  createProductFamilySchema,
  updateProductFamilySchema,
  listProductFamiliesQuerySchema,
  productFamilyIdParamSchema,
} from './product-families.schema.js'

export default async function productFamiliesRoutes(fastify) {
  const repository = new ProductFamiliesRepository()
  const service = new ProductFamiliesService(repository)
  const controller = new ProductFamiliesController(service)

  // Zod validation preHandler
  const validateBody = (schema) => async (request) => {
    request.validatedBody = schema.parse(request.body)
  }
  const validateQuery = (schema) => async (request) => {
    request.validatedQuery = schema.parse(request.query)
  }
  const validateParams = (schema) => async (request) => {
    request.validatedParams = schema.parse(request.params)
  }

  // GET / — List product families
  fastify.get('/', {
    schema: { tags: ['Product Families'], summary: 'List product families [ADMIN]' },
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN']), validateQuery(listProductFamiliesQuerySchema)],
  }, controller.list.bind(controller))

  // GET /:id — Get single product family
  fastify.get('/:id', {
    schema: { tags: ['Product Families'], summary: 'Get product family [ADMIN]' },
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN']), validateParams(productFamilyIdParamSchema)],
  }, controller.getById.bind(controller))

  // GET /:id/options — All products linked to this family
  fastify.get('/:id/options', {
    schema: {
      tags: ['Product Families'],
      summary: 'List options/products in a family [ADMIN]',
    },
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN']), validateParams(productFamilyIdParamSchema)],
  }, controller.listOptions.bind(controller))

  // POST / — Create product family
  fastify.post('/', {
    schema: { tags: ['Product Families'], summary: 'Create product family [ADMIN]' },
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN']), validateBody(createProductFamilySchema)],
  }, controller.create.bind(controller))

  // PATCH /:id — Update product family
  fastify.patch('/:id', {
    schema: { tags: ['Product Families'], summary: 'Update product family [ADMIN]' },
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN']), validateParams(productFamilyIdParamSchema), validateBody(updateProductFamilySchema)],
  }, controller.update.bind(controller))

  // DELETE /:id — Deactivate product family
  fastify.delete('/:id', {
    schema: { tags: ['Product Families'], summary: 'Deactivate product family [ADMIN]' },
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN']), validateParams(productFamilyIdParamSchema)],
  }, controller.deactivate.bind(controller))
}
