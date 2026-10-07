import { success } from '../../utils/apiResponse.js'

/**
 * Admin controller — handles admin-specific operations
 */
export class AdminController {
  constructor(service) {
    this.service = service
  }

  // ─── DASHBOARD ──────────────────────────────────────

  async getDashboard(request, reply) {
    const stats = await this.service.getDashboardStats()
    return reply.code(200).send(success(stats, 'Dashboard stats fetched'))
  }

  // ─── ANALYTICS ──────────────────────────────────────

  async getSalesAnalytics(request, reply) {
    const { startDate, endDate, groupBy } = request.query
    const data = await this.service.getSalesAnalytics({ startDate, endDate, groupBy })
    return reply.code(200).send(success(data, 'Sales analytics fetched'))
  }

  async getTopProducts(request, reply) {
    const { limit = 20 } = request.query
    const data = await this.service.getTopProducts(limit)
    return reply.code(200).send(success(data, 'Top products fetched'))
  }

  async getUserAnalytics(request, reply) {
    const { startDate, endDate } = request.query
    const data = await this.service.getUserAnalytics({ startDate, endDate })
    return reply.code(200).send(success(data, 'User analytics fetched'))
  }

  // ─── USERS ──────────────────────────────────────────

  async getAllUsers(request, reply) {
    const { page = 1, limit = 20, search = '', role = '' } = request.query
    const result = await this.service.getAllUsers({ page, limit, search, role })
    return reply.code(200).send(success(result, 'Users fetched'))
  }

  async updateUserRole(request, reply) {
    const { id } = request.params
    const { role } = request.body
    const user = await this.service.updateUserRole(id, role)
    return reply.code(200).send(success(user, 'User role updated'))
  }

  async blockUser(request, reply) {
    const { id } = request.params
    const { blocked, reason } = request.body
    const user = await this.service.blockUser(id, blocked, reason)
    const msg = blocked ? 'User blocked' : 'User unblocked'
    return reply.code(200).send(success(user, msg))
  }

  // ─── ORDER STATS ────────────────────────────────────

  async getOrderStats(request, reply) {
    const { startDate, endDate } = request.query
    const stats = await this.service.getOrderStats({ startDate, endDate })
    return reply.code(200).send(success(stats, 'Order stats fetched'))
  }

  // ─── RIDERS ─────────────────────────────────────────

  async getAllRiders(request, reply) {
    const { page = 1, limit = 20, status = '' } = request.query
    const result = await this.service.getAllRiders({ page, limit, status })
    return reply.code(200).send(success(result, 'Riders fetched'))
  }

  async approveRider(request, reply) {
    const { id } = request.params
    const rider = await this.service.approveRider(id)
    return reply.code(200).send(success(rider, 'Rider approved'))
  }

  // ─── BULK NOTIFICATION ──────────────────────────────

  async sendBulkNotification(request, reply) {
    const { title, body, target, role } = request.body
    const result = await this.service.sendBulkNotification({ title, body, target, role })
    return reply.code(200).send(success(result, 'Notifications queued'))
  }

  // ─── SETTINGS ───────────────────────────────────────

  async getSettings(request, reply) {
    const settings = await this.service.getSettings()
    return reply.code(200).send(success(settings, 'Settings fetched'))
  }

  async updateSettings(request, reply) {
    const settings = request.body
    const result = await this.service.updateSettings(settings)
    return reply.code(200).send(success(result, 'Settings updated'))
  }
}
