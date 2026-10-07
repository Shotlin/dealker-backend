/**
 * Loyalty admin routes — mounted at /api/v1/admin/loyalty.
 *
 * @module modules/loyalty/loyalty.routes
 */

import { LoyaltyService } from './loyalty.service.js'

const service = new LoyaltyService()

export const adminLoyaltyRoutes = async function loyaltyRoutes(fastify) {
  fastify.get('/settings', {
    preHandler: [fastify.authenticate, fastify.requirePermission('loyalty_settings.view')],
    handler: async () => ({ success: true, data: await service.getSettings() }),
  })

  fastify.put('/settings', {
    preHandler: [fastify.authenticate, fastify.requirePermission('loyalty_settings.manage')],
    handler: async (request) => ({
      success: true,
      data: await service.updateSettings(request.body || {}, request.user?.id),
    }),
  })

  fastify.get('/stats', {
    preHandler: [fastify.authenticate, fastify.requirePermission('loyalty.view')],
    handler: async () => ({ success: true, data: await service.getStats() }),
  })

  fastify.get('/customers', {
    preHandler: [fastify.authenticate, fastify.requirePermission('loyalty.view')],
    handler: async (request) => {
      const { page = 1, limit = 20, search = '' } = request.query || {}
      return service.listCustomers({
        page: Number(page), limit: Math.min(100, Number(limit)), search: String(search || ''),
      })
    },
  })

  fastify.get('/customers/:customerId/transactions', {
    preHandler: [fastify.authenticate, fastify.requirePermission('loyalty.view')],
    handler: async (request) => {
      const { page = 1, limit = 20 } = request.query || {}
      return service.listTransactions(request.params.customerId, {
        page: Number(page), limit: Math.min(100, Number(limit)),
      })
    },
  })

  fastify.post('/customers/:customerId/adjust', {
    preHandler: [fastify.authenticate, fastify.requirePermission('loyalty.configure')],
    handler: async (request, reply) => {
      const { points, reason } = request.body || {}
      const value = Math.trunc(Number(points))
      if (!Number.isFinite(value) || value === 0) {
        return reply.status(400).send({ success: false, message: 'points must be a non-zero integer (negative to debit)' })
      }
      const row = await service.adminAdjust(request.params.customerId, value, String(reason || ''), request.user?.id)
      return { success: true, data: row }
    },
  })
}
