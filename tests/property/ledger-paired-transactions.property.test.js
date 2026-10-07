// Feature: multi-vendor-system, Property 12: Paired Transactions
// **Validates: Requirements 7.5**
//
// Property:
//   For any completed order, the ledger contains exactly one ORDER_REVENUE
//   and one COMMISSION_DEBIT, created atomically inside the caller's
//   transaction. Both entries share the same `reference_id` (the order ID)
//   and `reference_type='ORDER'` so they pair up under the same order.
//   Commission amount = round(revenue_amount * commission_rate / 100, 2)
//   computed in integer cents to avoid IEEE-754 drift.
//
//   Concretely on `LedgerWriteService.recordPair(client, …)`:
//
//   1. Atomic pair semantics — both inserts use the SAME pg client passed
//      in by the caller (so the caller's BEGIN…COMMIT envelope wraps both),
//      and the second insert's reference_id matches the first.
//   2. Commission formula — commission amount equals
//      `round(revenue_amount * commission_rate / 100, 2)` (cents-based).
//   3. Balance after pair — `balance_after` of the COMMISSION_DEBIT row
//      equals `prev_balance + revenue - commission` (Req 7.7, 7.8).
//   4. Zero-commission edge case — when `commission_rate = 0` (or the
//      computed commission rounds to zero cents), only ORDER_REVENUE is
//      written; no COMMISSION_DEBIT is recorded.
//   5. Failure rolls back the pair — if the second insertEntry throws, the
//      error propagates so the caller can ROLLBACK. The caller's pg client
//      itself receives no extra queries from the service.
//
// Approach:
//   The service collaborates with `ShopTransactionsRepository` for both the
//   FOR UPDATE read (`lockLatestForShop`) and the INSERT (`insertEntry`).
//   We hand it a stateful repository mock that:
//     - stores the latest balance in-memory and returns it from
//       `lockLatestForShop`, so the second call sees the row written by the
//       first (mirroring the SELECT … FOR UPDATE serialisation a real
//       transaction provides),
//     - records every `insertEntry` call's `client` and `row` so we can
//       assert exactly which writes happened, in what order, and on which
//       client.
//   The pg client is an opaque object with a `query` spy — passed through
//   the service unchanged. This mirrors the smoke-test pattern in
//   `tests/unit/shop-transactions/shop-transactions.smoke.test.js`.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'

// ─── External deps mocked per project convention ───────────────────────
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

import { LedgerWriteService } from '../../src/modules/shop-transactions/shop-transactions.service.js'

// ─── Test doubles ──────────────────────────────────────────────────────

/**
 * Build a fake pg.PoolClient. The service does not call client.query()
 * directly — the repository does — so the spy here is purely to assert
 * "the service issued no extra queries on the caller's client" (Req 7.9
 * — caller owns BEGIN/COMMIT/ROLLBACK).
 */
