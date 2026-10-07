import { query } from '../../config/database.js'

/**
 * Payment Settings repository — thin read access into the generic
 * `app_settings` key/value table for the keys that gate payment methods
 * (COD / Razorpay / Wallet enablement + COD min/max amount).
 *
 * Writes still go through the existing admin settings endpoint
 * (`AdminRepository#updateSetting`) which already upserts arbitrary keys —
 * this repository only adds a read path other modules (cart, orders,
 * wallet, payments) can use without depending on the `admin` module.
 */
export class PaymentSettingsRepository {
  async getMany(keys) {
    const { rows } = await query(
      `SELECT key, value FROM app_settings WHERE key = ANY($1)`,
      [keys]
    )
    return rows.reduce((acc, row) => {
      acc[row.key] = row.value
      return acc
    }, {})
  }
}
