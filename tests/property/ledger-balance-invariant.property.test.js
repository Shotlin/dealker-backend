// Feature: multi-vendor-system, Property 10: Ledger Balance Invariant
// **Validates: Requirements 7.7, 7.8**
//
// Property:
//   For any transaction sequence, balance_after = previous_balance +/- amount
//   (credits add, debits subtract), starting from 0.00 (Req 7.7, 7.8).
//
// What we exercise:
//   The pure decision lives in
//   `LedgerWriteService.computeBalanceCents(prevCents, type, amountCents)`
//   from src/modules/shop-transactions/shop-transactions.service.js. That
//   single function — together with the cents helpers `__internals.toCents`
//   / `__internals.fromCents` — encapsulates the running-balance arithmetic
//   that Req 7.7 specifies. We property-test it directly.
//
//   A second layer of property checks drives the full
//   `LedgerWriteService.append(...)` happy path through a mocked repository
//   so we also assert that the integer-cents math matches the canonical
//   "0.00" / "10.50" / "-3.25" string written into `balance_after` (Req 7.8
//   — the very first entry on an empty shop bootstraps from 0.00).
//
// Sub-properties:
//   10.A — Initial balance is 0.00: for any first entry,
//          balance_after = (+/-) amount based on type.
//   10.B — Credit semantics: for any (prev, type ∈ CREDIT_TYPES, amount),
//          computeBalanceCents = prev + amount.
//   10.C — Debit semantics: for any (prev, type ∈ DEBIT_TYPES, amount),
//          computeBalanceCents = prev - amount.
//   10.D — Sequence invariant: for any sequence of (type, amount) pairs,
//          the running balance at step N equals the signed sum of the first
//          N entries (in cents).
//   10.E — No floating-point drift: summing many 2-decimal amounts via the
//          cents helpers produces exact 2-decimal output (e.g.
//          0.10 + 0.20 = 0.30, not 0.30000000000000004).
//
// Mocks:
//   The service file imports cache.js / database.js / logger.js at module
//   load. We mock all three so the test stays hermetic — no Redis, no
//   Postgres. computeBalanceCents itself is pure, but the append-driver
//   path (sub-properties 10.A and 10.D) needs the surrounding module to
//   load cleanly.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'

// ─── Mock external dependencies BEFORE importing the service ──
vi.mock('../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  LedgerWriteService,
  __internals,
} from '../../src/modules/shop-transactions/shop-transactions.service.js'
import {
  TRANSACTION_TYPES,
  CREDIT_TYPES,
  DEBIT_TYPES,
} from '../../src/modules/shop-transactions/shop-transactions.schema.js'

const { toCents, fromCents } = __internals

// ─── Test fixtures ───────────────────────────────────────────
const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const ORDER_ID = '22222222-2222-2222-2222-222222222222'

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── Arbitraries ─────────────────────────────────────────────

// Transaction type — every string in the schema enum, uniformly sampled.
const transactionTypeArb = fc.constantFrom(...TRANSACTION_TYPES)
const creditTypeArb = fc.constantFrom(...CREDIT_TYPES)
const debitTypeArb = fc.constantFrom(...DEBIT_TYPES)

// Pick a valid reference_type for each transaction type. Req 7.7 only
// looks at `type`, but the surrounding `ledgerAppendDataSchema` rejects
// payloads with a missing/invalid `referenceType`, so we constrain the
// arbitrary to the schema's enum.
function referenceTypeFor(type) {
  if (type === 'PAYOUT_CREDIT') return 'PAYOUT'
  if (type === 'ADJUSTMENT') return 'ADJUSTMENT'
  if (type === 'EXPENSE') return 'EXPENSE'
  return 'ORDER'
}

// Amount in cents — DECIMAL(10,2) range from migration: 0.01 .. 99999999.99.
// We keep amounts smaller (≤ 1,000.00 = 100_000 cents) so a sequence of up
// to 20 entries can never overflow Number.MAX_SAFE_INTEGER.
const amountCentsArb = fc.integer({ min: 1, max: 100_000 })

// Amount as a 2-decimal number derived from cents — so the schema's
// `amount.min(0.01)` passes and we never feed an arbitrary IEEE-754 float
// that the schema would reject (e.g. 0.001).
const amountFromCentsArb = amountCentsArb.map((c) => Number(fromCents(c)))

