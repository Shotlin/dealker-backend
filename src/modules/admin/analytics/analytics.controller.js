import { AdminAnalyticsService } from './analytics.service.js'
import { success } from '../../../utils/apiResponse.js'

const svc = new AdminAnalyticsService()

export class AdminAnalyticsController {
  async getSales(request, reply) {
    const { startDate, endDate, groupBy } = request.query
    const data = await svc.getSalesAnalytics({ startDate, endDate, groupBy, shopId: request.shopId })
    return success(data, 'Sales analytics fetched')
  }

  async getProductPerformance(request, reply) {
    const { startDate, endDate, limit } = request.query
    const data = await svc.getProductPerformance({ startDate, endDate, limit, shopId: request.shopId })
    return success(data, 'Product performance fetched')
  }

  async getCustomerCohorts(request, reply) {
    const data = await svc.getCustomerCohorts({ shopId: request.shopId })
    return success(data, 'Customer cohorts fetched')
  }

  async getDeliveryAnalytics(request, reply) {
    const { startDate, endDate } = request.query
    const data = await svc.getDeliveryAnalytics({ startDate, endDate, shopId: request.shopId })
    return success(data, 'Delivery analytics fetched')
  }

  async getFinancialReport(request, reply) {
    const { startDate, endDate } = request.query
    const data = await svc.getFinancialReport({ startDate, endDate, shopId: request.shopId })
    return success(data, 'Financial report fetched')
  }

  async getCartEnhancementAnalytics(request, reply) {
    const { startDate, endDate } = request.query
    const data = await svc.getCartEnhancementAnalytics({ startDate, endDate, shopId: request.shopId })
    return success(data, 'Cart enhancement analytics fetched')
  }

  async getComparison(request, reply) {
    const data = await svc.getComparison({ ...request.query, shopId: request.shopId })
    return success(data, 'Comparison fetched')
  }

  async getGeographicAnalytics(request, reply) {
    const { startDate, endDate } = request.query
    const data = await svc.getGeographicAnalytics({ startDate, endDate, shopId: request.shopId })
    return success(data, 'Geographic analytics fetched')
  }

  async getDeadStock(request, reply) {
    const { limit } = request.query
    const data = await svc.getDeadStock({ limit, shopId: request.shopId })
    return success(data, 'Dead stock fetched')
  }

  async exportPDF(request, reply) {
    const { startDate, endDate } = request.query
    const buffer = await svc.exportReportPDF({ startDate, endDate, shopId: request.shopId })
    reply.header('Content-Type', 'application/pdf')
    reply.header('Content-Disposition', `attachment; filename="analytics-report-${Date.now()}.pdf"`)
    return reply.send(buffer)
  }

  async exportExcel(request, reply) {
    const { startDate, endDate } = request.query
    const buffer = await svc.exportReportExcel({ startDate, endDate, shopId: request.shopId })
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    reply.header('Content-Disposition', `attachment; filename="analytics-report-${Date.now()}.xlsx"`)
    return reply.send(buffer)
  }
}
