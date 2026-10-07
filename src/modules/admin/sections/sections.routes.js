import { SectionsController } from './sections.controller.js'
import {
  createSectionSchema,
  reorderSectionsSchema,
  rollbackSchema,
  scheduleSchema,
  sectionIdSchema,
  tabIdSchema,
  updateMerchSchema,
  updateSectionSchema,
} from './sections.schema.js'

const ctrl = new SectionsController()

export default async function adminSectionRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/:tabId', { schema: tabIdSchema }, ctrl.listByTab)
  fastify.get('/item/:id', { schema: sectionIdSchema }, ctrl.getById)
  fastify.post('/:tabId', { schema: createSectionSchema }, ctrl.create)
  fastify.put('/:id', { schema: updateSectionSchema }, ctrl.update)
  fastify.put('/:id/merch', { schema: updateMerchSchema }, ctrl.updateMerch)
  fastify.delete('/:id', { schema: sectionIdSchema }, ctrl.remove)
  fastify.patch('/:tabId/reorder', { schema: reorderSectionsSchema }, ctrl.reorder)
  fastify.post('/:id/duplicate', { schema: sectionIdSchema }, ctrl.duplicate)
  fastify.get('/:tabId/versions', { schema: tabIdSchema }, ctrl.getVersions)
  fastify.post('/:tabId/rollback', { schema: rollbackSchema }, ctrl.rollbackVersion)
  fastify.post('/:tabId/schedule', { schema: scheduleSchema }, ctrl.scheduleLayout)
  fastify.delete('/:tabId/schedule', { schema: tabIdSchema }, ctrl.cancelSchedule)
}
