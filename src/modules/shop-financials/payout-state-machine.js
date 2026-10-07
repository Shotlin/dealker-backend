// Feature: multi-vendor-system, Property 16: Payout State Machine
// Validates: Requirements 8.2, 8.5
//
// Pure state machine for payout_status (no I/O, no DB, no logger).
//
// Why pure:
//   - Property 16 drives this with fast-check across thousands of
//     (state, event, attemptCount) triples; isolating the transition table
//     here means the property test never has to spin up Redis/Postgres or
//     mock the BullMQ payout worker.
//   - The Payout_Worker (task 9.2) calls `nextPayoutState(...)` to decide
//     the next status BEFORE any side effect (DB UPDATE, ledger write,
//     notification). Keeping the function side-effect-free guarantees the
//     decision is deterministic and replay-safe.
//
// Transition table (matches Req 8.2 + 8.5 + 8.7):
//
//   PENDING    + START                         → PROCESSING
//   PROCESSING + PAID                          → PAID
//   PROCESSING + FAIL  (attemptCount < 3)      → PENDING   (Req 8.5)
//   PROCESSING + FAIL  (attemptCount >= 3)     → HELD      (Req 8.5)
//   PENDING    + HOLD                          → HELD      (Req 8.7)
//   PROCESSING + HOLD                          → HELD      (Req 8.7)
//   HELD       + RELEASE                       → PENDING   (Req 8.7)
//   PAID       + (any event)                   → PAID      (terminal)
//   anything else                              → null      (rejected)
//
// Terminal-state choice (PAID):
//   PAID is terminal in the business sense — once a payout is disbursed
//   the platform never moves it back to PENDING/PROCESSING. Returning the
//   same `'PAID'` for any event (rather than null) lets the worker write
//   idempotent reconciliation jobs without crashing if a stale event
//   arrives. Property 16.4 documents and tests this behaviour.

/** Allowed payout_status values (kept in sync with the DB CHECK constraint). */
export const PAYOUT_STATES = Object.freeze([
  'PENDING',
  'PROCESSING',
  'PAID',
  'HELD',
])

/** Allowed events that can drive a transition. */
export const PAYOUT_EVENTS = Object.freeze([
  'START',
  'PAID',
  'FAIL',
  'HOLD',
  'RELEASE',
])

/** Max retry attempts before a payout flips to HELD (Req 8.5). */
export const PAYOUT_MAX_ATTEMPTS = 3

/**
 * Compute the next payout_status for the given (state, event, attemptCount).
 *
 * Pure: returns a string from PAYOUT_STATES on a valid transition, or
 * `null` when the transition is not allowed. Never throws on unknown
 * inputs — the caller (Payout_Worker) treats `null` as "reject event,
 * keep current state" so an invalid event can't accidentally advance the
 * state machine.
 *
 * @param {string} currentState - one of PAYOUT_STATES
 * @param {string} event        - one of PAYOUT_EVENTS
 * @param {number} [attemptCount=0] - prior failure count (>= 0). Only
 *   relevant for PROCESSING + FAIL: when attemptCount >= 3 the row flips
 *   to HELD instead of going back to PENDING (Req 8.5).
 * @returns {string|null} next state, or null if the transition is invalid.
 */
export function nextPayoutState(currentState, event, attemptCount = 0) {
  // Terminal: PAID swallows every event so reconciliation is idempotent.
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
      const n = Number.isFinite(attemptCount) ? attemptCount : 0
      return n >= PAYOUT_MAX_ATTEMPTS ? 'HELD' : 'PENDING'
    }
    return null
  }

  if (currentState === 'HELD') {
    if (event === 'RELEASE') return 'PENDING'
    return null
  }

  // Unknown current state.
  return null
}
