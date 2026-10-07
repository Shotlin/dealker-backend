import { ThemeTabsController } from './theme-tabs.controller.js'
import {
  createThemeTabSchema,
  listThemeTabsSchema,
  themeTabIdSchema,
  updateThemeTabSchema,
} from './theme-tabs.schema.js'

const ctrl = new ThemeTabsController()

export default async function adminThemeTabRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', { schema: listThemeTabsSchema }, ctrl.list)
  fastify.get('/:id', { schema: themeTabIdSchema }, ctrl.getById)
  fastify.post('/', { schema: createThemeTabSchema }, ctrl.create)
  fastify.put('/:id', { schema: updateThemeTabSchema }, ctrl.update)
  fastify.post('/:id/icon', { schema: themeTabIdSchema }, ctrl.uploadIcon)
  fastify.delete('/:id', { schema: themeTabIdSchema }, ctrl.archive)
  fastify.post('/:id/restore', { schema: themeTabIdSchema }, ctrl.restore)
}
