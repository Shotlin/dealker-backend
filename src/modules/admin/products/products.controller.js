import { AdminProductsService } from './products.service.js'
import { success, error } from '../../../utils/apiResponse.js'

const svc = new AdminProductsService()

export class AdminProductsController {
  async getAnalytics(request, reply) {
    const { page, limit, sortBy } = request.query
    const data = await svc.getAnalytics({ page, limit, sortBy })
    return success(data, 'Product analytics fetched')
  }

  async getDeadStock(request, reply) {
    const { days } = request.query
    const data = await svc.getDeadStock(days)
    return success(data, 'Dead stock products fetched')
  }

  async getLowMargin(request, reply) {
    const { threshold } = request.query
    const data = await svc.getLowMargin(threshold)
    return success(data, 'Low margin products fetched')
  }

  async exportProducts(request, reply) {
    const { format } = request.query
    const { buffer, contentType, filename } = await svc.exportProducts(format)
    reply.header('Content-Type', contentType)
    reply.header('Content-Disposition', `attachment; filename="${filename}"`)
    return reply.send(buffer)
  }

  async bulkUpdate(request, reply) {
    const { results, shopProductsUpdated } = await svc.bulkUpdate(
      request.body.products,
      request.body.propagate_to_shops,
      request.user.id,
      request.ip
    )
    const message = shopProductsUpdated > 0
      ? `${results.length} products updated (${shopProductsUpdated} shop listings synced)`
      : `${results.length} products updated`
    return success({ updated: results, shop_products_updated: shopProductsUpdated }, message)
  }

  async duplicate(request, reply) {
    const product = await svc.duplicate(request.params.id, request.user.id, request.ip)
    if (!product) return error('Product not found', 404)
    return success(product, 'Product duplicated')
  }

  async searchBarcode(request, reply) {
    const product = await svc.searchBarcode(request.params.code)
    if (!product) return error('Product not found', 404)
    return success(product, 'Product found')
  }
}
