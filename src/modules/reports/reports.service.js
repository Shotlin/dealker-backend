/**
 * Admin Reports Service — Business Logic for Operational Dashboards
 * Source of truth: Blueprint §06.10, Phase 11
 *
 * @module modules/reports/reports.service
 */

export class ReportsService {
  /**
   * @param {import('./reports.repository.js').ReportsRepository} repository
   */
  constructor(repository) {
    this.repository = repository
  }

  async getDashboardSummary() {
    return this.repository.getDashboardSummary()
  }

  async getVendorMetrics() {
    return this.repository.getVendorMetrics()
  }

  async getProcurementMetrics() {
    return this.repository.getProcurementMetrics()
  }

  async getInventoryMetrics() {
    return this.repository.getInventoryMetrics()
  }

  async getOrderMetrics() {
    return this.repository.getOrderMetrics()
  }

  async getSupportMetrics() {
    return this.repository.getSupportMetrics()
  }

  async getRecallMetrics() {
    return this.repository.getRecallMetrics()
  }

  async getReportsSummary() {
    const [categoryDemand, cohortRetention] = await Promise.all([
      this.repository.getCategoryDemand(),
      this.repository.getCohortRetention(),
    ])
    return { categoryDemand, cohortRetention }
  }
}
