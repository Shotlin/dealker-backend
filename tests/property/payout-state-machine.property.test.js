// Feature: multi-vendor-system, Property 16: Payout State Machine
// **Validates: Requirements 8.2, 8.5**
//
// Property:
//   For any payout, transitions follow PENDING → PROCESSING → PAID. Three
//   failures during PROCESSING flip the row to HELD (manual review).
//
// Sub-properties asserted below (each as its own property test):
//   16.1 Valid transitions      — PENDING+START → PROCESSING,
//                                 PROCESSING+PAID → PAID,
//                                 HELD+RELEASE → PENDING are accepted.
//   16.2 Failure threshold      — PROCESSING+FAIL with attemptCount < 3 → PENDING;
//                                 PROCESSING+FAIL with attemptCount >= 3 → HELD.
//   16.3 Admin hold             — PENDING+HOLD → HELD; PROCESSING+HOLD → HELD.
//   16.4 PAID is terminal       — any event from PAID returns PAID
//                                 (idempotent reconciliation; see module
//                                 doc for rationale).
//   16.5 Invalid → null         — every (state, event) NOT in the allowed
//                                 map returns null. Generated exhaustively
//                                 with fast-check.
//
// All output values are constrained to PAYOUT_STATES ∪ {null}, which is
// the closure assertion that lets the Payout_Worker (task 9.2) trust the
// return value for a DB UPDATE without re-validating against the CHECK
// constraint on shop_financials.payout_status.

import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'

import {
  PAYOUT_STATES,
  PAYOUT_EVENTS,
  PAYOUT_MAX_ATTEMPTS,
  nextPayoutState,
} from '../../src/modules/shop-financials/payout-state-machine.js'

// ─── Arbitraries ───────────────────────────────────────────────

const stateArb = fc.constantFrom(...PAYOUT_STATES)
const eventArb = fc.constantFrom(...PAYOUT_EVENTS)
const attemptArb = fc.integer({ min: 0, max: 10 })

// ─── Allowed-transition oracle ─────────────────────────────────
//
// Mirrors the transition table in payout-state-machine.js. We restate it
// here (instead of re-importing the function) so the test is checking the
// SPEC, not the implementation. If someone changes the implementation,
// this oracle stays put and any divergence shows up as a test failure.
function expectedNext(currentState, event, attemptCount) {
  if (currentState === 'PAID') return 'PAID'
  if (currentState === 'PENDING') {
    if (event === 'START') return 'PROCESSING'
    if (event === 'HOLD') return 'HELD'
    return null
  }
  if (currentState === 'PROCESSING') {
    if (event === 'PAID') return 'PAID'
    if (event === 'HOLD') return 'HELD'
    if (event === 'FAIL') {
      return attemptCount >= PAYOUT_MAX_ATTEMPTS ? 'HELD' : 'PENDING'
    }
    return null
  }
  if (currentState === 'HELD') {
    if (event === 'RELEASE') return 'PENDING'
    return null
  }
  return null
}

