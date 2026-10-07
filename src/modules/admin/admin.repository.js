import { query, getClient } from '../../config/database.js'

/**
 * Admin repository — database access for admin operations
 */
export class AdminRepository {
  // ─── DASHBOARD ──────────────────────────────────────

  async getDashboardStats() {
    const [users, orders, revenue, products, riders, todayOrders] = await Promise.all([
      query('SELECT COUNT(*) as total FROM users'),
      query('SELECT COUNT(*) as total FROM orders'),
      query("SELECT COALESCE(SUM(total_amount), 0) as total FROM orders WHERE payment_status = 'PAID'"),
      query('SELECT COUNT(*) as total FROM products WHERE is_available = true'),
      query('SELECT COUNT(*) as total FROM rider_profiles'),
      query("SELECT COUNT(*) as total FROM orders WHERE created_at::date = CURRENT_DATE"),
    ])

    return {
      totalUsers: parseInt(users.rows[0].total),
      totalOrders: parseInt(orders.rows[0].total),
      totalRevenue: parseFloat(revenue.rows[0].total),
      activeProducts: parseInt(products.rows[0].total),
      totalRiders: parseInt(riders.rows[0].total),
      todayOrders: parseInt(todayOrders.rows[0].total),
    }
  }

  // ─── ANALYTICS ──────────────────────────────────────

  async getSalesAnalytics({ startDate, endDate, groupBy = 'day' }) {
    const truncUnit = groupBy === 'month' ? 'month' : groupBy === 'week' ? 'week' : 'day'
    const params = []
    let dateFilter = ''

    if (startDate && endDate) {
      params.push(startDate, endDate)
      dateFilter = 'WHERE o.created_at BETWEEN $1 AND $2'
    }

    const { rows } = await query(
      `SELECT
         date_trunc('${truncUnit}', o.created_at) as period,
         COUNT(*) as total_orders,
         COUNT(*) FILTER (WHERE o.status = 'DELIVERED') as delivered_orders,
         COALESCE(SUM(o.total_amount) FILTER (WHERE o.payment_status = 'PAID'), 0) as revenue,
         COALESCE(AVG(o.total_amount), 0) as avg_order_value
       FROM orders o
       ${dateFilter}
       GROUP BY period
       ORDER BY period DESC
       LIMIT 90`,
      params
    )

    return rows.map(r => ({
      period: r.period,
      totalOrders: parseInt(r.total_orders),
      deliveredOrders: parseInt(r.delivered_orders),
      revenue: parseFloat(r.revenue),
      avgOrderValue: parseFloat(r.avg_order_value),
    }))
  }

