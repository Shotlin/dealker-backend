import { describe, expect, it } from 'vitest'
import { computeRecoveryPriorityScore } from '../../../src/modules/abandoned-carts/priority-score.js'

describe('computeRecoveryPriorityScore', () => {
  it('scores a large, fresh, high-LTV cart with a strong recovery history near the top', () => {
    const { score } = computeRecoveryPriorityScore({
      cartValue: 2000,
      itemCount: 8,
      ltv: 10000,
      minutesSinceAbandonment: 0,
      recoveryRate: 1,
    })
    expect(score).toBe(100)
  })

  it('scores an empty-signal cart (old, no value, no history) near the bottom but not exactly 0 due to the neutral recovery-rate default', () => {
    const { score } = computeRecoveryPriorityScore({
      cartValue: 0,
      itemCount: 0,
      ltv: 0,
      minutesSinceAbandonment: 1440,
      recoveryRate: null,
    })
    // Only the recoveryRate component (10% weight) contributes, at its
    // neutral 0.5 default: 100 * 0.10 * 0.5 = 5
    expect(score).toBe(5)
  })

  it('applies a neutral 0.5 recovery-rate score when the user has no closed episode history, rather than penalizing a first-time abandoner', () => {
    const withHistory = computeRecoveryPriorityScore({
      cartValue: 500,
      itemCount: 3,
      ltv: 1000,
      minutesSinceAbandonment: 30,
      recoveryRate: 0.5,
    })
    const withoutHistory = computeRecoveryPriorityScore({
      cartValue: 500,
      itemCount: 3,
      ltv: 1000,
      minutesSinceAbandonment: 30,
      recoveryRate: null,
    })
    expect(withoutHistory.score).toBe(withHistory.score)
  })

  it('clamps inputs above their normalization ceiling instead of exceeding a 1.0 normalized score', () => {
    const overCeiling = computeRecoveryPriorityScore({
      cartValue: 50000, // far above the 2000 ceiling
      itemCount: 40, // far above the 8 ceiling
      ltv: 500000, // far above the 10000 ceiling
      minutesSinceAbandonment: 0,
      recoveryRate: 1,
    })
    const atCeiling = computeRecoveryPriorityScore({
      cartValue: 2000,
      itemCount: 8,
      ltv: 10000,
      minutesSinceAbandonment: 0,
      recoveryRate: 1,
    })
    expect(overCeiling.score).toBe(atCeiling.score)
    expect(overCeiling.score).toBe(100)
  })

  it('decays the recency component to 0 once the cart has been abandoned 24h or longer', () => {
    const { breakdown } = computeRecoveryPriorityScore({
      cartValue: 500,
      itemCount: 2,
      ltv: 0,
      minutesSinceAbandonment: 1440,
      recoveryRate: 0.5,
    })
    expect(breakdown.recency.normalized).toBe(0)
  })

  it('never returns a negative score for pathological negative-ish inputs', () => {
    const { score } = computeRecoveryPriorityScore({
      cartValue: -100,
      itemCount: 0,
      ltv: 0,
      minutesSinceAbandonment: 999999,
      recoveryRate: 0,
    })
    expect(score).toBeGreaterThanOrEqual(0)
  })

  it('breakdown weights sum to 1.0 so a fully-maxed input always yields exactly 100', () => {
    const { breakdown } = computeRecoveryPriorityScore({
      cartValue: 2000,
      itemCount: 8,
      ltv: 10000,
      minutesSinceAbandonment: 0,
      recoveryRate: 1,
    })
    const totalWeight = Object.values(breakdown).reduce((sum, c) => sum + c.weight, 0)
    expect(totalWeight).toBeCloseTo(1.0, 5)
  })
})
