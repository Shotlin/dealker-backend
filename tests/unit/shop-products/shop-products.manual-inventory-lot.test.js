/**
 * ShopProductsService#createManualInventoryLot
 *
 * Lets an admin/shop-staff backfill a vendor batch (name, quantity, expiry,
 * optional quality video) for stock that never came through the real
 * Vendor Procurement receiving pipeline (§7.5.1) — e.g. stock typed in by
 * hand before a vendor relationship was formalized. Unlike the read-only
 * `getInventoryLots`, this DOES create the shop's derived warehouse, and
 * optionally applies the same quantity as a real stock delta in the same
 * transaction.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  cacheDeletePattern: vi.fn(),
}))

const dbClientMock = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [] })),
  release: vi.fn(),
}))
vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(async () => dbClientMock),
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

vi.mock('../../../src/utils/audit-log.js', () => ({
  emit: vi.fn(async () => {}),
  emitInTx: vi.fn(async () => {}),
}))

const vendorProcurementRepoMock = vi.hoisted(() => ({
  ensureShopWarehouse: vi.fn(),
}))
vi.mock('../../../src/modules/vendor-procurement/vendor-procurement.repository.js', () => ({
  VendorProcurementRepository: vi.fn(),
}))

const inventoryRepoMock = vi.hoisted(() => ({
  createManualLot: vi.fn(),
}))
vi.mock('../../../src/modules/inventory/inventory.repository.js', () => ({
  InventoryRepository: vi.fn(),
}))

import { ShopProductsService } from '../../../src/modules/shop-products/shop-products.service.js'
import { VendorProcurementRepository } from '../../../src/modules/vendor-procurement/vendor-procurement.repository.js'
import { InventoryRepository } from '../../../src/modules/inventory/inventory.repository.js'
import { emitInTx } from '../../../src/utils/audit-log.js'

const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_PRODUCT_ID = '22222222-2222-2222-2222-222222222222'
const PRODUCT_ID = '33333333-3333-3333-3333-333333333333'
const WAREHOUSE_ID = '44444444-4444-4444-4444-444444444444'

const ADMIN_ACTOR = { id: 'user-1', role: 'ADMIN' }

function makeRepo(overrides = {}) {
  return {
    findById: vi.fn(async () => ({
      id: SHOP_PRODUCT_ID,
      shop_id: SHOP_ID,
      product_id: PRODUCT_ID,
      stock_quantity: 70,
      low_stock_threshold: 5,
    })),
    applyStockChange: vi.fn(),
    ...overrides,
  }
}

function baseBody(overrides = {}) {
  return {
    vendor_name: 'Ramesh Poultry Farm',
    quantity: 10,
    expiry_date: '2026-12-31',
    also_add_to_stock: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  VendorProcurementRepository.mockImplementation(() => vendorProcurementRepoMock)
  InventoryRepository.mockImplementation(() => inventoryRepoMock)
  vendorProcurementRepoMock.ensureShopWarehouse.mockResolvedValue(WAREHOUSE_ID)
  inventoryRepoMock.createManualLot.mockResolvedValue({
    id: 'lot-manual-1',
    quantity_on_hand: '10.00',
    manual_vendor_name: 'Ramesh Poultry Farm',
  })
  dbClientMock.query.mockImplementation(async () => ({ rows: [] }))
})

describe('ShopProductsService.createManualInventoryLot', () => {
  it('rejects an actor without shop-mutation permission', async () => {
    const repo = makeRepo()
    const svc = new ShopProductsService(repo)

    const result = await svc.createManualInventoryLot(SHOP_ID, SHOP_PRODUCT_ID, baseBody(), {
      id: 'user-2',
      role: 'CUSTOMER',
    })

    expect(result.success).toBe(false)
    expect(result.code).toBe('FORBIDDEN')
    expect(inventoryRepoMock.createManualLot).not.toHaveBeenCalled()
  })

  it('returns PRODUCT_NOT_FOUND when the shop_product does not exist in this shop scope', async () => {
    const repo = makeRepo({ findById: vi.fn(async () => null) })
    const svc = new ShopProductsService(repo)

    const result = await svc.createManualInventoryLot(SHOP_ID, SHOP_PRODUCT_ID, baseBody(), ADMIN_ACTOR)

    expect(result.success).toBe(false)
    expect(result.code).toBe('PRODUCT_NOT_FOUND')
    expect(vendorProcurementRepoMock.ensureShopWarehouse).not.toHaveBeenCalled()
  })

  it('creates the shop warehouse if needed (unlike the read-only lots view) and inserts a manual lot', async () => {
    const repo = makeRepo()
    const svc = new ShopProductsService(repo)

    const result = await svc.createManualInventoryLot(SHOP_ID, SHOP_PRODUCT_ID, baseBody(), ADMIN_ACTOR)

    expect(result.success).toBe(true)
    expect(vendorProcurementRepoMock.ensureShopWarehouse).toHaveBeenCalledWith(SHOP_ID)
    expect(inventoryRepoMock.createManualLot).toHaveBeenCalledWith(
      dbClientMock,
      expect.objectContaining({
        warehouseId: WAREHOUSE_ID,
        productId: PRODUCT_ID,
        expiryDate: '2026-12-31',
        quantity: 10,
        vendorName: 'Ramesh Poultry Farm',
      })
    )
    // Never touches shop_products.stock_quantity unless explicitly asked.
    expect(repo.applyStockChange).not.toHaveBeenCalled()
    expect(result.data.movement).toBeNull()
  })

  it('generates a server-side batch number sanitized from the optional reference, never a raw user string', async () => {
    const repo = makeRepo()
    const svc = new ShopProductsService(repo)

    await svc.createManualInventoryLot(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      baseBody({ batch_reference: "weird ' input; DROP TABLE--" }),
      ADMIN_ACTOR
    )

    const call = inventoryRepoMock.createManualLot.mock.calls[0][1]
    expect(call.batchNumber).toMatch(/^MANUAL-[A-Z0-9-]+$/)
    expect(call.batchNumber).not.toContain("'")
    expect(call.batchNumber).not.toContain(';')
  })

  it('also applies a MANUAL_ADJUSTMENT stock delta in the same transaction when also_add_to_stock is true', async () => {
    const repo = makeRepo({
      applyStockChange: vi.fn(async () => ({
        stockProduct: { id: SHOP_PRODUCT_ID, stock_quantity: 80, low_stock_threshold: 5 },
        movement: { quantity_before: 70, quantity_after: 80 },
      })),
    })
    const svc = new ShopProductsService(repo)

    const result = await svc.createManualInventoryLot(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      baseBody({ also_add_to_stock: true }),
      ADMIN_ACTOR
    )

    expect(result.success).toBe(true)
    expect(repo.applyStockChange).toHaveBeenCalledWith(
      dbClientMock,
      expect.objectContaining({
        shopProductId: SHOP_PRODUCT_ID,
        delta: 10,
        type: 'MANUAL_ADJUSTMENT',
      })
    )
    expect(result.data.shopProduct.stock_quantity).toBe(80)
    expect(result.data.movement.quantity_after).toBe(80)
  })

  it('never bumps stock when also_add_to_stock is left off, even though the lot quantity is real', async () => {
    const repo = makeRepo()
    const svc = new ShopProductsService(repo)

    await svc.createManualInventoryLot(SHOP_ID, SHOP_PRODUCT_ID, baseBody({ also_add_to_stock: false }), ADMIN_ACTOR)

    expect(repo.applyStockChange).not.toHaveBeenCalled()
  })

  it('rolls back the whole transaction (lot included) if the stock bump is rejected as negative', async () => {
    const negErr = Object.assign(new Error('would go negative'), { code: 'STOCK_NEGATIVE_FORBIDDEN' })
    const repo = makeRepo({
      applyStockChange: vi.fn(async () => {
        throw negErr
      }),
    })
    const svc = new ShopProductsService(repo)

    const result = await svc.createManualInventoryLot(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      baseBody({ also_add_to_stock: true }),
      ADMIN_ACTOR
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('STOCK_NEGATIVE_FORBIDDEN')
    expect(dbClientMock.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('records an audit entry for the backfill', async () => {
    const repo = makeRepo()
    const svc = new ShopProductsService(repo)

    await svc.createManualInventoryLot(SHOP_ID, SHOP_PRODUCT_ID, baseBody(), ADMIN_ACTOR)

    expect(emitInTx).toHaveBeenCalledWith(
      dbClientMock,
      'inventory_lot_manual_backfill',
      expect.objectContaining({ target_type: 'inventory_lot', actor_shop_id: SHOP_ID })
    )
  })
})
