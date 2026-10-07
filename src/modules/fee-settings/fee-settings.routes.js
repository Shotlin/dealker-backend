import { FeeSettingsController } from './fee-settings.controller.js'
import { FeeSettingsService } from './fee-settings.service.js'
import { FeeSettingsRepository } from './fee-settings.repository.js'
import { TotalsEngine } from '../cart/totals-engine.service.js'

/**
 * Fee Settings admin routes plugin.
 * Prefix: /api/v1/admin/fee-settings
 *
 * All routes require admin auth. Provides:
 *   GET    /                  — fetch effective config (?shopId= optional)
 *   PUT    /                  — update the GLOBAL config
 *   PUT    /shops/:shopId      — upsert a per-shop override
 *   POST   /preview            — preview a fee breakdown (calculator)
 */
export default async function feeSettingsRoutes(fastify) {
  const repository = new FeeSettingsRepository()
  const service = new FeeSettingsService(repository)
  const totalsEngine = new TotalsEngine({ feeSettingsService: service })
  const controller = new FeeSettingsController(service, totalsEngine)
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/', {
    schema: { tags: ['Fee Settings'], summary: 'Get effective fee settings' },
    preHandler: adminAuth,
  }, controller.get.bind(controller))

  fastify.put('/', {
    schema: { tags: ['Fee Settings'], summary: 'Update global fee settings' },
    preHandler: adminAuth,
  }, controller.updateGlobal.bind(controller))

  fastify.put('/shops/:shopId', {
    schema: {
      tags: ['Fee Settings'],
      summary: 'Update per-shop fee settings',
      params: {
        type: 'object',
        required: ['shopId'],
        properties: { shopId: { type: 'string', format: 'uuid' } },
      },
    },
    preHandler: adminAuth,
  }, controller.updateShop.bind(controller))

  fastify.post('/preview', {
    schema: { tags: ['Fee Settings'], summary: 'Preview fee breakdown' },
    preHandler: adminAuth,
  }, controller.preview.bind(controller))
}
