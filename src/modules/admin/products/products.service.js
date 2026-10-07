import { AdminProductsRepository } from './products.repository.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import { cacheDeletePattern } from '../../../utils/cache.js'
import ExcelJS from 'exceljs'

const repo = new AdminProductsRepository()

export class AdminProductsService {
  async getAnalytics({ page = 1, limit = 20, sortBy }) {
    const offset = (page - 1) * limit
    return repo.getAnalytics({ offset, limit, sortBy })
  }

  async getDeadStock(days) {
    return repo.getDeadStock(days)
  }

  async getLowMargin(threshold) {
    return repo.getLowMargin(threshold)
  }

  async exportProducts(format = 'csv') {
    const products = await repo.getAllForExport()
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Products')
    ws.columns = [
      { header: 'ID', key: 'id', width: 8 },
      { header: 'Name', key: 'name', width: 30 },
      { header: 'SKU', key: 'sku', width: 15 },
      { header: 'Category', key: 'category', width: 20 },
      { header: 'Price', key: 'price', width: 10 },
      { header: 'Sale Price', key: 'sale_price', width: 10 },
      { header: 'Cost Price', key: 'cost_price', width: 10 },
      { header: 'Stock', key: 'stock_quantity', width: 10 },
      { header: 'Unit', key: 'unit', width: 10 },
      { header: 'Active', key: 'is_active', width: 8 },
      { header: 'Total Sold', key: 'total_sold', width: 10 },
      { header: 'Created', key: 'created_at', width: 20 },
    ]
    products.forEach(p => ws.addRow(p))

    const buffer = format === 'xlsx'
      ? await wb.xlsx.writeBuffer()
      : await wb.csv.writeBuffer()

    return {
      buffer,
      contentType: format === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'text/csv',
      filename: `products-export-${Date.now()}.${format}`,
    }
  }

  async bulkUpdate(updates, propagateToShops, adminId, ip) {
    const { results, shopProductsUpdated } = await repo.bulkUpdate(updates, propagateToShops)
    await cacheDeletePattern('products:*')
    await cacheDeletePattern('categories:*')
    if (shopProductsUpdated > 0) {
      // Broad invalidation (not per-shop) since a propagated price change
      // can touch many shops in one batch — matches the simplicity of the
      // products:* clear above.
      await cacheDeletePattern('bakaloo:shop-products:v1:*')
    }
    logAdminActivity(adminId, 'BULK_UPDATE_PRODUCTS', 'product', null, null,
      { count: results.length, propagateToShops, shopProductsUpdated }, ip)
    return { results, shopProductsUpdated }
  }

  async duplicate(productId, adminId, ip) {
    const newProduct = await repo.duplicate(productId)
    if (newProduct) {
      await cacheDeletePattern('products:*')
      logAdminActivity(adminId, 'DUPLICATE_PRODUCT', 'product', newProduct.id, null, { source_id: productId }, ip)
    }
    return newProduct
  }

  async searchBarcode(code) {
    return repo.findBySku(code)
  }
}
