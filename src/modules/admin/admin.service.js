import { notificationQueue } from '../../config/bullmq.js'

/**
 * Admin service — business logic for admin operations
 */
export class AdminService {
  constructor(repository) {
    this.repository = repository
  }

  // ─── DASHBOARD ──────────────────────────────────────

  async getDashboardStats() {
    return await this.repository.getDashboardStats()
  }

  // ─── ANALYTICS ──────────────────────────────────────

  async getSalesAnalytics({ startDate, endDate, groupBy }) {
    return await this.repository.getSalesAnalytics({ startDate, endDate, groupBy })
  }

  async getTopProducts(limit) {
    return await this.repository.getTopProducts(limit)
  }

  async getUserAnalytics({ startDate, endDate }) {
    return await this.repository.getUserAnalytics({ startDate, endDate })
  }

  // ─── USERS ──────────────────────────────────────────

  async getAllUsers({ page, limit, search, role }) {
    const offset = (page - 1) * limit
    return await this.repository.getAllUsers({ offset, limit, search, role })
  }

  async updateUserRole(userId, role) {
    if (!['CUSTOMER', 'ADMIN', 'RIDER'].includes(role)) {
      throw new Error('Invalid role')
    }
    return await this.repository.updateUserRole(userId, role)
  }

  async blockUser(userId, blocked, reason) {
    const user = await this.repository.getUserById(userId)
    if (!user) throw { statusCode: 404, message: 'User not found' }
    if (user.role === 'ADMIN') throw { statusCode: 400, message: 'Cannot block admin users' }
    return await this.repository.blockUser(userId, blocked, reason)
  }

  // ─── ORDER STATS ────────────────────────────────────

  async getOrderStats({ startDate, endDate }) {
    return await this.repository.getOrderStats({ startDate, endDate })
  }

  // ─── RIDERS ─────────────────────────────────────────

  async getAllRiders({ page, limit, status }) {
    const offset = (page - 1) * limit
    return await this.repository.getAllRiders({ offset, limit, status })
  }

  async approveRider(userId) {
    const rider = await this.repository.getRiderProfile(userId)
    if (!rider) throw { statusCode: 404, message: 'Rider profile not found' }
    if (rider.is_approved) throw { statusCode: 400, message: 'Rider already approved' }
    return await this.repository.approveRider(userId)
  }

  // ─── BULK NOTIFICATION ──────────────────────────────

  async sendBulkNotification({ title, body, target, role }) {
    let userIds
    if (target === 'all') {
      userIds = await this.repository.getAllUserIds()
    } else if (target === 'role' && role) {
      userIds = await this.repository.getUserIdsByRole(role)
    } else {
      throw { statusCode: 400, message: 'Invalid target' }
    }

    if (userIds.length === 0) {
      return { sent: 0, message: 'No matching users found' }
    }

    // Queue notifications in batches
    const batchSize = 50
    for (let i = 0; i < userIds.length; i += batchSize) {
      const batch = userIds.slice(i, i + batchSize)
      for (const uid of batch) {
        await notificationQueue.add('bulk-push', {
          userId: uid,
          title,
          body,
          type: 'ADMIN_BROADCAST',
          data: {},
        })
      }
    }

    return { sent: userIds.length, message: `Queued ${userIds.length} notifications` }
  }

  // ─── SETTINGS ───────────────────────────────────────

  async getSettings() {
    return await this.repository.getSettings()
  }

  async updateSettings(settings) {
    const results = {}
    for (const [key, value] of Object.entries(settings)) {
      const existing = await this.repository.getSettingByKey(key)
      if (!existing) throw { statusCode: 400, message: `Unknown setting: ${key}` }
      results[key] = await this.repository.updateSetting(key, value)
    }
    return results
  }
}
