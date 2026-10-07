/**
 * Vendor Procurement Service — receipt-to-shop-stock sync
 *
 * Covers the bridge added to `receiveSupply` that closes the gap between a
 * vendor's accepted receipt (inventory_lots, batch/FEFO-tracked) and the
 * sellable `shop_products.stock_quantity` a customer actually buys against
 * — previously these were two entirely disconnected writes (see
 * `_syncShopProductStockFromReceipt`). The database layer is mocked per
 * repo test convention; `receiveSupply`'s own transaction/rollback
 * behaviour is covered separately (this file only exercises the
 * post-commit inventory + shop-stock bridge).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external dependencies BEFORE importing the service ────────────────

const databaseMock = vi.hoisted(() => {
  const fakeClient = {
    query: vi.fn(async () => ({ rows: [] })),
    release: vi.fn(),
  }
  return {
    query: vi.fn(async () => ({ rows: [] })),
    getClient: vi.fn(async () => fakeClient),
    fakeClient,
  }
})

vi.mock('../../../src/config/database.js', () => ({
  query: databaseMock.query,
  getClient: databaseMock.getClient,
  pool: { query: databaseMock.query },
}))

vi.mock('../../../src/utils/audit-log.js', () => ({
  emit: vi.fn(),
  emitInTx: vi.fn(async () => true),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../../src/utils/cache.js', () => ({
  cacheDeletePattern: vi.fn(async () => {}),
}))

const shopProductsRepoMock = vi.hoisted(() => ({
  findByShopAndProduct: vi.fn(),
  applyStockChange: vi.fn(),
}))
vi.mock('../../../src/modules/shop-products/shop-products.repository.js', () => ({
  ShopProductsRepository: vi.fn(),
}))

const inventoryServiceMock = vi.hoisted(() => ({
  registerInbound: vi.fn(),
}))
vi.mock('../../../src/modules/inventory/inventory.service.js', () => ({
  InventoryService: vi.fn(),
}))
vi.mock('../../../src/modules/inventory/inventory.repository.js', () => ({
  InventoryRepository: vi.fn(),
}))

import { VendorProcurementService } from '../../../src/modules/vendor-procurement/vendor-procurement.service.js'
import { cacheDeletePattern } from '../../../src/utils/cache.js'
import { ShopProductsRepository } from '../../../src/modules/shop-products/shop-products.repository.js'
import { InventoryService } from '../../../src/modules/inventory/inventory.service.js'
import { InventoryRepository } from '../../../src/modules/inventory/inventory.repository.js'

// ─── Fixtures ────────────────────────────────────────────────────────────

const SUPPLY_ID = 'supply-1'
const SHOP_ID = 'shop-1'
const PRODUCT_ID = 'product-1'
const VENDOR_ID = 'vendor-1'
const SUPPLY_ITEM_ID = 'supply-item-1'
const ACTOR_ID = 'actor-1'

function baseSupply(overrides = {}) {
  return {
    id: SUPPLY_ID,
    shop_id: SHOP_ID,
    vendor_id: VENDOR_ID,
    request_id: 'req-1',
    supply_number: 'SUP-TEST-0001',
    status: 'DELIVERED_PENDING_RECEIPT',
    items: [{ id: SUPPLY_ITEM_ID, agreed_quantity: 10, product_id: null }],
    ...overrides,
  }
}

function makeService(repoOverrides = {}) {
  const repo = {
    findSupplyOrderById: vi.fn(async () => baseSupply()),
    insertReceipt: vi.fn(async (_client, data) => ({ id: 'receipt-1', ...data })),
    insertReceiptItem: vi.fn(async (_client, receiptId, line) => ({
      id: `receipt-item-${line.supply_order_item_id}`,
      receipt_id: receiptId,
      ...line,
    })),
    markSupplyReceived: vi.fn(async (id, status) => ({ id, status })),
    insertSupplyEvent: vi.fn(async () => ({})),
    markRequestCompleted: vi.fn(async () => ({})),
    ensureShopWarehouse: vi.fn(async () => 'warehouse-1'),
    linkReceiptItemToLot: vi.fn(async () => {}),
    ...repoOverrides,
  }
  return { service: new VendorProcurementService(repo), repo }
}

function acceptedReceiptPayload(overrides = {}) {
  return {
    items: [
      {
        supply_order_item_id: SUPPLY_ITEM_ID,
        received_quantity: 10,
        accepted_quantity: 10,
        rejected_quantity: 0,
        product_id: PRODUCT_ID,
        ...overrides,
      },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // vi.clearAllMocks() only clears call/result history; re-assert the
  // constructor mocks' implementations explicitly each test rather than
  // relying on vi.restoreAllMocks() in afterEach, which for a bare vi.fn()
  // (no real "original" to restore to) wipes mockImplementation entirely —
  // that would make `new InventoryService()`/`new ShopProductsRepository()`
  // return an empty object from the second test onward.
  ShopProductsRepository.mockImplementation(() => shopProductsRepoMock)
  InventoryService.mockImplementation(() => inventoryServiceMock)
  InventoryRepository.mockImplementation(() => ({}))
  databaseMock.getClient.mockImplementation(async () => databaseMock.fakeClient)
  databaseMock.query.mockResolvedValue({ rows: [] })
  databaseMock.fakeClient.query.mockResolvedValue({ rows: [] })
})

// ─── Tests ───────────────────────────────────────────────────────────────

describe('receiveSupply — shop-product stock sync', () => {
  it('increments shop_products.stock_quantity via a PROCUREMENT_RECEIPT movement when a matching shop_product exists', async () => {
    const { service } = makeService()
    shopProductsRepoMock.findByShopAndProduct.mockResolvedValue({
      id: 'sp-1',
      shop_id: SHOP_ID,
      product_id: PRODUCT_ID,
      stock_quantity: 5,
      deleted_at: null,
    })
    shopProductsRepoMock.applyStockChange.mockResolvedValue({
      stockProduct: { id: 'sp-1', stock_quantity: 15 },
      movement: { id: 'mv-1' },
    })
    inventoryServiceMock.registerInbound.mockResolvedValue({ lot: { id: 'lot-1', quantity_on_hand: 10 } })

    const result = await service.receiveSupply(SUPPLY_ID, ACTOR_ID, acceptedReceiptPayload())

    expect(result.inventory[0].inventory_skipped).toBe(false)
    expect(result.inventory[0].inventory_lot_id).toBe('lot-1')
    expect(result.inventory[0].shop_stock_linked).toBe(true)
    expect(result.inventory[0].shop_product_id).toBe('sp-1')
    expect(result.inventory[0].shop_stock_quantity_after).toBe(15)

    expect(shopProductsRepoMock.applyStockChange).toHaveBeenCalledTimes(1)
    const [, params] = shopProductsRepoMock.applyStockChange.mock.calls[0]
    expect(params).toMatchObject({
      shopProductId: 'sp-1',
      delta: 10,
      type: 'PROCUREMENT_RECEIPT',
      source: 'API',
      actor: { userId: ACTOR_ID, shopRole: null },
    })
    expect(params.metadata).toMatchObject({
      supply_order_id: SUPPLY_ID,
      supply_number: 'SUP-TEST-0001',
      inventory_lot_id: 'lot-1',
      vendor_id: VENDOR_ID,
      quantity_received: 10,
    })

    // Cache invalidation runs after the stock sync commits.
    expect(cacheDeletePattern).toHaveBeenCalledWith(`bakaloo:shop-products:v1:${SHOP_ID}:*`)
  })

  it('never auto-creates a shop_products row — skips the sync cleanly when the product is not yet in this shop\'s catalog', async () => {
    const { service } = makeService()
    shopProductsRepoMock.findByShopAndProduct.mockResolvedValue(null)
    inventoryServiceMock.registerInbound.mockResolvedValue({ lot: { id: 'lot-1' } })

    const result = await service.receiveSupply(SUPPLY_ID, ACTOR_ID, acceptedReceiptPayload())

    // The vendor batch itself is still fully recorded...
    expect(result.inventory[0].inventory_skipped).toBe(false)
    expect(result.inventory[0].inventory_lot_id).toBe('lot-1')
    // ...but the sellable count is untouched, and no fake row was created.
    expect(result.inventory[0].shop_stock_linked).toBe(false)
    expect(shopProductsRepoMock.applyStockChange).not.toHaveBeenCalled()
  })

  it('treats a soft-deleted shop_product the same as no shop_product at all', async () => {
    const { service } = makeService()
    shopProductsRepoMock.findByShopAndProduct.mockResolvedValue({
      id: 'sp-1',
      shop_id: SHOP_ID,
      product_id: PRODUCT_ID,
      stock_quantity: 5,
      deleted_at: '2026-01-01T00:00:00.000Z',
    })
    inventoryServiceMock.registerInbound.mockResolvedValue({ lot: { id: 'lot-1' } })

    const result = await service.receiveSupply(SUPPLY_ID, ACTOR_ID, acceptedReceiptPayload())

    expect(result.inventory[0].shop_stock_linked).toBe(false)
    expect(shopProductsRepoMock.applyStockChange).not.toHaveBeenCalled()
  })

  it('rounds a fractional accepted quantity to the nearest whole unit (integer stock_quantity column)', async () => {
    const { service } = makeService()
    shopProductsRepoMock.findByShopAndProduct.mockResolvedValue({
      id: 'sp-1',
      shop_id: SHOP_ID,
      product_id: PRODUCT_ID,
      stock_quantity: 5,
      deleted_at: null,
    })
    shopProductsRepoMock.applyStockChange.mockResolvedValue({
      stockProduct: { id: 'sp-1', stock_quantity: 8 },
      movement: { id: 'mv-1' },
    })
    inventoryServiceMock.registerInbound.mockResolvedValue({ lot: { id: 'lot-1' } })

    await service.receiveSupply(SUPPLY_ID, ACTOR_ID, acceptedReceiptPayload({ received_quantity: 2.6, accepted_quantity: 2.6 }))

    const [, params] = shopProductsRepoMock.applyStockChange.mock.calls[0]
    expect(params.delta).toBe(3) // Math.round(2.6)
    expect(params.metadata.quantity_received).toBe(2.6) // exact vendor quantity preserved in the ledger
  })

  it('skips the sync (never a zero-delta write) when a sub-1-unit quantity rounds to zero', async () => {
    const { service } = makeService()
    shopProductsRepoMock.findByShopAndProduct.mockResolvedValue({
      id: 'sp-1',
      shop_id: SHOP_ID,
      product_id: PRODUCT_ID,
      stock_quantity: 5,
      deleted_at: null,
    })
    inventoryServiceMock.registerInbound.mockResolvedValue({ lot: { id: 'lot-1' } })

    const result = await service.receiveSupply(SUPPLY_ID, ACTOR_ID, acceptedReceiptPayload({ received_quantity: 0.4, accepted_quantity: 0.4 }))

    expect(result.inventory[0].shop_stock_linked).toBe(false)
    expect(result.inventory[0].shop_stock_skip_reason).toBe('QUANTITY_ROUNDS_TO_ZERO')
    expect(shopProductsRepoMock.applyStockChange).not.toHaveBeenCalled()
  })

  it('never fails receipt confirmation when the shop-stock sync itself throws (best-effort bridge)', async () => {
    const { service } = makeService()
    shopProductsRepoMock.findByShopAndProduct.mockResolvedValue({
      id: 'sp-1',
      shop_id: SHOP_ID,
      product_id: PRODUCT_ID,
      stock_quantity: 5,
      deleted_at: null,
    })
    shopProductsRepoMock.applyStockChange.mockRejectedValue(new Error('boom'))
    inventoryServiceMock.registerInbound.mockResolvedValue({ lot: { id: 'lot-1' } })

    const result = await service.receiveSupply(SUPPLY_ID, ACTOR_ID, acceptedReceiptPayload())

    // The receipt + inventory lot are unaffected by the sync failure.
    expect(result.receipt).toBeDefined()
    expect(result.inventory[0].inventory_skipped).toBe(false)
    expect(result.inventory[0].inventory_lot_id).toBe('lot-1')
    expect(result.inventory[0].shop_stock_linked).toBe(false)
    expect(result.inventory[0].shop_stock_sync_failed).toBe(true)
  })

  it('skips the sync entirely for a receipt line with no product_id (unmapped/variance-only line)', async () => {
    const { service } = makeService()

    const result = await service.receiveSupply(
      SUPPLY_ID,
      ACTOR_ID,
      acceptedReceiptPayload({ product_id: null })
    )

    expect(result.inventory[0].inventory_skipped).toBe(true)
    expect(result.inventory[0].shop_stock_linked).toBeUndefined()
    expect(shopProductsRepoMock.findByShopAndProduct).not.toHaveBeenCalled()
    expect(shopProductsRepoMock.applyStockChange).not.toHaveBeenCalled()
  })

  it('pre-fills product_id from the awarded supply-order item when the receipt line omits it — a known SKU is never re-picked from scratch', async () => {
    const { service } = makeService({
      findSupplyOrderById: vi.fn(async () => baseSupply({ items: [{ id: SUPPLY_ITEM_ID, agreed_quantity: 10, product_id: PRODUCT_ID }] })),
    })
    shopProductsRepoMock.findByShopAndProduct.mockResolvedValue({
      id: 'sp-1',
      shop_id: SHOP_ID,
      product_id: PRODUCT_ID,
      stock_quantity: 5,
      deleted_at: null,
    })
    shopProductsRepoMock.applyStockChange.mockResolvedValue({
      stockProduct: { id: 'sp-1', stock_quantity: 15 },
      movement: { id: 'mv-1' },
    })
    inventoryServiceMock.registerInbound.mockResolvedValue({ lot: { id: 'lot-1' } })

    // No product_id at all in the receiving payload — it must come from
    // what was already agreed at award time (migration 143).
    const result = await service.receiveSupply(SUPPLY_ID, ACTOR_ID, {
      items: [{ supply_order_item_id: SUPPLY_ITEM_ID, received_quantity: 10, accepted_quantity: 10, rejected_quantity: 0 }],
    })

    expect(result.inventory[0].inventory_skipped).toBe(false)
    expect(inventoryServiceMock.registerInbound).toHaveBeenCalledWith(
      ACTOR_ID,
      expect.objectContaining({ product_id: PRODUCT_ID })
    )
  })

  it('still lets staff override the pre-filled product_id per receipt line if the physical goods differ', async () => {
    const OTHER_PRODUCT = 'product-OTHER'
    const { service } = makeService({
      findSupplyOrderById: vi.fn(async () => baseSupply({ items: [{ id: SUPPLY_ITEM_ID, agreed_quantity: 10, product_id: PRODUCT_ID }] })),
    })
    shopProductsRepoMock.findByShopAndProduct.mockResolvedValue({
      id: 'sp-2',
      shop_id: SHOP_ID,
      product_id: OTHER_PRODUCT,
      stock_quantity: 5,
      deleted_at: null,
    })
    shopProductsRepoMock.applyStockChange.mockResolvedValue({
      stockProduct: { id: 'sp-2', stock_quantity: 15 },
      movement: { id: 'mv-2' },
    })
    inventoryServiceMock.registerInbound.mockResolvedValue({ lot: { id: 'lot-2' } })

    const result = await service.receiveSupply(SUPPLY_ID, ACTOR_ID, acceptedReceiptPayload({ product_id: OTHER_PRODUCT }))

    expect(result.inventory[0].inventory_skipped).toBe(false)
    expect(inventoryServiceMock.registerInbound).toHaveBeenCalledWith(
      ACTOR_ID,
      expect.objectContaining({ product_id: OTHER_PRODUCT })
    )
  })
})
