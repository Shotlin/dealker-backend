// Coverage for CartMilestonesService — the graduated cart-value ladder
// that powers the mobile Smart Bottom Bar's progress state. Constructor
// injection (repo + segmentsRepo), no database mocking needed.

import { describe, expect, it, vi } from 'vitest'
import { CartMilestonesService } from '../../../src/modules/cart-milestones/cart-milestones.service.js'

const USER_ID = 'user-1'

function tier(overrides = {}) {
  return {
    id: 'm-1',
    name: 'Tier',
    minCartAmount: 299,
    rewardType: 'CASHBACK',
    rewardValue: 20,
    maxDiscount: null,
    unlockCouponId: null,
    messageBefore: 'Add ₹{amount} more to unlock {name}',
    messageAfter: 'Unlocked!',
    applicableUserType: 'ALL',
    applicableSegmentId: null,
    stackableWithCoupon: true,
    cashbackCreditTrigger: 'ORDER_DELIVERED',
    ...overrides,
  }
}

function makeRepoMock(overrides = {}) {
  return {
    findAllActive: vi.fn().mockResolvedValue([]),
    hasPriorOrder: vi.fn().mockResolvedValue(false),
    getUserUsageCount: vi.fn().mockResolvedValue(0),
    recordUsage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeSegmentsRepoMock() {
  return { isMember: vi.fn().mockResolvedValue(false) }
}

describe('CartMilestonesService.getProgress — graduated ladder (positive)', () => {
  it('picks the highest unlocked tier and the nearest next tier for a cart in between', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ id: 'm-299', minCartAmount: 299, name: 'Free delivery tier' }),
        tier({ id: 'm-500', minCartAmount: 500, name: '₹20 cashback tier' }),
        tier({ id: 'm-999', minCartAmount: 999, name: '₹100 cashback tier' }),
      ]),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 600)

    expect(progress.unlocked.id).toBe('m-500')
    expect(progress.next.id).toBe('m-999')
    expect(progress.next.amountToUnlock).toBe(399)
  })

  it('unlocked is null when the cart is below every tier (negative)', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([tier({ minCartAmount: 299 })]),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 100)

    expect(progress.unlocked).toBeNull()
    expect(progress.next.amountToUnlock).toBe(199)
  })

  it('next is null when the cart already clears every tier (positive — top of ladder)', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([tier({ id: 'm-999', minCartAmount: 999 })]),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 1500)

    expect(progress.unlocked.id).toBe('m-999')
    expect(progress.next).toBeNull()
  })

  it('substitutes {amount} in the message template', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ minCartAmount: 299, messageBefore: 'Add ₹{amount} more to unlock FREE DELIVERY' }),
      ]),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 239)

    expect(progress.next.message).toBe('Add ₹60 more to unlock FREE DELIVERY')
  })
})

describe('CartMilestonesService.getProgress — eligibility filtering (negative)', () => {
  it('excludes a FIRST_TIME-only milestone for a repeat customer', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([tier({ minCartAmount: 100, applicableUserType: 'FIRST_TIME' })]),
      hasPriorOrder: vi.fn().mockResolvedValue(true),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 500)

    expect(progress.unlocked).toBeNull()
    expect(progress.next).toBeNull()
  })

  it('excludes a SEGMENT-only milestone for a non-member', async () => {
    const segmentsRepo = makeSegmentsRepoMock()
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([
        tier({ minCartAmount: 100, applicableUserType: 'SEGMENT', applicableSegmentId: 'seg-1' }),
      ]),
    })
    const service = new CartMilestonesService(repo, segmentsRepo)

    const progress = await service.getProgress(USER_ID, 500)

    expect(progress.unlocked).toBeNull()
    expect(segmentsRepo.isMember).toHaveBeenCalledWith('seg-1', USER_ID)
  })
})

describe('CartMilestonesService — per-user usage limit (2026-07-04, "reward every order forever" fix)', () => {
  it('excludes a milestone once the user has hit its usageLimitPerUser (negative)', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([tier({ minCartAmount: 100, usageLimitPerUser: 2 })]),
      getUserUsageCount: vi.fn().mockResolvedValue(2),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 500)

    expect(progress.unlocked).toBeNull()
  })

  it('still includes the milestone when usage is below the limit (positive)', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([tier({ id: 'm-1', minCartAmount: 100, usageLimitPerUser: 2 })]),
      getUserUsageCount: vi.fn().mockResolvedValue(1),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 500)

    expect(progress.unlocked?.id).toBe('m-1')
  })

  it('never limits usage when usageLimitPerUser is null (default, unlimited — negative test for the check itself)', async () => {
    const repo = makeRepoMock({
      findAllActive: vi.fn().mockResolvedValue([tier({ id: 'm-1', minCartAmount: 100, usageLimitPerUser: null })]),
      getUserUsageCount: vi.fn().mockResolvedValue(9999),
    })
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    const progress = await service.getProgress(USER_ID, 500)

    expect(progress.unlocked?.id).toBe('m-1')
    expect(repo.getUserUsageCount).not.toHaveBeenCalled()
  })

  it('recordUsage() delegates to the repository', async () => {
    const repo = makeRepoMock()
    const service = new CartMilestonesService(repo, makeSegmentsRepoMock())

    await service.recordUsage('m-1', USER_ID, 'order-1')

    expect(repo.recordUsage).toHaveBeenCalledWith('m-1', USER_ID, 'order-1')
  })
})

describe('CartMilestonesService.computeReward — each reward type (positive)', () => {
  const service = new CartMilestonesService(makeRepoMock(), makeSegmentsRepoMock())

  it('CASHBACK is capped at maxDiscount when set', () => {
    const reward = service.computeReward(tier({ rewardType: 'CASHBACK', rewardValue: 500, maxDiscount: 100 }), 2000)
    expect(reward.cashbackAmount).toBe(100)
  })

  it('FLAT_DISCOUNT is capped at the cart total', () => {
    const reward = service.computeReward(tier({ rewardType: 'FLAT_DISCOUNT', rewardValue: 5000 }), 300)
    expect(reward.discount).toBe(300)
  })

  it('COUPON_UNLOCK returns the coupon id', () => {
    const reward = service.computeReward(tier({ rewardType: 'COUPON_UNLOCK', unlockCouponId: 'coupon-9' }), 500)
    expect(reward).toEqual({ unlockCouponId: 'coupon-9' })
  })
})
