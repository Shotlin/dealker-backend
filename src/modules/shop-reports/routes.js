/**
 * Shop Reports routes — shop-scoped report endpoints.
 * Prefix: /api/v1/shop-reports
 *
 * All routes require:
 *   - Valid JWT (fastify.authenticate)
 *   - Shop scope (requireShopScope with requireShop: true)
 *   - shop_reports.view permission
 *
 * Access control (task 11.5):
 *   - HQ access without X-Shop-Id header returns 400 SHOP_SCOPE_REQUIRED
 *     (enforced by requireShopScope({ requireShop: true }))
 *   - Store-user without shop_reports.view gets 403 PERMISSION_DENIED
 *
 * @module modules/shop-reports/routes
 */

import { ShopReportsController } from './controller.js'
import { ShopReportsService } from './service.js'
import { ShopReportsRepository } from './repository.js'
import { requirePermission } from '../../middlewares/permission-check.js'
import { requireShopScope } from '../../middlewares/shop-scope.js'
import {
  gmvSchema,
  ordersSchema,
  revenueSchema,
  refundsSchema,
  topProductsSchema,
  lowStockSchema,
  staffActivitySchema,
  riderPerformanceSchema,
  couponUsageSchema,
  settlementSchema,
  exportSchema,
} from './schema.js'

export default async function shopReportsRoutes(fastify) {
  const repository = new ShopReportsRepository()
  const service = new ShopReportsService(repository)
  const controller = new ShopReportsController(service)

  // All routes require authentication + shop scope + shop_reports.view permission
  const preHandler = [
    fastify.authenticate,
    requireShopScope({ requireShop: true }),
    requirePermission('shop_reports.view'),
  ]

  // GET /gmv
  fastify.get('/gmv', {
    schema: gmvSchema,
    preHandler,
    config: { requiredPermission: 'shop_reports.view' },
  }, controller.getGmv.bind(controller))

  // GET /orders
  fastify.get('/orders', {
    schema: ordersSchema,
    preHandler,
    config: { requiredPermission: 'shop_reports.view' },
  }, controller.getOrders.bind(controller))

  // GET /revenue
  fastify.get('/revenue', {
    schema: revenueSchema,
    preHandler,
    config: { requiredPermission: 'shop_reports.view' },
  }, controller.getRevenue.bind(controller))

  // GET /refunds
  fastify.get('/refunds', {
    schema: refundsSchema,
    preHandler,
    config: { requiredPermission: 'shop_reports.view' },
  }, controller.getRefunds.bind(controller))

  // GET /top-products
  fastify.get('/top-products', {
    schema: topProductsSchema,
    preHandler,
    config: { requiredPermission: 'shop_reports.view' },
  }, controller.getTopProducts.bind(controller))

  // GET /low-stock
  fastify.get('/low-stock', {
    schema: lowStockSchema,
    preHandler,
    config: { requiredPermission: 'shop_reports.view' },
  }, controller.getLowStock.bind(controller))

  // GET /staff-activity
  fastify.get('/staff-activity', {
    schema: staffActivitySchema,
    preHandler,
    config: { requiredPermission: 'shop_reports.view' },
  }, controller.getStaffActivity.bind(controller))

  // GET /rider-performance
  fastify.get('/rider-performance', {
    schema: riderPerformanceSchema,
    preHandler,
    config: { requiredPermission: 'shop_reports.view' },
  }, controller.getRiderPerformance.bind(controller))

  // GET /coupon-usage
  fastify.get('/coupon-usage', {
    schema: couponUsageSchema,
    preHandler,
    config: { requiredPermission: 'shop_reports.view' },
  }, controller.getCouponUsage.bind(controller))

  // GET /settlement
  fastify.get('/settlement', {
    schema: settlementSchema,
    preHandler,
    config: { requiredPermission: 'shop_reports.view' },
  }, controller.getSettlement.bind(controller))

  // GET /export — CSV export (max 10000 rows)
  fastify.get('/export', {
    schema: exportSchema,
    preHandler,
    config: { requiredPermission: 'shop_reports.view' },
  }, controller.exportCsv.bind(controller))
}
