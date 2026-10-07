import { AdminProductsController } from './products.controller.js'
import {
  productAnalyticsSchema, deadStockSchema, lowMarginSchema,
  exportProductsSchema, bulkUpdateSchema, duplicateSchema, searchBarcodeSchema,
} from './products.schema.js'

const ctrl = new AdminProductsController()

export default async function adminProductRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  // GET / — List all products (admin view: delegates to analytics endpoint logic)
  fastify.get('/', async (request, reply) => {
    // Reuse analytics handler which returns paginated products with performance data
    return ctrl.getAnalytics(request, reply)
  })

  fastify.get('/analytics', { schema: productAnalyticsSchema }, ctrl.getAnalytics)
  fastify.get('/dead-stock', { schema: deadStockSchema }, ctrl.getDeadStock)
  fastify.get('/low-margin', { schema: lowMarginSchema }, ctrl.getLowMargin)
  fastify.get('/export', { schema: exportProductsSchema }, ctrl.exportProducts)
  fastify.put('/bulk-update', { schema: bulkUpdateSchema }, ctrl.bulkUpdate)
  fastify.post('/:id/duplicate', { schema: duplicateSchema }, ctrl.duplicate)
  fastify.get('/search-barcode/:code', { schema: searchBarcodeSchema }, ctrl.searchBarcode)
}
