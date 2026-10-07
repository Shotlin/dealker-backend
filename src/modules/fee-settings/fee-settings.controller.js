import { success, error } from '../../utils/apiResponse.js'
import { updateFeeSettingsSchema, feePreviewSchema } from './fee-settings.schema.js'

/**
 * Fee Settings controller — thin HTTP layer over FeeSettingsService and
 * the TotalsEngine (for the admin preview calculator).
 */
export class FeeSettingsController {
  /**
   * @param {import('./fee-settings.service.js').FeeSettingsService} service
   * @param {import('../cart/totals-engine.service.js').TotalsEngine} [totalsEngine]
   */
  constructor(service, totalsEngine = null) {
    this.service = service
    this.totalsEngine = totalsEngine
  }

  /** @private */
  _actor(request) {
    return { id: request.user?.id, role: request.user?.role }
  }

  /** @private */
  _formatZodErrors(zodError) {
    return zodError.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
  }

  // GET / — effective global config (or ?shopId= for a store override)
  async get(request, reply) {
    const shopId = request.query?.shopId || request.shopId || null
    if (shopId) {
      const { config, source } = await this.service.resolveForShop(shopId)
      return reply.code(200).send(success(config, 'Fee settings fetched', { source }))
    }
    const config = await this.service.getGlobal()
    return reply.code(200).send(success(config, 'Fee settings fetched', { source: 'GLOBAL' }))
  }

  // PUT / — update the global config
  async updateGlobal(request, reply) {
    const parsed = updateFeeSettingsSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }
    const updated = await this.service.updateGlobal(parsed.data, this._actor(request))
    return reply.code(200).send(success(updated, 'Fee settings updated'))
  }

  // PUT /shops/:shopId — update (upsert) a store override
  async updateShop(request, reply) {
    const { shopId } = request.params
    const parsed = updateFeeSettingsSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }
    const updated = await this.service.updateShop(shopId, parsed.data, this._actor(request))
    return reply.code(200).send(success(updated, 'Shop fee settings updated'))
  }

  // POST /preview — preview the fee breakdown for a subtotal + distance
  async preview(request, reply) {
    const parsed = feePreviewSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }
    if (!this.totalsEngine) {
      return reply.code(503).send(error('Preview engine unavailable', 'FEATURE_DISABLED'))
    }
    const { subtotal, distanceKm, shopId } = parsed.data
    const breakdown = await this.totalsEngine.preview({ subtotal, distanceKm, shopId })
    return reply.code(200).send(success(breakdown, 'Fee preview computed'))
  }
}
