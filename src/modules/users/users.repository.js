import { query } from '../../config/database.js'

/**
 * Users repository — all database queries for user management
 */
export class UsersRepository {
  /**
   * Find user by ID with full profile fields
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT id, phone, email, name, role, avatar_url, birthday,
              loyalty_points, referral_code, is_active, created_at, updated_at
       FROM users WHERE id = $1`,
      [id]
    )
    return rows[0] || null
  }

  /**
   * Update user profile fields
   * Only updates provided fields (partial update)
   * @param {string} id
   * @param {{ name?: string, email?: string, birthday?: string }} data
   * @returns {Promise<object>}
   */
  async updateProfile(id, data) {
    const fields = []
    const params = []
    let idx = 1

    if (data.name !== undefined) {
      fields.push(`name = $${idx++}`)
      params.push(data.name)
    }
    if (data.email !== undefined) {
      fields.push(`email = $${idx++}`)
      params.push(data.email)
    }
    if (data.birthday !== undefined) {
      fields.push(`birthday = $${idx++}`)
      params.push(data.birthday)
    }

    if (fields.length === 0) return this.findById(id)

    fields.push(`updated_at = NOW()`)
    params.push(id)

    const { rows } = await query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}
       RETURNING id, phone, email, name, role, avatar_url, birthday,
                 loyalty_points, referral_code, created_at, updated_at`,
      params
    )
    return rows[0]
  }

  /**
   * Update user avatar URL
   * @param {string} id
   * @param {string} avatarUrl
   * @returns {Promise<object>}
   */
  async updateAvatar(id, avatarUrl) {
    const { rows } = await query(
      `UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, phone, email, name, role, avatar_url`,
      [avatarUrl, id]
    )
    return rows[0]
  }

  /**
   * Get user stats (order count, total spent, loyalty points)
   * @param {string} userId
   * @returns {Promise<object>}
   */
  async getStats(userId) {
    const { rows } = await query(
      `SELECT
         (SELECT COUNT(*) FROM orders WHERE user_id = $1)::int AS total_orders,
         (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE user_id = $1 AND status = 'DELIVERED') AS total_spent,
         (SELECT loyalty_points FROM users WHERE id = $1) AS loyalty_points`,
      [userId]
    )
    return rows[0] || { total_orders: 0, total_spent: 0, loyalty_points: 0 }
  }

  /**
   * Check if email is already taken by another user
   * @param {string} email
   * @param {string} excludeUserId
   * @returns {Promise<boolean>}
   */
  async isEmailTaken(email, excludeUserId) {
    const { rows } = await query(
      `SELECT id FROM users WHERE email = $1 AND id != $2`,
      [email, excludeUserId]
    )
    return rows.length > 0
  }
}
