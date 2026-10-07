/**
 * Referrals routes — customer + admin surfaces.
 *
 * @module modules/referrals/referrals.routes
 */

import { ReferralsService } from './referrals.service.js'

const service = new ReferralsService()

/** Customer routes — mounted at /api/v1/referrals */
export const referralsRoutes = async function referralRoutes(fastify) {
  // My code + referred users + rewards
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    handler: async (request) => ({ success: true, data: await service.myReferrals(request.user.id) }),
  })

  // Attribute a signup to a referrer (called at registration with ?ref=CODE)
  fastify.post('/claim', {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      const { code } = request.body || {}
      if (!code) return reply.status(400).send({ success: false, message: 'code is required' })
      const result = await service.claimCode(request.user.id, code)
      if (!result.claimed) {
        return reply.status(400).send({ success: false, message: result.reason, data: result })
      }
      return { success: true, data: result.referral }
    },
  })
}

/** Admin routes — mounted at /api/v1/admin/referrals */
export const referralsAdminRoutes = async function referralAdminRoutes(fastify) {
  fastify.get('/settings', {
    preHandler: [fastify.authenticate, fastify.requirePermission('referrals.view')],
    handler: async () => ({ success: true, data: await service.getSettings() }),
  })

  fastify.put('/settings', {
    preHandler: [fastify.authenticate, fastify.requirePermission('referral_settings.manage')],
    handler: async (request) => ({
      success: true,
      data: await service.updateSettings(request.body || {}, request.user?.id),
    }),
  })

  fastify.get('/', {
    preHandler: [fastify.authenticate, fastify.requirePermission('referrals.view')],
    handler: async (request) => {
      const { page = 1, limit = 20, status = '', search = '' } = request.query || {}
      return service.adminList({
        page: Number(page), limit: Math.min(100, Number(limit)),
        status: String(status || ''), search: String(search || ''),
      })
    },
  })
}
