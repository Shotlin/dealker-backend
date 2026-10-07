// Regression coverage for a real audit gap found investigating order
// BKLOO-20260718-005: single-product create/update/updateStock/delete
// never called logAdminActivity, unlike the sibling admin/products
// module's bulkUpdate()/duplicate() — so a price mix-up made directly on
// a product never showed up in the Activity Log, and was only traceable
// via a direct database investigation.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDeletePattern: vi.fn(),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../../src/utils/activityLogger.js', () => ({
  logAdminActivity: vi.fn(),
}))

import { ProductsService } from '../../../src/modules/products/products.service.js'
import { logAdminActivity } from '../../../src/utils/activityLogger.js'

const ADMIN_ID = 'admin-1'
const IP = '127.0.0.1'
const PRODUCT_ID = 'product-1'

function makeRepoMock(overrides = {}) {
  return {
    findById: vi.fn().mockResolvedValue({ id: PRODUCT_ID, name: 'Sumul Malai Peda', price: 290, stock_quantity: 100 }),
    create: vi.fn().mockResolvedValue({ id: PRODUCT_ID, name: 'Sumul Malai Peda', price: 290 }),
    update: vi.fn().mockResolvedValue({ id: PRODUCT_ID, name: 'Sumul Malai Peda', price: 750 }),
    updateStock: vi.fn().mockResolvedValue({ id: PRODUCT_ID, name: 'Sumul Malai Peda', stock_quantity: 50 }),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ProductsService — single-product mutations are now audited', () => {
  it('create() logs CREATE_PRODUCT', async () => {
    const repo = makeRepoMock()
    const service = new ProductsService(repo)

    await service.create({ name: 'Sumul Malai Peda', price: 290 }, ADMIN_ID, IP)

    expect(logAdminActivity).toHaveBeenCalledWith(
      ADMIN_ID, 'CREATE_PRODUCT', 'product', PRODUCT_ID, null,
      expect.objectContaining({ id: PRODUCT_ID }), IP
    )
  })

  it('update() logs UPDATE_PRODUCT with before/after values', async () => {
    const repo = makeRepoMock()
    const service = new ProductsService(repo)

    await service.update(PRODUCT_ID, { price: 750 }, ADMIN_ID, IP)

    expect(logAdminActivity).toHaveBeenCalledWith(
      ADMIN_ID, 'UPDATE_PRODUCT', 'product', PRODUCT_ID,
      expect.objectContaining({ price: 290 }),
      expect.objectContaining({ price: 750 }),
      IP
    )
  })

  it('update() does not log when the product does not exist', async () => {
    const repo = makeRepoMock({ findById: vi.fn().mockResolvedValue(null) })
    const service = new ProductsService(repo)

    const result = await service.update(PRODUCT_ID, { price: 750 }, ADMIN_ID, IP)

    expect(result.success).toBe(false)
    expect(logAdminActivity).not.toHaveBeenCalled()
  })

  it('updateStock() logs UPDATE_PRODUCT_STOCK with before/after quantities', async () => {
    const repo = makeRepoMock()
    const service = new ProductsService(repo)

    await service.updateStock(PRODUCT_ID, 50, ADMIN_ID, IP)

    expect(logAdminActivity).toHaveBeenCalledWith(
      ADMIN_ID, 'UPDATE_PRODUCT_STOCK', 'product', PRODUCT_ID,
      { stock_quantity: 100 }, { stock_quantity: 50 }, IP
    )
  })

  it('delete() logs DELETE_PRODUCT', async () => {
    const repo = makeRepoMock()
    const service = new ProductsService(repo)

    await service.delete(PRODUCT_ID, ADMIN_ID, IP)

    expect(logAdminActivity).toHaveBeenCalledWith(
      ADMIN_ID, 'DELETE_PRODUCT', 'product', PRODUCT_ID,
      expect.objectContaining({ id: PRODUCT_ID }), null, IP
    )
  })
})
