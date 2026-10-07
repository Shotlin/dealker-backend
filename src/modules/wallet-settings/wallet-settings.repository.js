import { query } from '../../config/database.js'

/**
 * Wallet Settings repository — thin read/write access into the generic
 * `app_settings` key/value table for the keys that cap wallet balances and
 * wallet-to-wallet transfers.
 */
export class WalletSettingsRepository {
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

  async upsert(key, value) {
    const { rows } = await query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = $2::jsonb, updated_at = NOW()
       RETURNING key, value, updated_at`,
      [key, JSON.stringify(value)]
    )
    return rows[0]
  }
}
