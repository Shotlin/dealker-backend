// Feature: multi-vendor-system, Property 14: Bulk Order State Machine
// **Validates: Requirements 9.1**
//
// Property statement:
//   For any bulk order in state S, only valid lifecycle transitions are accepted.
//
// Lifecycle (Req 9.1):
//   DRAFT      → SUBMITTED, CANCELLED
//   SUBMITTED  → CONFIRMED, CANCELLED
//   CONFIRMED  → PROCESSING, CANCELLED
//   PROCESSING → READY
//   READY      → DELIVERED
//   DELIVERED  → ∅ (terminal)
//   CANCELLED  → ∅ (terminal)
//
// Properties verified:
//   1. Allowed list:         every (from, to) in the table returns true.
//   2. Disallowed pairs:     every (from, to) NOT in the table returns false.
//   3. Same-state:           isValidTransition(s, s) === false for any s.
//   4. Terminal states:      DELIVERED and CANCELLED accept no transitions.

import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'

// ─── Mock infra deps so the service module loads without DB/logger ───
// `bulk-orders.service.js` imports the database client and logger at load
// time. The state machine itself is pure — these mocks just keep the
// module loadable in isolation for the property test.
vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  BulkOrdersService,
  STATE_MACHINE,
} from '../../src/modules/bulk-orders/bulk-orders.service.js'

// ─── Canonical lifecycle table (Req 9.1) ─────────────────
const STATES = [
  'DRAFT',
  'SUBMITTED',
  'CONFIRMED',
  'PROCESSING',
  'READY',
  'DELIVERED',
  'CANCELLED',
]

const ALLOWED_TRANSITIONS = [
  ['DRAFT', 'SUBMITTED'],
  ['DRAFT', 'CANCELLED'],
  ['SUBMITTED', 'CONFIRMED'],
  ['SUBMITTED', 'CANCELLED'],
  ['CONFIRMED', 'PROCESSING'],
  ['CONFIRMED', 'CANCELLED'],
  ['PROCESSING', 'READY'],
  ['READY', 'DELIVERED'],
]

const TERMINAL_STATES = ['DELIVERED', 'CANCELLED']

// O(1) membership check — `${from}->${to}` keyed Set.
const allowedKey = (from, to) => `${from}->${to}`
const ALLOWED_SET = new Set(
  ALLOWED_TRANSITIONS.map(([f, t]) => allowedKey(f, t))
)

// ─── Arbitraries ─────────────────────────────────────────
const stateArb = fc.constantFrom(...STATES)

// Arbitrary that picks one allowed (from, to) pair from the table.
const allowedPairArb = fc.constantFrom(...ALLOWED_TRANSITIONS)

// Sanity: the canonical table inside the service module exposes exactly the
// states and edges we are testing. If this drifts, the property tests below
// become meaningless — fail loudly with a single targeted check.
describe('Property 14: Bulk Order State Machine — module surface', () => {
  it('exports a frozen STATE_MACHINE keyed by every lifecycle state', () => {
    expect(Object.isFrozen(STATE_MACHINE)).toBe(true)
    expect(Object.keys(STATE_MACHINE).sort()).toEqual([...STATES].sort())
  })

  it('exposes isValidTransition as a static method on BulkOrdersService', () => {
    expect(typeof BulkOrdersService.isValidTransition).toBe('function')
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 14.1 — Every allowed (from, to) is accepted
// ═══════════════════════════════════════════════════════════════
describe('Property 14.1: every allowed transition is accepted (Req 9.1)', () => {
  it('isValidTransition returns true for each documented (from, to)', () => {
    fc.assert(
      fc.property(allowedPairArb, ([from, to]) => {
        expect(BulkOrdersService.isValidTransition(from, to)).toBe(true)
      }),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 14.2 — Every (from, to) NOT in the allowed table is rejected
// ═══════════════════════════════════════════════════════════════
describe('Property 14.2: every disallowed transition is rejected (Req 9.1)', () => {
  it('isValidTransition returns false for any pair not in the allowed table', () => {
    fc.assert(
      fc.property(stateArb, stateArb, (from, to) => {
        // Skip allowed pairs — those are covered by 14.1.
        fc.pre(!ALLOWED_SET.has(allowedKey(from, to)))
        expect(BulkOrdersService.isValidTransition(from, to)).toBe(false)
      }),
      { numRuns: 100 }
    )
  })

  it('exhaustive cross-product agrees with the allowed table', () => {
    // Belt-and-braces: enumerate the full 7×7 matrix once so we never miss
    // a pair through fc.pre filtering. Exhaustive check is cheap (49 cases)
    // and locks the table down.
    for (const from of STATES) {
      for (const to of STATES) {
        const expected = ALLOWED_SET.has(allowedKey(from, to))
        expect(BulkOrdersService.isValidTransition(from, to)).toBe(expected)
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 14.3 — Same-state transitions are always rejected
// ═══════════════════════════════════════════════════════════════
describe('Property 14.3: same-state transitions are rejected (Req 9.1)', () => {
  it('isValidTransition(s, s) === false for every state s', () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        expect(BulkOrdersService.isValidTransition(s, s)).toBe(false)
      }),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 14.4 — Terminal states accept no outbound transitions
// ═══════════════════════════════════════════════════════════════
describe('Property 14.4: terminal states are absorbing (Req 9.1)', () => {
  const terminalArb = fc.constantFrom(...TERMINAL_STATES)

  it('no transition out of DELIVERED or CANCELLED is ever valid', () => {
    fc.assert(
      fc.property(terminalArb, stateArb, (terminal, target) => {
        expect(BulkOrdersService.isValidTransition(terminal, target)).toBe(
          false
        )
      }),
      { numRuns: 100 }
    )
  })

  it('STATE_MACHINE entry for each terminal state is empty', () => {
    for (const terminal of TERMINAL_STATES) {
      expect([...STATE_MACHINE[terminal]]).toEqual([])
    }
  })
})
