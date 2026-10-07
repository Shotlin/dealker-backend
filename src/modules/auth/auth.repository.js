import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'

/**
 * Auth repository — all user-related database queries for authentication
 */
export class AuthRepository {
  /**
   * Find user by phone number
   * @param {string} phone
   * @returns {Promise<object|null>}
   */
  async findByPhone(phone) {
    const { rows } = await query(
      `SELECT id, phone, email, name, role, avatar_url, is_active, created_at
       FROM users WHERE phone = $1`,
      [phone]
    )
    return rows[0] || null
  }

  /**
   * Find user by ID
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT id, phone, email, name, role, avatar_url, is_active, created_at
       FROM users WHERE id = $1`,
      [id]
    )
    return rows[0] || null
  }

  /**
   * Create a new user with phone number
   * @param {string} phone
   * @returns {Promise<object>}
   */
  async createUser(phone, role = 'CUSTOMER') {
    const referralCode = this._generateReferralCode()
    const { rows } = await query(
      `INSERT INTO users (phone, role, referral_code)
       VALUES ($1, $2, $3)
       RETURNING id, phone, name, role, is_active, created_at`,
      [phone, role, referralCode]
    )
    return rows[0]
  }

  /**
   * Update a user's role
   * @param {string} userId
   * @param {string} role
   */
  async updateRole(userId, role) {
    await query(
      `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2`,
      [role, userId]
    )
  }

  /**
   * Ensure a rider_profile row exists for this user.
   * Creates one if missing (is_approved defaults to false for admin review,
   * unless the caller passes isApproved: true — e.g. demo-OTP riders).
   * If a profile already exists and isApproved is true, flips it to approved
   * (never demotes an already-approved profile back to false here).
   * @param {string} userId
   * @param {{ isApproved?: boolean }} [options]
   */
  async ensureRiderProfile(userId, { isApproved = false } = {}) {
    const { rows } = await query(
      `SELECT id, is_approved FROM rider_profiles WHERE user_id = $1`,
      [userId]
    )
    if (rows.length === 0) {
      await query(
        `INSERT INTO rider_profiles (user_id, is_approved, is_online)
         VALUES ($1, $2, false)`,
        [userId, !!isApproved]
      )
      return
    }
    if (isApproved && !rows[0].is_approved) {
      await query(
        `UPDATE rider_profiles SET is_approved = true, updated_at = NOW() WHERE user_id = $1`,
        [userId]
      )
    }
  }

  /**
   * Get rider profile for a user
   * @param {string} userId
   * @returns {Promise<object|null>}
   */
  async getRiderProfile(userId) {
    const { rows } = await query(
      `SELECT * FROM rider_profiles WHERE user_id = $1`,
      [userId]
    )
    return rows[0] || null
  }

  /**
   * Update user's FCM push token
   * @param {string} userId
   * @param {string} fcmToken
   */
  async updateFcmToken(userId, fcmToken) {
    await query(
      `UPDATE users SET fcm_token = $1, updated_at = NOW() WHERE id = $2`,
      [fcmToken, userId]
    )
  }

  /**
   * Soft-delete user account (set is_active = false, clear PII)
   * @param {string} userId
   */
  async deleteUser(userId) {
    await query(
      `UPDATE users
       SET is_active = false,
           name = NULL,
           email = NULL,
           avatar_url = NULL,
           fcm_token = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [userId]
    )
  }

  /**
   * Generate a unique 8-char referral code
   */
  _generateReferralCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    let code = ''
    for (let i = 0; i < 8; i++) {
      code += chars[Math.floor(Math.random() * chars.length)]
    }
    return code
  }

  /**
   * Find all active shop_staff records for a user.
   * "Active" means: shop_staff.is_active = true, shop_staff.deleted_at IS NULL,
   *                 the parent shop is_active = true and deleted_at IS NULL.
   * Joins shops in a single query to avoid N+1 lookups.
   *
   * Used by:
   *   - login flow (decide auto-scope vs require selection) — Requirement 13.1, 13.2, 13.3, 13.4
   *   - select-shop endpoint (validate selection)               — Requirement 2.8
   *
   * @param {string} userId
   * @returns {Promise<Array<{shop_staff_id, shop_id, shop_name, role, permissions}>>}
   */
  /**
   * Active vendor memberships for a user (vendor app login: vendor-scoped JWT).
   */
  async findActiveVendorUsersByUserId(userId) {
    const { rows } = await query(
      `SELECT vu.vendor_id, vu.role
         FROM vendor_users vu
         JOIN vendors v ON v.id = vu.vendor_id
        WHERE vu.user_id = $1
          AND vu.is_active = true
          AND vu.deleted_at IS NULL
          AND v.is_active = true
          AND v.deleted_at IS NULL
        ORDER BY vu.created_at`,
      [userId]
    )
    return rows
  }

  async findActiveShopStaffByUserId(userId) {
    const { rows } = await query(
      `SELECT
         ss.id          AS shop_staff_id,
         ss.shop_id     AS shop_id,
         s.name         AS shop_name,
         ss.role        AS role,
         ss.permissions AS permissions
       FROM shop_staff ss
       JOIN shops s ON s.id = ss.shop_id
      WHERE ss.user_id    = $1
        AND ss.is_active  = true
        AND ss.deleted_at IS NULL
        AND s.is_active   = true
        AND s.deleted_at  IS NULL
      ORDER BY s.created_at ASC`,
      [userId]
    )
    return rows
  }

  /**
   * Find a single active shop_staff record for a (user_id, shop_id) pair.
   * Used by select-shop to validate a user's access to the requested shop.
   * Requirement 2.8, 13.2
   *
   * @param {string} userId
   * @param {string} shopId
   * @returns {Promise<{shop_staff_id, shop_id, shop_name, role, permissions}|null>}
   */
  async findActiveShopStaffByUserAndShop(userId, shopId) {
    const { rows } = await query(
      `SELECT
         ss.id          AS shop_staff_id,
         ss.shop_id     AS shop_id,
         s.name         AS shop_name,
         ss.role        AS role,
         ss.permissions AS permissions
       FROM shop_staff ss
       JOIN shops s ON s.id = ss.shop_id
      WHERE ss.user_id    = $1
        AND ss.shop_id    = $2
        AND ss.is_active  = true
        AND ss.deleted_at IS NULL
        AND s.is_active   = true
        AND s.deleted_at  IS NULL
      LIMIT 1`,
      [userId, shopId]
    )
    return rows[0] || null
  }
}
