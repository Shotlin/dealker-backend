import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external collaborators BEFORE importing the SUT ─────────────
// These mocks match the conventions used in
// tests/unit/shop-products/shop-products.smoke.test.js so the two files
// stay aligned.
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

// Stub BullMQ + Socket.IO so importing the service doesn't open Redis
// connections or fail on missing env vars (task 13.1 wires post-commit
// fan-out through these modules).
vi.mock('../../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn().mockResolvedValue(undefined) },
  stockNotificationsQueue: { add: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('../../../src/plugins/socketio.plugin.js', () => ({
  getSocketIo: vi.fn().mockReturnValue(null),
}))

import { ShopProductsService } from '../../../src/modules/shop-products/shop-products.service.js'
import { ShopProductsRepository } from '../../../src/modules/shop-products/shop-products.repository.js'
import {
  cacheGet,
  cacheSet,
  cacheDeletePattern,
} from '../../../src/utils/cache.js'
import { getClient, query } from '../../../src/config/database.js'

// ═══════════════════════════════════════════════════════════════════════
// Test fixtures
// ═══════════════════════════════════════════════════════════════════════

const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_PRODUCT_ID = '22222222-2222-2222-2222-222222222222'
const PRODUCT_ID = '33333333-3333-3333-3333-333333333333'
const USER_ID = '44444444-4444-4444-4444-444444444444'

/** Build a fully-populated repository mock (one stub per public method). */
function makeRepoMock() {
  return {
    create: vi.fn(),
    revive: vi.fn(),
    findById: vi.fn(),
    findByShopAndProduct: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    findByIdForUpdate: vi.fn(),
    applyStockUpdate: vi.fn(),
  }
}

/**
 * Build a transactional pg client mock that records the BEGIN/COMMIT/ROLLBACK
 * sequence so we can assert ordering and rollback behaviour.
 */
function makeTxClientMock() {
  const calls = []
  const client = {
    query: vi.fn((sql) => {
      calls.push(sql)
      return Promise.resolve({ rows: [], rowCount: 0 })
    }),
    release: vi.fn(),
  }
  return { client, calls }
}

const ADMIN_ACTOR = { id: USER_ID, role: 'ADMIN' }
const VIEWER_ACTOR = { id: USER_ID, shopRole: 'SHOP_VIEWER' }
const CUSTOMER_ACTOR = { id: USER_ID, role: 'CUSTOMER' }

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no cached entry; cacheSet succeeds; pattern delete succeeds
  cacheGet.mockResolvedValue(null)
  cacheSet.mockResolvedValue(undefined)
  cacheDeletePattern.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════
// 1.  ShopProductsService.create  — Req 3.1, 3.9, 12.6, 11.1, 3.10
// ═══════════════════════════════════════════════════════════════════════

describe('ShopProductsService.create', () => {
  it('persists the row with the correct shop_id scope and returns success', async () => {
    const repo = makeRepoMock()
    repo.findByShopAndProduct.mockResolvedValueOnce(null)
    const created = {
      id: SHOP_PRODUCT_ID,
      shop_id: SHOP_ID,
      product_id: PRODUCT_ID,
      price: 100,
      sale_price: 80,
      stock_quantity: 10,
      is_available: true,
    }
    repo.create.mockResolvedValueOnce(created)
    const svc = new ShopProductsService(repo)

    const result = await svc.create(
      SHOP_ID,
      {
        product_id: PRODUCT_ID,
        price: 100,
        sale_price: 80,
        stock_quantity: 10,
        low_stock_threshold: 5,
        max_order_qty: 50,
        is_available: true,
      },
      ADMIN_ACTOR
    )

    expect(result).toEqual({ success: true, data: created })
    expect(repo.create).toHaveBeenCalledTimes(1)
    const passed = repo.create.mock.calls[0][0]
    expect(passed.shop_id).toBe(SHOP_ID)
    expect(passed.product_id).toBe(PRODUCT_ID)
    expect(passed.price).toBe(100)
    expect(passed.sale_price).toBe(80)
    expect(passed.is_available).toBe(true)
  })

  it('rejects sale_price >= price with SALE_PRICE_INVALID', async () => {
    const repo = makeRepoMock()
    repo.findByShopAndProduct.mockResolvedValueOnce(null)
    const svc = new ShopProductsService(repo)

    const result = await svc.create(
      SHOP_ID,
      {
        product_id: PRODUCT_ID,
        price: 100,
        sale_price: 100, // equal → invalid
        stock_quantity: 5,
      },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('SALE_PRICE_INVALID')
    expect(repo.create).not.toHaveBeenCalled()
  })

  it('rejects duplicate (shop_id, product_id) with SHOP_PRODUCT_DUPLICATE', async () => {
    const repo = makeRepoMock()
    repo.findByShopAndProduct.mockResolvedValueOnce({
      id: 'existing-row',
      shop_id: SHOP_ID,
      product_id: PRODUCT_ID,
      deleted_at: null,
    })
    const svc = new ShopProductsService(repo)

    const result = await svc.create(
      SHOP_ID,
      { product_id: PRODUCT_ID, price: 50, stock_quantity: 5 },
      ADMIN_ACTOR
    )

    expect(result).toEqual({
      success: false,
      message: expect.any(String),
      code: 'SHOP_PRODUCT_DUPLICATE',
      // The dashboard's duplicate-add banner links straight to editing the
      // existing row, so the response carries its id alongside the error.
      existingId: 'existing-row',
    })
    expect(repo.create).not.toHaveBeenCalled()
  })

  it('revives a soft-deleted row instead of inserting a duplicate', async () => {
    // Regression test: uq_shop_products_shop_product UNIQUE(shop_id, product_id)
    // is NOT partial — it still counts soft-deleted rows. Re-adding a product
    // that was previously removed from this shop must UPDATE the existing row
    // (repo.revive), never INSERT, or Postgres rejects with 23505 and the
    // request surfaces as an unhandled 500 (see prod incident 2026-06-18).
    const repo = makeRepoMock()
    const existingDeletedRow = {
      id: 'soft-deleted-row',
      shop_id: SHOP_ID,
      product_id: PRODUCT_ID,
      deleted_at: '2026-06-01T00:00:00.000Z',
    }
    repo.findByShopAndProduct.mockResolvedValueOnce(existingDeletedRow)
    const revived = {
      id: 'soft-deleted-row',
      shop_id: SHOP_ID,
      product_id: PRODUCT_ID,
      price: 50,
      stock_quantity: 5,
      is_available: true,
      deleted_at: null,
    }
    repo.revive.mockResolvedValueOnce(revived)
    const svc = new ShopProductsService(repo)

    const result = await svc.create(
      SHOP_ID,
      { product_id: PRODUCT_ID, price: 50, stock_quantity: 5, is_available: true },
      ADMIN_ACTOR
    )

    expect(result).toEqual({ success: true, data: revived })
    expect(repo.revive).toHaveBeenCalledTimes(1)
    expect(repo.revive).toHaveBeenCalledWith(
      'soft-deleted-row',
      SHOP_ID,
      expect.objectContaining({ product_id: PRODUCT_ID, shop_id: SHOP_ID })
    )
    expect(repo.create).not.toHaveBeenCalled()
  })

  it('translates a concurrent 23505 unique violation into SHOP_PRODUCT_DUPLICATE', async () => {
    // Defense-in-depth: two requests can both pass the findByShopAndProduct
    // check (TOCTOU) and race to insert the same (shop_id, product_id). The
    // loser must get a friendly 409, not an unhandled 500.
    const repo = makeRepoMock()
    repo.findByShopAndProduct.mockResolvedValueOnce(null)
    const pgError = new Error('duplicate key value violates unique constraint "uq_shop_products_shop_product"')
    pgError.code = '23505'
    repo.create.mockRejectedValueOnce(pgError)
    const svc = new ShopProductsService(repo)

    const result = await svc.create(
      SHOP_ID,
      { product_id: PRODUCT_ID, price: 50, stock_quantity: 5 },
      ADMIN_ACTOR
    )

    expect(result).toEqual({
      success: false,
      message: expect.any(String),
      code: 'SHOP_PRODUCT_DUPLICATE',
    })
  })

  it('forces is_available=false when initial stock_quantity=0 (Req 11.1)', async () => {
    const repo = makeRepoMock()
    repo.findByShopAndProduct.mockResolvedValueOnce(null)
    repo.create.mockImplementation(async (data) => ({
      id: SHOP_PRODUCT_ID,
      ...data,
    }))
    const svc = new ShopProductsService(repo)

    await svc.create(
      SHOP_ID,
      {
        product_id: PRODUCT_ID,
        price: 50,
        stock_quantity: 0,
        is_available: true, // caller asked for true, but stock is 0
      },
      ADMIN_ACTOR
    )

    const passed = repo.create.mock.calls[0][0]
    expect(passed.is_available).toBe(false)
    expect(passed.stock_quantity).toBe(0)
  })

  it.each([
    ['ADMIN', { id: USER_ID, role: 'ADMIN' }, true],
    ['SHOP_ADMIN', { id: USER_ID, shopRole: 'SHOP_ADMIN' }, true],
    ['SHOP_MANAGER', { id: USER_ID, shopRole: 'SHOP_MANAGER' }, true],
    ['SHOP_STAFF', { id: USER_ID, shopRole: 'SHOP_STAFF' }, true],
    ['SHOP_VIEWER', { id: USER_ID, shopRole: 'SHOP_VIEWER' }, false],
    ['CUSTOMER', { id: USER_ID, role: 'CUSTOMER' }, false],
    ['null actor', null, false],
  ])(
    'authorizes %s correctly (Req 3.10)',
    async (_label, actor, allowed) => {
      const repo = makeRepoMock()
      repo.findByShopAndProduct.mockResolvedValue(null)
      repo.create.mockResolvedValue({ id: SHOP_PRODUCT_ID })
      const svc = new ShopProductsService(repo)

      const result = await svc.create(
        SHOP_ID,
        { product_id: PRODUCT_ID, price: 50, stock_quantity: 5 },
        actor
      )

      if (allowed) {
        expect(result.success).toBe(true)
        expect(repo.create).toHaveBeenCalled()
      } else {
        expect(result.success).toBe(false)
        // null actor → UNAUTHORIZED, all other unauthorized roles → FORBIDDEN
        expect(['FORBIDDEN', 'UNAUTHORIZED']).toContain(result.code)
        expect(repo.create).not.toHaveBeenCalled()
      }
    }
  )

  it('invalidates the Redis cache pattern after a successful create', async () => {
    const repo = makeRepoMock()
    repo.findByShopAndProduct.mockResolvedValueOnce(null)
    repo.create.mockResolvedValueOnce({ id: SHOP_PRODUCT_ID })
    const svc = new ShopProductsService(repo)

    await svc.create(
      SHOP_ID,
      { product_id: PRODUCT_ID, price: 50, stock_quantity: 5 },
      ADMIN_ACTOR
    )

    expect(cacheDeletePattern).toHaveBeenCalledTimes(1)
    expect(cacheDeletePattern).toHaveBeenCalledWith(
      `bakaloo:shop-products:v1:${SHOP_ID}:*`
    )
  })

  it('does NOT invalidate cache when authorization fails', async () => {
    const repo = makeRepoMock()
    const svc = new ShopProductsService(repo)

    const result = await svc.create(
      SHOP_ID,
      { product_id: PRODUCT_ID, price: 50, stock_quantity: 5 },
      VIEWER_ACTOR
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('FORBIDDEN')
    expect(cacheDeletePattern).not.toHaveBeenCalled()
    expect(repo.create).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 2.  ShopProductsService.update  — Req 3.9, 12.5, 12.6
// ═══════════════════════════════════════════════════════════════════════

describe('ShopProductsService.update', () => {
  it('rejects sale_price >= price using merged values (existing + delta)', async () => {
    const repo = makeRepoMock()
    // Existing row has price=100; delta sets sale_price=120 → 120 >= 100 → reject
    repo.findById.mockResolvedValueOnce({
      id: SHOP_PRODUCT_ID,
      shop_id: SHOP_ID,
      price: 100,
      sale_price: 80,
    })
    const svc = new ShopProductsService(repo)

    const result = await svc.update(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { sale_price: 120 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('SALE_PRICE_INVALID')
    expect(repo.update).not.toHaveBeenCalled()
  })

  it('also catches the merge case where price is lowered to existing sale_price', async () => {
    const repo = makeRepoMock()
    // Existing sale_price=80; delta lowers price to 80 → equal → reject
    repo.findById.mockResolvedValueOnce({
      id: SHOP_PRODUCT_ID,
      shop_id: SHOP_ID,
      price: 100,
      sale_price: 80,
    })
    const svc = new ShopProductsService(repo)

    const result = await svc.update(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { price: 80 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('SALE_PRICE_INVALID')
    expect(repo.update).not.toHaveBeenCalled()
  })

  it('returns SHOP_PRODUCT_NOT_FOUND when the record is missing', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce(null)
    const svc = new ShopProductsService(repo)

    const result = await svc.update(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { price: 99 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('SHOP_PRODUCT_NOT_FOUND')
    expect(repo.update).not.toHaveBeenCalled()
    expect(cacheDeletePattern).not.toHaveBeenCalled()
  })

  it('invalidates the cache pattern after a successful update (Req 12.5)', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce({
      id: SHOP_PRODUCT_ID,
      shop_id: SHOP_ID,
      price: 100,
      sale_price: 80,
    })
    repo.update.mockResolvedValueOnce({
      id: SHOP_PRODUCT_ID,
      shop_id: SHOP_ID,
      price: 100,
      sale_price: 70,
      max_order_qty: 30,
    })
    const svc = new ShopProductsService(repo)

    const result = await svc.update(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { sale_price: 70, max_order_qty: 30 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(true)
    expect(cacheDeletePattern).toHaveBeenCalledWith(
      `bakaloo:shop-products:v1:${SHOP_ID}:*`
    )
  })

  it.each([
    ['ADMIN', { id: USER_ID, role: 'ADMIN' }, true],
    ['SHOP_MANAGER', { id: USER_ID, shopRole: 'SHOP_MANAGER' }, true],
    ['SHOP_STAFF', { id: USER_ID, shopRole: 'SHOP_STAFF' }, true],
    ['SHOP_VIEWER', { id: USER_ID, shopRole: 'SHOP_VIEWER' }, false],
    ['CUSTOMER', { id: USER_ID, role: 'CUSTOMER' }, false],
  ])('authorizes update for %s correctly', async (_label, actor, allowed) => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValue({
      id: SHOP_PRODUCT_ID,
      shop_id: SHOP_ID,
      price: 100,
      sale_price: 80,
    })
    repo.update.mockResolvedValue({ id: SHOP_PRODUCT_ID, price: 100 })
    const svc = new ShopProductsService(repo)

    const result = await svc.update(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { is_available: false },
      actor
    )

    if (allowed) {
      expect(result.success).toBe(true)
      expect(repo.update).toHaveBeenCalled()
    } else {
      expect(result.success).toBe(false)
      expect(result.code).toBe('FORBIDDEN')
      expect(repo.update).not.toHaveBeenCalled()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 3.  ShopProductsService.updateStock  — Req 3.5, 3.8, 11.7
// ═══════════════════════════════════════════════════════════════════════

describe('ShopProductsService.updateStock', () => {
  it('runs inside a BEGIN → COMMIT transaction and locks the row before applying', async () => {
    const repo = makeRepoMock()
    repo.findByIdForUpdate.mockResolvedValueOnce({
      id: SHOP_PRODUCT_ID,
      shop_id: SHOP_ID,
      stock_quantity: 10,
      is_available: true,
    })
    repo.applyStockUpdate.mockResolvedValueOnce({
      id: SHOP_PRODUCT_ID,
      stock_quantity: 8,
      is_available: true,
    })
    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = new ShopProductsService(repo)

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { delta: -2, reason: 'manual adjust' },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(true)
    expect(result.data.stock_quantity).toBe(8)
    expect(result.prev).toEqual({ stock_quantity: 10, is_available: true })

    // Ordering: BEGIN before findByIdForUpdate before applyStockUpdate before COMMIT
    expect(calls[0]).toBe('BEGIN')
    expect(calls[calls.length - 1]).toBe('COMMIT')

    expect(repo.findByIdForUpdate).toHaveBeenCalledTimes(1)
    expect(repo.findByIdForUpdate).toHaveBeenCalledWith(
      client,
      SHOP_PRODUCT_ID,
      SHOP_ID
    )
    expect(repo.applyStockUpdate).toHaveBeenCalledTimes(1)
    expect(repo.applyStockUpdate).toHaveBeenCalledWith(
      client,
      SHOP_PRODUCT_ID,
      SHOP_ID,
      8
    )

    // findByIdForUpdate must run before applyStockUpdate
    const lockOrder = repo.findByIdForUpdate.mock.invocationCallOrder[0]
    const applyOrder = repo.applyStockUpdate.mock.invocationCallOrder[0]
    expect(applyOrder).toBeGreaterThan(lockOrder)

    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('rejects with INSUFFICIENT_STOCK when delta would push below zero, and rolls back', async () => {
    const repo = makeRepoMock()
    repo.findByIdForUpdate.mockResolvedValueOnce({
      id: SHOP_PRODUCT_ID,
      shop_id: SHOP_ID,
      stock_quantity: 3,
      is_available: true,
    })
    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = new ShopProductsService(repo)

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { delta: -5 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('INSUFFICIENT_STOCK')
    expect(repo.applyStockUpdate).not.toHaveBeenCalled()
    expect(calls).toContain('BEGIN')
    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    expect(client.release).toHaveBeenCalledTimes(1)
    // Cache must NOT be invalidated on rollback
    expect(cacheDeletePattern).not.toHaveBeenCalled()
  })

  it('rejects with NEGATIVE_STOCK when an absolute target value is < 0', async () => {
    const repo = makeRepoMock()
    repo.findByIdForUpdate.mockResolvedValueOnce({
      id: SHOP_PRODUCT_ID,
      shop_id: SHOP_ID,
      stock_quantity: 5,
      is_available: true,
    })
    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = new ShopProductsService(repo)

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: -1 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('NEGATIVE_STOCK')
    expect(repo.applyStockUpdate).not.toHaveBeenCalled()
    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    expect(cacheDeletePattern).not.toHaveBeenCalled()
  })

  it('returns SHOP_PRODUCT_NOT_FOUND when the locked row is missing', async () => {
    const repo = makeRepoMock()
    repo.findByIdForUpdate.mockResolvedValueOnce(null)
    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = new ShopProductsService(repo)

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { delta: 1 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('SHOP_PRODUCT_NOT_FOUND')
    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('translates a Postgres CHECK violation (23514) into NEGATIVE_STOCK and rolls back', async () => {
    const repo = makeRepoMock()
    repo.findByIdForUpdate.mockResolvedValueOnce({
      id: SHOP_PRODUCT_ID,
      shop_id: SHOP_ID,
      stock_quantity: 5,
      is_available: true,
    })
    const checkViolation = Object.assign(
      new Error('check constraint violated'),
      { code: '23514' }
    )
    repo.applyStockUpdate.mockRejectedValueOnce(checkViolation)
    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = new ShopProductsService(repo)

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 5 }, // legal in service guard, but DB rejects
      ADMIN_ACTOR
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('NEGATIVE_STOCK')
    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    expect(client.release).toHaveBeenCalledTimes(1)
    expect(cacheDeletePattern).not.toHaveBeenCalled()
  })

  it('always releases the client AND rolls back when an unexpected error occurs', async () => {
    const repo = makeRepoMock()
    repo.findByIdForUpdate.mockRejectedValueOnce(new Error('boom'))
    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = new ShopProductsService(repo)

    await expect(
      svc.updateStock(SHOP_ID, SHOP_PRODUCT_ID, { delta: 1 }, ADMIN_ACTOR)
    ).rejects.toThrow('boom')

    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    expect(client.release).toHaveBeenCalledTimes(1)
    expect(cacheDeletePattern).not.toHaveBeenCalled()
  })

  it('invalidates cache only AFTER COMMIT (success path)', async () => {
    const repo = makeRepoMock()
    repo.findByIdForUpdate.mockResolvedValueOnce({
      id: SHOP_PRODUCT_ID,
      shop_id: SHOP_ID,
      stock_quantity: 4,
      is_available: true,
    })
    repo.applyStockUpdate.mockResolvedValueOnce({
      id: SHOP_PRODUCT_ID,
      stock_quantity: 5,
      is_available: true,
    })
    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)
    const svc = new ShopProductsService(repo)

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { stock_quantity: 5 },
      ADMIN_ACTOR
    )

    expect(result.success).toBe(true)
    expect(calls).toContain('COMMIT')
    expect(cacheDeletePattern).toHaveBeenCalledTimes(1)

    // Locate the COMMIT call's invocation order
    const commitCallIdx = client.query.mock.calls.findIndex(
      (c) => c[0] === 'COMMIT'
    )
    const commitOrder = client.query.mock.invocationCallOrder[commitCallIdx]
    const invalidateOrder = cacheDeletePattern.mock.invocationCallOrder[0]
    expect(invalidateOrder).toBeGreaterThan(commitOrder)
  })

  it('rejects callers without a permitted role (FORBIDDEN) and never opens a tx', async () => {
    const repo = makeRepoMock()
    const svc = new ShopProductsService(repo)

    const result = await svc.updateStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { delta: 1 },
      VIEWER_ACTOR
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('FORBIDDEN')
    expect(getClient).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 4.  ShopProductsService.delete  — Req 3.10, 12.5
// ═══════════════════════════════════════════════════════════════════════

describe('ShopProductsService.delete', () => {
  it('returns SHOP_PRODUCT_NOT_FOUND when the row is missing', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce(null)
    const svc = new ShopProductsService(repo)

    const result = await svc.delete(SHOP_ID, SHOP_PRODUCT_ID, ADMIN_ACTOR)

    expect(result.success).toBe(false)
    expect(result.code).toBe('SHOP_PRODUCT_NOT_FOUND')
    expect(repo.softDelete).not.toHaveBeenCalled()
    expect(cacheDeletePattern).not.toHaveBeenCalled()
  })

  it('soft-deletes via the repository and invalidates cache on success', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce({
      id: SHOP_PRODUCT_ID,
      shop_id: SHOP_ID,
    })
    repo.softDelete.mockResolvedValueOnce(true)
    const svc = new ShopProductsService(repo)

    const result = await svc.delete(SHOP_ID, SHOP_PRODUCT_ID, ADMIN_ACTOR)

    expect(result).toEqual({ success: true })
    expect(repo.softDelete).toHaveBeenCalledWith(SHOP_PRODUCT_ID, SHOP_ID)
    expect(cacheDeletePattern).toHaveBeenCalledWith(
      `bakaloo:shop-products:v1:${SHOP_ID}:*`
    )
  })

  it('returns SHOP_PRODUCT_NOT_FOUND when softDelete reports zero rows affected', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce({
      id: SHOP_PRODUCT_ID,
      shop_id: SHOP_ID,
    })
    repo.softDelete.mockResolvedValueOnce(false)
    const svc = new ShopProductsService(repo)

    const result = await svc.delete(SHOP_ID, SHOP_PRODUCT_ID, ADMIN_ACTOR)

    expect(result.success).toBe(false)
    expect(result.code).toBe('SHOP_PRODUCT_NOT_FOUND')
    expect(cacheDeletePattern).not.toHaveBeenCalled()
  })

  it('rejects unauthorized actors with FORBIDDEN', async () => {
    const repo = makeRepoMock()
    const svc = new ShopProductsService(repo)

    const result = await svc.delete(SHOP_ID, SHOP_PRODUCT_ID, CUSTOMER_ACTOR)

    expect(result.success).toBe(false)
    expect(result.code).toBe('FORBIDDEN')
    expect(repo.findById).not.toHaveBeenCalled()
    expect(repo.softDelete).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 5.  Pagination + listing cache  — Req 3.6, 3.7, 12.5
// ═══════════════════════════════════════════════════════════════════════

describe('ShopProductsService.list (pagination + caching)', () => {
  it('on a cache HIT returns the cached object without hitting the repository', async () => {
    const repo = makeRepoMock()
    const cached = { items: [{ id: 'a' }], total: 1, page: 1, limit: 20 }
    cacheGet.mockResolvedValueOnce(cached)
    const svc = new ShopProductsService(repo)

    const out = await svc.list(SHOP_ID, { page: 1, limit: 20 })

    expect(out).toBe(cached)
    expect(repo.findMany).not.toHaveBeenCalled()
    expect(cacheSet).not.toHaveBeenCalled()
  })

  it('on a cache MISS queries the repo and stores with TTL=120', async () => {
    const repo = makeRepoMock()
    repo.findMany.mockResolvedValueOnce({ items: [{ id: 'a' }], total: 1 })
    cacheGet.mockResolvedValueOnce(null)
    const svc = new ShopProductsService(repo)

    const out = await svc.list(SHOP_ID, { page: 1, limit: 20 })

    expect(out).toEqual({
      items: [{ id: 'a' }],
      total: 1,
      page: 1,
      limit: 20,
    })
    expect(repo.findMany).toHaveBeenCalledTimes(1)
    expect(cacheSet).toHaveBeenCalledTimes(1)
    const [, , ttl] = cacheSet.mock.calls[0]
    expect(ttl).toBe(120)
  })

  it('uses canonical cache key bakaloo:shop-products:v1:{shop_id}:p{page}:l{limit}…', () => {
    const svc = new ShopProductsService(makeRepoMock())

    expect(svc.cacheKeyForList(SHOP_ID, { page: 1, limit: 20 })).toBe(
      `bakaloo:shop-products:v1:${SHOP_ID}:p1:l20`
    )

    // Optional filters appended in a stable order
    expect(
      svc.cacheKeyForList(SHOP_ID, {
        page: 2,
        limit: 50,
        is_available: 'true',
        low_stock: 'true',
        search: 'milk',
        includeDeleted: true,
      })
    ).toBe(
      `bakaloo:shop-products:v1:${SHOP_ID}:p2:l50:atrue:lstrue:smilk:inc-del`
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 6.  Repository SQL safety
// ═══════════════════════════════════════════════════════════════════════

describe('ShopProductsRepository — SQL safety', () => {
  it('SELECT/UPDATE/INSERT statements never use SELECT *', async () => {
    const repo = new ShopProductsRepository()

    query.mockResolvedValue({ rows: [], rowCount: 0 })

    await repo.findById(SHOP_PRODUCT_ID, SHOP_ID)
    await repo.findByShopAndProduct(SHOP_ID, PRODUCT_ID)
    await repo.findMany({ shopId: SHOP_ID, page: 1, limit: 20 })
    await repo.update(SHOP_PRODUCT_ID, SHOP_ID, { price: 99 })
    await repo.softDelete(SHOP_PRODUCT_ID, SHOP_ID)
    await repo.create({
      shop_id: SHOP_ID,
      product_id: PRODUCT_ID,
      price: 100,
      sale_price: 80,
      cost_price: 60,
      stock_quantity: 10,
      low_stock_threshold: 5,
      max_order_qty: 50,
      is_available: true,
    })

    const allSql = query.mock.calls.map(([text]) => text)
    expect(allSql.length).toBeGreaterThan(0)
    for (const sql of allSql) {
      expect(sql).not.toMatch(/SELECT\s+\*/i)
    }
  })

  it('findById uses parameterized $1, $2 placeholders (no string interpolation)', async () => {
    const repo = new ShopProductsRepository()
    query.mockResolvedValue({ rows: [], rowCount: 0 })

    await repo.findById(SHOP_PRODUCT_ID, SHOP_ID)

    const [sql, params] = query.mock.calls[0]
    expect(sql).toMatch(/\$1/)
    expect(sql).toMatch(/\$2/)
    expect(params).toEqual([SHOP_PRODUCT_ID, SHOP_ID])
    // Make sure raw values weren't baked into the SQL string
    expect(sql).not.toContain(SHOP_PRODUCT_ID)
    expect(sql).not.toContain(SHOP_ID)
  })

  it('findMany builds parameterized search and pagination clauses ($1..$N)', async () => {
    const repo = new ShopProductsRepository()
    query.mockResolvedValue({ rows: [{ total: 0 }], rowCount: 0 })

    await repo.findMany({
      shopId: SHOP_ID,
      page: 2,
      limit: 30,
      search: 'milk',
    })

    expect(query.mock.calls.length).toBeGreaterThanOrEqual(2)
    const dataCall = query.mock.calls[0]
    const [dataSql, dataParams] = dataCall
    // Must reference $1 (shopId), $2 (search), $3 (limit), $4 (offset)
    expect(dataSql).toMatch(/\$1/)
    expect(dataSql).toMatch(/\$2/)
    expect(dataSql).toMatch(/\$3/)
    expect(dataSql).toMatch(/\$4/)
    expect(dataParams[0]).toBe(SHOP_ID)
    expect(dataParams).toContain('%milk%')
    expect(dataParams).toContain(30) // limit
    expect(dataParams).toContain(30) // offset = (page-1)*limit = 30
    // The literal user value must NOT be inlined into the SQL text
    expect(dataSql).not.toContain('milk')
  })

  it('create uses ten parameterized placeholders and names every column explicitly', async () => {
    const repo = new ShopProductsRepository()
    query.mockResolvedValue({
      rows: [{ id: SHOP_PRODUCT_ID }],
      rowCount: 1,
    })

    await repo.create({
      shop_id: SHOP_ID,
      product_id: PRODUCT_ID,
      price: 100,
      sale_price: 80,
      cost_price: 60,
      stock_quantity: 10,
      low_stock_threshold: 5,
      max_order_qty: 50,
      is_available: true,
    })

    const [sql, params] = query.mock.calls[0]
    expect(sql).toMatch(/INSERT INTO shop_products/i)
    for (let i = 1; i <= 11; i++) {
      expect(sql).toContain(`$${i}`)
    }
    expect(params).toHaveLength(11)
    // Column list must be explicit
    expect(sql).toMatch(/shop_id,\s*product_id/)
  })

  it('findByIdForUpdate executes via the transactional client and uses FOR UPDATE', async () => {
    const repo = new ShopProductsRepository()
    const { client } = makeTxClientMock()
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    await repo.findByIdForUpdate(client, SHOP_PRODUCT_ID, SHOP_ID)

    const [sql, params] = client.query.mock.calls[0]
    expect(sql).toMatch(/FOR UPDATE/i)
    expect(sql).toMatch(/\$1/)
    expect(sql).toMatch(/\$2/)
    expect(sql).not.toMatch(/SELECT\s+\*/i)
    expect(params).toEqual([SHOP_PRODUCT_ID, SHOP_ID])
    // It should not run on the pool's plain query helper
    expect(query).not.toHaveBeenCalled()
  })
})
