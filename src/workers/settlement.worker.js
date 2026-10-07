import { logger } from '../config/logger.js'
import { SettlementService } from '../modules/shop-financials/settlement.service.js'

/**
 * Settlement worker — processes BullMQ `settlement` queue jobs.
 *
 * Job types:
 *   - `daily`   — Aggregate previous UTC day; fired by the daily 02:00 UTC
 *                 cron. After the daily run, this same job fans out a
 *                 weekly job on Mondays and a monthly job on the 1st (so
 *                 weekly/monthly always see the daily rows they need —
 *                 Req 6.9).
 *   - `weekly`  — Aggregate the 7 daily rows of a Monday..Sunday week.
 *                 Skips shops whose week is incomplete (<7 daily rows).
 *   - `monthly` — Aggregate all daily rows of a calendar month. Skips
 *                 shops whose month is incomplete.
 *   - `shop`    — Single-shop replay (manual / refund-driven). Useful for
 *                 the refund flow that lands later in the spec
 *                 (Req 6.8 mentions recompute on refund).
 *
 * Retry / concurrency (Req 6.7, 14.6):
 *   - Concurrency 1 (queue-level) — financial writes serialized
 *   - 3 attempts with exponential backoff (queue defaults)
 *   - Idempotent UPSERT in the service layer means safe-to-retry
 *
 * Recurring scheduling — see `scheduleSettlementCron(queue)` below; the
 * runtime calls it once at startup so BullMQ owns the cron metadata.
 */

/**
 * Build a job processor bound to a fresh SettlementService instance.
 * Factory style mirrors the allocation worker so tests can substitute a
 * mock service without touching module-level state.
 *
 * @param {object} [deps]
 * @param {SettlementService} [deps.service]
 * @param {import('bullmq').Queue} [deps.queue] - Used by `daily` to fan out
 *   weekly/monthly jobs. Optional in tests.
 * @returns {(job: import('bullmq').Job) => Promise<object>}
 */
export function createSettlementProcessor(deps = {}) {
  const service = deps.service || new SettlementService()
  const queue = deps.queue || null

  return async function processSettlementJob(job) {
    const type = job?.data?.type || job?.name

    if (type === 'daily') {
      return handleDaily(job, { service, queue })
    }

    if (type === 'weekly') {
      return handleWeekly(job, { service })
    }

    if (type === 'monthly') {
      return handleMonthly(job, { service })
    }

    if (type === 'shop') {
      return handleSingleShop(job, { service })
    }

    if (type === 'late-refund') {
      return handleLateRefund(job, { service })
    }

    logger.warn(
      { jobId: job?.id, type, action: 'settlement_unknown_job_type' },
      'Unknown settlement job type'
    )
    return { ignored: true }
  }
}

/**
 * Daily run + Monday/1st fan-out. Always settles "the previous UTC day".
 *
 * Fan-out timing rule (Req 6.9):
 *   - Once the daily run for date D completes, all 7 days of the week
 *     ending on D are settled IFF D is a Sunday → enqueue a weekly job
 *     for that Monday..Sunday window.
 *   - Once the daily run for the last day of a month completes → enqueue
 *     a monthly job for that calendar month.
 */
async function handleDaily(job, { service, queue }) {
  const date = job?.data?.date ? new Date(job.data.date) : new Date()
  const summary = await service.runDailySettlement({ date })

  // Fan out aggregate jobs deterministically based on the settled day.
  if (queue) {
    const settledDay = new Date(`${summary.periodStart}T00:00:00.000Z`)
    const isSunday = settledDay.getUTCDay() === 0

    if (isSunday) {
      const weekStart = SettlementService.weekStartFor(settledDay)
      try {
        await queue.add(
          'weekly',
          { type: 'weekly', weekStart },
          { jobId: `settlement-weekly:${weekStart}` }
        )
      } catch (err) {
        logger.warn(
          { weekStart, err: err.message, action: 'settlement_weekly_enqueue_failed' },
          'Could not enqueue weekly settlement'
        )
      }
    }

    const monthEnd = SettlementService.monthEndFor(settledDay)
    if (summary.periodStart === monthEnd) {
      const monthStart = SettlementService.monthStartFor(settledDay)
      try {
        await queue.add(
          'monthly',
          { type: 'monthly', monthStart },
          { jobId: `settlement-monthly:${monthStart}` }
        )
      } catch (err) {
        logger.warn(
          { monthStart, err: err.message, action: 'settlement_monthly_enqueue_failed' },
          'Could not enqueue monthly settlement'
        )
      }
    }
  }

  return { type: 'daily', ...summary }
}

