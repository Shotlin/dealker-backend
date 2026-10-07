import { FeeConfigController } from './fee-config.controller.js'
import { FeeConfigService } from './fee-config.service.js'
import { FeeConfigRepository } from './fee-config.repository.js'
import { getFeeConfigsSchema, updateFeeConfigSchema } from './fee-config.schema.js'

/**
 * Fee config admin routes plugin
 * Prefix: /api/v1/admin/fee-config
 * All routes require admin auth
 */
export default async function feeConfigRoutes(fastify) {
  const repository = new FeeConfigRepository()
  const service = new FeeConfigService(repository)
  const controller = new FeeConfigController(service)
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  // GET / — List all fee configs
  fastify.get('/', {
    schema: getFeeConfigsSchema,
    preHandler: adminAuth,
  }, controller.getAll.bind(controller))

  // PUT /:feeType — Update a fee config
  fastify.put('/:feeType', {
    schema: updateFeeConfigSchema,
    preHandler: adminAuth,
  }, controller.update.bind(controller))
}
