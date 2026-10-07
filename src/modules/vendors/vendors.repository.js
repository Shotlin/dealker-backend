/**
 * Vendor Repository — Data Access Layer for Vendor Domain
 * Source of truth: Blueprint §06.1, Phase 2A
 *
 * @module modules/vendors/vendors.repository
 */

import { query } from '../../config/database.js'

export class VendorsRepository {
  /**
   * Find vendor by ID with profile and settings
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT v.*,
              row_to_json(vp.*) AS profile,
              row_to_json(vs.*) AS settings
         FROM vendors v
         LEFT JOIN vendor_profiles vp ON vp.vendor_id = v.id
         LEFT JOIN vendor_settings vs ON vs.vendor_id = v.id
        WHERE v.id = $1 AND v.deleted_at IS NULL
        LIMIT 1`,
      [id]
    )
    return rows[0] || null
  }

  /**
   * Find vendor by slug
   * @param {string} slug
   * @returns {Promise<object|null>}
   */
  async findBySlug(slug) {
    const { rows } = await query(
      `SELECT * FROM vendors WHERE slug = $1 AND deleted_at IS NULL LIMIT 1`,
      [slug]
    )
    return rows[0] || null
  }

  /**
   * Find vendor by email or phone for duplicate checks
   * @param {string} email
   * @param {string} phone
   * @param {string} [excludeId]
   * @returns {Promise<object|null>}
   */
  async findDuplicate(email, phone, excludeId = null) {
    const { rows } = await query(
      `SELECT id, email, phone FROM vendors
        WHERE (email = $1 OR phone = $2)
          AND ($3::uuid IS NULL OR id != $3)
          AND deleted_at IS NULL
        LIMIT 1`,
      [email, phone, excludeId]
    )
    return rows[0] || null
  }

  /**
   * Insert new vendor record
   * @param {object} data
   * @returns {Promise<object>}
   */
  async create(data) {
    const { name, slug, email, phone, status = 'PENDING_ONBOARDING', is_active = true } = data
    const { rows } = await query(
      `INSERT INTO vendors (name, slug, email, phone, status, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, slug, email, phone, status, is_active]
    )
    const vendor = rows[0]

    // Create default profile and settings records
    await query(`INSERT INTO vendor_profiles (vendor_id) VALUES ($1) ON CONFLICT DO NOTHING`, [vendor.id])
    await query(`INSERT INTO vendor_settings (vendor_id) VALUES ($1) ON CONFLICT DO NOTHING`, [vendor.id])

    return this.findById(vendor.id)
  }

  /**
   * Update vendor record
   * @param {string} id
   * @param {object} data
   * @returns {Promise<object|null>}
   */
  async update(id, data) {
    const fields = []
    const params = [id]
    let idx = 2

    for (const key of ['name', 'slug', 'email', 'phone', 'status', 'is_active']) {
      if (data[key] !== undefined) {
        fields.push(`${key} = $${idx}`)
        params.push(data[key])
        idx++
      }
    }

    if (fields.length === 0) return this.findById(id)

    const { rows } = await query(
      `UPDATE vendors SET ${fields.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      params
    )

    return rows.length > 0 ? this.findById(id) : null
  }

  /**
   * Soft delete vendor
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async softDelete(id) {
    const { rowCount } = await query(
      `UPDATE vendors SET deleted_at = NOW(), is_active = false WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    )
    return rowCount > 0
  }

  /**
   * List / Search vendors with pagination
   * @param {object} params
   * @returns {Promise<{ data: Array, total: number }>}
   */
  async findMany({ page = 1, limit = 20, search = '', status = null, is_active = null }) {
    const offset = (page - 1) * limit
    const conditions = ['v.deleted_at IS NULL']
    const params = []
    let idx = 1

    if (search) {
      conditions.push(`(v.name ILIKE $${idx} OR v.email ILIKE $${idx} OR v.phone ILIKE $${idx})`)
      params.push(`%${search}%`)
      idx++
    }

    if (status) {
      conditions.push(`v.status = $${idx}`)
      params.push(status)
      idx++
    }

    if (is_active !== null && is_active !== undefined) {
      conditions.push(`v.is_active = $${idx}`)
      params.push(is_active)
      idx++
    }

    const whereClause = conditions.join(' AND ')

    const countRes = await query(`SELECT COUNT(*)::int AS total FROM vendors v WHERE ${whereClause}`, params)
    const total = countRes.rows[0]?.total || 0

    const dataRes = await query(
      `SELECT v.*,
              row_to_json(vp.*) AS profile,
              row_to_json(vs.*) AS settings
         FROM vendors v
         LEFT JOIN vendor_profiles vp ON vp.vendor_id = v.id
         LEFT JOIN vendor_settings vs ON vs.vendor_id = v.id
        WHERE ${whereClause}
        ORDER BY v.created_at DESC
        LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    )

    return { data: dataRes.rows, total }
  }

  /**
   * Update vendor profile
   * @param {string} vendorId
   * @param {object} profileData
   * @returns {Promise<object>}
   */
  async updateProfile(vendorId, profileData) {
    const fields = []
    const params = [vendorId]
    let idx = 2

    for (const key of [
      'legal_name', 'trade_license_number', 'gstin', 'fssai_license', 'pan_number',
      'address_line1', 'address_line2', 'city', 'state', 'pincode', 'latitude', 'longitude', 'metadata'
    ]) {
      if (profileData[key] !== undefined) {
        fields.push(`${key} = $${idx}`)
        params.push(key === 'metadata' ? JSON.stringify(profileData[key]) : profileData[key])
        idx++
      }
    }

    if (fields.length > 0) {
      await query(
        `INSERT INTO vendor_profiles (vendor_id, ${fields.map(f => f.split(' = ')[0]).join(', ')})
         VALUES ($1, ${fields.map((_, i) => `$${i + 2}`).join(', ')})
         ON CONFLICT (vendor_id) DO UPDATE SET ${fields.join(', ')}`,
        params
      )
    }

    return this.findById(vendorId)
  }

  /**
   * Update vendor settings
   * @param {string} vendorId
   * @param {object} settingsData
   * @returns {Promise<object>}
   */
  async updateSettings(vendorId, settingsData) {
    const fields = []
    const params = [vendorId]
    let idx = 2

    for (const key of [
      'auto_accept_orders', 'commission_rate', 'payout_schedule',
      'notification_email', 'notification_phone', 'operating_hours'
    ]) {
      if (settingsData[key] !== undefined) {
        fields.push(`${key} = $${idx}`)
        params.push(key === 'operating_hours' ? JSON.stringify(settingsData[key]) : settingsData[key])
        idx++
      }
    }

    if (fields.length > 0) {
      await query(
        `INSERT INTO vendor_settings (vendor_id, ${fields.map(f => f.split(' = ')[0]).join(', ')})
         VALUES ($1, ${fields.map((_, i) => `$${i + 2}`).join(', ')})
         ON CONFLICT (vendor_id) DO UPDATE SET ${fields.join(', ')}`,
        params
      )
    }

    return this.findById(vendorId)
  }
}
