import { describe, it, expect, vi } from 'vitest'

// Avoid touching Redis/Postgres during the smoke test
vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// Stub BullMQ + Socket.IO so importing the side-effect helpers doesn't
// open Redis connections or fail on missing env vars (task 13.1 wires
// post-commit fan-out through these modules).
vi.mock('../../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn().mockResolvedValue(undefined) },
  stockNotificationsQueue: { add: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('../../../src/plugins/socketio.plugin.js', () => ({
  getSocketIo: vi.fn().mockReturnValue(null),
}))

import { ShopProductsService } from '../../../src/modules/shop-products/shop-products.service.js'
import { ShopProductsRepository } from '../../../src/modules/shop-products/shop-products.repository.js'
import { ShopProductsController } from '../../../src/modules/shop-products/shop-products.controller.js'
import {
  createShopProductSchema,
  updateShopProductSchema,
  stockUpdateSchema,
  listShopProductsQuerySchema,
  shopProductIdParamSchema,
} from '../../../src/modules/shop-products/shop-products.schema.js'

// ═══════════════════════════════════════════════════════════
// Smoke tests — module wiring + Zod schema correctness
// (Detailed property tests are tasks 4.3 / 4.4)
// ═══════════════════════════════════════════════════════════

describe('shop-products module bootstrap', () => {
  it('exports the Repository / Service / Controller classes', () => {
    const repo = new ShopProductsRepository()
    const service = new ShopProductsService(repo)
    const controller = new ShopProductsController(service)

    expect(typeof service.create).toBe('function')
    expect(typeof service.list).toBe('function')
    expect(typeof service.update).toBe('function')
    expect(typeof service.updateStock).toBe('function')
    expect(typeof service.delete).toBe('function')

    expect(typeof controller.create).toBe('function')
    expect(typeof controller.updateStock).toBe('function')
  })
})

describe('shop-products schema validation', () => {
  // Requirement 3.9 — sale_price must be < price
  it('rejects sale_price >= price on create', () => {
    const result = createShopProductSchema.safeParse({
      product_id: '550e8400-e29b-41d4-a716-446655440000',
      price: 100,
      sale_price: 100, // equal → must fail
      stock_quantity: 10,
    })
    expect(result.success).toBe(false)
  })

  it('accepts sale_price < price on create', () => {
    const result = createShopProductSchema.safeParse({
      product_id: '550e8400-e29b-41d4-a716-446655440000',
      price: 100,
      sale_price: 80,
      stock_quantity: 10,
    })
    expect(result.success).toBe(true)
  })

  // Requirement 12.1 — max_order_qty range 1..10000
  it('rejects max_order_qty above 10000', () => {
    const result = createShopProductSchema.safeParse({
      product_id: '550e8400-e29b-41d4-a716-446655440000',
      max_order_qty: 10001,
    })
    expect(result.success).toBe(false)
  })

  it('rejects max_order_qty below 1', () => {
    const result = createShopProductSchema.safeParse({
      product_id: '550e8400-e29b-41d4-a716-446655440000',
      max_order_qty: 0,
    })
    expect(result.success).toBe(false)
  })

  // Requirement 3.5 — stock_quantity must be >= 0
  it('rejects negative stock_quantity', () => {
    const result = createShopProductSchema.safeParse({
      product_id: '550e8400-e29b-41d4-a716-446655440000',
      stock_quantity: -1,
    })
    expect(result.success).toBe(false)
  })

  // Requirement 3.6 — list endpoint pagination caps
  it('caps list limit at 100', () => {
    const result = listShopProductsQuerySchema.safeParse({
      page: '1',
      limit: '101',
    })
    expect(result.success).toBe(false)
  })

  it('uses default page=1 limit=20 on list', () => {
    const result = listShopProductsQuerySchema.safeParse({})
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ page: 1, limit: 20 })
  })

  // stock-update schema: exactly one of stock_quantity | delta
  it('requires exactly one of stock_quantity or delta', () => {
    expect(stockUpdateSchema.safeParse({}).success).toBe(false)
    expect(
      stockUpdateSchema.safeParse({ stock_quantity: 5, delta: 1 }).success
    ).toBe(false)
    expect(stockUpdateSchema.safeParse({ stock_quantity: 5 }).success).toBe(
      true
    )
    expect(stockUpdateSchema.safeParse({ delta: -3 }).success).toBe(true)
  })

  // update schema: at least one field
  it('rejects empty update payload', () => {
    const result = updateShopProductSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  // params schema requires UUID
  it('rejects non-UUID id param', () => {
    expect(
      shopProductIdParamSchema.safeParse({ id: 'not-a-uuid' }).success
    ).toBe(false)
    expect(
      shopProductIdParamSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
      }).success
    ).toBe(true)
  })
})

describe('ShopProductsService.authorizeMutation', () => {
  // Requirement 3.10 — only Shop Admin/Manager/Staff or platform ADMIN
  it('allows platform ADMIN', () => {
    const svc = new ShopProductsService(new ShopProductsRepository())
    expect(svc.authorizeMutation({ role: 'ADMIN' }).ok).toBe(true)
  })

  it('allows SHOP_ADMIN, SHOP_MANAGER, SHOP_STAFF', () => {
    const svc = new ShopProductsService(new ShopProductsRepository())
    for (const shopRole of ['SHOP_ADMIN', 'SHOP_MANAGER', 'SHOP_STAFF']) {
      expect(svc.authorizeMutation({ shopRole }).ok).toBe(true)
    }
  })

  it('rejects SHOP_VIEWER and unrelated roles', () => {
    const svc = new ShopProductsService(new ShopProductsRepository())
    expect(svc.authorizeMutation({ shopRole: 'SHOP_VIEWER' }).ok).toBe(false)
    expect(svc.authorizeMutation({ role: 'CUSTOMER' }).ok).toBe(false)
    expect(svc.authorizeMutation(null).ok).toBe(false)
  })
})

describe('ShopProductsService cache key shape (Requirement 14.3)', () => {
  it('builds the canonical bakaloo:shop-products:v1:{shop}:p{page} key', () => {
    const svc = new ShopProductsService(new ShopProductsRepository())
    const key = svc.cacheKeyForList('shop-uuid', { page: 2, limit: 50 })
    expect(key).toBe('bakaloo:shop-products:v1:shop-uuid:p2:l50')
  })
})