function makeFakeClient() {
  const calls = []
  return {
    calls,
    query: vi.fn(async (sql) => {
      const text = typeof sql === 'string' ? sql : sql?.text || ''
      calls.push(text)
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
}

/**
 * Stateful repository mock. Tracks the latest row in-memory so the
 * second `lockLatestForShop` call inside `recordPair` sees the
 * ORDER_REVENUE row that the first append just wrote — exactly what
 * SELECT … FOR UPDATE would surface inside one transaction.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.initialBalanceAfter=null] - balance_after of the
 *   pre-existing latest row, or null for "shop has no entries yet" (Req 7.8).
 * @param {number|null} [opts.failOnInsertCall=null] - 1-indexed call number
 *   of the insertEntry invocation that should throw (used by the rollback
 *   property to simulate a DB error on the second entry).
 */
function makeStatefulRepo({
  initialBalanceAfter = null,
  failOnInsertCall = null,
} = {}) {
  const inserts = [] // captures every insertEntry row arg (in order)
  const insertedClients = [] // captures every insertEntry client arg
  const lockedClients = [] // captures every lockLatestForShop client arg
  let latest =
    initialBalanceAfter === null
      ? null
      : { balance_after: initialBalanceAfter }

  const repo = {
    lockLatestForShop: vi.fn(async (client, _shopId) => {
      lockedClients.push(client)
      return latest
    }),
    insertEntry: vi.fn(async (client, row) => {
      const callNum = repo.insertEntry.mock.calls.length // 1-indexed at this point
      if (failOnInsertCall !== null && callNum === failOnInsertCall) {
        throw Object.assign(new Error('simulated DB insert failure'), {
          code: 'XX000',
        })
      }
      inserts.push(row)
      insertedClients.push(client)
      latest = { balance_after: row.balance_after }
      return { id: `tx-${callNum}`, ...row, created_at: new Date() }
    }),
    findById: vi.fn(),
    findManyByShop: vi.fn(),
    findCurrentBalance: vi.fn(),
  }

  return {
    repo,
    inserts,
    insertedClients,
    lockedClients,
    getLatest: () => latest,
  }
}

// ─── Decimal helpers — mirror the service's cent-based arithmetic ──────
function toCents(value) {
  if (value === null || value === undefined) return 0
  const n = typeof value === 'string' ? Number(value) : value
  return Math.round(n * 100)
}
function fromCents(cents) {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const whole = Math.trunc(abs / 100)
  const frac = abs % 100
  return `${sign}${whole}.${frac.toString().padStart(2, '0')}`
}
function expectedCommissionCents(revenue_amount, commission_rate) {
  return Math.round((toCents(revenue_amount) * commission_rate) / 100)
}

// ─── fast-check arbitraries ────────────────────────────────────────────

const shopIdArb = fc.uuid()
const referenceIdArb = fc.uuid()

// Revenue amount in cents-precise range. The service stores amount as
// DECIMAL(10,2) and converts via `Math.round(n*100)`, so any double in
// [0.01, ~9e15 / 100] is precision-safe. We use [0.01, 1000] — wide enough
// to exercise every ledger code path while keeping cents-arithmetic exact.
const revenueAmountArb = fc.double({
  min: 0.01,
  max: 1000,
  noNaN: true,
  noDefaultInfinity: true,
})

// Commission rate as percentage in [0, 100] (DB CHECK on shops.commission_rate).
const commissionRateArb = fc.double({
  min: 0,
  max: 100,
  noNaN: true,
  noDefaultInfinity: true,
})

// Strictly positive rate — used by tests that need a non-zero commission.
const positiveCommissionRateArb = fc.double({
  min: 0.5,
  max: 100,
  noNaN: true,
  noDefaultInfinity: true,
})

// Previous balance in [0, 1000]. Real ledgers can dip negative mid-cycle
// (DELIVERY_COST before ORDER_REVENUE), but for this property a non-negative
// starting point is sufficient and clearer.
const prevBalanceArb = fc.double({
  min: 0,
  max: 1000,
  noNaN: true,
  noDefaultInfinity: true,
})

const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const REF_ID = '22222222-2222-2222-2222-222222222222'

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════
// Property 12.1 — Atomic pair semantics
// ═══════════════════════════════════════════════════════════════════════
describe('Property 12.1: Atomic pair semantics', () => {
  it('records exactly one ORDER_REVENUE then one COMMISSION_DEBIT on the same client, both with reference_type=ORDER and the same reference_id', async () => {
    await fc.assert(
      fc.asyncProperty(
        shopIdArb,
        referenceIdArb,
        revenueAmountArb,
        positiveCommissionRateArb,
        async (shop_id, reference_id, revenue_amount, commission_rate) => {
          // Skip cases where commission rounds to zero — those are handled
          // by the dedicated zero-commission property below.
          fc.pre(expectedCommissionCents(revenue_amount, commission_rate) > 0)

          const { repo, inserts, insertedClients } = makeStatefulRepo()
          const writer = new LedgerWriteService(repo)
          const client = makeFakeClient()

          const result = await writer.recordPair(client, {
            shop_id,
            revenue_amount,
            commission_rate,
            reference_id,
          })

          // Exactly two ledger entries.
          expect(inserts).toHaveLength(2)
          expect(repo.insertEntry).toHaveBeenCalledTimes(2)

          // Order matters: ORDER_REVENUE first, COMMISSION_DEBIT second.
          expect(inserts[0].type).toBe('ORDER_REVENUE')
          expect(inserts[1].type).toBe('COMMISSION_DEBIT')

          // Both reference the same order under reference_type=ORDER.
          expect(inserts[0].reference_type).toBe('ORDER')
          expect(inserts[1].reference_type).toBe('ORDER')
          expect(inserts[0].reference_id).toBe(reference_id)
          expect(inserts[1].reference_id).toBe(reference_id)

          // Both scoped to the same shop.
          expect(inserts[0].shop_id).toBe(shop_id)
          expect(inserts[1].shop_id).toBe(shop_id)

          // Same caller-owned transactional client used for both inserts —
          // the atomic envelope (Property 12 / Req 7.5).
          expect(insertedClients[0]).toBe(client)
          expect(insertedClients[1]).toBe(client)

          // Result mirrors the inserted rows.
          expect(result.revenue.type).toBe('ORDER_REVENUE')
          expect(result.commission).not.toBeNull()
          expect(result.commission.type).toBe('COMMISSION_DEBIT')
          expect(result.revenue.reference_id).toBe(reference_id)
          expect(result.commission.reference_id).toBe(reference_id)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('the same pg client also threads through both lockLatestForShop calls (FOR UPDATE inside the caller transaction)', async () => {
    await fc.assert(
      fc.asyncProperty(
        shopIdArb,
        referenceIdArb,
        revenueAmountArb,
        positiveCommissionRateArb,
        async (shop_id, reference_id, revenue_amount, commission_rate) => {
          fc.pre(expectedCommissionCents(revenue_amount, commission_rate) > 0)

          const { repo, lockedClients } = makeStatefulRepo()
          const writer = new LedgerWriteService(repo)
          const client = makeFakeClient()

          await writer.recordPair(client, {
            shop_id,
            revenue_amount,
            commission_rate,
            reference_id,
          })

          // Two FOR UPDATE locks on the same shop, on the same client.
          expect(repo.lockLatestForShop).toHaveBeenCalledTimes(2)
          expect(lockedClients[0]).toBe(client)
          expect(lockedClients[1]).toBe(client)
          expect(repo.lockLatestForShop.mock.calls[0][1]).toBe(shop_id)
          expect(repo.lockLatestForShop.mock.calls[1][1]).toBe(shop_id)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Property 12.2 — Commission formula
// ═══════════════════════════════════════════════════════════════════════
describe('Property 12.2: Commission formula', () => {
  it('commission amount = round(revenue_amount * commission_rate / 100, 2) (cents-based half-up)', async () => {
    await fc.assert(
      fc.asyncProperty(
        revenueAmountArb,
        commissionRateArb,
        async (revenue_amount, commission_rate) => {
          const expectedCents = expectedCommissionCents(
            revenue_amount,
            commission_rate
          )
          fc.pre(expectedCents > 0)

          const { repo, inserts } = makeStatefulRepo()
          const writer = new LedgerWriteService(repo)
          const client = makeFakeClient()

          await writer.recordPair(client, {
            shop_id: SHOP_ID,
            revenue_amount,
            commission_rate,
            reference_id: REF_ID,
          })

          // ORDER_REVENUE preserves the exact revenue amount in cents.
          expect(inserts[0].type).toBe('ORDER_REVENUE')
          expect(inserts[0].amount).toBe(fromCents(toCents(revenue_amount)))

          // COMMISSION_DEBIT uses the canonical cents-rounded commission.
          expect(inserts[1].type).toBe('COMMISSION_DEBIT')
          expect(inserts[1].amount).toBe(fromCents(expectedCents))

          // Commission never exceeds the revenue (rate is in [0, 100]).
          expect(expectedCents).toBeLessThanOrEqual(toCents(revenue_amount))
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Property 12.3 — Balance after pair (Req 7.7, 7.8)
// ═══════════════════════════════════════════════════════════════════════
describe('Property 12.3: Balance after pair', () => {
  it('balance_after of COMMISSION_DEBIT = prev_balance + revenue - commission', async () => {
    await fc.assert(
      fc.asyncProperty(
        prevBalanceArb,
        revenueAmountArb,
        commissionRateArb,
        async (prevBalance, revenue_amount, commission_rate) => {
          const commissionCents = expectedCommissionCents(
            revenue_amount,
            commission_rate
          )
          fc.pre(commissionCents > 0)

          const prevCents = toCents(prevBalance)
          const revenueCents = toCents(revenue_amount)
          const expectedAfterRevenueCents = prevCents + revenueCents
          const expectedAfterCommissionCents =
            expectedAfterRevenueCents - commissionCents

          const { repo, inserts } = makeStatefulRepo({
            // null when prev = 0 to also exercise the "no prior entries"
            // branch (Req 7.8 — initial balance is treated as 0.00).
            initialBalanceAfter:
              prevCents === 0 ? null : fromCents(prevCents),
          })
          const writer = new LedgerWriteService(repo)
          const client = makeFakeClient()

          await writer.recordPair(client, {
            shop_id: SHOP_ID,
            revenue_amount,
            commission_rate,
            reference_id: REF_ID,
          })

          // First entry's balance reflects credit (Req 7.7).
          expect(inserts[0].balance_after).toBe(
            fromCents(expectedAfterRevenueCents)
          )
          // Second entry's balance reflects revenue then debit.
          expect(inserts[1].balance_after).toBe(
            fromCents(expectedAfterCommissionCents)
          )
        }
      ),
      { numRuns: 100 }
    )
  })

  it('starting from no prior entries (Req 7.8): balance_after of COMMISSION_DEBIT = revenue - commission', async () => {
    await fc.assert(
      fc.asyncProperty(
        revenueAmountArb,
        commissionRateArb,
        async (revenue_amount, commission_rate) => {
          const commissionCents = expectedCommissionCents(
            revenue_amount,
            commission_rate
          )
          fc.pre(commissionCents > 0)

          const { repo, inserts } = makeStatefulRepo({
            initialBalanceAfter: null,
          })
          const writer = new LedgerWriteService(repo)
          const client = makeFakeClient()

          await writer.recordPair(client, {
            shop_id: SHOP_ID,
            revenue_amount,
            commission_rate,
            reference_id: REF_ID,
          })

          const revenueCents = toCents(revenue_amount)
          expect(inserts[0].balance_after).toBe(fromCents(revenueCents))
          expect(inserts[1].balance_after).toBe(
            fromCents(revenueCents - commissionCents)
          )
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Property 12.4 — Zero-commission edge case
// ═══════════════════════════════════════════════════════════════════════
describe('Property 12.4: Zero-commission edge case', () => {
  it('when commission_rate = 0, only ORDER_REVENUE is recorded (insertEntry called once)', async () => {
    await fc.assert(
      fc.asyncProperty(revenueAmountArb, async (revenue_amount) => {
        const { repo, inserts } = makeStatefulRepo()
        const writer = new LedgerWriteService(repo)
        const client = makeFakeClient()

        const result = await writer.recordPair(client, {
          shop_id: SHOP_ID,
          revenue_amount,
          commission_rate: 0,
          reference_id: REF_ID,
        })

        // Exactly one ledger entry — no COMMISSION_DEBIT.
        expect(inserts).toHaveLength(1)
        expect(repo.insertEntry).toHaveBeenCalledTimes(1)
        expect(inserts[0].type).toBe('ORDER_REVENUE')

        // Commission slot in the result is null.
        expect(result.revenue.type).toBe('ORDER_REVENUE')
        expect(result.commission).toBeNull()

        // Balance reflects the revenue credit only.
        expect(inserts[0].balance_after).toBe(
          fromCents(toCents(revenue_amount))
        )
      }),
      { numRuns: 100 }
    )
  })

  it('when commission rounds to zero cents (rate so small it disappears), only ORDER_REVENUE is recorded', async () => {
    await fc.assert(
      fc.asyncProperty(
        revenueAmountArb,
        // Rate small enough that revenueCents * rate / 100 rounds to 0.
        // For revenue ≤ 1000 (≤ 100,000 cents), any rate < 0.5 / 100,000 = 5e-6
        // guarantees the product < 0.5 and thus rounds to 0.
        fc.double({
          min: 0,
          max: 1e-7,
          noNaN: true,
          noDefaultInfinity: true,
        }),
        async (revenue_amount, commission_rate) => {
          fc.pre(
            expectedCommissionCents(revenue_amount, commission_rate) === 0
          )

          const { repo, inserts } = makeStatefulRepo()
          const writer = new LedgerWriteService(repo)
          const client = makeFakeClient()

          const result = await writer.recordPair(client, {
            shop_id: SHOP_ID,
            revenue_amount,
            commission_rate,
            reference_id: REF_ID,
          })

          expect(inserts).toHaveLength(1)
          expect(inserts[0].type).toBe('ORDER_REVENUE')
          expect(result.commission).toBeNull()
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Property 12.5 — Failure rolls back the pair (Req 7.9)
// ═══════════════════════════════════════════════════════════════════════
describe('Property 12.5: Failure propagates so caller can ROLLBACK', () => {
  it('if the second insertEntry (COMMISSION_DEBIT) throws, the error propagates and only the first entry was committed in-memory; the caller receives no further queries on its client', async () => {
    await fc.assert(
      fc.asyncProperty(
        revenueAmountArb,
        positiveCommissionRateArb,
        async (revenue_amount, commission_rate) => {
          fc.pre(
            expectedCommissionCents(revenue_amount, commission_rate) > 0
          )

          const { repo, inserts } = makeStatefulRepo({
            failOnInsertCall: 2, // fail the COMMISSION_DEBIT insert
          })
          const writer = new LedgerWriteService(repo)
          const client = makeFakeClient()

          let thrown = null
          try {
            await writer.recordPair(client, {
              shop_id: SHOP_ID,
              revenue_amount,
              commission_rate,
              reference_id: REF_ID,
            })
          } catch (e) {
            thrown = e
          }

          // The error from insertEntry propagated to the caller (Req 7.9).
          expect(thrown).not.toBeNull()
          expect(thrown.message).toMatch(/simulated DB insert failure/i)

          // Both insertEntry calls were attempted (the second one threw).
          expect(repo.insertEntry).toHaveBeenCalledTimes(2)
          // Only the first row landed in our in-memory ledger — the second
          // threw before being recorded. The caller is responsible for the
          // outer ROLLBACK to undo the first.
          expect(inserts).toHaveLength(1)
          expect(inserts[0].type).toBe('ORDER_REVENUE')

          // The service issued only the `transaction_posted` audit INSERT
          // for the successful first ledger row on the caller's client
          // (R24.13 / design §9.2). It must NOT issue BEGIN/COMMIT/ROLLBACK
          // — those still belong to the caller (Req 7.9). Every query
          // recorded on the client must therefore be the audit_logs insert.
          for (const sql of client.calls) {
            expect(sql).toMatch(/INSERT\s+INTO\s+audit_logs/i)
            expect(sql).not.toMatch(/^\s*BEGIN\b/i)
            expect(sql).not.toMatch(/^\s*COMMIT\b/i)
            expect(sql).not.toMatch(/^\s*ROLLBACK\b/i)
          }
          // Exactly one audit row — paired with the one successful insert.
          expect(client.query).toHaveBeenCalledTimes(1)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('if the first insertEntry (ORDER_REVENUE) throws, the error propagates and the COMMISSION_DEBIT path is never reached', async () => {
    await fc.assert(
      fc.asyncProperty(
        revenueAmountArb,
        positiveCommissionRateArb,
        async (revenue_amount, commission_rate) => {
          fc.pre(
            expectedCommissionCents(revenue_amount, commission_rate) > 0
          )

          const { repo, inserts } = makeStatefulRepo({
            failOnInsertCall: 1, // fail the ORDER_REVENUE insert
          })
          const writer = new LedgerWriteService(repo)
          const client = makeFakeClient()

          let thrown = null
          try {
            await writer.recordPair(client, {
              shop_id: SHOP_ID,
              revenue_amount,
              commission_rate,
              reference_id: REF_ID,
            })
          } catch (e) {
            thrown = e
          }

          expect(thrown).not.toBeNull()
          // Service stopped after the first throw — no second insert.
          expect(repo.insertEntry).toHaveBeenCalledTimes(1)
          expect(inserts).toHaveLength(0)
          // The first insert threw BEFORE the audit emit ran, so no
          // `transaction_posted` query reached the client. The caller still
          // owns BEGIN/COMMIT/ROLLBACK (Req 7.9), so no other queries
          // should appear on `client` either.
          expect(client.query).not.toHaveBeenCalled()
        }
      ),
      { numRuns: 100 }
    )
  })
})
