// Feature: multi-vendor-system, Property 9: Settlement Aggregation
// **Validates: Requirements 6.2, 6.9**
//
// Property 9 (design.md):
//   For any weekly record, values must equal sum of 7 corresponding daily
//   records. The same property holds for monthly records over all daily
//   records within the calendar month (Req 6.9).
//
// Aggregation runs server-side in
//   `ShopFinancialsWriteRepository.sumDailyRows`
// (a single SQL `COALESCE(SUM(field),0)` query). At the SettlementService
// layer the contract is:
//
//   1. Sum of fields — for any N daily rows for a shop, the weekly /
//      monthly aggregate row that the service writes via `upsert` has
//      every financial dimension equal to the row-by-row sum across the
//      period (gross_revenue, net_revenue, total_orders,
//      platform_commission, delivery_costs, refund_amount, payout_amount).
//   2. avg_order_value re-derivation — the service does NOT pass through
//      the daily avg, it re-computes
//         avg_order_value = round2(gross_revenue / total_orders)
//      when total_orders > 0, and 0 when total_orders === 0.
//   3. Monthly aggregation — the same sum-of-rows identity holds across
//      all daily rows within a calendar month (28 / 29 / 30 / 31 days).
//
// Approach (per task brief — easiest path):
//   Stub the write repository entirely. `sumDailyRows` returns the
//   row-by-row sum that we pre-compute in the test from arbitrary daily
//   rows (mirroring exactly what the SQL SUM would return). `upsert`
//   captures what the service writes. `listActiveShopsPage` returns one
//   shop and then an empty page. No DB / Redis / HTTP / BullMQ.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'

// ─── External deps mocked per project convention ──────────────────────
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

import { SettlementService } from '../../src/modules/shop-financials/settlement.service.js'

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Money-precise round to 2dp, matching `financial-formula.js#round2` so the
 * expected values reconstructed in the test agree with what the service
 * computes when re-deriving `avg_order_value`.
 */
function round2(x) {
  if (!Number.isFinite(x)) return 0
  return x >= 0 ? Math.round(x * 100) / 100 : -Math.round(-x * 100) / 100
}

/**
 * Mirror of the production `sumDailyRows` SQL: `COALESCE(SUM(field), 0)`
 * for each financial dimension over the daily rows. Returns the same shape
 * the write repository would return so the SettlementService consumes it
 * unchanged. We sum in integer cents and divide back to avoid IEEE-754
 * drift accumulating across up to 31 rows.
 */
function computeExpectedSums(rows) {
  const sumCents = (key) =>
    rows.reduce((acc, r) => acc + Math.round(r[key] * 100), 0)
  return {
    dailyCount: rows.length,
    grossRevenue: sumCents('gross_revenue') / 100,
    totalOrders: rows.reduce((acc, r) => acc + r.total_orders, 0),
    platformCommission: sumCents('platform_commission') / 100,
    deliveryCosts: sumCents('delivery_costs') / 100,
    refundAmount: sumCents('refund_amount') / 100,
    netRevenue: sumCents('net_revenue') / 100,
    payoutAmount: sumCents('payout_amount') / 100,
  }
}

// ─── Arbitraries ──────────────────────────────────────────────────────
//
// All money values are produced via integer cents and divided by 100 so
// each value is exactly representable in IEEE-754 and matches the
// DECIMAL(*,2) shape stored in shop_financials. Ranges are bounded so
// 31-row sums comfortably fit DECIMAL(12,2) without overflow.

// gross / commission / delivery / refund all share the same daily money
// range: ≤ ~$99_999.99 so a 31-row sum stays under $3.1M.
const dailyMoneyMaxCents = 99_999_99

// payout_amount: strictly positive (≥ 1¢) so the sum is > 0 and the
// service's defensive `payoutAmount: sums.payoutAmount || sums.netRevenue`
// fallback (which only kicks in for the all-zero degenerate case) does
// not muddy the property's expected value.
const dailyPayoutArb = fc
  .integer({ min: 1, max: dailyMoneyMaxCents })
  .map((cents) => cents / 100)

const dailyMoneyArb = fc
  .integer({ min: 0, max: dailyMoneyMaxCents })
  .map((cents) => cents / 100)

// net_revenue may be legitimately negative when refunds + delivery exceed
// gross − commission (Req 6.4). Allow the full signed range.
const dailyNetArb = fc
  .integer({ min: -dailyMoneyMaxCents, max: dailyMoneyMaxCents })
  .map((cents) => cents / 100)

// total_orders ∈ [0, 1000] per day — exercises both the divide-by-zero
// guard for avg_order_value (when all rows are 0) and the ordinary path.
const dailyOrdersArb = fc.integer({ min: 0, max: 1_000 })

