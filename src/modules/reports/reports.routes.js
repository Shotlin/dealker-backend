/**
 * Admin Reports Routes — Fastify Plugin for Reporting & Dashboard Endpoints
 * Source of truth: Blueprint §06.10, Phase 11
 *
 * @module modules/reports/reports.routes
 */

import { ReportsRepository } from './reports.repository.js'
import { ReportsService } from './reports.service.js'
import { ReportsController } from './reports.controller.js'

export async function reportsRoutes(fastify) {
  const repository = new ReportsRepository()
  const service = new ReportsService(repository)
  const controller = new ReportsController(service)

  const preHandlers = [
    fastify.authenticate,
    fastify.requirePermission('reports.view'),
  ]

  fastify.get('/summary', { preHandler: preHandlers, handler: controller.getReportsSummary })
  fastify.get('/dashboard', { preHandler: preHandlers, handler: controller.getDashboardSummary })
  fastify.get('/vendors', { preHandler: preHandlers, handler: controller.getVendorMetrics })
  fastify.get('/procurement', { preHandler: preHandlers, handler: controller.getProcurementMetrics })
  fastify.get('/inventory', { preHandler: preHandlers, handler: controller.getInventoryMetrics })
  fastify.get('/orders', { preHandler: preHandlers, handler: controller.getOrderMetrics })
  fastify.get('/support', { preHandler: preHandlers, handler: controller.getSupportMetrics })
  fastify.get('/recalls', { preHandler: preHandlers, handler: controller.getRecallMetrics })
}

export default reportsRoutes
