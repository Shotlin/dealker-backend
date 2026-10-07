// Feature: multi-vendor-system, Property 8: Financial Formula
// **Validates: Requirements 6.3, 6.4**
//
// Property 8 (design.md):
//   For any Shop_Financial,
//     commission = gross_revenue * rate / 100
//     net        = gross - commission - delivery - refunds
//
// The pure helpers under test live in
//   src/modules/shop-financials/financial-formula.js
// and are re-used by the Settlement_Worker (task 9.1) when it aggregates
// daily orders. Importing the production helpers (rather than re-defining
// them inline) means this test pins the formulas the worker actually runs.
//
// This file performs pure unit testing only — no I/O, DB, Redis, or HTTP.

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

import {
  computeCommission,
  computeNetRevenue,
  computeAvgOrderValue,
} from '../../src/modules/shop-financials/financial-formula.js'

// ────────────────────────────────────────────────────────
// Local mirror of the production rounding (so the test reconstructs the
// expected value via integer cents and only calls round2 for documentation).
// ────────────────────────────────────────────────────────

function round2(x) {
  if (!Number.isFinite(x)) return 0
  return x >= 0 ? Math.round(x * 100) / 100 : -Math.round(-x * 100) / 100
}

// ────────────────────────────────────────────────────────
// Arbitraries
//
// All "money" values are generated via integer cents and divided by 100
// so each value is exactly representable in IEEE-754 and matches the
// DECIMAL(*,2) shape stored in shop_financials. This avoids spurious
// failures from `0.1 + 0.2` style drift while still exercising the same
// value space the settlement worker sees in production.
// ────────────────────────────────────────────────────────

// gross_revenue ∈ [0, 999_999.99] dollars, cent-precise
const moneyArb = fc
  .integer({ min: 0, max: 99_999_999 })
  .map((cents) => cents / 100)

// commission_rate ∈ [0, 100] percent, two-decimal precision (DECIMAL(5,2))
const rateArb = fc.integer({ min: 0, max: 10_000 }).map((bps) => bps / 100)

// delivery_costs ∈ [0, 9_999.99] dollars, cent-precise
const deliveryArb = fc
  .integer({ min: 0, max: 999_999 })
  .map((cents) => cents / 100)

// refund_amount ∈ [0, 9_999.99] dollars, cent-precise
const refundArb = fc
  .integer({ min: 0, max: 999_999 })
  .map((cents) => cents / 100)

// total_orders ∈ [0, 10_000]
const totalOrdersArb = fc.integer({ min: 0, max: 10_000 })

