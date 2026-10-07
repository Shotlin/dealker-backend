import { query, getClient } from '../../config/database.js'

/**
 * Addresses repository — all SQL queries for delivery addresses
 */
export class AddressesRepository {
  /**
   * Get all addresses for a user
   */
  async findByUser(userId) {
    const { rows } = await query(
      `SELECT id, label, address_line1, address_line2, landmark, city, state, pincode,
              lat, lng, is_default, created_at
       FROM addresses
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY is_default DESC, created_at DESC`,
      [userId]
    )
    return rows.map(this._format)
  }

  /**
   * Find a single address by ID + user ownership check. Excludes
   * soft-deleted rows so a removed address can no longer be selected at
   * checkout or edited while it sits in its retention window.
   */
  async findByIdAndUser(id, userId) {
    const { rows } = await query(
      `SELECT id, label, address_line1, address_line2, landmark, city, state, pincode,
              lat, lng, is_default, created_at, updated_at
       FROM addresses
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Create a new address
   */
  async create(userId, data) {
    const { rows } = await query(
      `INSERT INTO addresses (user_id, label, address_line1, address_line2, landmark, city, state, pincode, lat, lng, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, label, address_line1, address_line2, landmark, city, state, pincode, lat, lng, is_default, created_at`,
      [
        userId,
        data.label || 'Home',
        data.addressLine1,
        data.addressLine2 || null,
        data.landmark || null,
        data.city,
        data.state || null,
        data.pincode,
        data.lat || null,
        data.lng || null,
        data.isDefault || false,
      ]
    )
    return this._format(rows[0])
  }

  /**
   * Update an address
   */
  async update(id, userId, data) {
    const fields = []
    const params = []
    let idx = 1

    const fieldMap = {
      label: 'label',
      addressLine1: 'address_line1',
      addressLine2: 'address_line2',
      landmark: 'landmark',
      city: 'city',
      state: 'state',
      pincode: 'pincode',
      lat: 'lat',
      lng: 'lng',
    }

    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbKey} = $${idx++}`)
        params.push(data[jsKey])
      }
    }

    if (fields.length === 0) return this.findByIdAndUser(id, userId)

    fields.push(`updated_at = NOW()`)
    params.push(id, userId)

    const { rows } = await query(
      `UPDATE addresses SET ${fields.join(', ')}
       WHERE id = $${idx} AND user_id = $${idx + 1} AND deleted_at IS NULL
       RETURNING id, label, address_line1, address_line2, landmark, city, state, pincode, lat, lng, is_default, created_at, updated_at`,
      params
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Soft-delete an address. The row is kept (with `deleted_at` set) for a
   * retention window — for delivery-dispute/security review against past
   * orders — and only hard-deleted later by the purge cron
   * (see `purgeDeletedOlderThan`). A soft-deleted address also loses
   * `is_default` immediately so it can't linger as the (invisible)
   * checkout default.
   */
  async delete(id, userId) {
    const result = await query(
      `UPDATE addresses SET deleted_at = NOW(), is_default = false, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId]
    )
    return result.rowCount > 0
  }

  /**
   * Permanently remove addresses whose retention window has elapsed.
   * Called by the daily purge cron. Returns the number of rows removed.
   */
  async purgeDeletedOlderThan(days) {
    const result = await query(
      `DELETE FROM addresses WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - ($1 || ' days')::interval`,
      [days]
    )
    return result.rowCount
  }

  /**
   * Set an address as default (unset all others first — transaction).
   * Scoped to non-deleted rows so a soft-deleted address can never be
   * promoted back to default.
   */
  async setDefault(id, userId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE addresses SET is_default = false, updated_at = NOW() WHERE user_id = $1 AND deleted_at IS NULL`,
        [userId]
      )
      const { rows } = await client.query(
        `UPDATE addresses SET is_default = true, updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING id, label, address_line1, address_line2, landmark, city, state, pincode, lat, lng, is_default, created_at, updated_at`,
        [id, userId]
      )
      await client.query('COMMIT')
      return rows[0] ? this._format(rows[0]) : null
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Count addresses for a user
   */
  async countByUser(userId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count FROM addresses WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId]
    )
    return rows[0].count
  }

  /**
   * Format snake_case DB row to camelCase JS
   */
  _format(row) {
    return {
      id:           row.id,
      label:        row.label,
      addressLine1: row.address_line1,
      addressLine2: row.address_line2,
      landmark:     row.landmark,
      city:         row.city,
      state:        row.state,
      pincode:      row.pincode,
      lat:          row.lat ? parseFloat(row.lat) : null,
      lng:          row.lng ? parseFloat(row.lng) : null,
      isDefault:    row.is_default,
      createdAt:    row.created_at,
      updatedAt:    row.updated_at,
    }
  }
}