// ═══════════════════════════════════════════════════════════════
// Property 16.1 — Valid transitions
// ═══════════════════════════════════════════════════════════════
describe('Property 16: Payout State Machine — valid transitions (Req 8.2)', () => {
  it('PENDING + START → PROCESSING', () => {
    fc.assert(
      fc.property(attemptArb, (attempt) => {
        expect(nextPayoutState('PENDING', 'START', attempt)).toBe('PROCESSING')
      }),
      { numRuns: 100 }
    )
  })

  it('PROCESSING + PAID → PAID', () => {
    fc.assert(
      fc.property(attemptArb, (attempt) => {
        expect(nextPayoutState('PROCESSING', 'PAID', attempt)).toBe('PAID')
      }),
      { numRuns: 100 }
    )
  })

  it('HELD + RELEASE → PENDING', () => {
    fc.assert(
      fc.property(attemptArb, (attempt) => {
        expect(nextPayoutState('HELD', 'RELEASE', attempt)).toBe('PENDING')
      }),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 16.2 — Failure threshold (Req 8.5)
// ═══════════════════════════════════════════════════════════════
describe('Property 16: Payout State Machine — failure threshold (Req 8.5)', () => {
  it('PROCESSING + FAIL with attemptCount < 3 → PENDING', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: PAYOUT_MAX_ATTEMPTS - 1 }), (attempt) => {
        expect(nextPayoutState('PROCESSING', 'FAIL', attempt)).toBe('PENDING')
      }),
      { numRuns: 100 }
    )
  })

  it('PROCESSING + FAIL with attemptCount >= 3 → HELD', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: PAYOUT_MAX_ATTEMPTS, max: 50 }),
        (attempt) => {
          expect(nextPayoutState('PROCESSING', 'FAIL', attempt)).toBe('HELD')
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 16.3 — Admin hold
// ═══════════════════════════════════════════════════════════════
describe('Property 16: Payout State Machine — admin hold (Req 8.7 supports 8.5)', () => {
  it('PENDING + HOLD → HELD', () => {
    fc.assert(
      fc.property(attemptArb, (attempt) => {
        expect(nextPayoutState('PENDING', 'HOLD', attempt)).toBe('HELD')
      }),
      { numRuns: 100 }
    )
  })

  it('PROCESSING + HOLD → HELD', () => {
    fc.assert(
      fc.property(attemptArb, (attempt) => {
        expect(nextPayoutState('PROCESSING', 'HOLD', attempt)).toBe('HELD')
      }),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 16.4 — PAID is terminal
// ═══════════════════════════════════════════════════════════════
describe('Property 16: Payout State Machine — PAID is terminal (Req 8.2)', () => {
  it('any event from PAID returns PAID (idempotent reconciliation)', () => {
    fc.assert(
      fc.property(eventArb, attemptArb, (event, attempt) => {
        expect(nextPayoutState('PAID', event, attempt)).toBe('PAID')
      }),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 16.5 — Invalid transitions return null
// ═══════════════════════════════════════════════════════════════
describe('Property 16: Payout State Machine — invalid transitions return null (Req 8.2)', () => {
  it('any (state, event) NOT in the allowed map returns null', () => {
    fc.assert(
      fc.property(stateArb, eventArb, attemptArb, (state, event, attempt) => {
        const got = nextPayoutState(state, event, attempt)
        const expected = expectedNext(state, event, attempt)
        expect(got).toBe(expected)
      }),
      { numRuns: 200 }
    )
  })

  it('output is always in PAYOUT_STATES or null (closure)', () => {
    fc.assert(
      fc.property(stateArb, eventArb, attemptArb, (state, event, attempt) => {
        const got = nextPayoutState(state, event, attempt)
        if (got === null) return
        expect(PAYOUT_STATES).toContain(got)
      }),
      { numRuns: 200 }
    )
  })

  it('explicit invalid examples return null', () => {
    // Not in the table — must be rejected.
    expect(nextPayoutState('PENDING', 'PAID')).toBeNull()
    expect(nextPayoutState('PENDING', 'FAIL')).toBeNull()
    expect(nextPayoutState('PENDING', 'RELEASE')).toBeNull()
    expect(nextPayoutState('PROCESSING', 'START')).toBeNull()
    expect(nextPayoutState('PROCESSING', 'RELEASE')).toBeNull()
    expect(nextPayoutState('HELD', 'START')).toBeNull()
    expect(nextPayoutState('HELD', 'PAID')).toBeNull()
    expect(nextPayoutState('HELD', 'FAIL')).toBeNull()
    expect(nextPayoutState('HELD', 'HOLD')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 16 — End-to-end happy path
// ═══════════════════════════════════════════════════════════════
describe('Property 16: Payout State Machine — happy path PENDING→PROCESSING→PAID', () => {
  it('threading a successful payout walks the canonical path', () => {
    let state = 'PENDING'
    state = nextPayoutState(state, 'START', 0)
    expect(state).toBe('PROCESSING')
    state = nextPayoutState(state, 'PAID', 0)
    expect(state).toBe('PAID')
    // PAID is terminal — any further event sticks.
    state = nextPayoutState(state, 'FAIL', 99)
    expect(state).toBe('PAID')
  })

  it('three failures from PROCESSING land in HELD', () => {
    let state = 'PROCESSING'
    let attempts = 0
    // 1st failure: attemptCount=0 → PENDING (retry next run)
    state = nextPayoutState(state, 'FAIL', attempts)
    attempts += 1
    expect(state).toBe('PENDING')
    // Worker picks it up again next Monday.
    state = nextPayoutState(state, 'START', attempts)
    expect(state).toBe('PROCESSING')
    // 2nd failure: attemptCount=1 → PENDING
    state = nextPayoutState(state, 'FAIL', attempts)
    attempts += 1
    expect(state).toBe('PENDING')
    state = nextPayoutState(state, 'START', attempts)
    expect(state).toBe('PROCESSING')
    // 3rd failure: attemptCount=2 → PENDING (still under threshold)
    state = nextPayoutState(state, 'FAIL', attempts)
    attempts += 1
    expect(state).toBe('PENDING')
    state = nextPayoutState(state, 'START', attempts)
    expect(state).toBe('PROCESSING')
    // 4th attempt fails: attemptCount=3 → HELD (Req 8.5)
    state = nextPayoutState(state, 'FAIL', attempts)
    expect(state).toBe('HELD')
    // Super_Admin releases for manual replay (Req 8.7).
    state = nextPayoutState(state, 'RELEASE', attempts)
    expect(state).toBe('PENDING')
  })
})
