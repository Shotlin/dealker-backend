// Feature: multi-vendor-system, task 9.1
// **Validates: Requirements 6.2, 6.3, 6.4, 6.7, 6.8, 6.9, 14.6, 14.11**
//
// Settlement_Worker unit tests. The worker is a thin BullMQ dispatcher
// that routes job types (`daily`, `weekly`, `monthly`, `shop`,
// `late-refund`) to the corresponding service entry points and fans out
// follow-up jobs after a daily run finishes (Sunday → weekly,
// last-day-of-month → monthly).
//
// Coverage targets (from the task brief):
//   • Zero-order day still upserts a row (no orders shouldn't crash).
//   • Single-shop happy path settles, formula matches Property 8.
//   • Retry on transient error — job throws and BullMQ would retry; the
//     dispatcher must NOT swallow the error.
//   • Idempotent re-run — calling the daily handler twice for the same
//     date produces the same writes (UPSERT semantics).
//   • Weekly aggregation when target is Sunday — Sunday daily run fans
//     out a weekly job for the Mon-Sun window.
//   • Monthly aggregation when target is end-of-month — last-day-of-month
//     daily run fans out a monthly job for the calendar month.
//   • Structured failure logging — unknown job types log a
//     `settlement_unknown_job_type` warning and return ignored.

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Inert collaborator mocks (must come before SUT import) ──
vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../../src/config/bullmq.js', () => ({
  settlementQueue: { add: vi.fn() },
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import {
  createSettlementProcessor,
  scheduleSettlementCron,
} from '../../../src/workers/settlement.worker.js'
import { logger } from '../../../src/config/logger.js'

// ─── Helpers ─────────────────────────────────────────────
const SHOP_A = '11111111-1111-1111-1111-111111111111'

/**
 * Build a service test double exposing only the methods the worker needs.
 * Each method resolves a sensible default that the dispatcher tests can
 * override per-case.
 */
function makeServiceMock(overrides = {}) {
  return {
    runDailySettlement: vi
      .fn()
      .mockResolvedValue({
        settled: 0,
        skipped: 0,
        failed: 0,
        periodStart: '2024-03-14',
      }),
    runWeeklySettlement: vi
      .fn()
      .mockResolvedValue({
        settled: 0,
        skipped: 0,
        failed: 0,
        periodType: 'WEEKLY',
      }),
    runMonthlySettlement: vi
      .fn()
      .mockResolvedValue({
        settled: 0,
        skipped: 0,
        failed: 0,
        periodType: 'MONTHLY',
      }),
    settleShopForPeriod: vi
      .fn()
      .mockResolvedValue({ shopId: SHOP_A, periodType: 'DAILY' }),
    recordLateRefund: vi.fn().mockResolvedValue({ applied: true }),
    ...overrides,
  }
}

function makeQueueMock() {
  return { add: vi.fn().mockResolvedValue(undefined) }
}

function makeJob({ id = 'job-1', name, data }) {
  return { id, name, data }
}

// ═══════════════════════════════════════════════════════════
// Daily — zero-order day, happy path, retry, idempotent re-run
// ═══════════════════════════════════════════════════════════

