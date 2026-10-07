// Coverage for PaymentOffersService (2026-07-04) — Payment Offers was
// previously a cart-page marketing banner only: getPublicOffers() computed
// a lock/unlock display flag from min_order_amount, but NOTHING in the
// codebase ever credited the cashback a customer actually earned (no
// reference to payment_offers anywhere in cart/bill-summary/orders
// services, and cashback_transactions.source_type didn't even allow
// 'PAYMENT_OFFER' as a value). resolveForCheckout() is the fix — the real
// application logic orders.service.js now calls at checkout.

import { describe, expect, it, vi } from 'vitest'
import { PaymentOffersService } from '../../../src/modules/payment-offers/payment-offers.service.js'

const USER_ID = 'user-1'

function offer(overrides = {}) {
  return {
    id: 'offer-1',
    title: '50 test cashback',
    provider: 'Test 50RS CASHBACK',
    cashback_amount: 50,
    cashback_percent: null,
    min_order_amount: 50,
    max_cashback: null,
    usage_limit_per_user: null,
    cashback_credit_trigger: 'ORDER_DELIVERED',
    ...overrides,
  }
}

function makeRepoMock(overrides = {}) {
  return {
    getActive: vi.fn().mockResolvedValue([]),
    getUserUsageCount: vi.fn().mockResolvedValue(0),
    recordUsage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('PaymentOffersService.resolveForCheckout — the exact reported bug (min order ₹50 → ₹50 cashback)', () => {
  it('matches and returns the cashback amount when the cart meets min_order_amount (positive)', async () => {
    const repo = makeRepoMock({ getActive: vi.fn().mockResolvedValue([offer()]) })
    const service = new PaymentOffersService(repo)

    const result = await service.resolveForCheckout(USER_ID, 50)

    expect(result).toMatchObject({
      offerId: 'offer-1',
      cashbackAmount: 50,
      creditTrigger: 'ORDER_DELIVERED',
    })
  })

  it('returns null when the cart is below min_order_amount (negative)', async () => {
    const repo = makeRepoMock({ getActive: vi.fn().mockResolvedValue([offer()]) })
    const service = new PaymentOffersService(repo)

    const result = await service.resolveForCheckout(USER_ID, 49)

    expect(result).toBeNull()
  })
})

describe('PaymentOffersService.resolveForCheckout — cashback computation (positive)', () => {
  it('uses cashback_percent (capped at max_cashback) when set, over the flat amount', async () => {
    const repo = makeRepoMock({
      getActive: vi.fn().mockResolvedValue([
        offer({ cashback_amount: 10, cashback_percent: 10, max_cashback: 30, min_order_amount: 0 }),
      ]),
    })
    const service = new PaymentOffersService(repo)

    const result = await service.resolveForCheckout(USER_ID, 1000)

    expect(result.cashbackAmount).toBe(30) // 10% of 1000 = 100, capped at 30
  })

  it('picks the highest-cashback offer when multiple qualify', async () => {
    const repo = makeRepoMock({
      getActive: vi.fn().mockResolvedValue([
        offer({ id: 'low', cashback_amount: 10, min_order_amount: 0 }),
        offer({ id: 'high', cashback_amount: 40, min_order_amount: 0 }),
      ]),
    })
    const service = new PaymentOffersService(repo)

    const result = await service.resolveForCheckout(USER_ID, 1000)

    expect(result.offerId).toBe('high')
  })
})

describe('PaymentOffersService.resolveForCheckout — per-user usage limit (negative)', () => {
  it('excludes an offer once the user has hit usage_limit_per_user', async () => {
    const repo = makeRepoMock({
      getActive: vi.fn().mockResolvedValue([offer({ usage_limit_per_user: 1 })]),
      getUserUsageCount: vi.fn().mockResolvedValue(1),
    })
    const service = new PaymentOffersService(repo)

    const result = await service.resolveForCheckout(USER_ID, 100)

    expect(result).toBeNull()
  })

  it('still matches when usage is below the limit (positive)', async () => {
    const repo = makeRepoMock({
      getActive: vi.fn().mockResolvedValue([offer({ usage_limit_per_user: 3 })]),
      getUserUsageCount: vi.fn().mockResolvedValue(2),
    })
    const service = new PaymentOffersService(repo)

    const result = await service.resolveForCheckout(USER_ID, 100)

    expect(result).not.toBeNull()
  })

  it('never checks usage when usage_limit_per_user is null (default, unlimited)', async () => {
    const repo = makeRepoMock({
      getActive: vi.fn().mockResolvedValue([offer({ usage_limit_per_user: null })]),
    })
    const service = new PaymentOffersService(repo)

    await service.resolveForCheckout(USER_ID, 100)

    expect(repo.getUserUsageCount).not.toHaveBeenCalled()
  })
})

describe('PaymentOffersService.resolveForCheckout — lock_threshold enforcement (reported bug: admin-configured unlock amount was cosmetic-only)', () => {
  // getPublicOffers() correctly showed the offer as "locked" below
  // lock_threshold (falling back to min_order_amount), but
  // resolveForCheckout() — the function that actually decides whether
  // cashback gets credited — only ever checked min_order_amount, so a cart
  // between min_order_amount and lock_threshold would silently earn
  // cashback the UI told the customer they hadn't unlocked yet.
  it('does not credit when the cart meets min_order_amount but not the higher lock_threshold (negative)', async () => {
    const repo = makeRepoMock({
      getActive: vi.fn().mockResolvedValue([
        offer({ min_order_amount: 50, lock_threshold: 200 }),
      ]),
    })
    const service = new PaymentOffersService(repo)

    const result = await service.resolveForCheckout(USER_ID, 100)

    expect(result).toBeNull()
  })

  it('credits once the cart clears lock_threshold (positive)', async () => {
    const repo = makeRepoMock({
      getActive: vi.fn().mockResolvedValue([
        offer({ min_order_amount: 50, lock_threshold: 200 }),
      ]),
    })
    const service = new PaymentOffersService(repo)

    const result = await service.resolveForCheckout(USER_ID, 200)

    expect(result).not.toBeNull()
    expect(result.cashbackAmount).toBe(50)
  })

  it('falls back to min_order_amount when lock_threshold is unset (unaffected default case)', async () => {
    const repo = makeRepoMock({
      getActive: vi.fn().mockResolvedValue([
        offer({ min_order_amount: 50, lock_threshold: null }),
      ]),
    })
    const service = new PaymentOffersService(repo)

    expect(await service.resolveForCheckout(USER_ID, 49)).toBeNull()
    expect(await service.resolveForCheckout(USER_ID, 50)).not.toBeNull()
  })
})

describe('PaymentOffersService.recordUsage', () => {
  it('delegates to the repository', async () => {
    const repo = makeRepoMock()
    const service = new PaymentOffersService(repo)

    await service.recordUsage('offer-1', USER_ID, 'order-1')

    expect(repo.recordUsage).toHaveBeenCalledWith('offer-1', USER_ID, 'order-1')
  })
})

describe('PaymentOffersService.getPublicOffers — no longer injects hardcoded demo offers', () => {
  it('returns only what the repository provides (no demo merge)', async () => {
    const repo = makeRepoMock({ getActive: vi.fn().mockResolvedValue([offer()]) })
    const service = new PaymentOffersService(repo)

    const result = await service.getPublicOffers(50)

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('offer-1')
  })

  it('returns an empty list when there are no real offers (previously would have shown 4 hardcoded demo offers)', async () => {
    const repo = makeRepoMock({ getActive: vi.fn().mockResolvedValue([]) })
    const service = new PaymentOffersService(repo)

    const result = await service.getPublicOffers(50)

    expect(result).toEqual([])
  })
})

describe('PaymentOffersService.getPublicOffers — per-user usage cap hides exhausted offers from a logged-in customer (reported gap)', () => {
  // A customer who already hit usage_limit_per_user still saw the offer as
  // unlocked/available (resolveForCheckout correctly skips it at checkout,
  // but the list itself never checked). Fixed by threading the caller's
  // userId through (from an optional-auth preHandler) and pre-filtering.
  it('excludes an offer the given user has already exhausted', async () => {
    const repo = makeRepoMock({
      getActive: vi.fn().mockResolvedValue([offer({ usage_limit_per_user: 1 })]),
      getUserUsageCount: vi.fn().mockResolvedValue(1),
    })
    const service = new PaymentOffersService(repo)

    const result = await service.getPublicOffers(50, USER_ID)

    expect(result).toEqual([])
    expect(repo.getUserUsageCount).toHaveBeenCalledWith('offer-1', USER_ID)
  })

  it('still includes it when the user has redemptions remaining', async () => {
    const repo = makeRepoMock({
      getActive: vi.fn().mockResolvedValue([offer({ usage_limit_per_user: 3 })]),
      getUserUsageCount: vi.fn().mockResolvedValue(1),
    })
    const service = new PaymentOffersService(repo)

    const result = await service.getPublicOffers(50, USER_ID)

    expect(result).toHaveLength(1)
  })

  it('shows every active offer to an anonymous caller (no userId — usage cannot be checked)', async () => {
    const repo = makeRepoMock({
      getActive: vi.fn().mockResolvedValue([offer({ usage_limit_per_user: 1 })]),
    })
    const service = new PaymentOffersService(repo)

    const result = await service.getPublicOffers(50)

    expect(result).toHaveLength(1)
    expect(repo.getUserUsageCount).not.toHaveBeenCalled()
  })

  it('never checks usage for an offer with no per-user cap, even when a userId is given', async () => {
    const repo = makeRepoMock({
      getActive: vi.fn().mockResolvedValue([offer({ usage_limit_per_user: null })]),
    })
    const service = new PaymentOffersService(repo)

    await service.getPublicOffers(50, USER_ID)

    expect(repo.getUserUsageCount).not.toHaveBeenCalled()
  })
})

describe('PaymentOffersService.delete — foreign-key-in-use conflict (negative)', () => {
  // Reported bug: deleting a payment offer that a customer had already
  // redeemed threw a raw Postgres FK violation (payment_offer_usages has no
  // ON DELETE cascade on payment_offer_id), reaching the customer as an
  // opaque 500. Surface a clear 409 instead and point at deactivating.
  it('surfaces a 409 with a clear message instead of a raw 500 when the offer has usage history', async () => {
    const fkErr = new Error('update or delete on table "payment_offers" violates foreign key constraint')
    fkErr.code = '23503'
    const repo = makeRepoMock({ delete: vi.fn().mockRejectedValue(fkErr) })
    const service = new PaymentOffersService(repo)

    await expect(service.delete('offer-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'PAYMENT_OFFER_IN_USE',
    })
  })

  it('re-throws any other repository error unchanged (not misclassified as in-use)', async () => {
    const repo = makeRepoMock({ delete: vi.fn().mockRejectedValue(new Error('connection lost')) })
    const service = new PaymentOffersService(repo)

    await expect(service.delete('offer-1')).rejects.toThrow('connection lost')
  })

  it('still throws 404 for a genuinely missing offer (unaffected by the new FK handling)', async () => {
    const repo = makeRepoMock({ delete: vi.fn().mockResolvedValue(null) })
    const service = new PaymentOffersService(repo)

    await expect(service.delete('missing-offer')).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    })
  })

  it('deletes successfully when the offer has no usage history (positive)', async () => {
    const repo = makeRepoMock({ delete: vi.fn().mockResolvedValue({ id: 'offer-1' }) })
    const service = new PaymentOffersService(repo)

    await expect(service.delete('offer-1')).resolves.toBeUndefined()
  })
})
