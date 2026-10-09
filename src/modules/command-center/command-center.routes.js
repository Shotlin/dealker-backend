/**
 * Command-centre route — GET /api/v1/admin/command-center?period=today|week|month|year
 *
 * @module modules/command-center/command-center.routes
 */

import { CommandCenterService, PERIODS } from './command-center.service.js'

const service = new CommandCenterService()

export const adminCommandCenterRoutes = async function commandCenterRoutes(fastify) {
  fastify.get('/', {
    preHandler: [fastify.authenticate, fastify.requirePermission('dashboard.view')],
    handler: async (request, reply) => {
      const period = String(request.query?.period || 'week')
      if (!PERIODS.includes(period)) return reply.status(400).send({ success: false, message: `period must be one of ${PERIODS.join(', ')}`, code: 'VALIDATION' })
      return { success: true, data: await service.build(period, { io: fastify.io }) }
    },
  })
}