describe('createSettlementProcessor — daily', () => {
  let service
  let queue
  let process

  beforeEach(() => {
    vi.clearAllMocks()
    service = makeServiceMock()
    queue = makeQueueMock()
    process = createSettlementProcessor({ service, queue })
  })

  it('zero-order day: forwards service summary even when 0 rows settled', async () => {
    service.runDailySettlement.mockResolvedValue({
      settled: 0,
      skipped: 0,
      failed: 0,
      periodStart: '2024-03-14',
    })

    const result = await process(
      makeJob({
        name: 'daily',
        data: { type: 'daily', date: '2024-03-15T03:00:00.000Z' },
      })
    )

    expect(service.runDailySettlement).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      type: 'daily',
      settled: 0,
      skipped: 0,
      failed: 0,
      periodStart: '2024-03-14',
    })
  })

  it('single-shop happy path: forwards counts when service settles a shop', async () => {
    service.runDailySettlement.mockResolvedValue({
      settled: 1,
      skipped: 0,
      failed: 0,
      periodStart: '2024-03-14',
    })

    const result = await process(
      makeJob({
        name: 'daily',
        data: { type: 'daily', date: '2024-03-15T03:00:00.000Z' },
      })
    )

    expect(result.settled).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.periodStart).toBe('2024-03-14')
  })

  // Req 6.7 — BullMQ retries on throw. The dispatcher MUST propagate the
  // error so BullMQ's attempts/backoff config kicks in; swallowing it
  // would silently drop a settlement run.
  it('retries on transient error by propagating the rejection (Req 6.7)', async () => {
    service.runDailySettlement.mockRejectedValueOnce(new Error('db timeout'))

    await expect(
      process(makeJob({ name: 'daily', data: { type: 'daily' } }))
    ).rejects.toThrow('db timeout')
  })

  // Idempotency lives in the service+UPSERT; at the dispatcher layer the
  // contract is: "calling me twice with the same payload calls the
  // service twice with the same arguments". Real idempotency is verified
  // in shop-financials/settlement.service.test.js and the integration
  // tests for ON CONFLICT.
  it('idempotent re-run: calling daily twice with same date forwards same args', async () => {
    const data = { type: 'daily', date: '2024-03-15T03:00:00.000Z' }
    await process(makeJob({ name: 'daily', data }))
    await process(makeJob({ id: 'job-2', name: 'daily', data }))

    expect(service.runDailySettlement).toHaveBeenCalledTimes(2)
    const [firstArgs] = service.runDailySettlement.mock.calls[0]
    const [secondArgs] = service.runDailySettlement.mock.calls[1]
    expect(firstArgs.date.toISOString()).toBe(secondArgs.date.toISOString())
  })

  it('defaults date to now when payload omits it', async () => {
    await process(makeJob({ name: 'daily', data: { type: 'daily' } }))
    const [args] = service.runDailySettlement.mock.calls[0]
    expect(args.date).toBeInstanceOf(Date)
  })
})

// ═══════════════════════════════════════════════════════════
// Daily fan-out — Sunday → weekly, EOM → monthly (Req 6.9)
// ═══════════════════════════════════════════════════════════

describe('createSettlementProcessor — daily fan-out (Req 6.9)', () => {
  let service
  let queue

  beforeEach(() => {
    vi.clearAllMocks()
    service = makeServiceMock()
    queue = makeQueueMock()
  })

  it('Sunday daily run enqueues a weekly job for the Mon..Sun window', async () => {
    // Settled period 2024-03-17 is a Sunday.
    service.runDailySettlement.mockResolvedValue({
      settled: 5,
      skipped: 0,
      failed: 0,
      periodStart: '2024-03-17',
    })
    const process = createSettlementProcessor({ service, queue })

    await process(
      makeJob({
        name: 'daily',
        data: { type: 'daily', date: '2024-03-18T03:00:00.000Z' },
      })
    )

    // queue.add called with (name, data, opts)
    const weeklyCall = queue.add.mock.calls.find((c) => c[0] === 'weekly')
    expect(weeklyCall).toBeDefined()
    expect(weeklyCall[1]).toMatchObject({
      type: 'weekly',
      weekStart: '2024-03-11',
    })
    expect(weeklyCall[2]).toMatchObject({
      jobId: 'settlement-weekly:2024-03-11',
    })
  })

  it('non-Sunday daily run does NOT enqueue a weekly job', async () => {
    // 2024-03-14 is a Thursday.
    service.runDailySettlement.mockResolvedValue({
      settled: 1,
      skipped: 0,
      failed: 0,
      periodStart: '2024-03-14',
    })
    const process = createSettlementProcessor({ service, queue })

    await process(
      makeJob({
        name: 'daily',
        data: { type: 'daily', date: '2024-03-15T03:00:00.000Z' },
      })
    )

    const weeklyCall = queue.add.mock.calls.find((c) => c[0] === 'weekly')
    expect(weeklyCall).toBeUndefined()
  })

  it('end-of-month daily run enqueues a monthly job for the calendar month', async () => {
    // 2024-03-31 is the last day of March.
    service.runDailySettlement.mockResolvedValue({
      settled: 8,
      skipped: 0,
      failed: 0,
      periodStart: '2024-03-31',
    })
    const process = createSettlementProcessor({ service, queue })

    await process(
      makeJob({
        name: 'daily',
        data: { type: 'daily', date: '2024-04-01T03:00:00.000Z' },
      })
    )

    const monthlyCall = queue.add.mock.calls.find((c) => c[0] === 'monthly')
    expect(monthlyCall).toBeDefined()
    expect(monthlyCall[1]).toMatchObject({
      type: 'monthly',
      monthStart: '2024-03-01',
    })
    expect(monthlyCall[2]).toMatchObject({
      jobId: 'settlement-monthly:2024-03-01',
    })
  })

  it('mid-month daily run does NOT enqueue a monthly job', async () => {
    service.runDailySettlement.mockResolvedValue({
      settled: 3,
      skipped: 0,
      failed: 0,
      periodStart: '2024-03-15',
    })
    const process = createSettlementProcessor({ service, queue })

    await process(
      makeJob({
        name: 'daily',
        data: { type: 'daily', date: '2024-03-16T03:00:00.000Z' },
      })
    )

    const monthlyCall = queue.add.mock.calls.find((c) => c[0] === 'monthly')
    expect(monthlyCall).toBeUndefined()
  })

  it('queue.add failure on weekly fan-out is logged but does not abort the job', async () => {
    service.runDailySettlement.mockResolvedValue({
      settled: 1,
      skipped: 0,
      failed: 0,
      periodStart: '2024-03-17',
    })
    queue.add = vi.fn().mockRejectedValue(new Error('queue down'))
    const process = createSettlementProcessor({ service, queue })

    const result = await process(
      makeJob({
        name: 'daily',
        data: { type: 'daily', date: '2024-03-18T03:00:00.000Z' },
      })
    )

    expect(result.type).toBe('daily')
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settlement_weekly_enqueue_failed',
      }),
      expect.any(String)
    )
  })

  it('runs without a queue when none is provided (no fan-out, no crash)', async () => {
    service.runDailySettlement.mockResolvedValue({
      settled: 1,
      skipped: 0,
      failed: 0,
      periodStart: '2024-03-17',
    })
    const process = createSettlementProcessor({ service })
    const result = await process(
      makeJob({ name: 'daily', data: { type: 'daily' } })
    )
    expect(result.type).toBe('daily')
  })
})

