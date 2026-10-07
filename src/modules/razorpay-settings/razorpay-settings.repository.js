import { query } from '../../config/database.js'
import { encryptSecret, decryptSecret } from '../../utils/encryption.js'

const CACHE_TTL_MS = 30_000
let cache = { value: undefined, expiresAt: 0 }

const COLUMNS = `
  id, active_mode,
  test_key_id, test_key_secret_encrypted, test_webhook_secret_encrypted,
  test_last_tested_at, test_last_test_status, test_last_test_message,
  live_key_id, live_key_secret_encrypted, live_webhook_secret_encrypted,
  live_last_tested_at, live_last_test_status, live_last_test_message,
  created_at, updated_at, updated_by
`

function prefixFor(mode) {
  return mode === 'PRODUCTION' ? 'live' : 'test'
}

/**
 * Singleton-row repository for `razorpay_settings` (migration 132) — same
 * in-process cache pattern as `ola-maps-settings.repository.js`, but two
 * independent credential sets (TEST/PRODUCTION) in one row instead of one.
 * `key_secret`/`webhook_secret` are encrypted before every write and
 * decrypted only by the `*Decrypted` accessors, which callers must use
 * deliberately — the cached raw row (`get()`) never exposes plaintext.
 */
export class RazorpaySettingsRepository {
  async get() {
    const now = Date.now()
    if (cache.value !== undefined && now < cache.expiresAt) {
      return cache.value
    }
    const { rows } = await query(`SELECT ${COLUMNS} FROM razorpay_settings LIMIT 1`)
    const row = rows[0] || null
    cache = { value: row, expiresAt: now + CACHE_TTL_MS }
    return row
  }

  /**
   * Decrypted credentials for one mode, or null if that mode has no
   * key id / key secret saved yet.
   */
  async getModeCredentialsDecrypted(mode) {
    const row = await this.get()
    if (!row) return null
    const prefix = prefixFor(mode)
    const keyId = row[`${prefix}_key_id`]
    const encSecret = row[`${prefix}_key_secret_encrypted`]
    if (!keyId || !encSecret) return null
    return {
      mode,
      keyId,
      keySecret: decryptSecret(encSecret),
      webhookSecret: row[`${prefix}_webhook_secret_encrypted`]
        ? decryptSecret(row[`${prefix}_webhook_secret_encrypted`])
        : null,
    }
  }

  /** Decrypted credentials for whichever mode is currently active, or null. */
  async getActiveCredentialsDecrypted() {
    const row = await this.get()
    if (!row) return null
    return this.getModeCredentialsDecrypted(row.active_mode)
  }

  /**
   * Partial update of one mode's credential columns.
   * `keyId`/`keySecret`/`webhookSecret` each: omitted -> untouched;
   * empty string -> cleared to NULL; non-empty -> encrypted (secret
   * fields) and stored.
   */
  async saveCredentials(mode, { keyId, keySecret, webhookSecret } = {}, updatedBy = null) {
    const prefix = prefixFor(mode)
    const fields = []
    const params = []
    let idx = 1

    if (keyId !== undefined) {
      fields.push(`${prefix}_key_id = $${idx++}`)
      params.push(keyId === '' ? null : keyId)
    }
    if (keySecret !== undefined) {
      fields.push(`${prefix}_key_secret_encrypted = $${idx++}`)
      params.push(keySecret === '' ? null : encryptSecret(keySecret))
    }
    if (webhookSecret !== undefined) {
      fields.push(`${prefix}_webhook_secret_encrypted = $${idx++}`)
      params.push(webhookSecret === '' ? null : encryptSecret(webhookSecret))
    }
    // A credential edit invalidates whatever the last test proved.
    fields.push(`${prefix}_last_tested_at = NULL`)
    fields.push(`${prefix}_last_test_status = NULL`)
    fields.push(`${prefix}_last_test_message = NULL`)

    fields.push(`updated_by = $${idx++}`)
    params.push(updatedBy)
    fields.push('updated_at = NOW()')

    const { rows } = await query(
      `UPDATE razorpay_settings SET ${fields.join(', ')} RETURNING ${COLUMNS}`,
      params
    )
    this.invalidate()
    return rows[0] || null
  }

  /** Records a Test Connection result for one mode without touching its credentials. */
  async recordTest(mode, { status, message }, updatedBy = null) {
    const prefix = prefixFor(mode)
    const { rows } = await query(
      `UPDATE razorpay_settings
       SET ${prefix}_last_tested_at = NOW(),
           ${prefix}_last_test_status = $1,
           ${prefix}_last_test_message = $2,
           updated_by = $3,
           updated_at = NOW()
       RETURNING ${COLUMNS}`,
      [status, message, updatedBy]
    )
    this.invalidate()
    return rows[0] || null
  }

  async setActiveMode(mode, updatedBy = null) {
    const { rows } = await query(
      `UPDATE razorpay_settings
       SET active_mode = $1, updated_by = $2, updated_at = NOW()
       RETURNING ${COLUMNS}`,
      [mode, updatedBy]
    )
    this.invalidate()
    return rows[0] || null
  }

  invalidate() {
    cache = { value: undefined, expiresAt: 0 }
  }
}
