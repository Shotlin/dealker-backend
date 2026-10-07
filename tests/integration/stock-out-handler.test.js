// Task 23.8 — Stock-out handler integration test
// stock=0 → is_available=false + sold_out_at + Socket.IO event within 2s
// stock=0→positive → is_available=true + push notification (wishlist restock)
//
// Requirements: 11.1, 11.2, 11.3, 11.4, 11.6
// Design: §8.1 (Stock-out side effects)
//
// Approach: exercise ShopProductsService.updateStock() with a fake pg client
// and mock Socket.IO / BullMQ / notifications. Verify the full post-commit
// side-effect chain fires correctly for each stock transition.

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external dependencies BEFORE importing the SUT ──────────────

vi.mock('../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn().mockResolvedValue(undefined) },
  stockNotificationsQueue: { add: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('../../src/config/env.js', () => ({
  env: { NODE_ENV: 'test' },
}))

vi.mock('../../src/utils/audit-log.js', () => ({
  emit: vi.fn(),
  emitInTx: vi.fn(),
}))

// ─── Import SUT after mocks ──────────────────────────────────────────

import { getClient } from '../../src/config/database.js'
import { stockNotificationsQueue, notificationQueue } from '../../src/config/bullmq.js'
import { ShopProductsService } from '../../src/modules/shop-products/shop-products.service.js'

// ─── Test fixtures ───────────────────────────────────────────────────

const SHOP_ID = 'shop-001'
const SHOP_PRODUCT_ID = 'sp-001'
const PRODUCT_ID = 'prod-001'

const mockIoEmits = []
const mockIo = {
  to: vi.fn().mockImplementation((channel) => ({
    emit: vi.fn().mockImplementation((event, payload) => {
      mockIoEmits.push({ channel, event, payload, timestamp: Date.now() })
    }),
  })),
}

function createMockClient(prevQty, newQty) {
  const updatedRow = {
    id: SHOP_PRODUCT_ID,
    product_id: PRODUCT_ID,
    shop_id: SHOP_ID,
    stock_quantity: newQty,
    is_available: newQty > 0,
    sold_out_at: newQty === 0 ? new Date().toISOString() : null,
    low_stock_threshold: 5,
    product_name: 'Test Product',
  }

  return {
    query: vi.fn()
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({
        // findByIdForUpdate (SELECT FOR UPDATE)
        rows: [{
          id: SHOP_PRODUCT_ID,
          product_id: PRODUCT_ID,
          shop_id: SHOP_ID,
          stock_quantity: prevQty,
          is_available: prevQty > 0,
          sold_out_at: prevQty === 0 ? new Date().toISOString() : null,
          low_stock_threshold: 5,
        }],
      })
      .mockResolvedValueOnce({
        // applyStockUpdate (UPDATE ... RETURNING)
        rows: [updatedRow],
      })
      .mockResolvedValueOnce(undefined), // COMMIT
    release: vi.fn(),
  }
}

function createMockRepo() {
  return {
    findByIdForUpdate: vi.fn(),
    applyStockUpdate: vi.fn(),
    findProductMetaById: vi.fn().mockResolvedValue({ product_name: 'Test Product' }),
  }
}

function createMockShopStaffRepo() {
  return {
    findActiveUserIdsByShopAndRoles: vi.fn().mockResolvedValue(['staff-001', 'staff-002']),
  }
}

function createService(mockRepo, overrides = {}) {
  return new ShopProductsService(mockRepo, {
    getIo: () => mockIo,
    notificationQueue,
    stockNotificationsQueue,
    shopStaffRepository: createMockShopStaffRepo(),
    ...overrides,
  })
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('Task 23.8 — Stock-out handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIoEmits.length = 0
  })

  describe('stock → 0: is_available=false + sold_out_at + Socket.IO event', () => {
    it('sets is_available=false when stock reaches 0', async () => {
      const prevQty = 5
      const newQty = 0
      const mockClient = createMockClient(prevQty, newQty)
      getClient.mockResolvedValue(mockClient)

      const mockRepo = createMockRepo()
      mockRepo.findByIdForUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: prevQty,
        is_available: true,
        sold_out_at: null,
        low_stock_threshold: 5,
      })
      mockRepo.applyStockUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 0,
        is_available: false,
        sold_out_at: new Date().toISOString(),
        low_stock_threshold: 5,
      })

      const service = createService(mockRepo)
      const result = await service.updateStock(
        SHOP_ID,
        SHOP_PRODUCT_ID,
        { stock_quantity: 0 },
        { id: 'admin-001', role: 'ADMIN' }
      )

      expect(result.success).toBe(true)
      expect(result.data.is_available).toBe(false)
      expect(result.data.sold_out_at).not.toBeNull()
    })

    it('emits Socket.IO shop:product:stock_out event', async () => {
      const prevQty = 3
      const newQty = 0
      const mockClient = createMockClient(prevQty, newQty)
      getClient.mockResolvedValue(mockClient)

      const mockRepo = createMockRepo()
      mockRepo.findByIdForUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: prevQty,
        is_available: true,
        sold_out_at: null,
        low_stock_threshold: 5,
      })
      mockRepo.applyStockUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 0,
        is_available: false,
        sold_out_at: new Date().toISOString(),
        low_stock_threshold: 5,
      })

      const service = createService(mockRepo)
      await service.updateStock(
        SHOP_ID,
        SHOP_PRODUCT_ID,
        { delta: -3 },
        { id: 'admin-001', role: 'ADMIN' }
      )

      // Verify Socket.IO emission
      expect(mockIo.to).toHaveBeenCalledWith(`shop:${SHOP_ID}`)
      const stockOutEmit = mockIoEmits.find((e) => e.event === 'shop:product:stock_out')
      expect(stockOutEmit).toBeDefined()
      expect(stockOutEmit.payload).toMatchObject({
        shop_product_id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        shop_id: SHOP_ID,
        stock_quantity: 0,
      })
      expect(stockOutEmit.payload).toHaveProperty('sold_out_at')
    })

    it('Socket.IO event fires within 2 seconds of stock update', async () => {
      const startTime = Date.now()
      const mockClient = createMockClient(1, 0)
      getClient.mockResolvedValue(mockClient)

      const mockRepo = createMockRepo()
      mockRepo.findByIdForUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 1,
        is_available: true,
        sold_out_at: null,
        low_stock_threshold: 5,
      })
      mockRepo.applyStockUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 0,
        is_available: false,
        sold_out_at: new Date().toISOString(),
        low_stock_threshold: 5,
      })

      const service = createService(mockRepo)
      await service.updateStock(
        SHOP_ID,
        SHOP_PRODUCT_ID,
        { stock_quantity: 0 },
        { id: 'admin-001', role: 'ADMIN' }
      )

      const stockOutEmit = mockIoEmits.find((e) => e.event === 'shop:product:stock_out')
      expect(stockOutEmit).toBeDefined()
      // Event must fire within 2000ms of the call
      expect(stockOutEmit.timestamp - startTime).toBeLessThan(2000)
    })

    it('sends push notification to shop staff on stock-out', async () => {
      const mockClient = createMockClient(2, 0)
      getClient.mockResolvedValue(mockClient)

      const mockRepo = createMockRepo()
      mockRepo.findByIdForUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 2,
        is_available: true,
        sold_out_at: null,
        low_stock_threshold: 5,
      })
      mockRepo.applyStockUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 0,
        is_available: false,
        sold_out_at: new Date().toISOString(),
        low_stock_threshold: 5,
        product_name: 'Test Product',
      })

      const service = createService(mockRepo)
      await service.updateStock(
        SHOP_ID,
        SHOP_PRODUCT_ID,
        { stock_quantity: 0 },
        { id: 'admin-001', role: 'ADMIN' }
      )

      // Notification queue should have been called for staff
      expect(notificationQueue.add).toHaveBeenCalled()
      const pushCall = notificationQueue.add.mock.calls[0]
      expect(pushCall[0]).toBe('push')
      expect(pushCall[1]).toMatchObject({
        type: 'push',
        title: 'Product out of stock',
      })
    })
  })

  describe('stock 0 → positive: is_available=true + push notification', () => {
    it('sets is_available=true when stock goes from 0 to positive', async () => {
      const prevQty = 0
      const newQty = 10
      const mockClient = createMockClient(prevQty, newQty)
      getClient.mockResolvedValue(mockClient)

      const mockRepo = createMockRepo()
      mockRepo.findByIdForUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 0,
        is_available: false,
        sold_out_at: new Date().toISOString(),
        low_stock_threshold: 5,
      })
      mockRepo.applyStockUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 10,
        is_available: true,
        sold_out_at: null,
        low_stock_threshold: 5,
      })

      const service = createService(mockRepo)
      const result = await service.updateStock(
        SHOP_ID,
        SHOP_PRODUCT_ID,
        { stock_quantity: 10 },
        { id: 'admin-001', role: 'ADMIN' }
      )

      expect(result.success).toBe(true)
      expect(result.data.is_available).toBe(true)
      expect(result.data.sold_out_at).toBeNull()
    })

    it('emits Socket.IO shop:product:restocked event', async () => {
      const mockClient = createMockClient(0, 5)
      getClient.mockResolvedValue(mockClient)

      const mockRepo = createMockRepo()
      mockRepo.findByIdForUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 0,
        is_available: false,
        sold_out_at: new Date().toISOString(),
        low_stock_threshold: 5,
      })
      mockRepo.applyStockUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 5,
        is_available: true,
        sold_out_at: null,
        low_stock_threshold: 5,
      })

      const service = createService(mockRepo)
      await service.updateStock(
        SHOP_ID,
        SHOP_PRODUCT_ID,
        { stock_quantity: 5 },
        { id: 'admin-001', role: 'ADMIN' }
      )

      expect(mockIo.to).toHaveBeenCalledWith(`shop:${SHOP_ID}`)
      const restockEmit = mockIoEmits.find((e) => e.event === 'shop:product:restocked')
      expect(restockEmit).toBeDefined()
      expect(restockEmit.payload).toMatchObject({
        shop_product_id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        shop_id: SHOP_ID,
        stock_quantity: 5,
      })
    })

    it('enqueues wishlist-restock BullMQ job for push notifications', async () => {
      const mockClient = createMockClient(0, 8)
      getClient.mockResolvedValue(mockClient)

      const mockRepo = createMockRepo()
      mockRepo.findByIdForUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 0,
        is_available: false,
        sold_out_at: new Date().toISOString(),
        low_stock_threshold: 5,
      })
      mockRepo.applyStockUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 8,
        is_available: true,
        sold_out_at: null,
        low_stock_threshold: 5,
      })

      const service = createService(mockRepo)
      await service.updateStock(
        SHOP_ID,
        SHOP_PRODUCT_ID,
        { stock_quantity: 8 },
        { id: 'admin-001', role: 'ADMIN' }
      )

      expect(stockNotificationsQueue.add).toHaveBeenCalledWith(
        'wishlist-restock',
        expect.objectContaining({
          type: 'wishlist-restock',
          product_id: PRODUCT_ID,
          shop_id: SHOP_ID,
          shop_product_id: SHOP_PRODUCT_ID,
        }),
        expect.objectContaining({ removeOnComplete: true })
      )
    })
  })

  describe('No transition (stock stays positive or stays zero)', () => {
    it('stock 10 → 5 does NOT emit stock_out event', async () => {
      const mockClient = createMockClient(10, 5)
      getClient.mockResolvedValue(mockClient)

      const mockRepo = createMockRepo()
      mockRepo.findByIdForUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 10,
        is_available: true,
        sold_out_at: null,
        low_stock_threshold: 5,
      })
      mockRepo.applyStockUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 5,
        is_available: true,
        sold_out_at: null,
        low_stock_threshold: 5,
      })

      const service = createService(mockRepo)
      await service.updateStock(
        SHOP_ID,
        SHOP_PRODUCT_ID,
        { stock_quantity: 5 },
        { id: 'admin-001', role: 'ADMIN' }
      )

      const stockOutEmit = mockIoEmits.find((e) => e.event === 'shop:product:stock_out')
      expect(stockOutEmit).toBeUndefined()
    })

    it('stock 10 → 3 (below threshold) triggers low-stock notification', async () => {
      const mockClient = createMockClient(10, 3)
      getClient.mockResolvedValue(mockClient)

      const mockRepo = createMockRepo()
      mockRepo.findByIdForUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 10,
        is_available: true,
        sold_out_at: null,
        low_stock_threshold: 5,
      })
      mockRepo.applyStockUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 3,
        is_available: true,
        sold_out_at: null,
        low_stock_threshold: 5,
      })

      const service = createService(mockRepo)
      await service.updateStock(
        SHOP_ID,
        SHOP_PRODUCT_ID,
        { stock_quantity: 3 },
        { id: 'admin-001', role: 'ADMIN' }
      )

      // Low stock notification should fire
      expect(notificationQueue.add).toHaveBeenCalled()
      const pushCall = notificationQueue.add.mock.calls[0]
      expect(pushCall[1]).toMatchObject({
        type: 'push',
        title: 'Low stock alert',
      })
    })

    it('negative stock is rejected with INSUFFICIENT_STOCK code', async () => {
      const mockClient = createMockClient(3, -2) // Would go negative
      getClient.mockResolvedValue(mockClient)

      const mockRepo = createMockRepo()
      mockRepo.findByIdForUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 3,
        is_available: true,
        sold_out_at: null,
        low_stock_threshold: 5,
      })

      const service = createService(mockRepo)
      const result = await service.updateStock(
        SHOP_ID,
        SHOP_PRODUCT_ID,
        { delta: -5 }, // 3 - 5 = -2 → rejected
        { id: 'admin-001', role: 'ADMIN' }
      )

      expect(result.success).toBe(false)
      expect(result.code).toBe('INSUFFICIENT_STOCK')

      // No side effects should fire
      expect(mockIoEmits).toHaveLength(0)
      expect(stockNotificationsQueue.add).not.toHaveBeenCalled()
    })
  })

  describe('Authorization', () => {
    it('rejects stock update from unauthorized role', async () => {
      const mockRepo = createMockRepo()
      const service = createService(mockRepo)

      const result = await service.updateStock(
        SHOP_ID,
        SHOP_PRODUCT_ID,
        { stock_quantity: 10 },
        { id: 'user-001', role: 'CUSTOMER', shopRole: null }
      )

      expect(result.success).toBe(false)
      expect(result.code).toBe('FORBIDDEN')
    })

    it('allows SHOP_ADMIN to update stock', async () => {
      const mockClient = createMockClient(5, 10)
      getClient.mockResolvedValue(mockClient)

      const mockRepo = createMockRepo()
      mockRepo.findByIdForUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 5,
        is_available: true,
        sold_out_at: null,
        low_stock_threshold: 5,
      })
      mockRepo.applyStockUpdate.mockResolvedValue({
        id: SHOP_PRODUCT_ID,
        product_id: PRODUCT_ID,
        stock_quantity: 10,
        is_available: true,
        sold_out_at: null,
        low_stock_threshold: 5,
      })

      const service = createService(mockRepo)
      const result = await service.updateStock(
        SHOP_ID,
        SHOP_PRODUCT_ID,
        { stock_quantity: 10 },
        { id: 'staff-001', role: 'STAFF', shopRole: 'SHOP_ADMIN' }
      )

      expect(result.success).toBe(true)
    })
  })
})
