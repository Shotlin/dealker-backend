// Coverage for the reported bug: coupon usage was recorded the instant an
// order row was created — before an ONLINE/WALLET payment had actually
// been confirmed. A customer whose wallet/online payment then failed or
// was never completed still had their coupon burned against their
// per-user limit, with the app showing "maximum uses" on their very next
// (genuinely first) attempt. orders.service.js now only records usage
// immediately for COD; ONLINE/WALLET confirmation call the new
// recordUsageForOrder() below once payment actually succeeds.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const ordersRepoMock = vi.hoisted(() => ({ findById: vi.fn() }))
vi.mock('../../../src/modules/orders/orders.repository.js', () => ({
  OrdersRepository: vi.fn(() => ordersRepoMock),
}))

import { CouponsService } from '../../../src/modules/coupons/coupons.service.js'

const UUID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

function makeRepoMock(overrides = {}) {
  return {
    findByCode: vi.fn(),
    recordUsage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('CouponsService.recordUsageForOrder — reads the coupon straight off the confirmed order (positive)', () => {
  it('records usage using the order row\'s own coupon_code/discount_amount/shop_id/user_id', async () => {
    ordersRepoMock.findById.mockResolvedValue({
      id: 'order-1',
      userId: 'user-1',
      shopId: 'shop-1',
      couponCode: 'SAVE50',
      discountAmount: 50,
    })
    const repo = makeRepoMock({
      findByCode: vi.fn().mockResolvedValue({ id: UUID_A, code: 'SAVE50' }),
    })
    const service = new CouponsService(repo)

    await service.recordUsageForOrder('order-1')

    expect(repo.recordUsage).toHaveBeenCalledWith(UUID_A, 'user-1', 'order-1', {
      shopId: 'shop-1',
      discountAmount: 50,
    })
  })
})

describe('CouponsService.recordUsageForOrder — no-ops safely (negative)', () => {
  it('does nothing when the order has no coupon_code (most orders)', async () => {
    ordersRepoMock.findById.mockResolvedValue({
      id: 'order-1', userId: 'user-1', shopId: 'shop-1', couponCode: null, discountAmount: 0,
    })
    const repo = makeRepoMock()
    const service = new CouponsService(repo)

    await service.recordUsageForOrder('order-1')

    expect(repo.findByCode).not.toHaveBeenCalled()
    expect(repo.recordUsage).not.toHaveBeenCalled()
  })

  it('does nothing when the order id does not resolve to a real order', async () => {
    ordersRepoMock.findById.mockResolvedValue(null)
    const repo = makeRepoMock()
    const service = new CouponsService(repo)

    await service.recordUsageForOrder('missing-order')

    expect(repo.recordUsage).not.toHaveBeenCalled()
  })
})

describe('CouponsService.recordUsage — idempotent against a duplicate confirmation event (the fix that makes retries safe)', () => {
  it('swallows a unique-constraint violation (23505) instead of throwing — a payment webhook firing twice must not double-count', async () => {
    const duplicateErr = new Error('duplicate key value violates unique constraint "idx_coupon_usage_unique"')
    duplicateErr.code = '23505'
    const repo = makeRepoMock({
      findByCode: vi.fn().mockResolvedValue({ id: UUID_A, code: 'SAVE50' }),
      recordUsage: vi.fn().mockRejectedValue(duplicateErr),
    })
    const service = new CouponsService(repo)

    await expect(
      service.recordUsage('SAVE50', 'user-1', 'order-1', { shopId: 'shop-1', discountAmount: 50 })
    ).resolves.toBeUndefined()
  })

  it('still throws for a genuine, non-duplicate database error (negative — must not swallow real failures)', async () => {
    const dbErr = new Error('connection terminated')
    dbErr.code = '57P01'
    const repo = makeRepoMock({
      findByCode: vi.fn().mockResolvedValue({ id: UUID_A, code: 'SAVE50' }),
      recordUsage: vi.fn().mockRejectedValue(dbErr),
    })
    const service = new CouponsService(repo)

    await expect(
      service.recordUsage('SAVE50', 'user-1', 'order-1', { shopId: 'shop-1', discountAmount: 50 })
    ).rejects.toThrow('connection terminated')
  })
})
