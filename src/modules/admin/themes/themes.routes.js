import { ThemesController } from './themes.controller.js'
import {
  createThemeSchema,
  updateThemeSchema,
  themeIdSchema,
  scheduleThemeSchema,
  rollbackSchema,
} from './themes.schema.js'

const ctrl = new ThemesController()

export default async function adminThemeRoutes(fastify) {
  // IMPORTANT: Use addHook for auth — same pattern as banners.routes.js
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', ctrl.list)
  fastify.get('/:id', { schema: themeIdSchema }, ctrl.getById)
  fastify.post('/', { schema: createThemeSchema }, ctrl.create)
  fastify.put('/:id', { schema: updateThemeSchema }, ctrl.update)
  fastify.put('/:id/activate', { schema: themeIdSchema }, ctrl.activate)
  fastify.delete('/:id', { schema: themeIdSchema }, ctrl.remove)
  fastify.get('/tabs', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          store_key: { type: 'string', enum: ['mobile', 'mobile_part', 'accessories', 'electronics', 'repellents', 'marketplace', 'deals', 'brand_store', 'new_arrivals'] },
        },
      },
    },
  }, ctrl.getTabThemes)
  fastify.get('/:id/versions', { schema: themeIdSchema }, ctrl.getVersions)
  fastify.post('/:id/schedule', { schema: scheduleThemeSchema }, ctrl.scheduleTheme)
  fastify.delete('/:id/schedule', { schema: themeIdSchema }, ctrl.cancelSchedule)
  fastify.post('/:id/rollback', { schema: rollbackSchema }, ctrl.rollbackVersion)
}
