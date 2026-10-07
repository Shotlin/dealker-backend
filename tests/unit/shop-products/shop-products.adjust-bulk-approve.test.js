import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external collaborators BEFORE importing the SUT ─────────────
// Mirrors the convention used in
// tests/unit/shop-products/shop-products.service.test.js and the smoke
// test so the three files stay aligned.

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

// emitInTx is awaited — return undefined so the await resolves cleanly.
// emit is fire-and-forget; we still mock it to silence side effects.
vi.mock('../../../src/utils/audit-log.js', () => ({
  emit: vi.fn(),
  emitInTx: vi.fn().mockResolvedValue(undefined),
  redact: (v) => v,
}))

import { ShopProductsService } from '../../../src/modules/shop-products/shop-products.service.js'
import { cacheDeletePattern } from '../../../src/utils/cache.js'
import { getClient } from '../../../src/config/database.js'
import { emitInTx as emitAuditInTx } from '../../../src/utils/audit-log.js'

// ═══════════════════════════════════════════════════════════════════════
// Test fixtures
// ═══════════════════════════════════════════════════════════════════════

const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_PRODUCT_ID = '22222222-2222-2222-2222-222222222222'
const PRODUCT_ID = '33333333-3333-3333-3333-333333333333'
const USER_ID = '44444444-4444-4444-4444-444444444444'

function makeRepoMock() {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findByShopAndProduct: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    findByIdForUpdate: vi.fn(),
    applyStockUpdate: vi.fn(),
    applyStockChange: vi.fn(),
    applyPriceUpdate: vi.fn(),
    findStockMovements: vi.fn(),
    findByIdForApprovalUpdate: vi.fn(),
    setApproved: vi.fn(),
    setRejected: vi.fn(),
  }
}

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

const ADMIN_ACTOR = {
  id: USER_ID,
  role: 'ADMIN',
  platformRole: 'SUPER_ADMIN',
  ip: '127.0.0.1',
  userAgent: 'test',
}
const SHOP_ADMIN_ACTOR = {
  id: USER_ID,
  shopRole: 'SHOP_ADMIN',
  ip: '127.0.0.1',
  userAgent: 'test',
}

