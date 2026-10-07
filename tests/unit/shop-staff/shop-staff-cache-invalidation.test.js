import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external dependencies BEFORE importing service ──
vi.mock('../../../src/middlewares/shop-scope.js', () => ({
  invalidateStaffActiveCache: vi.fn(),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// `audit-log` opens a pg pool when imported — replace it with a no-op
// mock so unit tests do not require a live database connection.
vi.mock('../../../src/utils/audit-log.js', () => ({
  emit: vi.fn(),
  emitInTx: vi.fn(),
}))

// `getClient()` is called by `deactivate()` to run an atomic tx around
// the soft-delete + audit emit (task 5.4 / R28 AC#6). Hand back a fake
// pg client that accepts BEGIN/COMMIT/ROLLBACK so the transaction
// wrapper resolves without a real Postgres.
vi.mock('../../../src/config/database.js', () => {
  const makeFakeClient = () => ({
    query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
    release: vi.fn(),
  })
  return {
    pool: { query: vi.fn() },
    query: vi.fn(),
    getClient: vi.fn(async () => makeFakeClient()),
    closePool: vi.fn(),
  }
})

import { ShopStaffService } from '../../../src/modules/shop-staff/shop-staff.service.js'
import { invalidateStaffActiveCache } from '../../../src/middlewares/shop-scope.js'

const SHOP_ID = '550e8400-e29b-41d4-a716-446655440000'
const STAFF_ID = '99999999-9999-9999-9999-999999999999'
const TARGET_USER_ID = '11111111-1111-1111-1111-111111111111'
const REQUESTER_ID = '22222222-2222-2222-2222-222222222222'

function makeRepoMock() {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findByUserAndShop: vi.fn(),
    countActiveByShop: vi.fn(),
    countActiveByUser: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════
// Requirement 2.11 — invalidate staff-active cache on update/delete
// so subsequent JWTs are rejected within 5 minutes (cache TTL).
// ═══════════════════════════════════════════════════════════════

describe('ShopStaffService.update — cache invalidation', () => {
  it('invalidates staff-active cache after a successful update', async () => {
    const repo = makeRepoMock()
    // The service reads the existing record before applying the patch
    // so the audit before-snapshot captures the pre-mutation state.
    repo.findById.mockResolvedValueOnce({
      id: STAFF_ID,
      user_id: TARGET_USER_ID,
      shop_id: SHOP_ID,
      role: 'SHOP_VIEWER',
      is_active: true,
    })
    repo.update.mockResolvedValueOnce({
      id: STAFF_ID,
      user_id: TARGET_USER_ID,
      shop_id: SHOP_ID,
      role: 'SHOP_VIEWER',
      is_active: false,
    })
    const service = new ShopStaffService(repo)

    const result = await service.update(
      STAFF_ID,
      { is_active: false },
      SHOP_ID,
      REQUESTER_ID
    )

    expect(result.success).toBe(true)
    expect(invalidateStaffActiveCache).toHaveBeenCalledTimes(1)
    expect(invalidateStaffActiveCache).toHaveBeenCalledWith(
      TARGET_USER_ID,
      SHOP_ID
    )
  })

  it('does NOT invalidate the cache when the record is missing (pre-update lookup)', async () => {
    const repo = makeRepoMock()
    // findById returns null → service short-circuits with STAFF_NOT_FOUND
    // BEFORE calling repo.update, so the cache is never touched.
    repo.findById.mockResolvedValueOnce(null)
    const service = new ShopStaffService(repo)

    const result = await service.update(
      STAFF_ID,
      { is_active: false },
      SHOP_ID,
      REQUESTER_ID
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('STAFF_NOT_FOUND')
    expect(repo.update).not.toHaveBeenCalled()
    expect(invalidateStaffActiveCache).not.toHaveBeenCalled()
  })

  it('does NOT invalidate the cache when the UPDATE itself reports zero rows', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce({
      id: STAFF_ID,
      user_id: TARGET_USER_ID,
      shop_id: SHOP_ID,
    })
    // Race condition: row deleted between findById and update.
    repo.update.mockResolvedValueOnce(null)
    const service = new ShopStaffService(repo)

    const result = await service.update(
      STAFF_ID,
      { is_active: false },
      SHOP_ID,
      REQUESTER_ID
    )

    expect(result.success).toBe(false)
    expect(result.code).toBe('STAFF_NOT_FOUND')
    expect(invalidateStaffActiveCache).not.toHaveBeenCalled()
  })
})

describe('ShopStaffService.delete — cache invalidation', () => {
  it('invalidates staff-active cache after a successful soft-delete', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce({
      id: STAFF_ID,
      user_id: TARGET_USER_ID,
      shop_id: SHOP_ID,
    })
    repo.softDelete.mockResolvedValueOnce(true)
    const service = new ShopStaffService(repo)

    const result = await service.delete(STAFF_ID, SHOP_ID, REQUESTER_ID)

    expect(result.success).toBe(true)
    expect(invalidateStaffActiveCache).toHaveBeenCalledTimes(1)
    expect(invalidateStaffActiveCache).toHaveBeenCalledWith(
      TARGET_USER_ID,
      SHOP_ID
    )
  })

  it('does NOT invalidate when the record cannot be found upfront', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce(null)
    const service = new ShopStaffService(repo)

    const result = await service.delete(STAFF_ID, SHOP_ID, REQUESTER_ID)

    expect(result.success).toBe(false)
    expect(result.code).toBe('STAFF_NOT_FOUND')
    expect(invalidateStaffActiveCache).not.toHaveBeenCalled()
    expect(repo.softDelete).not.toHaveBeenCalled()
  })

  it('does NOT invalidate when softDelete reports no rows affected', async () => {
    const repo = makeRepoMock()
    repo.findById.mockResolvedValueOnce({
      id: STAFF_ID,
      user_id: TARGET_USER_ID,
      shop_id: SHOP_ID,
    })
    repo.softDelete.mockResolvedValueOnce(false)
    const service = new ShopStaffService(repo)

    const result = await service.delete(STAFF_ID, SHOP_ID, REQUESTER_ID)

    expect(result.success).toBe(false)
    expect(result.code).toBe('STAFF_NOT_FOUND')
    expect(invalidateStaffActiveCache).not.toHaveBeenCalled()
  })
})