// Previous balance in cents. May be negative (a shop posting DELIVERY_COST
// before ORDER_REVENUE legitimately goes red mid-cycle, per the service's
// design comment on `computeBalanceCents`).
const prevCentsArb = fc.integer({ min: -100_000_000, max: 100_000_000 })

// A single (type, amount) entry for sequences. Amount is in cents so the
// arithmetic stays exact; the driver converts to a 2dp number before
// handing it to `append`.
const sequenceEntryArb = fc.record({
  type: transactionTypeArb,
  amountCents: amountCentsArb,
})

// 1..20 entries, per the task description.
const sequenceArb = fc.array(sequenceEntryArb, { minLength: 1, maxLength: 20 })

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Reference oracle: signed sum of a sequence in integer cents.
 * Matches the spec phrasing in Req 7.7 — credits add, debits subtract,
 * starting from 0 (Req 7.8).
 */
function expectedRunningBalances(steps) {
  const balances = []
  let running = 0
  for (const { type, amountCents } of steps) {
    if (CREDIT_TYPES.has(type)) running += amountCents
    else if (DEBIT_TYPES.has(type)) running -= amountCents
    else throw new Error(`Bad type in oracle: ${type}`)
    balances.push(running)
  }
  return balances
}

/**
 * Build a fresh repository-shaped mock that threads `balance_after` between
 * calls so successive appends see the previous row, matching real DB
 * behaviour (with SELECT FOR UPDATE collapsed away — we only test the
 * arithmetic here).
 */
function makeThreadingRepoMock() {
  let prev = null
  return {
    lockLatestForShop: vi.fn(async () => prev),
    insertEntry: vi.fn(async (_client, row) => {
      prev = { balance_after: row.balance_after }
      return { id: 'tx-' + Math.random(), ...row }
    }),
    findById: vi.fn(),
    findManyByShop: vi.fn(),
    findCurrentBalance: vi.fn(),
  }
}

function makeTxClientMock() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  }
}