beforeEach(() => {
  vi.clearAllMocks()
  cacheDeletePattern.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════
// adjustStock (R23.8, R23.9, R23.14)
// ═══════════════════════════════════════════════════════════════════════

describe('ShopProductsService.adjustStock', () => {
  it('opens a transaction, calls applyStockChange with DASHBOARD source, emits stock_changed audit, COMMITs, and invalidates cache', async () => {
    const repo = makeRepoMock()
    const updated = {
      id: SHOP_PRODUCT_ID,
      shop_id: SHOP_ID,
      product_id: PRODUCT_ID,
      stock_quantity: 12,
      is_available: true,
      low_stock_threshold: 5,
    }
    const movement = {
      id: 'mv-1',
      shop_product_id: SHOP_PRODUCT_ID,
      quantity_before: 10,
      quantity_after: 12,
      quantity_delta: 2,
      type: 'MANUAL_ADJUSTMENT',
      source: 'DASHBOARD',
    }
    repo.applyStockChange.mockResolvedValueOnce({
      stockProduct: updated,
      movement,
    })

    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)

    const svc = new ShopProductsService(repo)
    const result = await svc.adjustStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      {
        quantity_delta: 2,
        type: 'MANUAL_ADJUSTMENT',
        reason: 'Restock from supplier',
      },
      SHOP_ADMIN_ACTOR
    )

    expect(result.success).toBe(true)
    expect(result.data).toEqual(updated)
    expect(result.movement).toEqual(movement)

    // applyStockChange called with the right args
    expect(repo.applyStockChange).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        shopProductId: SHOP_PRODUCT_ID,
        delta: 2,
        type: 'MANUAL_ADJUSTMENT',
        reason: 'Restock from supplier',
        source: 'DASHBOARD',
        actor: { userId: USER_ID, shopRole: 'SHOP_ADMIN' },
        orderId: null,
      })
    )

    // Audit emitted transactionally with stock_changed action and product_id
    expect(emitAuditInTx).toHaveBeenCalledWith(
      client,
      'stock_changed',
      expect.objectContaining({
        target_type: 'shop_product',
        target_id: SHOP_PRODUCT_ID,
        actor_user_id: USER_ID,
        actor_shop_id: SHOP_ID,
      })
    )

    // BEGIN/COMMIT order
    expect(calls[0]).toBe('BEGIN')
    expect(calls[calls.length - 1]).toBe('COMMIT')
    expect(client.release).toHaveBeenCalled()

    // Cache invalidation runs AFTER COMMIT
    expect(cacheDeletePattern).toHaveBeenCalledWith(
      expect.stringContaining(`bakaloo:shop-products:v1:${SHOP_ID}:`)
    )
  })

  it('returns 409 STOCK_NEGATIVE_FORBIDDEN on negative result and rolls back', async () => {
    const repo = makeRepoMock()
    const negativeErr = Object.assign(new Error('Resulting stock_quantity cannot be negative'), {
      code: 'STOCK_NEGATIVE_FORBIDDEN',
      statusCode: 409,
      details: { before: 5, delta: -10, after: -5 },
    })
    repo.applyStockChange.mockRejectedValueOnce(negativeErr)

    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)

    const svc = new ShopProductsService(repo)
    const result = await svc.adjustStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { quantity_delta: -10, type: 'DAMAGED_STOCK', reason: 'Spoiled' },
      SHOP_ADMIN_ACTOR
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('STOCK_NEGATIVE_FORBIDDEN')
    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    expect(emitAuditInTx).not.toHaveBeenCalled()
    expect(cacheDeletePattern).not.toHaveBeenCalled()
  })

  it('returns 404 PRODUCT_NOT_FOUND on missing shop_product', async () => {
    const repo = makeRepoMock()
    const notFoundErr = Object.assign(new Error('Shop product not found'), {
      code: 'PRODUCT_NOT_FOUND',
      statusCode: 404,
    })
    repo.applyStockChange.mockRejectedValueOnce(notFoundErr)

    const { client } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)

    const svc = new ShopProductsService(repo)
    const result = await svc.adjustStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { quantity_delta: 5, type: 'MANUAL_ADJUSTMENT', reason: 'noop' },
      SHOP_ADMIN_ACTOR
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('PRODUCT_NOT_FOUND')
  })

  it('rejects non-staff non-admin actors before opening a transaction', async () => {
    const repo = makeRepoMock()
    const svc = new ShopProductsService(repo)
    const result = await svc.adjustStock(
      SHOP_ID,
      SHOP_PRODUCT_ID,
      { quantity_delta: 1, type: 'MANUAL_ADJUSTMENT', reason: 'r' },
      { id: USER_ID, role: 'CUSTOMER' }
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('FORBIDDEN')
    expect(getClient).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// bulkPriceUpdate (R23.12)
// ═══════════════════════════════════════════════════════════════════════

describe('ShopProductsService.bulkPriceUpdate', () => {
  it('updates each item in one transaction, never invokes applyStockChange, and emits exactly ONE bulk audit row', async () => {
    const repo = makeRepoMock()

    // Two items, each resolved via findByShopAndProduct → findByIdForUpdate
    // → applyPriceUpdate.
    const sp1 = {
      id: 'sp-1',
      shop_id: SHOP_ID,
      product_id: 'p-1',
      price: '100.00',
      sale_price: null,
      cost_price: '50.00',
      deleted_at: null,
    }
    const sp2 = {
      id: 'sp-2',
      shop_id: SHOP_ID,
      product_id: 'p-2',
      price: '200.00',
      sale_price: '180.00',
      cost_price: null,
      deleted_at: null,
    }
    repo.findByShopAndProduct
      .mockResolvedValueOnce(sp1)
      .mockResolvedValueOnce(sp2)
    repo.findByIdForUpdate
      .mockResolvedValueOnce(sp1)
      .mockResolvedValueOnce(sp2)
    repo.applyPriceUpdate
      .mockResolvedValueOnce({ ...sp1, price: '110.00' })
      .mockResolvedValueOnce({ ...sp2, sale_price: '170.00' })

    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)

    const svc = new ShopProductsService(repo)
    const result = await svc.bulkPriceUpdate(
      SHOP_ID,
      {
        items: [
          { product_id: 'p-1', price: 110 },
          { product_id: 'p-2', sale_price: 170 },
        ],
      },
      SHOP_ADMIN_ACTOR
    )

    expect(result.success).toBe(true)
    expect(result.data.updated_count).toBe(2)
    expect(repo.applyPriceUpdate).toHaveBeenCalledTimes(2)
    // Stock ledger is NEVER touched in bulk-price-update (R23.12).
    expect(repo.applyStockChange).not.toHaveBeenCalled()

    // Exactly ONE bulk audit row emitted with both before+after items.
    expect(emitAuditInTx).toHaveBeenCalledTimes(1)
    expect(emitAuditInTx).toHaveBeenCalledWith(
      client,
      'shop_products_bulk_price_updated',
      expect.objectContaining({
        actor_user_id: USER_ID,
        actor_shop_id: SHOP_ID,
        target_type: 'shop_products_batch',
        before: { items: expect.any(Array) },
        after: { items: expect.any(Array) },
      })
    )
    const auditCall = emitAuditInTx.mock.calls[0][2]
    expect(auditCall.before.items).toHaveLength(2)
    expect(auditCall.after.items).toHaveLength(2)

    expect(calls[0]).toBe('BEGIN')
    expect(calls[calls.length - 1]).toBe('COMMIT')
    expect(cacheDeletePattern).toHaveBeenCalled()
  })

  it('rejects duplicate product_id without opening a transaction', async () => {
    const repo = makeRepoMock()
    const svc = new ShopProductsService(repo)
    const result = await svc.bulkPriceUpdate(
      SHOP_ID,
      {
        items: [
          { product_id: 'p-1', price: 10 },
          { product_id: 'p-1', price: 20 }, // duplicate
        ],
      },
      SHOP_ADMIN_ACTOR
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('VALIDATION_ERROR')
    expect(getClient).not.toHaveBeenCalled()
  })

  it('rolls back the entire batch when one item is missing', async () => {
    const repo = makeRepoMock()
    repo.findByShopAndProduct
      .mockResolvedValueOnce({
        id: 'sp-1',
        shop_id: SHOP_ID,
        product_id: 'p-1',
        price: '10.00',
        sale_price: null,
        cost_price: null,
        deleted_at: null,
      })
      .mockResolvedValueOnce(null) // p-2 missing
    repo.findByIdForUpdate.mockResolvedValueOnce({
      id: 'sp-1',
      shop_id: SHOP_ID,
      product_id: 'p-1',
      price: '10.00',
      sale_price: null,
      cost_price: null,
    })
    repo.applyPriceUpdate.mockResolvedValueOnce({
      id: 'sp-1',
      shop_id: SHOP_ID,
      product_id: 'p-1',
      price: '12.00',
      sale_price: null,
      cost_price: null,
    })

    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)

    const svc = new ShopProductsService(repo)
    const result = await svc.bulkPriceUpdate(
      SHOP_ID,
      {
        items: [
          { product_id: 'p-1', price: 12 },
          { product_id: 'p-2', price: 20 },
        ],
      },
      SHOP_ADMIN_ACTOR
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('PRODUCT_NOT_FOUND')
    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    expect(emitAuditInTx).not.toHaveBeenCalled()
    expect(cacheDeletePattern).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// listStockMovements (R23.5)
// ═══════════════════════════════════════════════════════════════════════

describe('ShopProductsService.listStockMovements', () => {
  it('forwards filters to the repository and returns paginated payload', async () => {
    const repo = makeRepoMock()
    repo.findStockMovements.mockResolvedValueOnce({
      items: [{ id: 'mv-1' }],
      total: 1,
    })

    const svc = new ShopProductsService(repo)
    const result = await svc.listStockMovements(SHOP_ID, {
      page: 2,
      limit: 50,
      product_id: SHOP_PRODUCT_ID,
      type: 'MANUAL_ADJUSTMENT',
      actor_user_id: USER_ID,
      from_date: undefined,
      to_date: undefined,
    })

    expect(result).toEqual({
      items: [{ id: 'mv-1' }],
      total: 1,
      page: 2,
      limit: 50,
    })
    expect(repo.findStockMovements).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: SHOP_ID,
        productId: SHOP_PRODUCT_ID,
        type: 'MANUAL_ADJUSTMENT',
        actorUserId: USER_ID,
        page: 2,
        limit: 50,
      })
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// approve / reject (R23.10, R23.11)
// ═══════════════════════════════════════════════════════════════════════

describe('ShopProductsService.approve', () => {
  it('locks, sets APPROVED, emits shop_product_approved audit, COMMITs, invalidates cache', async () => {
    const repo = makeRepoMock()
    const lockedRow = {
      id: SHOP_PRODUCT_ID,
      shop_id: SHOP_ID,
      product_id: PRODUCT_ID,
      approval_status: 'PENDING',
      approved_at: null,
      approved_by: null,
      rejection_reason: null,
    }
    const updatedRow = {
      ...lockedRow,
      approval_status: 'APPROVED',
      approved_at: new Date(),
      approved_by: USER_ID,
    }
    repo.findByIdForApprovalUpdate.mockResolvedValueOnce(lockedRow)
    repo.setApproved.mockResolvedValueOnce(updatedRow)

    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)

    const svc = new ShopProductsService(repo)
    const result = await svc.approve(SHOP_PRODUCT_ID, ADMIN_ACTOR)

    expect(result.success).toBe(true)
    expect(result.data).toEqual(updatedRow)
    expect(repo.setApproved).toHaveBeenCalledWith(
      client,
      SHOP_PRODUCT_ID,
      USER_ID
    )
    expect(emitAuditInTx).toHaveBeenCalledWith(
      client,
      'shop_product_approved',
      expect.objectContaining({
        target_type: 'shop_product',
        target_id: SHOP_PRODUCT_ID,
        before: expect.objectContaining({ approval_status: 'PENDING' }),
        after: expect.objectContaining({ approval_status: 'APPROVED' }),
      })
    )
    expect(calls[0]).toBe('BEGIN')
    expect(calls[calls.length - 1]).toBe('COMMIT')
    expect(cacheDeletePattern).toHaveBeenCalled()
  })

  it('returns 404 PRODUCT_NOT_FOUND when row is missing', async () => {
    const repo = makeRepoMock()
    repo.findByIdForApprovalUpdate.mockResolvedValueOnce(null)

    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)

    const svc = new ShopProductsService(repo)
    const result = await svc.approve(SHOP_PRODUCT_ID, ADMIN_ACTOR)

    expect(result.success).toBe(false)
    expect(result.code).toBe('PRODUCT_NOT_FOUND')
    expect(calls).toContain('ROLLBACK')
    expect(repo.setApproved).not.toHaveBeenCalled()
    expect(emitAuditInTx).not.toHaveBeenCalled()
  })
})

describe('ShopProductsService.reject', () => {
  it('locks, sets REJECTED with reason, emits shop_product_rejected audit, COMMITs', async () => {
    const repo = makeRepoMock()
    const lockedRow = {
      id: SHOP_PRODUCT_ID,
      shop_id: SHOP_ID,
      product_id: PRODUCT_ID,
      approval_status: 'PENDING',
      approved_at: null,
      approved_by: null,
      rejection_reason: null,
    }
    const updatedRow = {
      ...lockedRow,
      approval_status: 'REJECTED',
      approved_at: new Date(),
      approved_by: USER_ID,
      rejection_reason: 'Wrong category assignment',
    }
    repo.findByIdForApprovalUpdate.mockResolvedValueOnce(lockedRow)
    repo.setRejected.mockResolvedValueOnce(updatedRow)

    const { client, calls } = makeTxClientMock()
    getClient.mockResolvedValueOnce(client)

    const svc = new ShopProductsService(repo)
    const result = await svc.reject(
      SHOP_PRODUCT_ID,
      'Wrong category assignment',
      ADMIN_ACTOR
    )

    expect(result.success).toBe(true)
    expect(result.data.approval_status).toBe('REJECTED')
    expect(result.data.rejection_reason).toBe('Wrong category assignment')
    expect(repo.setRejected).toHaveBeenCalledWith(
      client,
      SHOP_PRODUCT_ID,
      USER_ID,
      'Wrong category assignment'
    )
    expect(emitAuditInTx).toHaveBeenCalledWith(
      client,
      'shop_product_rejected',
      expect.objectContaining({
        target_type: 'shop_product',
        target_id: SHOP_PRODUCT_ID,
        after: expect.objectContaining({
          approval_status: 'REJECTED',
          rejection_reason: 'Wrong category assignment',
        }),
      })
    )
    expect(calls[0]).toBe('BEGIN')
    expect(calls[calls.length - 1]).toBe('COMMIT')
  })
})
