import { query } from '../../config/database.js'
import { encryptSecret, decryptSecret } from '../../utils/encryption.js'

const COLUMNS = `id, api_email, api_password_encrypted, pickup_location, delivery_partner, simulation_mode,
  last_tested_at, last_test_status, last_test_message, updated_at, updated_by`

let partnerCache = { value: undefined, expiresAt: 0 }

/** Which partner delivers new orders right now. Cached 10s; fails open to OWN_RIDERS. */
export async function getDeliveryPartner() {
  const now = Date.now()
  if (partnerCache.value !== undefined && now < partnerCache.expiresAt) return partnerCache.value
  try {
    const { rows } = await query('SELECT delivery_partner FROM shiprocket_settings LIMIT 1')
    partnerCache = { value: rows[0]?.delivery_partner || 'OWN_RIDERS', expiresAt: now + 10_000 }
  } catch {
    return 'OWN_RIDERS'
  }
  return partnerCache.value
}

/** Singleton-row repository for `shiprocket_settings` (migration 149). */
export class ShiprocketRepository {
  async get() {
    const { rows } = await query(`SELECT ${COLUMNS} FROM shiprocket_settings LIMIT 1`)
    return rows[0] || null
  }

  /** Decrypted API credentials, or null when email/password are not saved. */
  async getCredentialsDecrypted() {
    const row = await this.get()
    if (!row?.api_email || !row.api_password_encrypted) return null
    return {
      email: row.api_email,
      password: decryptSecret(row.api_password_encrypted),
      pickupLocation: row.pickup_location,
    }
  }

  /** Omitted -> untouched; empty string -> cleared. Any edit clears the last test. */
  async save({ email, password, pickupLocation, deliveryPartner, simulationMode } = {}, updatedBy = null) {
    const fields = []
    const params = []
    let i = 1
    if (email !== undefined) { fields.push(`api_email = $${i++}`); params.push(email === '' ? null : email) }
    if (password !== undefined) {
      fields.push(`api_password_encrypted = $${i++}`)
      params.push(password === '' ? null : encryptSecret(password))
    }
    if (pickupLocation !== undefined) {
      fields.push(`pickup_location = $${i++}`)
      params.push(pickupLocation === '' ? null : pickupLocation)
    }
    if (deliveryPartner !== undefined) {
      fields.push(`delivery_partner = $${i++}`)
      params.push(deliveryPartner)
      partnerCache = { value: undefined, expiresAt: 0 }
    }
    if (simulationMode !== undefined) {
      fields.push(`simulation_mode = $${i++}`)
      params.push(Boolean(simulationMode))
    }
    if (email !== undefined || password !== undefined) {
      fields.push('last_tested_at = NULL', 'last_test_status = NULL', 'last_test_message = NULL')
    }
    fields.push(`updated_by = $${i++}`, 'updated_at = NOW()')
    params.push(updatedBy)
    const { rows } = await query(
      `UPDATE shiprocket_settings SET ${fields.join(', ')} RETURNING ${COLUMNS}`,
      params
    )
    return rows[0] || null
  }

  async recordTest({ status, message }, updatedBy = null) {
    const { rows } = await query(
      `UPDATE shiprocket_settings
       SET last_tested_at = NOW(), last_test_status = $1, last_test_message = $2,
           updated_by = $3, updated_at = NOW()
       RETURNING ${COLUMNS}`,
      [status, message, updatedBy]
    )
    return rows[0] || null
  }
}
