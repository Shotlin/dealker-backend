import { AdminBannersController } from './banners.controller.js'
import {
  bannerIdSchema, createBannerSchema, updateBannerSchema, reorderSchema,
} from './banners.schema.js'

const ctrl = new AdminBannersController()

export default async function adminBannerRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', ctrl.list)
  fastify.get('/:id', { schema: bannerIdSchema }, ctrl.getById)
  fastify.post('/', { schema: createBannerSchema }, ctrl.create)
  fastify.put('/:id', { schema: updateBannerSchema }, ctrl.update)
  fastify.delete('/:id', { schema: bannerIdSchema }, ctrl.remove)
  fastify.put('/reorder', { schema: reorderSchema }, ctrl.reorder)
}
