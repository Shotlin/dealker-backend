/**
 * Vendor Settlements routes — admin + vendor surfaces.
 *
 * @module modules/vendor-settlements/vendor-settlements.routes
 */

import { requireVendorScope } from '../../middlewares/vendor-scope.js'
import { VendorSettlementsService } from './vendor-settlements.service.js'

const service = new VendorSettlementsService()

/** Admin routes — mounted at /api/v1/admin/settlements */
export const adminSettlementsRoutes = async function settlementsAdminRoutes(fastify) {
  fastify.get('/overview', {
    preHandler: [fastify.authenticate, fastify.requirePermission('settlements.view')],
    handler: async () => ({ success: true, data: await service.adminOverview() }),
  })

  fastify.get('/vendors/:vendorId/statement', {
    preHandler: [fastify.authenticate, fastify.requirePermission('settlements.view')],
    handler: async (request) => {
      const { page = 1, limit = 20, entryType = '' } = request.query || {}
      return service.vendorStatement(request.params.vendorId, {
        page: Number(page), limit: Math.min(100, Number(limit)), entryType: String(entryType || ''),
      })
    },
  })

  fastify.post('/vendors/:vendorId/adjust', {
    preHandler: [fastify.authenticate, fastify.requirePermission('settlements.manage')],
    handler: async (request, reply) => {
      const { amount, reason } = request.body || {}
      const value = Number(amount)
      if (!Number.isFinite(value) || value === 0) {
        return reply.status(400).send({ success: false, message: 'amount must be a non-zero number (negative for deductions)' })
      }
      await service.adminAdjust(request.params.vendorId, value, String(reason || ''), request.user?.id)
      return { success: true }
    },
  })

  fastify.post('/vendors/:vendorId/payouts', {
    preHandler: [fastify.authenticate, fastify.requirePermission('settlements.manage')],
    handler: async (request, reply) => {
      try {
        const payout = await service.createPayout(request.params.vendorId, {
          amount: request.body?.amount,
          notes: request.body?.notes,
          createdBy: request.user?.id,
        })
        return { success: true, data: payout }
      } catch (err) {
        if (err.code === 'NOT_FOUND') return reply.status(404).send({ success: false, message: err.message })
        if (err.code === 'NOTHING_TO_PAY') return reply.status(400).send({ success: false, message: err.message })
        throw err
      }
    },
  })

  fastify.get('/payouts', {
    preHandler: [fastify.authenticate, fastify.requirePermission('settlements.view')],
    handler: async (request) => {
      const { page = 1, limit = 20 } = request.query || {}
      return service.listPayouts({ page: Number(page), limit: Math.min(100, Number(limit)) })
    },
  })

  fastify.post('/payouts/:id/mark-paid', {
    preHandler: [fastify.authenticate, fastify.requirePermission('settlements.manage')],
    handler: async (request, reply) => {
      const payout = await service.markPayoutPaid(request.params.id, {
        utrNumber: request.body?.utrNumber, actorId: request.user?.id,
      })
      if (!payout) return reply.status(404).send({ success: false, message: 'Payout not found' })
      return { success: true, data: payout }
    },
  })
}

/** Vendor routes — mounted at /api/v1/settlements (vendor-scoped) */
export const vendorSettlementsRoutes = async function settlementsVendorRoutes(fastify) {
  fastify.get('/summary', {
    preHandler: [fastify.authenticate, requireVendorScope({ requireVendor: true })],
    handler: async (request) => ({
      success: true,
      data: await service.vendorSummary(request.vendorId),
    }),
  })

  fastify.get('/statement', {
    preHandler: [fastify.authenticate, requireVendorScope({ requireVendor: true })],
    handler: async (request) => {
      const { page = 1, limit = 20, entryType = '' } = request.query || {}
      return service.vendorStatement(request.vendorId, {
        page: Number(page), limit: Math.min(100, Number(limit)), entryType: String(entryType || ''),
      })
    },
  })
}
