/**
 * Shop Reports Controller — request/response handling for shop-scoped reports.
 *
 * No business logic — delegates to service layer.
 * Applies Redis caching via cachedReport utility.
 * Streams CSV for /export endpoint.
 *
 * @module modules/shop-reports/controller
 */

import { cachedReport } from '../../utils/report-cache.js'
import { streamCsvResponse } from '../../utils/csv-stream.js'

export class ShopReportsController {
  /**
   * @param {import('./service.js').ShopReportsService} service
   */
  constructor(service) {
    this.service = service
  }

  async getGmv(request, reply) {
    const shopId = request.shopId
    const result = await cachedReport({
      endpoint: 'shop-gmv',
      query: request.query,
      shopId,
      reply,
      compute: () => this.service.getGmv(shopId, request.query),
    })
    return { success: true, ...result }
  }

  async getOrders(request, reply) {
    const shopId = request.shopId
    const result = await cachedReport({
      endpoint: 'shop-orders',
      query: request.query,
      shopId,
      reply,
      compute: () => this.service.getOrders(shopId, request.query),
    })
    return { success: true, ...result }
  }

  async getRevenue(request, reply) {
    const shopId = request.shopId
    const result = await cachedReport({
      endpoint: 'shop-revenue',
      query: request.query,
      shopId,
      reply,
      compute: () => this.service.getRevenue(shopId, request.query),
    })
    return { success: true, ...result }
  }

  async getRefunds(request, reply) {
    const shopId = request.shopId
    const result = await cachedReport({
      endpoint: 'shop-refunds',
      query: request.query,
      shopId,
      reply,
      compute: () => this.service.getRefunds(shopId, request.query),
    })
    return { success: true, ...result }
  }

  async getTopProducts(request, reply) {
    const shopId = request.shopId
    const result = await cachedReport({
      endpoint: 'shop-top-products',
      query: request.query,
      shopId,
      reply,
      compute: () => this.service.getTopProducts(shopId, request.query),
    })
    return { success: true, ...result }
  }

  async getLowStock(request, reply) {
    const shopId = request.shopId
    const result = await cachedReport({
      endpoint: 'shop-low-stock',
      query: request.query,
      shopId,
      reply,
      compute: () => this.service.getLowStock(shopId, request.query),
    })
    return { success: true, ...result }
  }

  async getStaffActivity(request, reply) {
    const shopId = request.shopId
    const result = await cachedReport({
      endpoint: 'shop-staff-activity',
      query: request.query,
      shopId,
      reply,
      compute: () => this.service.getStaffActivity(shopId, request.query),
    })
    return { success: true, ...result }
  }

  async getRiderPerformance(request, reply) {
    const shopId = request.shopId
    const result = await cachedReport({
      endpoint: 'shop-rider-performance',
      query: request.query,
      shopId,
      reply,
      compute: () => this.service.getRiderPerformance(shopId, request.query),
    })
    return { success: true, ...result }
  }

  async getCouponUsage(request, reply) {
    const shopId = request.shopId
    const result = await cachedReport({
      endpoint: 'shop-coupon-usage',
      query: request.query,
      shopId,
      reply,
      compute: () => this.service.getCouponUsage(shopId, request.query),
    })
    return { success: true, ...result }
  }

  async getSettlement(request, reply) {
    const shopId = request.shopId
    const result = await cachedReport({
      endpoint: 'shop-settlement',
      query: request.query,
      shopId,
      reply,
      compute: () => this.service.getSettlement(shopId, request.query),
    })
    return { success: true, ...result }
  }

  async exportCsv(request, reply) {
    const shopId = request.shopId
    const { report, ...filters } = request.query
    const data = await this.service.getExportData(shopId, report, filters)
    const filename = `bakaloo-shop-${report}-${new Date().toISOString().slice(0, 10)}.csv`
    streamCsvResponse(reply, data, filename)
  }
}
