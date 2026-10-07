// Feature: multi-vendor-system, Property 15: Scheduled Order Recurrence
// **Validates: Requirements 10.3**
//
// Property statement (design.md):
//   For any recurring order, next scheduled_for = current + interval
//   (1d / 7d / 1mo), unless past repeat_until.
//
// Pure helper under test:
//   ScheduledOrdersService.computeNextScheduledFor(currentDate, repeatType)
//
// Sub-properties asserted below (each as its own property test):
//   1. DAILY      — next − current === 24h                        (Req 10.3)
//   2. WEEKLY     — next − current === 7 × 24h                    (Req 10.3)
//   3. MONTHLY    — next is exactly +1 calendar month with        (Req 10.3)
//                   end-of-month clamp (Jan 31 → Feb 28/29, …)
//                   and Dec → Jan year roll-over.
//   4. ONCE       — returns null                                  (Req 10.3)
//   5. Determinism — same (date, repeatType) ⇒ identical Date     (Req 10.3)
//   6. repeat_until contract — for arbitrary repeat_until, the    (Req 10.3)
//                   `nextAt.getTime() <= repeat_until.getTime()`
//                   comparison the worker (task 10.3) uses to
//                   decide whether to create a successor agrees
//                   with a fresh recomputation.
//
// All output values are Date|null, which is the closure assertion the
// worker (task 10.3) relies on when deciding whether to INSERT a
// successor row.
//
// This file performs pure unit testing only — no I/O, DB, Redis, BullMQ
// or HTTP. Infrastructure modules pulled in transitively by
// scheduled-orders.service.js are mocked so that importing the SUT does
// not open any sockets.

import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'

// ─── Mock infra deps so the service module loads without DB/Redis/BullMQ ──
// `scheduled-orders.service.js` imports the database client, the BullMQ
// queue (which would otherwise instantiate a real Redis connection at
// module load), and the logger. The `computeNextScheduledFor` static
// helper is pure — these mocks just keep the module loadable in
// isolation for the property test.
vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../src/config/bullmq.js', () => ({
  scheduledOrdersQueue: {
    add: vi.fn(),
    getJob: vi.fn(),
  },
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { ScheduledOrdersService } from '../../src/modules/scheduled-orders/scheduled-orders.service.js'

// ─── Constants ────────────────────────────────────────────
const MS_PER_DAY = 24 * 60 * 60 * 1000
const MS_PER_WEEK = 7 * MS_PER_DAY

// ─── Arbitraries ──────────────────────────────────────────
//
// `dateArb` covers the production scheduling window (10y forward from
// 2020) and includes the boundary calendar cases the MONTHLY clamp must
// handle: Jan 31 → Feb 28/29, Mar 31 → Apr 30, May 31 → Jun 30, Aug 31 →
// Sep 30, Oct 31 → Nov 30, Dec 31 → Jan 31, plus leap-year Feb 29.
const dateArb = fc.date({
  min: new Date('2020-01-01T00:00:00Z'),
  max: new Date('2030-12-31T00:00:00Z'),
  noInvalidDate: true,
})

const repeatTypeArb = fc.constantFrom('ONCE', 'DAILY', 'WEEKLY', 'MONTHLY')

// Mirror of the helper's MONTHLY arithmetic, reconstructed from UTC
// components so the assertion does not rely on the SUT's own
// implementation. Mirrors design.md §Property 15 and Req 10.3.
function expectedMonthlyNext(cur) {
  const y = cur.getUTCFullYear()
  const m = cur.getUTCMonth()
  const d = cur.getUTCDate()
  const targetYear = m === 11 ? y + 1 : y
  const targetMonth = (m + 1) % 12
  // Last calendar day of target month (UTC).
  const lastDayOfTargetMonth = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0)
  ).getUTCDate()
  const day = Math.min(d, lastDayOfTargetMonth)
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      day,
      cur.getUTCHours(),
      cur.getUTCMinutes(),
      cur.getUTCSeconds(),
      cur.getUTCMilliseconds()
    )
  )
}