// ═══════════════════════════════════════════════════════════════
// Property 10.A — Initial balance is 0.00 (Req 7.8)
// ═══════════════════════════════════════════════════════════════
describe('Property 10.A: Initial balance is 0.00 (Req 7.8)', () => {
  it('first entry on a fresh shop produces balance_after = (+/-) amount', async () => {
    await fc.assert(
      fc.asyncProperty(
        transactionTypeArb,
        amountCentsArb,
        async (type, amountCents) => {
          const repo = makeThreadingRepoMock()
          const writer = new LedgerWriteService(repo)
          const client = makeTxClientMock()
          const amount = Number(fromCents(amountCents))

          const inserted = await writer.append(client, {
            shopId: SHOP_ID,
            type,
            amount,
            referenceType: referenceTypeFor(type),
            referenceId: ORDER_ID,
          })

          // Prior balance was treated as 0 (Req 7.8) so the first
          // balance_after equals signed amount, formatted to 2dp.
          const sign = CREDIT_TYPES.has(type) ? 1 : -1
          const expectedCents = sign * amountCents
          expect(inserted.balance_after).toBe(fromCents(expectedCents))

          // Sanity: the repository was indeed asked to lock the latest row,
          // which returned null (fresh shop), and exactly one INSERT ran.
          expect(repo.lockLatestForShop).toHaveBeenCalledTimes(1)
          expect(repo.insertEntry).toHaveBeenCalledTimes(1)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('computeBalanceCents from prev=0 returns +/- amountCents', () => {
    fc.assert(
      fc.property(transactionTypeArb, amountCentsArb, (type, amountCents) => {
        const out = LedgerWriteService.computeBalanceCents(0, type, amountCents)
        const expected = CREDIT_TYPES.has(type) ? amountCents : -amountCents
        expect(out).toBe(expected)
      }),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 10.B — Credit semantics (Req 7.7)
// ═══════════════════════════════════════════════════════════════
describe('Property 10.B: Credit semantics (Req 7.7)', () => {
  it('for any prev and any CREDIT type, computeBalanceCents = prev + amount', () => {
    fc.assert(
      fc.property(
        prevCentsArb,
        creditTypeArb,
        amountCentsArb,
        (prev, type, amountCents) => {
          const out = LedgerWriteService.computeBalanceCents(
            prev,
            type,
            amountCents
          )
          expect(out).toBe(prev + amountCents)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 10.C — Debit semantics (Req 7.7)
// ═══════════════════════════════════════════════════════════════
describe('Property 10.C: Debit semantics (Req 7.7)', () => {
  it('for any prev and any DEBIT type, computeBalanceCents = prev - amount', () => {
    fc.assert(
      fc.property(
        prevCentsArb,
        debitTypeArb,
        amountCentsArb,
        (prev, type, amountCents) => {
          const out = LedgerWriteService.computeBalanceCents(
            prev,
            type,
            amountCents
          )
          expect(out).toBe(prev - amountCents)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 10.D — Sequence invariant (Req 7.7, 7.8)
// ═══════════════════════════════════════════════════════════════
describe('Property 10.D: Sequence invariant (Req 7.7, 7.8)', () => {
  it('balance_after at step N matches signed sum of all entries up to step N', async () => {
    await fc.assert(
      fc.asyncProperty(sequenceArb, async (steps) => {
        const repo = makeThreadingRepoMock()
        const writer = new LedgerWriteService(repo)
        const client = makeTxClientMock()

        const oracle = expectedRunningBalances(steps)
        const observedCents = []

        for (const { type, amountCents } of steps) {
          const amount = Number(fromCents(amountCents))
          const inserted = await writer.append(client, {
            shopId: SHOP_ID,
            type,
            amount,
            referenceType: referenceTypeFor(type),
            referenceId: ORDER_ID,
          })
          observedCents.push(toCents(inserted.balance_after))
        }

        expect(observedCents).toEqual(oracle)

        // The first step always read no previous row (Req 7.8 bootstrap).
        const firstLockReturn =
          await repo.lockLatestForShop.mock.results[0].value
        expect(firstLockReturn).toBeNull()
      }),
      { numRuns: 100 }
    )
  })

  it('pure computeBalanceCents folds correctly over a random sequence', () => {
    fc.assert(
      fc.property(sequenceArb, (steps) => {
        let running = 0
        const observed = []
        for (const { type, amountCents } of steps) {
          running = LedgerWriteService.computeBalanceCents(
            running,
            type,
            amountCents
          )
          observed.push(running)
        }
        expect(observed).toEqual(expectedRunningBalances(steps))
      }),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 10.E — No floating-point drift (Req 7.7, 7.8)
// ═══════════════════════════════════════════════════════════════
describe('Property 10.E: No floating-point drift (Req 7.7, 7.8)', () => {
  it('summing 2-decimal amounts via cents helpers yields an exact 2dp string', () => {
    fc.assert(
      fc.property(
        // 1..50 amounts in [0.01, 1000.00]
        fc.array(amountFromCentsArb, { minLength: 1, maxLength: 50 }),
        (amounts) => {
          // Reference: integer-cents fold (always exact in Number).
          const totalCents = amounts.reduce((acc, a) => acc + toCents(a), 0)

          const observed = fromCents(totalCents)

          // Must be a clean 2dp string ("123.45" or "-0.05") with NO long
          // floating-point tail like "0.30000000000000004".
          expect(observed).toMatch(/^-?\d+\.\d{2}$/)

          // Numerically equal to the integer-cents fold.
          expect(toCents(observed)).toBe(totalCents)

          // And specifically: a naive Number sum of the same inputs may
          // disagree at the 1e-15 scale, but our cents-based output must
          // round-trip back to the same total.
          const roundedNaive = Math.round(
            amounts.reduce((s, a) => s + a, 0) * 100
          )
          expect(roundedNaive).toBe(totalCents)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('the canonical "0.10 + 0.20 = 0.30" example holds (regression anchor)', () => {
    expect(fromCents(toCents(0.1) + toCents(0.2))).toBe('0.30')
    expect(fromCents(toCents(0.1) + toCents(0.2) + toCents(0.3))).toBe('0.60')
  })

  it('long arithmetic chain through computeBalanceCents stays drift-free', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ type: transactionTypeArb, amountCents: amountCentsArb }),
          { minLength: 1, maxLength: 50 }
        ),
        (steps) => {
          let running = 0
          for (const { type, amountCents } of steps) {
            running = LedgerWriteService.computeBalanceCents(
              running,
              type,
              amountCents
            )
          }
          // The fold value must round-trip cleanly through the formatter:
          // fromCents(running) is a 2dp string and toCents of that string
          // returns the same integer.
          const formatted = fromCents(running)
          expect(formatted).toMatch(/^-?\d+\.\d{2}$/)
          expect(toCents(formatted)).toBe(running)
        }
      ),
      { numRuns: 100 }
    )
  })
})