const dailyRowArb = fc.record({
  gross_revenue: dailyMoneyArb,
  total_orders: dailyOrdersArb,
  platform_commission: dailyMoneyArb,
  delivery_costs: dailyMoneyArb,
  refund_amount: dailyMoneyArb,
  net_revenue: dailyNetArb,
  payout_amount: dailyPayoutArb,
})

const weeklyRowsArb = fc.array(dailyRowArb, { minLength: 7, maxLength: 7 })
// Monthly: any calendar-month length (Feb=28/29, Apr/Jun/Sep/Nov=30,
// remaining=31). The test maps each generated length to a month with that
// many UTC days so `requireDailyCount` (= days in month) is satisfied.
const monthlyRowsArb = fc.array(dailyRowArb, { minLength: 28, maxLength: 31 })

// ─── Test doubles ─────────────────────────────────────────────────────

/**
 * Build a fake write-repository whose `sumDailyRows` returns the
 * pre-computed sums and whose `upsert` captures the row that the service
 * writes. `listActiveShopsPage` yields a single shop on the first page
 * and an empty page thereafter so `_runAggregateSettlement` terminates
 * after one iteration.
 */
function makeWriteRepoStub({ shopId, sums }) {
  const upsertCalls = []
  return {
    upsertCalls,
    listActiveShopsPage: vi.fn(async ({ afterId } = {}) => {
      if (afterId) return []
      return [{ id: shopId, commission_rate: 10 }]
    }),
    sumDailyRows: vi.fn(async () => sums),
    upsert: vi.fn(async (fields) => {
      upsertCalls.push(fields)
      return { id: 'sf-1', ...fields }
    }),
    findCommissionRate: vi.fn(async () => 10),
    recordFailureReason: vi.fn(async () => false),
  }
}

function makeFinancialsServiceStub() {
  return { invalidateForShop: vi.fn(async () => {}) }
}

beforeEach(() => {
  vi.clearAllMocks()
})

const SHOP_ID = '11111111-1111-4111-8111-111111111111'