describe('Property 8: Financial Formula', () => {
  // ──────────────────────────────────────────────────────
  // Sub-property 1 — Commission formula (Requirement 6.3)
  //   computeCommission(gross, rate) === round2(gross * rate / 100)
  // ──────────────────────────────────────────────────────
  it('1. commission = round2(gross * rate / 100)', () => {
    fc.assert(
      fc.property(moneyArb, rateArb, (gross, rate) => {
        const commission = computeCommission(gross, rate)

        // Reconstruct via integer cents so the assertion does not depend
        // on float ordering inside computeCommission.
        const grossCents = Math.round(gross * 100)
        const rateBps = Math.round(rate * 100)
        const expectedCents = Math.round((grossCents * rateBps) / 10_000)

        expect(Math.round(commission * 100)).toBe(expectedCents)

        // Result is cent-precise (fits DECIMAL(10,2)).
        expect(commission).toBe(round2(commission))
      }),
      { numRuns: 100 }
    )
  })

  // ──────────────────────────────────────────────────────
  // Sub-property 2 — Commission bounds.
  //   For 0 ≤ gross and 0 ≤ rate ≤ 100, commission ∈ [0, gross].
  // ──────────────────────────────────────────────────────
  it('2. commission ∈ [0, gross] for non-negative gross and rate ≤ 100', () => {
    fc.assert(
      fc.property(moneyArb, rateArb, (gross, rate) => {
        const commission = computeCommission(gross, rate)

        expect(commission).toBeGreaterThanOrEqual(0)
        // 0.005 of slack absorbs the half-away-from-zero rounding step
        // (commission may round up by ½ cent vs. the exact ratio).
        expect(commission).toBeLessThanOrEqual(gross + 0.005 + 1e-9)
      }),
      { numRuns: 100 }
    )
  })

  // ──────────────────────────────────────────────────────
  // Sub-property 3 — Zero rate boundary (Requirement 6.3)
  //   rate = 0 ⇒ commission = 0 for any gross.
  // ──────────────────────────────────────────────────────
  it('3. rate = 0 ⇒ commission = 0', () => {
    fc.assert(
      fc.property(moneyArb, (gross) => {
        expect(computeCommission(gross, 0)).toBe(0)
      }),
      { numRuns: 100 }
    )
  })

  // ──────────────────────────────────────────────────────
  // Sub-property 4 — 100% rate boundary (Requirement 6.3)
  //   rate = 100 ⇒ commission = gross (for cent-precise gross).
  // ──────────────────────────────────────────────────────
  it('4. rate = 100 ⇒ commission = gross', () => {
    fc.assert(
      fc.property(moneyArb, (gross) => {
        expect(computeCommission(gross, 100)).toBe(gross)
      }),
      { numRuns: 100 }
    )
  })

  // ──────────────────────────────────────────────────────
  // Sub-property 5 — Net revenue formula (Requirement 6.4)
  //   net = round2(gross - commission - delivery - refunds)
  // ──────────────────────────────────────────────────────
  it('5. net = round2(gross - commission - delivery - refunds)', () => {
    fc.assert(
      fc.property(
        moneyArb,
        rateArb,
        deliveryArb,
        refundArb,
        (gross, rate, delivery, refunds) => {
          const commission = computeCommission(gross, rate)
          const net = computeNetRevenue({
            grossRevenue: gross,
            commissionRate: rate,
            deliveryCosts: delivery,
            refundAmount: refunds,
          })

          // Algebraic identity (in 2dp money), reconstructed in cents to
          // avoid float drift when commission is rounded.
          const grossCents = Math.round(gross * 100)
          const commissionCents = Math.round(commission * 100)
          const deliveryCents = Math.round(delivery * 100)
          const refundCents = Math.round(refunds * 100)
          const expectedNetCents =
            grossCents - commissionCents - deliveryCents - refundCents

          expect(Math.round(net * 100)).toBe(expectedNetCents)
          // Result is cent-precise (fits DECIMAL(12,2)).
          expect(net).toBe(round2(net))
        }
      ),
      { numRuns: 100 }
    )
  })

  // ──────────────────────────────────────────────────────
  // Sub-property 6 — Net does NOT clamp to zero.
  //   When delivery + refunds > gross − commission, net is negative and
  //   the function returns the true mathematical value (the ledger
  //   requires it). Refunds are forced strictly greater than gross so
  //   the negative-net path is exercised every iteration.
  // ──────────────────────────────────────────────────────
  it('6. net can be negative when delivery + refunds exceed gross − commission', () => {
    const negCaseArb = fc.record({
      // Keep gross small so delivery + refunds dominate.
      gross: fc.integer({ min: 0, max: 10_000 }).map((c) => c / 100),
      // Modest rate so commission can't eat all of gross.
      rate: fc.integer({ min: 0, max: 1_000 }).map((bps) => bps / 100),
      delivery: fc.integer({ min: 0, max: 50_000 }).map((c) => c / 100),
      // Refunds strictly greater than max gross (10_000 cents) to
      // guarantee the negative-net precondition.
      refunds: fc.integer({ min: 50_001, max: 100_000 }).map((c) => c / 100),
    })

    fc.assert(
      fc.property(negCaseArb, ({ gross, rate, delivery, refunds }) => {
        const commission = computeCommission(gross, rate)
        const net = computeNetRevenue({
          grossRevenue: gross,
          commissionRate: rate,
          deliveryCosts: delivery,
          refundAmount: refunds,
        })

        // Precondition: refunds alone already exceeds gross by construction.
        expect(refunds).toBeGreaterThan(gross)
        expect(net).toBeLessThan(0)
        // And the function did not clamp.
        expect(net).toBe(round2(gross - commission - delivery - refunds))
      }),
      { numRuns: 100 }
    )
  })

  // ──────────────────────────────────────────────────────
  // Sub-property 7 — Average order value.
  //   total_orders > 0  ⇒ avg = round2(gross / total_orders)
  //   total_orders = 0  ⇒ avg = 0
  // ──────────────────────────────────────────────────────
  it('7. avg_order_value = totalOrders > 0 ? round2(gross/totalOrders) : 0', () => {
    fc.assert(
      fc.property(moneyArb, totalOrdersArb, (gross, totalOrders) => {
        const avg = computeAvgOrderValue(gross, totalOrders)

        if (totalOrders === 0) {
          expect(avg).toBe(0)
        } else {
          expect(avg).toBe(round2(gross / totalOrders))
          expect(avg).toBeGreaterThanOrEqual(0)
          // Result is cent-precise (fits DECIMAL(10,2)).
          expect(avg).toBe(round2(avg))
        }
      }),
      { numRuns: 100 }
    )
  })
})
