/**
 * ShopProductsService#getInventoryLotsForProduct
 *
 * The "Add Product to Shop" counterpart to `getInventoryLots` — a store
 * can run a full procurement request → award → receive cycle for a
 * product BEFORE it's ever added to the shop as a `shop_products` row
 * (§7.5.1's `receiveSupply` bridge deliberately skips syncing stock when
 * no shop_product exists yet). This surfaces those already-received
 * vendor batches by product_id alone, with no shop_products id in hand.
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
const PRODUCT_ID = '33333333-3333-3333-3333-333333333333'

beforeEach(() => {
  vi.clearAllMocks()
  VendorProcurementRepository.mockImplementation(() => vendorProcurementRepoMock)
  InventoryRepository.mockImplementation(() => inventoryRepoMock)
})

describe('ShopProductsService.getInventoryLotsForProduct', () => {
  it('never touches the repo (no shop_products lookup at all — none may exist yet)', async () => {
    const repo = { findByShopAndProduct: vi.fn() }
    const svc = new ShopProductsService(repo)
    vendorProcurementRepoMock.findShopWarehouseId.mockResolvedValue(null)

    await svc.getInventoryLotsForProduct(SHOP_ID, PRODUCT_ID)

    expect(repo.findByShopAndProduct).not.toHaveBeenCalled()
  })

  it('returns an empty lot list without creating a warehouse when the shop has never received vendor stock', async () => {
    const svc = new ShopProductsService({})
    vendorProcurementRepoMock.findShopWarehouseId.mockResolvedValue(null)

    const result = await svc.getInventoryLotsForProduct(SHOP_ID, PRODUCT_ID)

    expect(result).toEqual({ lots: [], lotQuantityTotal: 0 })
    expect(inventoryRepoMock.listLots).not.toHaveBeenCalled()
  })

  it('surfaces real vendor batches already received for this product before it was ever added to the shop', async () => {
    const svc = new ShopProductsService({})
    vendorProcurementRepoMock.findShopWarehouseId.mockResolvedValue('warehouse-1')
    inventoryRepoMock.listLots.mockResolvedValue([
      { id: 'lot-a', quantity_on_hand: '50.00', vendor_name: 'Egg Farm Co', product_id: PRODUCT_ID },
    ])

    const result = await svc.getInventoryLotsForProduct(SHOP_ID, PRODUCT_ID)

    expect(inventoryRepoMock.listLots).toHaveBeenCalledWith('warehouse-1', PRODUCT_ID)
    expect(result.lots).toHaveLength(1)
    expect(result.lots[0].vendor_name).toBe('Egg Farm Co')
    expect(result.lotQuantityTotal).toBe(50)
  })
})
