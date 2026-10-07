/**
 * Admin Reports Controller — HTTP Handlers
 * Source of truth: Blueprint §06.10, Phase 11
 *
 * @module modules/reports/reports.controller
 */

export class ReportsController {
  /**
   * @param {import('./reports.service.js').ReportsService} service
   */
  constructor(service) {
    this.service = service
  }

  getDashboardSummary = async (req, reply) => {
    const data = await this.service.getDashboardSummary()
    return reply.status(200).send({ success: true, data })
  }

  getVendorMetrics = async (req, reply) => {
    const data = await this.service.getVendorMetrics()
    return reply.status(200).send({ success: true, data })
  }

  getProcurementMetrics = async (req, reply) => {
    const data = await this.service.getProcurementMetrics()
    return reply.status(200).send({ success: true, data })
  }

  getInventoryMetrics = async (req, reply) => {
    const data = await this.service.getInventoryMetrics()
    return reply.status(200).send({ success: true, data })
  }

  getOrderMetrics = async (req, reply) => {
    const data = await this.service.getOrderMetrics()
    return reply.status(200).send({ success: true, data })
  }

  getSupportMetrics = async (req, reply) => {
    const data = await this.service.getSupportMetrics()
    return reply.status(200).send({ success: true, data })
  }

  getRecallMetrics = async (req, reply) => {
    const data = await this.service.getRecallMetrics()
    return reply.status(200).send({ success: true, data })
  }

  getReportsSummary = async (req, reply) => {
    const data = await this.service.getReportsSummary()
    return reply.status(200).send({ success: true, data })
  }
}