async function handleWeekly(job, { service }) {
  const weekStart = job?.data?.weekStart
  if (!weekStart) {
    logger.warn(
      { jobId: job?.id, action: 'settlement_weekly_missing_week_start' },
      'weekly settlement job missing weekStart'
    )
    return { type: 'weekly', skipped: true }
  }
  const summary = await service.runWeeklySettlement({ weekStart })
  return { type: 'weekly', ...summary }
}

async function handleMonthly(job, { service }) {
  const monthStart = job?.data?.monthStart
  if (!monthStart) {
    logger.warn(
      { jobId: job?.id, action: 'settlement_monthly_missing_month_start' },
      'monthly settlement job missing monthStart'
    )
    return { type: 'monthly', skipped: true }
  }
  const summary = await service.runMonthlySettlement({ monthStart })
  return { type: 'monthly', ...summary }
}

async function handleSingleShop(job, { service }) {
  const { shopId, periodType, periodStart, periodEnd } = job?.data || {}
  if (!shopId || !periodType || !periodStart || !periodEnd) {
    logger.warn(
      { jobId: job?.id, action: 'settlement_single_shop_invalid' },
      'single-shop settlement job missing required fields'
    )
    return { type: 'shop', skipped: true }
  }
  const result = await service.settleShopForPeriod(
    shopId,
    periodType,
    periodStart,
    periodEnd
  )
  return { type: 'shop', ...result }
}

/**
 * Apply a late-arriving refund to an existing daily shop_financials row
 * (Req 6.8). Job payload:
 *
 *   { type: 'late-refund', orderId, shopId?, refundAmount, completionDate? }
 *
 * Either `orderId` or `(shopId, completionDate)` must be supplied — the
 * service resolves any missing fields from the orders table when an
 * orderId is present.
 *
 * Idempotency: BullMQ retries are safe because the underlying UPDATE adds
 * the refund delta exactly once per job invocation. Producers that need
 * exactly-once semantics across enqueues (e.g. a refund webhook firing
 * twice) should pass a deterministic `jobId`.
 */
async function handleLateRefund(job, { service }) {
  const { orderId, shopId, refundAmount, completionDate } = job?.data || {}
  if ((!orderId && !shopId) || refundAmount == null) {
    logger.warn(
      { jobId: job?.id, action: 'settlement_late_refund_invalid' },
      'late-refund settlement job missing required fields'
    )
    return { type: 'late-refund', applied: false, reason: 'INVALID_INPUT' }
  }
  const result = await service.recordLateRefund({
    orderId,
    shopId,
    refundAmount,
    completionDate,
  })
  return { type: 'late-refund', ...result }
}

/**
 * Register the daily settlement cron on a queue.
 *
 * BullMQ's `repeat: { pattern, tz }` creates a "repeatable" job that
 * reschedules itself after each run. The `jobId` keeps successive cron
 * registrations idempotent — calling this on every startup will not
 * accumulate duplicate cron entries.
 *
 * Pattern explanation: `0 2 * * *` → minute 0, hour 2, every day, in
 * the UTC timezone — i.e., 02:00 UTC daily (Req 6.2).
 *
 * @param {import('bullmq').Queue} queue
 * @returns {Promise<void>}
 */
export async function scheduleSettlementCron(queue) {
  if (!queue) return
  await queue.add(
    'daily',
    { type: 'daily' },
    {
      repeat: { pattern: '0 2 * * *', tz: 'UTC' },
      jobId: 'settlement-daily-cron',
      removeOnComplete: true,
      removeOnFail: false,
    }
  )
  logger.info(
    { action: 'settlement_cron_registered', pattern: '0 2 * * * (UTC)' },
    'Settlement daily cron registered'
  )
}
