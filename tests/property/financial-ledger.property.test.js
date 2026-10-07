// Task 8.12 — Financial Ledger Balance + Immutability Property
// **Property:** Ledger balance after N inserts equals Σ(CREDIT) − Σ(DEBIT);
// no row UPDATE/DELETE ever occurs.
//
// This property test combines the balance-summation invariant (from 10.D in
// ledger-balance-invariant) with the immutability invariant (from 11 in
// ledger-immutability) into a single focused property that matches the
// task 8.12 statement exactly.
//
// Sub-properties:
//   8.12.A — Balance after N inserts = Σ(CREDIT amounts) − Σ(DEBIT amounts)
//   8.12.B — No row is ever modified after insertion (byte-identical snapshots)
//   8.12.C — Row count grows by exactly +1 per append, never decreases

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
  CREDIT_TYPES,
  DEBIT_TYPES,
  TRANSACTION_TYPES,
} from '../../src/modules/shop-transactions/shop-transactions.schema.js'

const { toCents, fromCents } = __internals

// ─── Test fixtures ───────────────────────────────────────────
const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const ORDER_ID = '22222222-2222-2222-2222-222222222222'

// ─── Seed for reproducibility ─────────────────────────────────
const SEED = 20240812
const NUM_RUNS = 100

// ─── Arbitraries ─────────────────────────────────────────────
const transactionTypeArb = fc.constantFrom(...TRANSACTION_TYPES)
const amountCentsArb = fc.integer({ min: 1, max: 100_000 })

const sequenceEntryArb = fc.record({
  type: transactionTypeArb,
  amountCents: amountCentsArb,
})

const sequenceArb = fc.array(sequenceEntryArb, { minLength: 1, maxLength: 20 })

// ─── Helpers ─────────────────────────────────────────────────

function referenceTypeFor(type) {
  if (type === 'PAYOUT_CREDIT') return 'PAYOUT'
  if (type === 'ADJUSTMENT') return 'ADJUSTMENT'
  if (type === 'EXPENSE') return 'EXPENSE'
  return 'ORDER'
}

/**
 * Build a threading repository mock that records all inserted rows
 * and never modifies them.
 */
function makeRecordingRepoMock() {
  const rows = []
  let prev = null

  return {
    rows,
    lockLatestForShop: vi.fn(async () => prev),
    insertEntry: vi.fn(async (_client, row) => {
      const inserted = { id: `tx-${rows.length}`, ...row, _insertedAt: Date.now() }
      rows.push(inserted)
      prev = { balance_after: row.balance_after }
      return inserted
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

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════
// Property 8.12.A — Balance = Σ(CREDIT) − Σ(DEBIT)
// ═══════════════════════════════════════════════════════════════
describe('Property 8.12: Financial Ledger Balance + Immutability', () => {
  it('balance after N inserts equals Σ(CREDIT amounts) − Σ(DEBIT amounts)', async () => {
    await fc.assert(
      fc.asyncProperty(sequenceArb, async (steps) => {
        const repo = makeRecordingRepoMock()
        const writer = new LedgerWriteService(repo)
        const client = makeTxClientMock()

        let lastInserted = null

        for (const { type, amountCents } of steps) {
          const amount = Number(fromCents(amountCents))
          lastInserted = await writer.append(client, {
            shopId: SHOP_ID,
            type,
            amount,
            referenceType: referenceTypeFor(type),
            referenceId: ORDER_ID,
          })
        }

        // Compute expected balance: Σ credits − Σ debits (in cents)
        let expectedCents = 0
        for (const { type, amountCents } of steps) {
          if (CREDIT_TYPES.has(type)) {
            expectedCents += amountCents
          } else if (DEBIT_TYPES.has(type)) {
            expectedCents -= amountCents
          }
        }

        // The last inserted row's balance_after must match
        const actualCents = toCents(lastInserted.balance_after)
        expect(actualCents).toBe(expectedCents)
      }),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })

  // ═══════════════════════════════════════════════════════════════
  // Property 8.12.B — No row UPDATE/DELETE ever occurs
  // ═══════════════════════════════════════════════════════════════
  it('no previously inserted row is ever modified (byte-identical after each append)', async () => {
    await fc.assert(
      fc.asyncProperty(sequenceArb, async (steps) => {
        const repo = makeRecordingRepoMock()
        const writer = new LedgerWriteService(repo)
        const client = makeTxClientMock()

        const snapshots = [] // snapshot after each insert

        for (const { type, amountCents } of steps) {
          const amount = Number(fromCents(amountCents))
          await writer.append(client, {
            shopId: SHOP_ID,
            type,
            amount,
            referenceType: referenceTypeFor(type),
            referenceId: ORDER_ID,
          })

          // Take a deep snapshot of all rows so far
          snapshots.push(repo.rows.map((r) => JSON.stringify(r)))
        }

        // Verify: each snapshot[i] is a prefix of snapshot[i+1] and
        // the rows in the prefix are byte-identical
        for (let i = 1; i < snapshots.length; i++) {
          const prev = snapshots[i - 1]
          const curr = snapshots[i]

          // Previous rows must be unchanged
          for (let j = 0; j < prev.length; j++) {
            expect(curr[j]).toBe(prev[j])
          }

          // Exactly one new row was added
          expect(curr.length).toBe(prev.length + 1)
        }
      }),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })

  // ═══════════════════════════════════════════════════════════════
  // Property 8.12.C — Row count grows by exactly +1 per append
  // ═══════════════════════════════════════════════════════════════
  it('row count grows by exactly +1 per append and never decreases', async () => {
    await fc.assert(
      fc.asyncProperty(sequenceArb, async (steps) => {
        const repo = makeRecordingRepoMock()
        const writer = new LedgerWriteService(repo)
        const client = makeTxClientMock()

        let expectedCount = 0

        for (const { type, amountCents } of steps) {
          const amount = Number(fromCents(amountCents))
          await writer.append(client, {
            shopId: SHOP_ID,
            type,
            amount,
            referenceType: referenceTypeFor(type),
            referenceId: ORDER_ID,
          })

          expectedCount++
          expect(repo.rows.length).toBe(expectedCount)
        }

        // Final count equals number of steps
        expect(repo.rows.length).toBe(steps.length)
      }),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })
})
