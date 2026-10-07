/**
 * Vendor Staff Repository — Data Access Layer for Vendor Staff & Invitations
 * Source of truth: Blueprint §06.1, Phase 2C
 *
 * @module modules/vendors/vendor-staff.repository
 */

import { query } from '../../config/database.js'

export class VendorStaffRepository {
  /**
   * Find staff membership by vendorId & userId
   * @param {string} vendorId
   * @param {string} userId
   * @returns {Promise<object|null>}
   */
  async findMembership(vendorId, userId) {
    const { rows } = await query(
      `SELECT vu.*, u.email, u.name, u.phone
         FROM vendor_users vu
         JOIN users u ON u.id = vu.user_id
        WHERE vu.vendor_id = $1 AND vu.user_id = $2 AND vu.deleted_at IS NULL
        LIMIT 1`,
      [vendorId, userId]
    )
    return rows[0] || null
  }

  /**
   * Insert new vendor staff membership
   * @param {object} data
   * @returns {Promise<object>}
   */
  async createMembership({ vendorId, userId, role = 'VENDOR_OPERATOR' }) {
    const { rows } = await query(
      `INSERT INTO vendor_users (vendor_id, user_id, role, is_active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (vendor_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, is_active = true, deleted_at = NULL, updated_at = NOW()
       RETURNING *`,
      [vendorId, userId, role]
    )
    return rows[0]
  }

  /**
   * Update staff membership (role / is_active / soft delete)
   * @param {string} vendorId
   * @param {string} userId
   * @param {object} updates
   * @returns {Promise<object|null>}
   */
  async updateMembership(vendorId, userId, updates) {
    const fields = []
    const params = [vendorId, userId]
    let idx = 3

    if (updates.role !== undefined) {
      fields.push(`role = $${idx}`)
      params.push(updates.role)
      idx++
    }
    if (updates.is_active !== undefined) {
      fields.push(`is_active = $${idx}`)
      params.push(updates.is_active)
      idx++
    }
    if (updates.deleted_at !== undefined) {
      fields.push(`deleted_at = $${idx}`)
      params.push(updates.deleted_at)
      idx++
    }

    if (fields.length === 0) return this.findMembership(vendorId, userId)

    const { rows } = await query(
      `UPDATE vendor_users SET ${fields.join(', ')} WHERE vendor_id = $1 AND user_id = $2 RETURNING *`,
      params
    )
    return rows[0] || null
  }

  /**
   * List staff memberships for vendor
   * @param {string} vendorId
   * @returns {Promise<Array>}
   */
  async listStaff(vendorId) {
    const { rows } = await query(
      `SELECT vu.*, u.email, u.name, u.phone
         FROM vendor_users vu
         JOIN users u ON u.id = vu.user_id
        WHERE vu.vendor_id = $1 AND vu.deleted_at IS NULL
        ORDER BY vu.created_at ASC`,
      [vendorId]
    )
    return rows
  }

  /**
   * Create invitation
   * @param {object} invData
   * @returns {Promise<object>}
   */
  async createInvitation({ vendorId, email, role, token, invitedBy, expiresAt }) {
    const { rows } = await query(
      `INSERT INTO vendor_invitations (vendor_id, email, role, token, status, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, 'PENDING', $5, $6)
       RETURNING *`,
      [vendorId, email, role, token, invitedBy, expiresAt]
    )
    return rows[0]
  }

  /**
   * Find invitation by token
   * @param {string} token
   * @returns {Promise<object|null>}
   */
  async findInvitationByToken(token) {
    const { rows } = await query(
      `SELECT * FROM vendor_invitations WHERE token = $1 LIMIT 1`,
      [token]
    )
    return rows[0] || null
  }

  /**
   * Update invitation status
   * @param {string} id
   * @param {string} status
   * @returns {Promise<object>}
   */
  async updateInvitationStatus(id, status) {
    const { rows } = await query(
      `UPDATE vendor_invitations SET status = $2 WHERE id = $1 RETURNING *`,
      [id, status]
    )
    return rows[0]
  }

  /**
   * Log membership audit action
   * @param {object} auditData
   * @returns {Promise<object>}
   */
  async logAudit({ vendorId, userId = null, actorId = null, action, oldRole = null, newRole = null }) {
    const { rows } = await query(
      `INSERT INTO vendor_membership_audits (vendor_id, user_id, actor_id, action, old_role, new_role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [vendorId, userId, actorId, action, oldRole, newRole]
    )
    return rows[0]
  }
}