// ═══════════════════════════════════════════════════════════
// Weekly / Monthly handlers
// ═══════════════════════════════════════════════════════════

describe('createSettlementProcessor — weekly / monthly', () => {
  let service
  let process

  beforeEach(() => {
    vi.clearAllMocks()
    service = makeServiceMock()
    process = createSettlementProcessor({ service })
  })

  it('weekly handler forwards weekStart to the service', async () => {
    service.runWeeklySettlement.mockResolvedValue({
      settled: 1,
      skipped: 0,
      failed: 0,
      periodType: 'WEEKLY',
    })
    const result = await process(
      makeJob({
        name: 'weekly',
        data: { type: 'weekly', weekStart: '2024-03-11' },
      })
    )
    expect(service.runWeeklySettlement).toHaveBeenCalledWith({
      weekStart: '2024-03-11',
    })
    expect(result.type).toBe('weekly')
  })

  it('weekly handler skips when weekStart is missing and logs a warn', async () => {
    const result = await process(
      makeJob({ name: 'weekly', data: { type: 'weekly' } })
    )
    expect(service.runWeeklySettlement).not.toHaveBeenCalled()
    expect(result).toEqual({ type: 'weekly', skipped: true })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settlement_weekly_missing_week_start',
      }),
      expect.any(String)
    )
  })

  it('monthly handler forwards monthStart to the service', async () => {
    service.runMonthlySettlement.mockResolvedValue({
      settled: 1,
      skipped: 0,
      failed: 0,
      periodType: 'MONTHLY',
    })
    const result = await process(
      makeJob({
        name: 'monthly',
        data: { type: 'monthly', monthStart: '2024-03-01' },
      })
    )
    expect(service.runMonthlySettlement).toHaveBeenCalledWith({
      monthStart: '2024-03-01',
    })
    expect(result.type).toBe('monthly')
  })

  it('monthly handler skips when monthStart is missing', async () => {
    const result = await process(
      makeJob({ name: 'monthly', data: { type: 'monthly' } })
    )
    expect(service.runMonthlySettlement).not.toHaveBeenCalled()
    expect(result).toEqual({ type: 'monthly', skipped: true })
  })
})

// ═══════════════════════════════════════════════════════════
// Single-shop and late-refund handlers
// ═══════════════════════════════════════════════════════════

