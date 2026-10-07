import { CartMilestonesController } from './cart-milestones.controller.js'
import { CartMilestonesService } from './cart-milestones.service.js'
import { CartMilestonesRepository } from './cart-milestones.repository.js'
import {
  progressSchema,
  listMilestonesSchema,
  createMilestoneSchema,
  updateMilestoneSchema,
  deleteMilestoneSchema,
} from './cart-milestones.schema.js'

/**
 * Cart Milestones routes plugin
 * Prefix: /api/v1/cart-milestones
 */
export default async function cartMilestonesRoutes(fastify) {
  const repository = new CartMilestonesRepository()
  const service = new CartMilestonesService(repository)
  const controller = new CartMilestonesController(service)

  // ─── Customer route ─────────────────────────────────────
  fastify.get('/progress', {
    schema: progressSchema,
    preHandler: [fastify.authenticate],
  }, controller.progress.bind(controller))

  // ─── Admin routes ────────────────────────────────────────
  fastify.get('/', {
    schema: listMilestonesSchema,
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, controller.listAll.bind(controller))

  fastify.post('/', {
    schema: createMilestoneSchema,
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, controller.create.bind(controller))

  fastify.patch('/:id', {
    schema: updateMilestoneSchema,
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, controller.update.bind(controller))

  fastify.delete('/:id', {
    schema: deleteMilestoneSchema,
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, controller.delete.bind(controller))
}
