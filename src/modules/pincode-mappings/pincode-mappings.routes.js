import { PincodeMappingsController } from './pincode-mappings.controller.js'
import { PincodeMappingsService } from './pincode-mappings.service.js'
import { PincodeMappingsRepository } from './pincode-mappings.repository.js'
import {
  listMappingsSchema,
  createMappingSchema,
  updateMappingSchema,
  deleteMappingSchema,
} from './pincode-mappings.schema.js'

/**
 * Pincode Mappings admin routes plugin.
 * Prefix: /api/v1/admin/pincode-mappings
 *
 * Admin-curated pincode -> city/area/state overrides, consumed by
 * addresses.service.js#validatePincode (see migration 089 for why).
 */
export default async function pincodeMappingsRoutes(fastify) {
  const repository = new PincodeMappingsRepository()
  const service = new PincodeMappingsService(repository)
  const controller = new PincodeMappingsController(service)
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/', {
    schema: listMappingsSchema,
    preHandler: adminAuth,
  }, controller.list.bind(controller))

  fastify.post('/', {
    schema: createMappingSchema,
    preHandler: adminAuth,
  }, controller.create.bind(controller))

  fastify.put('/:id', {
    schema: updateMappingSchema,
    preHandler: adminAuth,
  }, controller.update.bind(controller))

  fastify.delete('/:id', {
    schema: deleteMappingSchema,
    preHandler: adminAuth,
  }, controller.remove.bind(controller))
}