describe('createSettlementProcessor — single shop and late refund', () => {
  let service
  let process

  beforeEach(() => {
    vi.clearAllMocks()
    service = makeServiceMock()
    process = createSettlementProcessor({ service })
  })

  it('shop handler forwards full payload to settleShopForPeriod', async () => {
    service.settleShopForPeriod.mockResolvedValue({
      shopId: SHOP_A,
      periodType: 'DAILY',
      row: { id: 'row-1', grossRevenue: 100 },
    })
    const result = await process(
      makeJob({
        name: 'shop',
        data: {
          type: 'shop',
          shopId: SHOP_A,
          periodType: 'DAILY',
          periodStart: '2024-03-14',
          periodEnd: '2024-03-14',
        },
      })
    )
    expect(service.settleShopForPeriod).toHaveBeenCalledWith(
      SHOP_A,
      'DAILY',
      '2024-03-14',
      '2024-03-14'
    )
    expect(result.type).toBe('shop')
  })

  it('shop handler skips when required fields are missing', async () => {
    const result = await process(
      makeJob({ name: 'shop', data: { type: 'shop', shopId: SHOP_A } })
    )
    expect(service.settleShopForPeriod).not.toHaveBeenCalled()
    expect(result).toEqual({ type: 'shop', skipped: true })
  })

  // Req 6.8 — late refund flow
  it('late-refund handler forwards orderId/refundAmount to recordLateRefund', async () => {
    service.recordLateRefund.mockResolvedValue({
      applied: true,
      row: { id: 'r-1' },
    })
    const result = await process(
      makeJob({
        name: 'late-refund',
        data: {
          type: 'late-refund',
          orderId: 'order-1',
          refundAmount: 250,
          completionDate: '2024-03-14',
        },
      })
    )
    expect(service.recordLateRefund).toHaveBeenCalledWith({
      orderId: 'order-1',
      shopId: undefined,
      refundAmount: 250,
      completionDate: '2024-03-14',
    })
    expect(result).toMatchObject({ type: 'late-refund', applied: true })
  })

  it('late-refund handler returns INVALID_INPUT when neither orderId nor shopId present', async () => {
    const result = await process(
      makeJob({
        name: 'late-refund',
        data: { type: 'late-refund', refundAmount: 100 },
      })
    )
    expect(service.recordLateRefund).not.toHaveBeenCalled()
    expect(result).toEqual({
      type: 'late-refund',
      applied: false,
      reason: 'INVALID_INPUT',
    })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settlement_late_refund_invalid',
      }),
      expect.any(String)
    )
  })

  it('late-refund handler returns INVALID_INPUT when refundAmount is missing', async () => {
    const result = await process(
      makeJob({
        name: 'late-refund',
        data: { type: 'late-refund', orderId: 'order-1' },
      })
    )
    expect(service.recordLateRefund).not.toHaveBeenCalled()
    expect(result.reason).toBe('INVALID_INPUT')
  })
})

// ═══════════════════════════════════════════════════════════
// Unknown job — structured failure logging (Req 6.7)
// ═══════════════════════════════════════════════════════════

describe('createSettlementProcessor — unknown job type', () => {
  it('logs a structured warning and returns ignored: true', async () => {
    vi.clearAllMocks()
    const service = makeServiceMock()
    const process = createSettlementProcessor({ service })

    const result = await process(
      makeJob({
        name: 'mystery',
        data: { type: 'mystery' },
      })
    )

    expect(result).toEqual({ ignored: true })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settlement_unknown_job_type',
        type: 'mystery',
        jobId: 'job-1',
      }),
      expect.any(String)
    )
    // None of the service methods should have been touched.
    expect(service.runDailySettlement).not.toHaveBeenCalled()
    expect(service.runWeeklySettlement).not.toHaveBeenCalled()
    expect(service.runMonthlySettlement).not.toHaveBeenCalled()
    expect(service.settleShopForPeriod).not.toHaveBeenCalled()
  })

  it('routes by job.data.type when present, falling back to job.name', async () => {
    vi.clearAllMocks()
    const service = makeServiceMock()
    service.runDailySettlement.mockResolvedValue({
      settled: 1,
      skipped: 0,
      failed: 0,
      periodStart: '2024-03-14',
    })
    const process = createSettlementProcessor({ service })

    await process(
      makeJob({
        name: 'mystery',           // ignored
        data: { type: 'daily' },   // routed to daily
      })
    )

    expect(service.runDailySettlement).toHaveBeenCalledTimes(1)
  })
})

// ═══════════════════════════════════════════════════════════
// scheduleSettlementCron — daily 02:00 UTC (Req 6.2, 14.6)
// ═══════════════════════════════════════════════════════════

describe('scheduleSettlementCron', () => {
  it('registers a daily 0 2 * * * UTC repeatable job with a stable jobId', async () => {
    const queue = makeQueueMock()
    await scheduleSettlementCron(queue)
    expect(queue.add).toHaveBeenCalledWith(
      'daily',
      { type: 'daily' },
      expect.objectContaining({
        repeat: { pattern: '0 2 * * *', tz: 'UTC' },
        jobId: 'settlement-daily-cron',
      })
    )
  })

  it('is a no-op when the queue is missing', async () => {
    await expect(scheduleSettlementCron(null)).resolves.toBeUndefined()
    await expect(scheduleSettlementCron(undefined)).resolves.toBeUndefined()
  })
})
