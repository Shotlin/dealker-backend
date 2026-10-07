import { AdminAnalyticsController } from './analytics.controller.js'
import { requireShopScope } from '../../../middlewares/shop-scope.js'
import {
  salesSchema, productPerformanceSchema, dateRangeSchema, comparisonSchema, cartEnhancementAnalyticsSchema,
  geographicSchema, deadStockSchema,
} from './analytics.schema.js'

const ctrl = new AdminAnalyticsController()
const shopScope = requireShopScope()

export default async function adminAnalyticsRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
    if (reply.sent) return
    // requireAdmin only checks the legacy base `role === 'ADMIN'` field,
    // which shop staff share too (there is no separate SHOP_STAFF base
    // role — see src/constants/roles.js). Without this, a single-shop
    // staff member's JWT (role: 'ADMIN', shopId: '<their shop>') could
    // read every shop's analytics/dashboard numbers, since none of the
    // queries below filtered by shop_id. requireShopScope() resolves
    // request.shopId from that JWT so every query can filter to it —
    // true HQ users (no shopId claim) keep seeing everything.
    await shopScope(request, reply)
  })

  fastify.get('/sales', { schema: salesSchema }, ctrl.getSales)
  fastify.get('/product-performance', { schema: productPerformanceSchema }, ctrl.getProductPerformance)
  fastify.get('/customer-cohorts', ctrl.getCustomerCohorts)
  fastify.get('/delivery', { schema: dateRangeSchema }, ctrl.getDeliveryAnalytics)
  fastify.get('/financial', { schema: dateRangeSchema }, ctrl.getFinancialReport)
  fastify.get('/cart-enhancements', { schema: cartEnhancementAnalyticsSchema }, ctrl.getCartEnhancementAnalytics)
  fastify.get('/comparison', { schema: comparisonSchema }, ctrl.getComparison)
  fastify.get('/geographic', { schema: geographicSchema }, ctrl.getGeographicAnalytics)
  fastify.get('/dead-stock', { schema: deadStockSchema }, ctrl.getDeadStock)
  fastify.get('/export-pdf', { schema: dateRangeSchema }, ctrl.exportPDF)
  fastify.get('/export-excel', { schema: dateRangeSchema }, ctrl.exportExcel)
}
