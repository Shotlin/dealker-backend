import { FeeSettingsRepository } from './fee-settings.repository.js'
import { logger } from '../../config/logger.js'
import { cacheDeletePattern } from '../../utils/cache.js'

/**
 * Fee Settings service — read/write the canonical fee configuration.
 *
 * Business rules live here; the repository is pure SQL. The TotalsEngine
 * (separate module) consumes `resolveForShop()` to compute bills so config
 * reads stay in one place.
 */
export class FeeSettingsService {
  constructor(repository = new FeeSettingsRepository()) {
    this.repo = repository
  }

  /** Return the GLOBAL config, or a safe in-memory default if the row is missing. */
  async getGlobal() {
    const config = await this.repo.getGlobal()
    return config || this._safeDefault()
  }

  /** Resolve the effective config for a shop (STORE override → GLOBAL fallback). */
  async resolveForShop(shopId) {
    const { config, source } = await this.repo.resolveForShop(shopId)
    return { config: config || this._safeDefault(), source: config ? source : 'DEFAULT' }
  }

  /** Update the GLOBAL config. */
  async updateGlobal(data, actor = null) {
    const updated = await this.repo.updateGlobal(data, actor?.id || null)

    // The public GET /theme/tabs response embeds delivery_eta_minutes from
    // this GLOBAL config (see public.controller.js#getTabThemes) and caches
    // it for 300s — without this, an admin's change here wouldn't reach the
    // app's home screen for up to 5 minutes.
    await cacheDeletePattern('bakaloo:tab_manifest:*')
    await cacheDeletePattern('bakaloo:tab_home:*')

    logger.info(
      { userId: actor?.id || null, action: 'fee_settings_updated', scope: 'GLOBAL' },
      'Fee settings updated'
    )
    return updated || this._safeDefault()
  }

  /** Update (upsert) a STORE config for a shop. */
  async updateShop(shopId, data, actor = null) {
    const updated = await this.repo.upsertShop(shopId, data, actor?.id || null)
    logger.info(
      { userId: actor?.id || null, action: 'fee_settings_updated', scope: 'STORE', shopId },
      'Shop fee settings updated'
    )
    return updated
  }

  /**
   * Safe default used when the GLOBAL row is somehow missing — checkout must
   * never crash on a missing config. Mirrors the migration 055 defaults.
   * @private
   */
  _safeDefault() {
    return {
      id: null,
      scope: 'GLOBAL',
      shop_id: null,
      is_active: true,
      delivery_fee_enabled: true,
      min_delivery_fee: 20,
      base_distance_km: 1.5,
      per_km_fee: 8,
      max_delivery_distance_km: null,
      free_delivery_enabled: true,
      free_delivery_above: 299,
      handling_fee_enabled: true,
      handling_fee_type: 'FLAT',
      handling_fee_value: 5,
      handling_fee_label: 'Handling fee',
      handling_fee_description: 'Covers packing and order handling.',
      platform_fee_enabled: true,
      platform_fee_type: 'FLAT',
      platform_fee_value: 5,
      platform_fee_label: 'Platform fee',
      platform_fee_description: 'Supports platform operations and support.',
      small_cart_fee_enabled: false,
      small_cart_threshold: 99,
      small_cart_fee: 0,
      small_cart_fee_label: 'Small cart fee',
      small_cart_fee_description:
        'Applied to small orders below the minimum cart value.',
      surge_fee_enabled: false,
      surge_fee_value: 0,
      surge_fee_label: 'Surge fee',
      surge_fee_description:
        'Temporary surcharge during high demand or bad weather.',
      packaging_fee_enabled: false,
      packaging_fee_value: 0,
      packaging_fee_label: 'Packaging fee',
      packaging_fee_description: 'Covers eco-friendly packaging materials.',
      delivery_eta_minutes: 30,
      quick_delivery_surcharge_enabled: false,
      quick_delivery_surcharge_amount: 0,
      quick_delivery_surcharge_label: 'Quick delivery fee',
      quick_delivery_eta_minutes: 15,
      gst_enabled: false,
      gst_rate: 18,
      gst_label: 'GST',
    }
  }
}