describe('Property 9: Settlement Aggregation', () => {
  // ──────────────────────────────────────────────────────────────────
  // Sub-property 1 — Weekly aggregate equals sum of 7 daily rows
  // (Req 6.9). Each financial dimension on the upserted weekly row
  // matches the cents-precise sum across the seven generated daily
  // rows.
  // ──────────────────────────────────────────────────────────────────
  it('1. weekly aggregate equals row-by-row sum across all financial dimensions', async () => {
    await fc.assert(
      fc.asyncProperty(weeklyRowsArb, async (rows) => {
        const sums = computeExpectedSums(rows)
        const writeRepo = makeWriteRepoStub({ shopId: SHOP_ID, sums })
        const financialsService = makeFinancialsServiceStub()
        const service = new SettlementService({
          writeRepository: writeRepo,
          financialsService,
        })

        // 2024-01-01 was a Monday (UTC) — valid weekStart per Req 6.9.
        const summary = await service.runWeeklySettlement({
          weekStart: '2024-01-01',
        })

        expect(summary.settled).toBe(1)
        expect(summary.skipped).toBe(0)
        expect(summary.failed).toBe(0)
        expect(writeRepo.upsertCalls).toHaveLength(1)

        const written = writeRepo.upsertCalls[0]
        expect(written.shopId).toBe(SHOP_ID)
        expect(written.periodType).toBe('WEEKLY')
        expect(written.periodStart).toBe('2024-01-01')
        expect(written.periodEnd).toBe('2024-01-07') // Sunday

        // Each summed field equals the row-by-row sum, asserted in
        // integer cents so floating-point ordering inside the service
        // doesn't leak into the assertion.
        expect(Math.round(written.grossRevenue * 100)).toBe(
          Math.round(sums.grossRevenue * 100)
        )
        expect(written.totalOrders).toBe(sums.totalOrders)
        expect(Math.round(written.platformCommission * 100)).toBe(
          Math.round(sums.platformCommission * 100)
        )
        expect(Math.round(written.deliveryCosts * 100)).toBe(
          Math.round(sums.deliveryCosts * 100)
        )
        expect(Math.round(written.refundAmount * 100)).toBe(
          Math.round(sums.refundAmount * 100)
        )
        expect(Math.round(written.netRevenue * 100)).toBe(
          Math.round(sums.netRevenue * 100)
        )
        expect(Math.round(written.payoutAmount * 100)).toBe(
          Math.round(sums.payoutAmount * 100)
        )
      }),
      { numRuns: 100 }
    )
  })

  // ──────────────────────────────────────────────────────────────────
  // Sub-property 2 — avg_order_value re-derivation (Req 6.2).
  //   total_orders > 0 ⇒ avg = round2(gross / total_orders)
  //   total_orders = 0 ⇒ avg = 0
  // The service must NOT carry the avg through; it must recompute from
  // the summed gross / total_orders so the weekly avg reflects the
  // entire week, not the last daily row.
  // ──────────────────────────────────────────────────────────────────
  it('2. avg_order_value = totalOrders > 0 ? round2(gross/totalOrders) : 0', async () => {
    await fc.assert(
      fc.asyncProperty(weeklyRowsArb, async (rows) => {
        const sums = computeExpectedSums(rows)
        const writeRepo = makeWriteRepoStub({ shopId: SHOP_ID, sums })
        const financialsService = makeFinancialsServiceStub()
        const service = new SettlementService({
          writeRepository: writeRepo,
          financialsService,
        })

        await service.runWeeklySettlement({ weekStart: '2024-01-01' })

        expect(writeRepo.upsertCalls).toHaveLength(1)
        const written = writeRepo.upsertCalls[0]

        if (sums.totalOrders === 0) {
          expect(written.avgOrderValue).toBe(0)
        } else {
          expect(written.avgOrderValue).toBe(
            round2(sums.grossRevenue / sums.totalOrders)
          )
          expect(written.avgOrderValue).toBeGreaterThanOrEqual(0)
          // Result is cent-precise (DECIMAL(10,2)).
          expect(written.avgOrderValue).toBe(round2(written.avgOrderValue))
        }
      }),
      { numRuns: 100 }
    )
  })

  // ──────────────────────────────────────────────────────────────────
  // Sub-property 3 — Monthly aggregation (Req 6.9). The same
  // sum-of-rows identity holds across all daily rows within a
  // calendar month (28/29/30/31 days). The chosen monthStart matches
  // the array length so `requireDailyCount` (= days in month) is
  // satisfied and the service does not skip the period.
  // ──────────────────────────────────────────────────────────────────
  it('3. monthly aggregate equals row-by-row sum for all daily rows in the month', async () => {
    await fc.assert(
      fc.asyncProperty(monthlyRowsArb, async (rows) => {
        // Map array length → a UTC month with exactly that many days.
        // Feb 2023 = 28, Feb 2024 = 29, Apr 2024 = 30, Jan 2024 = 31.
        const monthByLen = {
          28: '2023-02-01',
          29: '2024-02-01',
          30: '2024-04-01',
          31: '2024-01-01',
        }
        const monthStart = monthByLen[rows.length]
        const sums = computeExpectedSums(rows)
        const writeRepo = makeWriteRepoStub({ shopId: SHOP_ID, sums })
        const financialsService = makeFinancialsServiceStub()
        const service = new SettlementService({
          writeRepository: writeRepo,
          financialsService,
        })

        const summary = await service.runMonthlySettlement({ monthStart })

        expect(summary.settled).toBe(1)
        expect(summary.skipped).toBe(0)
        expect(summary.failed).toBe(0)
        expect(writeRepo.upsertCalls).toHaveLength(1)

        const written = writeRepo.upsertCalls[0]
        expect(written.shopId).toBe(SHOP_ID)
        expect(written.periodType).toBe('MONTHLY')
        expect(written.periodStart).toBe(monthStart)

        // Same field-by-field sum identity as sub-property 1.
        expect(Math.round(written.grossRevenue * 100)).toBe(
          Math.round(sums.grossRevenue * 100)
        )
        expect(written.totalOrders).toBe(sums.totalOrders)
        expect(Math.round(written.platformCommission * 100)).toBe(
          Math.round(sums.platformCommission * 100)
        )
        expect(Math.round(written.deliveryCosts * 100)).toBe(
          Math.round(sums.deliveryCosts * 100)
        )
        expect(Math.round(written.refundAmount * 100)).toBe(
          Math.round(sums.refundAmount * 100)
        )
        expect(Math.round(written.netRevenue * 100)).toBe(
          Math.round(sums.netRevenue * 100)
        )
        expect(Math.round(written.payoutAmount * 100)).toBe(
          Math.round(sums.payoutAmount * 100)
        )

        // avg_order_value re-derivation also holds for monthly periods.
        if (sums.totalOrders === 0) {
          expect(written.avgOrderValue).toBe(0)
        } else {
          expect(written.avgOrderValue).toBe(
            round2(sums.grossRevenue / sums.totalOrders)
          )
        }
      }),
      { numRuns: 100 }
    )
  })
})
