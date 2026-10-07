import { query } from '../../config/database.js'

/**
 * Fee Settings repository — canonical fee configuration store.
 *
 * Backed by the `fee_settings` table (migration 055). Holds one GLOBAL row
 * plus optional per-shop STORE rows. All columns are named explicitly
 * (never SELECT *) per project standards.
 */

const COLUMNS = `
  id, scope, shop_id, is_active,
  delivery_fee_enabled, min_delivery_fee, base_distance_km, per_km_fee,
  max_delivery_distance_km, free_delivery_enabled, free_delivery_above,
  handling_fee_enabled, handling_fee_type, handling_fee_value,
  handling_fee_label, handling_fee_description,
  platform_fee_enabled, platform_fee_type, platform_fee_value,
  platform_fee_label, platform_fee_description,
  small_cart_fee_enabled, small_cart_threshold, small_cart_fee,
  small_cart_fee_label, small_cart_fee_description,
  surge_fee_enabled, surge_fee_value, surge_fee_label, surge_fee_description,
  packaging_fee_enabled, packaging_fee_value, packaging_fee_label,
  packaging_fee_description,
  delivery_eta_minutes,
  quick_delivery_surcharge_enabled, quick_delivery_surcharge_amount,
  quick_delivery_surcharge_label, quick_delivery_eta_minutes,
  gst_enabled, gst_rate, gst_label,
  created_at, updated_at, updated_by
`

// Columns the admin may update (scope/shop_id/id/audit are managed by the service).
const UPDATABLE_COLUMNS = [
  'is_active',
  'delivery_fee_enabled',
  'min_delivery_fee',
  'base_distance_km',
  'per_km_fee',
  'max_delivery_distance_km',
  'free_delivery_enabled',
  'free_delivery_above',
  'handling_fee_enabled',
  'handling_fee_type',
  'handling_fee_value',
  'handling_fee_label',
  'handling_fee_description',
  'platform_fee_enabled',
  'platform_fee_type',
  'platform_fee_value',
  'platform_fee_label',
  'platform_fee_description',
  'small_cart_fee_enabled',
  'small_cart_threshold',
  'small_cart_fee',
  'small_cart_fee_label',
  'small_cart_fee_description',
  'surge_fee_enabled',
  'surge_fee_value',
  'surge_fee_label',
  'surge_fee_description',
  'packaging_fee_enabled',
  'packaging_fee_value',
  'packaging_fee_label',
  'packaging_fee_description',
  'delivery_eta_minutes',
  'quick_delivery_surcharge_enabled',
  'quick_delivery_surcharge_amount',
  'quick_delivery_surcharge_label',
  'quick_delivery_eta_minutes',
  'gst_enabled',
  'gst_rate',
  'gst_label',
]

const NUMERIC_COLUMNS = new Set([
  'min_delivery_fee',
  'base_distance_km',
  'per_km_fee',
  'max_delivery_distance_km',
  'free_delivery_above',
  'handling_fee_value',
  'platform_fee_value',
  'small_cart_threshold',
  'small_cart_fee',
  'surge_fee_value',
  'packaging_fee_value',
  'quick_delivery_surcharge_amount',
  'gst_rate',
])

export class FeeSettingsRepository {
  /** Fetch the single GLOBAL config row. */
  async getGlobal() {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM fee_settings WHERE scope = 'GLOBAL' LIMIT 1`
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /** Fetch a STORE config row for a shop (null when none configured). */
  async getByShop(shopId) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM fee_settings WHERE scope = 'STORE' AND shop_id = $1 LIMIT 1`,
      [shopId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Resolve the effective config for a shop: the STORE row when present and
   * active, otherwise the GLOBAL row. Returns `{ config, source }`.
   */
  async resolveForShop(shopId) {
    if (shopId) {
      const store = await this.getByShop(shopId)
      if (store && store.is_active) {
        return { config: store, source: 'STORE' }
      }
    }
    const global = await this.getGlobal()
    return { config: global, source: 'GLOBAL' }
  }

  /** Update the GLOBAL row, returning the fresh row. */
  async updateGlobal(data, updatedBy = null) {
    return this._update({ scope: 'GLOBAL', shopId: null, data, updatedBy })
  }

  /**
   * Upsert a STORE row for a shop. Creates the row (seeded from the partial
   * payload over table defaults) when absent, otherwise updates in place.
   */
  async upsertShop(shopId, data, updatedBy = null) {
    const existing = await this.getByShop(shopId)
    if (!existing) {
      await query(
        `INSERT INTO fee_settings (scope, shop_id, updated_by) VALUES ('STORE', $1, $2)`,
        [shopId, updatedBy]
      )
    }
    return this._update({ scope: 'STORE', shopId, data, updatedBy })
  }

  /** @private build + run a parameterized UPDATE for global or store scope. */
  async _update({ scope, shopId, data, updatedBy }) {
    const fields = []
    const params = []
    let idx = 1

    for (const key of UPDATABLE_COLUMNS) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        fields.push(`${key} = $${idx++}`)
        params.push(data[key])
      }
    }

    fields.push(`updated_by = $${idx++}`)
    params.push(updatedBy)
    fields.push('updated_at = NOW()')

    let where
    if (scope === 'GLOBAL') {
      where = `scope = 'GLOBAL'`
    } else {
      where = `scope = 'STORE' AND shop_id = $${idx++}`
      params.push(shopId)
    }

    const { rows } = await query(
      `UPDATE fee_settings SET ${fields.join(', ')} WHERE ${where} RETURNING ${COLUMNS}`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /** @private coerce DECIMAL strings to numbers for safe arithmetic. */
  _format(row) {
    const out = { ...row }
    for (const col of NUMERIC_COLUMNS) {
      if (out[col] === null || out[col] === undefined) continue
      const parsed = Number(out[col])
      out[col] = Number.isFinite(parsed) ? parsed : 0
    }
    out.delivery_eta_minutes = Number(out.delivery_eta_minutes) || 0
    out.quick_delivery_eta_minutes = Number(out.quick_delivery_eta_minutes) || 0
    return out
  }
}