  async getTopProducts(limit = 20) {
    const { rows } = await query(
      `SELECT p.id, p.name, p.price, p.images, p.total_sold,
              COUNT(DISTINCT oi.order_id) as order_count,
              COALESCE(SUM(oi.total), 0) as total_revenue,
              COALESCE(AVG(r.rating), 0) as avg_rating
       FROM products p
       LEFT JOIN order_items oi ON oi.product_id = p.id
       LEFT JOIN reviews r ON r.product_id = p.id
       WHERE p.is_available = true
       GROUP BY p.id
       ORDER BY p.total_sold DESC
       LIMIT $1`,
      [limit]
    )

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      price: parseFloat(r.price),
      image: r.images?.[0] || null,
      totalSold: parseInt(r.total_sold),
      orderCount: parseInt(r.order_count),
      totalRevenue: parseFloat(r.total_revenue),
      avgRating: parseFloat(r.avg_rating),
    }))
  }

  async getUserAnalytics({ startDate, endDate }) {
    const params = []
    let dateFilter = ''
    let dateFilterUsers = ''

    if (startDate && endDate) {
      params.push(startDate, endDate)
      dateFilter = 'AND created_at BETWEEN $1 AND $2'
      dateFilterUsers = 'WHERE created_at BETWEEN $1 AND $2'
    }

    const [totalUsers, newUsers, activeCustomers, roleBreakdown] = await Promise.all([
      query('SELECT COUNT(*) as total FROM users'),
      query(`SELECT COUNT(*) as total FROM users ${dateFilterUsers}`, params),
      query(
        `SELECT COUNT(DISTINCT user_id) as total FROM orders WHERE status != 'CANCELLED' ${dateFilter}`,
        params
      ),
      query('SELECT role, COUNT(*) as count FROM users GROUP BY role'),
    ])

    return {
      totalUsers: parseInt(totalUsers.rows[0].total),
      newUsers: parseInt(newUsers.rows[0].total),
      activeCustomers: parseInt(activeCustomers.rows[0].total),
      roleBreakdown: roleBreakdown.rows.reduce((acc, r) => {
        acc[r.role] = parseInt(r.count)
        return acc
      }, {}),
    }
  }

  // ─── USERS ──────────────────────────────────────────

  async getAllUsers({ offset, limit, search, role }) {
    let sql = 'SELECT id, phone, name, email, role, 0::decimal AS wallet_balance, is_active, created_at FROM users WHERE 1=1'
    const params = []
    let idx = 1

    if (search) {
      params.push(`%${search}%`)
      sql += ` AND (phone ILIKE $${idx} OR name ILIKE $${idx})`
      idx++
    }

    if (role) {
      params.push(role)
      sql += ` AND role = $${idx}`
      idx++
    }

    const countSql = sql.replace(/SELECT .+ FROM users/, 'SELECT COUNT(*) FROM users')
    const countResult = await query(countSql, params)
    const total = parseInt(countResult.rows[0].count)

    params.push(limit, offset)
    sql += ` ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`

    const result = await query(sql, params)

    return {
      users: result.rows,
      pagination: {
        page: Math.floor(offset / limit) + 1,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }

  async updateUserRole(userId, role) {
    const { rows } = await query(
      'UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING id, phone, name, role',
      [role, userId]
    )
    return rows[0]
  }

  async blockUser(userId, blocked, reason) {
    const { rows } = await query(
      `UPDATE users
       SET is_active = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING id, phone, name, role, is_active, updated_at`,
      [!blocked, userId]
    )
    return rows[0]
  }

  async getUserById(userId) {
    const { rows } = await query(
      'SELECT id, phone, name, role, is_active FROM users WHERE id = $1',
      [userId]
    )
    return rows[0]
  }

  // ─── ORDER STATS ────────────────────────────────────

  async getOrderStats({ startDate, endDate }) {
    const params = []
    let dateFilter = ''

    if (startDate && endDate) {
      params.push(startDate, endDate)
      dateFilter = 'WHERE created_at BETWEEN $1 AND $2'
    }

    const [totalOrders, completedOrders, revenue, avgOrderValue] = await Promise.all([
      query(`SELECT COUNT(*) as total FROM orders ${dateFilter}`, params),
      query(`SELECT COUNT(*) as total FROM orders ${dateFilter ? dateFilter + ' AND' : 'WHERE'} status = 'DELIVERED'`, params),
      query(`SELECT COALESCE(SUM(total_amount), 0) as total FROM orders ${dateFilter ? dateFilter + ' AND' : 'WHERE'} payment_status = 'PAID'`, params),
      query(`SELECT COALESCE(AVG(total_amount), 0) as avg FROM orders ${dateFilter}`, params),
    ])

    return {
      totalOrders: parseInt(totalOrders.rows[0].total),
      completedOrders: parseInt(completedOrders.rows[0].total),
      totalRevenue: parseFloat(revenue.rows[0].total),
      avgOrderValue: parseFloat(avgOrderValue.rows[0].avg),
    }
  }

  // ─── RIDERS ─────────────────────────────────────────

  async getAllRiders({ offset, limit, status }) {
    let sql = `
      SELECT rp.*, u.name, u.phone, u.email, u.created_at as joined_at
      FROM rider_profiles rp
      JOIN users u ON u.id = rp.user_id
      WHERE 1=1
    `
    const params = []
    let idx = 1

    if (status === 'approved') {
      sql += ' AND rp.is_approved = true'
    } else if (status === 'pending') {
      sql += ' AND rp.is_approved = false'
    } else if (status === 'online') {
      sql += ' AND rp.is_online = true AND rp.is_approved = true'
    }

    const countSql = sql.replace(/SELECT .+ FROM rider_profiles/, 'SELECT COUNT(*) FROM rider_profiles')
    const countResult = await query(countSql, params)
    const total = parseInt(countResult.rows[0].count)

    params.push(limit, offset)
    sql += ` ORDER BY rp.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`

    const result = await query(sql, params)

    return {
      riders: result.rows,
      pagination: {
        page: Math.floor(offset / limit) + 1,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }

  async approveRider(userId) {
    const { rows } = await query(
      `UPDATE rider_profiles
       SET is_approved = true, updated_at = NOW()
       WHERE user_id = $1
       RETURNING user_id, is_approved, vehicle_type, vehicle_number`,
      [userId]
    )
    return rows[0]
  }

  async getRiderProfile(userId) {
    const { rows } = await query(
      'SELECT user_id, is_approved FROM rider_profiles WHERE user_id = $1',
      [userId]
    )
    return rows[0]
  }

  // ─── SETTINGS ───────────────────────────────────────

  async getSettings() {
    const { rows } = await query(
      'SELECT key, value, description, updated_at FROM app_settings ORDER BY key'
    )
    return rows.reduce((acc, r) => {
      acc[r.key] = { value: r.value, description: r.description, updatedAt: r.updated_at }
      return acc
    }, {})
  }

  async updateSetting(key, value) {
    const { rows } = await query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = $2::jsonb, updated_at = NOW()
       RETURNING key, value, description, updated_at`,
      [key, JSON.stringify(value)]
    )
    return rows[0]
  }

  async getSettingByKey(key) {
    return { key } // Allow any key — upsert handles creation
  }

  // ─── BULK NOTIFICATION HELPERS ──────────────────────

  async getUserIdsByRole(role) {
    const { rows } = await query(
      'SELECT id FROM users WHERE role = $1 AND is_active = true',
      [role]
    )
    return rows.map(r => r.id)
  }

  async getAllUserIds() {
    const { rows } = await query(
      'SELECT id FROM users WHERE is_active = true'
    )
    return rows.map(r => r.id)
  }
}
