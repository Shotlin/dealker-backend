/**
 * ShopProductsService#getInventoryLots
 *
 * The "which vendor batches make up this number" view backing the
 * dashboard's Edit Shop Pricing & Stock modal — surfaces the real
 * inventory_lots rows behind a shop_product's stock instead of leaving
 * stock_quantity looking like an independent, manually-typed value.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  cacheDeletePattern: vi.fn(),
}))

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn().mockResolvedValue(undefined) },
  stockNotificationsQueue: { add: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('../../../src/plugins/socketio.plugin.js', () => ({
  getSocketIo: vi.fn().mockReturnValue(null),
}))

const vendorProcurementRepoMock = vi.hoisted(() => ({
  findShopWarehouseId: vi.fn(),
}))
vi.mock('../../../src/modules/vendor-procurement/vendor-procurement.repository.js', () => ({
  VendorProcurementRepository: vi.fn(),
}))

const inventoryRepoMock = vi.hoisted(() => ({
  listLots: vi.fn(),
}))
vi.mock('../../../src/modules/inventory/inventory.repository.js', () => ({
  InventoryRepository: vi.fn(),
}))

import { ShopProductsService } from '../../../src/modules/shop-products/shop-products.service.js'
import { VendorProcurementRepository } from '../../../src/modules/vendor-procurement/vendor-procurement.repository.js'
import { InventoryRepository } from '../../../src/modules/inventory/inventory.repository.js'

const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_PRODUCT_ID = '22222222-2222-2222-2222-222222222222'
const PRODUCT_ID = '33333333-3333-3333-3333-333333333333'

function makeRepo(overrides = {}) {
  return {
    findById: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  VendorProcurementRepository.mockImplementation(() => vendorProcurementRepoMock)
  InventoryRepository.mockImplementation(() => inventoryRepoMock)
})

describe('ShopProductsService.getInventoryLots', () => {
  it('returns null when the shop_product does not exist in this shop scope', async () => {
    const repo = makeRepo({ findById: vi.fn(async () => null) })
    const svc = new ShopProductsService(repo)

    const result = await svc.getInventoryLots(SHOP_ID, SHOP_PRODUCT_ID)

    expect(result).toBeNull()
    expect(repo.findById).toHaveBeenCalledWith(SHOP_PRODUCT_ID, SHOP_ID)
  })

  it('returns an empty lot list without creating a warehouse when the shop has never received vendor stock', async () => {
    const repo = makeRepo({
      findById: vi.fn(async () => ({ id: SHOP_PRODUCT_ID, shop_id: SHOP_ID, product_id: PRODUCT_ID, stock_quantity: 0 })),
    })
    const svc = new ShopProductsService(repo)
    vendorProcurementRepoMock.findShopWarehouseId.mockResolvedValue(null)

    const result = await svc.getInventoryLots(SHOP_ID, SHOP_PRODUCT_ID)

    expect(result.lots).toEqual([])
    expect(result.lotQuantityTotal).toBe(0)
    expect(inventoryRepoMock.listLots).not.toHaveBeenCalled()
  })

  it('returns the real vendor lot breakdown and their quantity sum when lots exist', async () => {
    const shopProduct = { id: SHOP_PRODUCT_ID, shop_id: SHOP_ID, product_id: PRODUCT_ID, stock_quantity: 12 }
    const repo = makeRepo({ findById: vi.fn(async () => shopProduct) })
    const svc = new ShopProductsService(repo)

    vendorProcurementRepoMock.findShopWarehouseId.mockResolvedValue('warehouse-1')
    inventoryRepoMock.listLots.mockResolvedValue([
      { id: 'lot-a', quantity_on_hand: '2.00', vendor_name: 'Vendor A', product_id: PRODUCT_ID },
      { id: 'lot-b', quantity_on_hand: '10.00', vendor_name: 'Vendor B', product_id: PRODUCT_ID },
    ])

    const result = await svc.getInventoryLots(SHOP_ID, SHOP_PRODUCT_ID)

    expect(inventoryRepoMock.listLots).toHaveBeenCalledWith('warehouse-1', PRODUCT_ID)
    expect(result.shopProduct).toBe(shopProduct)
    expect(result.lots).toHaveLength(2)
    // Two independent vendor batches never collapse into one anonymous total —
    // each lot keeps its own vendor/quantity; only the sum is derived.
    expect(result.lots[0].vendor_name).toBe('Vendor A')
    expect(result.lots[1].vendor_name).toBe('Vendor B')
    expect(result.lotQuantityTotal).toBe(12)
  })
})
