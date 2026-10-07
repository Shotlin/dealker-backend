// Coverage for CouponsService.delete() (2026-07-04) — reported bug: deleting
// a coupon that had already been redeemed by a customer threw a raw
// Postgres foreign-key-violation (coupon_usages.coupon_id has no ON DELETE
// cascade), which reached the global error handler as an opaque 500 with no
// actionable message. The fix catches the 23503 and surfaces a friendly 409
// pointing the admin at deactivating instead (an already-supported toggle),
// which preserves redemption history.

import { describe, expect, it, vi } from 'vitest'
import { CouponsService } from '../../../src/modules/coupons/coupons.service.js'

const COUPON_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const ACTOR = { userId: 'admin-1', platformRole: 'ADMIN', shopId: null, ip: '127.0.0.1', userAgent: 'test' }

function fkViolation() {
  const err = new Error('update or delete on table "coupons" violates foreign key constraint')
  err.code = '23503'
  return err
}

function makeRepoMock(overrides = {}) {
  return {
    findById: vi.fn().mockResolvedValue({ id: COUPON_ID, code: 'SAVE50' }),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('CouponsService.delete — foreign-key-in-use conflict (negative)', () => {
  it('surfaces a 409 with a clear message when the coupon has already been redeemed, instead of a raw 500', async () => {
    const repo = makeRepoMock({ delete: vi.fn().mockRejectedValue(fkViolation()) })
    const service = new CouponsService(repo)

    await expect(service.delete(COUPON_ID, ACTOR)).rejects.toMatchObject({
      statusCode: 409,
      code: 'COUPON_IN_USE',
    })
  })

  it('re-throws any other repository error unchanged (not misclassified as in-use)', async () => {
    const repo = makeRepoMock({ delete: vi.fn().mockRejectedValue(new Error('connection lost')) })
    const service = new CouponsService(repo)

    await expect(service.delete(COUPON_ID, ACTOR)).rejects.toThrow('connection lost')
  })
})

describe('CouponsService.delete — happy path unaffected by the new error handling (positive)', () => {
  it('deletes successfully when the coupon has no usage history', async () => {
    const repo = makeRepoMock()
    const service = new CouponsService(repo)

    const result = await service.delete(COUPON_ID, ACTOR)

    expect(result).toEqual({ success: true })
    expect(repo.delete).toHaveBeenCalledWith(COUPON_ID)
  })

  it('returns success:false without touching the repository delete when the coupon does not exist', async () => {
    const repo = makeRepoMock({ findById: vi.fn().mockResolvedValue(null) })
    const service = new CouponsService(repo)

    const result = await service.delete(COUPON_ID, ACTOR)

    expect(result.success).toBe(false)
    expect(repo.delete).not.toHaveBeenCalled()
  })
})
