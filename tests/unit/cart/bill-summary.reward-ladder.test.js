import { describe, expect, it } from 'vitest'

import { BillSummaryService } from '../../../src/modules/cart/bill-summary.service.js'

/**
 * Coverage for the merged reward ladder (Phase 3 follow-up, 2026-07-03):
 * the Smart Bottom Bar's progress bar previously reset to 0% every time a
 * milestone tier was crossed, making it impossible to see whether further
 * tiers existed. _buildRewardLadder merges the free-delivery threshold and
 * every eligible cart-milestone tier into one ascending sequence with a
 * self-contained per-segment progress (0–1 within that tier's own span),
 * so the app can render one continuous segmented track instead.
 */

function service() {
  // _buildRewardLadder is pure given its arguments — no DB/repo needed.
  return new BillSummaryService({})
}

function tier(overrides = {}) {
  return { id: 'm-1', name: 'Tier', minCartAmount: 500, ...overrides }
}

describe('BillSummaryService._buildRewardLadder — segment progress (positive)', () => {
  it('fills the free-delivery segment proportionally before it is reached', () => {
    const ladder = service()._buildRewardLadder({
      freeDeliveryEnabled: true,
      freeDeliveryThreshold: 300,
      tiers: [],
      cartTotal: 240,
    })

    expect(ladder).toHaveLength(1)
    expect(ladder[0].id).toBe('free-delivery')
    expect(ladder[0].achieved).toBe(false)
    expect(ladder[0].segmentProgress).toBe(0.8)
  })

  it('marks a segment fully achieved once the cart crosses its threshold', () => {
    const ladder = service()._buildRewardLadder({
      freeDeliveryEnabled: true,
      freeDeliveryThreshold: 300,
      tiers: [],
      cartTotal: 300,
    })

    expect(ladder[0].achieved).toBe(true)
    expect(ladder[0].segmentProgress).toBe(1)
  })

  it('computes each later segment relative to the PREVIOUS checkpoint, not from zero (the actual bug being fixed)', () => {
    // Free delivery at 300, then a milestone at 500 — cart at 400 is
    // "40% of the way from 300 to 500" for the second segment, not "80%
    // of the way from 0 to 500".
    const ladder = service()._buildRewardLadder({
      freeDeliveryEnabled: true,
      freeDeliveryThreshold: 300,
      tiers: [tier({ id: 'm-500', minCartAmount: 500, name: '₹500 tier' })],
      cartTotal: 400,
    })

    expect(ladder).toHaveLength(2)
    expect(ladder[0]).toMatchObject({ id: 'free-delivery', achieved: true, segmentProgress: 1 })
    expect(ladder[1]).toMatchObject({ id: 'm-500', achieved: false, segmentProgress: 0.5 })
  })

  it('sorts tiers ascending by amount regardless of input order', () => {
    const ladder = service()._buildRewardLadder({
      freeDeliveryEnabled: false,
      freeDeliveryThreshold: null,
      tiers: [
        tier({ id: 'm-999', minCartAmount: 999, name: 'Big' }),
        tier({ id: 'm-500', minCartAmount: 500, name: 'Small' }),
      ],
      cartTotal: 0,
    })

    expect(ladder.map((c) => c.id)).toEqual(['m-500', 'm-999'])
  })

  it('the whole ladder reads as fully achieved once the cart clears the last tier (full line, no gaps)', () => {
    const ladder = service()._buildRewardLadder({
      freeDeliveryEnabled: true,
      freeDeliveryThreshold: 300,
      tiers: [
        tier({ id: 'm-500', minCartAmount: 500 }),
        tier({ id: 'm-999', minCartAmount: 999 }),
      ],
      cartTotal: 1500,
    })

    expect(ladder.every((c) => c.achieved && c.segmentProgress === 1)).toBe(true)
  })
})

describe('BillSummaryService._buildRewardLadder — edge cases (negative)', () => {
  it('omits the free-delivery checkpoint when it is disabled', () => {
    const ladder = service()._buildRewardLadder({
      freeDeliveryEnabled: false,
      freeDeliveryThreshold: 300,
      tiers: [tier()],
      cartTotal: 0,
    })

    expect(ladder.find((c) => c.id === 'free-delivery')).toBeUndefined()
  })

  it('returns an empty ladder when there is nothing configured', () => {
    const ladder = service()._buildRewardLadder({
      freeDeliveryEnabled: false,
      freeDeliveryThreshold: null,
      tiers: [],
      cartTotal: 500,
    })

    expect(ladder).toEqual([])
  })

  it('an empty cart (0 total) has every segment at 0 progress, not achieved', () => {
    const ladder = service()._buildRewardLadder({
      freeDeliveryEnabled: true,
      freeDeliveryThreshold: 300,
      tiers: [tier({ id: 'm-500', minCartAmount: 500 })],
      cartTotal: 0,
    })

    expect(ladder.every((c) => !c.achieved && c.segmentProgress === 0)).toBe(true)
  })
})
