import { describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn().mockResolvedValue({ rows: [{ has_prior: false }] })

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

import { FirstTimeOffersRepository } from '../../../src/modules/first-time-offers/first-time-offers.repository.js'

/**
 * Regression coverage for hasPriorOrder() gating the first-order offer.
 * Previously checked `delivered_at IS NOT NULL`, which correctly stopped a
 * stuck-PENDING failed-payment order from permanently costing a genuine
 * first-time customer their offer, but reopened a worse hole: nothing
 * stopped placing several orders back-to-back before the first one ever
 * reached DELIVERED, each still counting as "first-time" (reported: the
 * same first-time discount applied on three separate real orders for one
 * customer). It must now exclude only CANCELLED — including PENDING,
 * since the reward is consumed the moment an order is placed, not once
 * delivered — relying on payment-expiry.worker.js to auto-cancel any
 * order genuinely abandoned mid-payment instead of excluding PENDING here.
 */
describe("FirstTimeOffersRepository.hasPriorOrder — gated on placement, not delivery", () => {
  it("excludes only CANCELLED, counts PENDING, and never references delivered_at", async () => {
    queryMock.mockClear()
    const repo = new FirstTimeOffersRepository()

    await repo.hasPriorOrder('user-1')

    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/status\s*!=\s*'CANCELLED'/i)
    expect(sql).not.toMatch(/PENDING/i)
    expect(sql).not.toMatch(/delivered_at/i)
    expect(params).toEqual(['user-1'])
  })

  /**
   * Regression: this query used `orders.user_id`, a column migration 106
   * renamed to `customer_id` (§5's documented rename drift). Every call
   * threw "column \"user_id\" does not exist" — caught silently by
   * bill-summary.service.js's try/catch ("First-time offer resolve
   * failed"), so first-time-offer discounts/teasers were dark for every
   * genuinely new customer, on every bill summary, without ever
   * surfacing as an error to anyone.
   */
  it('queries orders.customer_id (the post-migration-106 column), never the renamed orders.user_id', async () => {
    queryMock.mockClear()
    const repo = new FirstTimeOffersRepository()

    await repo.hasPriorOrder('user-1')

    const [sql] = queryMock.mock.calls[0]
    expect(sql).toMatch(/\bcustomer_id\s*=\s*\$1/i)
    expect(sql).not.toMatch(/\buser_id\b/i)
  })
})
