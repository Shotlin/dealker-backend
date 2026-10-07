/**
 * Shop Reports Service — business logic for shop-scoped reports.
 *
 * Delegates data access to repository. All methods require shopId.
 *
 * @module modules/shop-reports/service
 */

export class ShopReportsService {
  /**
   * @param {import('./repository.js').ShopReportsRepository} repository
   */
  constructor(repository) {
    this.repository = repository
  }

  /**
   * Parse query params into standard filter object.
   * @param {object} query
   * @returns {{ filters: object, page: number, limit: number }}
   */
  parseQuery(query) {
    const page = Math.max(1, parseInt(query.page, 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20))
    const filters = {}

    if (query.from) filters.from = query.from
    if (query.to) filters.to = query.to

    return { filters, page, limit }
  }

  async getGmv(shopId, query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getGmv(shopId, filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  async getOrders(shopId, query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getOrders(shopId, filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  async getRevenue(shopId, query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getRevenue(shopId, filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  async getRefunds(shopId, query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getRefunds(shopId, filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  async getTopProducts(shopId, query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getTopProducts(shopId, filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  async getLowStock(shopId, query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getLowStock(shopId, filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  async getStaffActivity(shopId, query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getStaffActivity(shopId, filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  async getRiderPerformance(shopId, query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getRiderPerformance(shopId, filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  async getCouponUsage(shopId, query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getCouponUsage(shopId, filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  async getSettlement(shopId, query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getSettlement(shopId, filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  /**
   * Get report data for CSV export (up to 10000 rows).
   * @param {string} shopId
   * @param {string} reportType
   * @param {object} query
   * @returns {Promise<object[]>}
   */
  async getExportData(shopId, reportType, query) {
    const exportQuery = { ...query, limit: '10000', page: '1' }
    const methodMap = {
      'gmv': 'getGmv',
      'orders': 'getOrders',
      'revenue': 'getRevenue',
      'refunds': 'getRefunds',
      'top-products': 'getTopProducts',
      'low-stock': 'getLowStock',
      'staff-activity': 'getStaffActivity',
      'rider-performance': 'getRiderPerformance',
      'coupon-usage': 'getCouponUsage',
      'settlement': 'getSettlement',
    }

    const method = methodMap[reportType]
    if (!method) return []

    const result = await this[method](shopId, exportQuery)
    return result.data || []
  }
}