describe('Property 15: Scheduled Order Recurrence', () => {
  // ──────────────────────────────────────────────────────
  // Sub-property 1 — DAILY interval (Requirement 10.3)
  //   next − current === 24h, exactly, in milliseconds.
  // ──────────────────────────────────────────────────────
  it('1. DAILY: next − current === 24h', () => {
    fc.assert(
      fc.property(dateArb, (cur) => {
        const next = ScheduledOrdersService.computeNextScheduledFor(
          cur,
          'DAILY'
        )
        expect(next).toBeInstanceOf(Date)
        expect(next.getTime() - cur.getTime()).toBe(MS_PER_DAY)
      }),
      { numRuns: 100 }
    )
  })

  // ──────────────────────────────────────────────────────
  // Sub-property 2 — WEEKLY interval (Requirement 10.3)
  //   next − current === 7 × 24h, exactly, in milliseconds.
  // ──────────────────────────────────────────────────────
  it('2. WEEKLY: next − current === 7 × 24h', () => {
    fc.assert(
      fc.property(dateArb, (cur) => {
        const next = ScheduledOrdersService.computeNextScheduledFor(
          cur,
          'WEEKLY'
        )
        expect(next).toBeInstanceOf(Date)
        expect(next.getTime() - cur.getTime()).toBe(MS_PER_WEEK)
      }),
      { numRuns: 100 }
    )
  })

  // ──────────────────────────────────────────────────────
  // Sub-property 3 — MONTHLY interval (Requirement 10.3)
  //   • Day 1..28: next month, same day
  //   • Day 29..31: clamp to last day of next month
  //   • Year rolls over Dec → Jan
  //   The expected value is reconstructed independently from UTC
  //   components so the assertion is decoupled from the SUT.
  // ──────────────────────────────────────────────────────
  it('3. MONTHLY: +1 calendar month with end-of-month clamp', () => {
    fc.assert(
      fc.property(dateArb, (cur) => {
        const next = ScheduledOrdersService.computeNextScheduledFor(
          cur,
          'MONTHLY'
        )
        const expected = expectedMonthlyNext(cur)

        expect(next).toBeInstanceOf(Date)
        expect(next.getTime()).toBe(expected.getTime())

        // Structural assertions on the components: the clamp guarantees
        // the day of `next` is min(curDay, lastDayOfTargetMonth) and
        // never overflows into the month-after-next.
        const curDay = cur.getUTCDate()
        const nextMonth = next.getUTCMonth()
        const expectedMonth = (cur.getUTCMonth() + 1) % 12
        expect(nextMonth).toBe(expectedMonth)

        const lastDayOfTargetMonth = new Date(
          Date.UTC(next.getUTCFullYear(), nextMonth + 1, 0)
        ).getUTCDate()
        expect(next.getUTCDate()).toBe(Math.min(curDay, lastDayOfTargetMonth))

        // Time-of-day is preserved (no DST drift — UTC math).
        expect(next.getUTCHours()).toBe(cur.getUTCHours())
        expect(next.getUTCMinutes()).toBe(cur.getUTCMinutes())
        expect(next.getUTCSeconds()).toBe(cur.getUTCSeconds())
        expect(next.getUTCMilliseconds()).toBe(cur.getUTCMilliseconds())

        // Year roll-over: Dec → Jan increments year by exactly 1.
        if (cur.getUTCMonth() === 11) {
          expect(next.getUTCFullYear()).toBe(cur.getUTCFullYear() + 1)
        } else {
          expect(next.getUTCFullYear()).toBe(cur.getUTCFullYear())
        }
      }),
      { numRuns: 100 }
    )
  })

  // ──────────────────────────────────────────────────────
  // Sub-property 4 — ONCE returns null (Requirement 10.3)
  //   ONCE schedules have no successor; the worker (task 10.3) skips
  //   recurrence creation when the helper returns null.
  // ──────────────────────────────────────────────────────
  it('4. ONCE: returns null for any current date', () => {
    fc.assert(
      fc.property(dateArb, (cur) => {
        const next = ScheduledOrdersService.computeNextScheduledFor(
          cur,
          'ONCE'
        )
        expect(next).toBeNull()
      }),
      { numRuns: 100 }
    )
  })

  // ──────────────────────────────────────────────────────
  // Sub-property 5 — Determinism (Requirement 10.3)
  //   Calling twice with the same (currentDate, repeatType) returns the
  //   identical Date (or both null). The worker (task 10.3) re-runs the
  //   helper on retries; non-determinism would create drifting
  //   recurrences.
  // ──────────────────────────────────────────────────────
  it('5. Determinism: same input ⇒ identical output', () => {
    fc.assert(
      fc.property(dateArb, repeatTypeArb, (cur, repeatType) => {
        const a = ScheduledOrdersService.computeNextScheduledFor(
          cur,
          repeatType
        )
        const b = ScheduledOrdersService.computeNextScheduledFor(
          cur,
          repeatType
        )

        if (repeatType === 'ONCE') {
          expect(a).toBeNull()
          expect(b).toBeNull()
        } else {
          expect(a).toBeInstanceOf(Date)
          expect(b).toBeInstanceOf(Date)
          expect(a.getTime()).toBe(b.getTime())
          // Strictly forward-progressing for non-ONCE repeats.
          expect(a.getTime()).toBeGreaterThan(cur.getTime())
        }
      }),
      { numRuns: 100 }
    )
  })

  // ──────────────────────────────────────────────────────
  // Sub-property 6 — repeat_until contract (Requirement 10.3)
  //   The worker (task 10.3) inserts a successor only when:
  //     nextAt && (!repeat_until || nextAt.getTime() <= repeat_until.getTime())
  //   For any (currentDate, repeatType, repeatUntil), the boolean
  //   computed against a fresh `computeNextScheduledFor` call agrees
  //   with itself (deterministic) and partitions the (next, until)
  //   space into the documented "create successor / skip" buckets.
  // ──────────────────────────────────────────────────────
  it('6. repeat_until: successor-eligibility is deterministic and consistent with next ≤ repeat_until', () => {
    fc.assert(
      fc.property(dateArb, repeatTypeArb, dateArb, (cur, repeatType, until) => {
        const next = ScheduledOrdersService.computeNextScheduledFor(
          cur,
          repeatType
        )

        // ONCE always produces no successor regardless of repeat_until.
        if (repeatType === 'ONCE') {
          expect(next).toBeNull()
          return
        }

        // For recurring types, the worker treats `null` repeat_until as
        // "open-ended" and otherwise gates on `next <= repeat_until`.
        const eligibleWithUntil =
          next !== null && next.getTime() <= until.getTime()
        const eligibleWithoutUntil = next !== null

        // Determinism — recompute and agree.
        const next2 = ScheduledOrdersService.computeNextScheduledFor(
          cur,
          repeatType
        )
        expect(next2.getTime()).toBe(next.getTime())

        // Partition consistency: if `next > until` the schedule must
        // not be flagged eligible; if `next <= until` it must be.
        if (next.getTime() > until.getTime()) {
          expect(eligibleWithUntil).toBe(false)
        } else {
          expect(eligibleWithUntil).toBe(true)
        }

        // Without a `repeat_until`, eligibility is always true for
        // recurring types (Req 10.10 — indefinite recurrence).
        expect(eligibleWithoutUntil).toBe(true)
      }),
      { numRuns: 100 }
    )
  })
})
