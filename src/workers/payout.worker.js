// Feature: multi-vendor-system, task 9.2
// Validates Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 14.6
//
// Payout_Worker — processes BullMQ `payouts` queue jobs.
//
// Job types:
//   - `weekly-run`      — Cron-triggered (Mon 02:00 UTC). Identifies all
//                         PENDING shop_financials rows whose period_end
//                         <= the preceding Sunday and enqueues one
//                         `process-payout` job per row (Req 8.1).
//   - `process-payout`  — Single-row state machine: PENDING → PROCESSING
//                         → PAID, with HELD branches for missing bank
//                         details (Req 8.6) and 3-attempt overflow
//                         (Req 8.5). Writes a PAYOUT_CREDIT ledger entry
//                         in the same transaction as the PAID transition
//                         (Req 8.3).
//   - `set-hold`        — Admin-triggered (Req 8.7): PENDING|PROCESSING
//                         → HELD.
//   - `release-hold`    — Admin-triggered (Req 8.7): HELD → PENDING.
//
// Concurrency / retry (Req 14.6):
//   - Queue concurrency 1 — payout writes serialized, ledger appends safe.
//   - Job-level retries: 3 attempts with exponential backoff (BullMQ
//     defaults from config/bullmq.js) cover transient infra failures.
//   - Row-level retries: max 3 disbursement attempts before HELD (Req 8.5)
//     are tracked on shop_financials.attempt_count, independent of BullMQ
//     attempts.
//
// The worker is intentionally a thin dispatcher — all business logic
// lives in `PayoutService` so it can be unit-tested without BullMQ.

import { logger } from '../config/logger.js'
import { PayoutService } from '../modules/shop-financials/payout.service.js'

/**
 * Build a job processor bound to a `PayoutService`. Factory style mirrors
 * the settlement worker so tests can inject a mock service without
 * touching module-level state.
 *
 * @param {object} [deps]
 * @param {PayoutService} [deps.payoutService]
 * @param {{ add: Function }} [deps.queue] - Used by `weekly-run` to
 *   enqueue per-row `process-payout` jobs. Optional in tests when the
 *   service already has its own queue handle.
 * @returns {(job: import('bullmq').Job) => Promise<object>}
 */
export function createPayoutProcessor(deps = {}) {
  // The service owns the queue handle for `weekly-run`. If a queue is
  // passed into the factory, prefer it; otherwise the service falls back
  // to its own injected queue (or no-op in tests).
  const service =
    deps.payoutService ||
    new PayoutService({ queue: deps.queue || null })

  return async function processPayoutJob(job) {
    const type = job?.data?.type || job?.name

    if (type === 'weekly-run') {
      return handleWeeklyRun(job, { service })
    }

    if (type === 'process-payout') {
      return handleProcessPayout(job, { service })
    }

    if (type === 'set-hold') {
      return handleSetHold(job, { service })
    }

    if (type === 'release-hold') {
      return handleReleaseHold(job, { service })
    }

    logger.warn(
      { jobId: job?.id, type, action: 'payout_unknown_job_type' },
      'Unknown payout job type'
    )
    return { ignored: true }
  }
}

/**
 * Cron entry point — picks up PENDING rows whose period_end is <= the
 * preceding Sunday and enqueues a `process-payout` job for each.
 * Idempotent: deterministic jobIds (`process-payout:{rowId}`) coalesce
 * duplicate enqueues, and the underlying state machine guards every
 * transition.
 */
async function handleWeeklyRun(job, { service }) {
  const asOf = job?.data?.asOf ? new Date(job.data.asOf) : new Date()
  const summary = await service.runWeeklyPayouts({ asOf })
  return { type: 'weekly-run', ...summary }
}

/**
 * Per-row processor — runs the full PENDING → PROCESSING → PAID
 * transition (with HELD branches) in a single transaction.
 *
 * BullMQ retry contract: the dispatcher MUST throw on infra-level
 * failures so BullMQ's attempts/backoff config applies. Domain-level
 * outcomes (HELD, RETRY_PENDING, NOT_FOUND, INVALID_STATE) are returned
 * as values — they are NOT errors and must not consume BullMQ attempts.
 */
async function handleProcessPayout(job, { service }) {
  const financialId = job?.data?.financialId
  if (!financialId) {
    logger.warn(
      { jobId: job?.id, action: 'payout_process_missing_id' },
      'process-payout job missing financialId'
    )
    return { type: 'process-payout', skipped: true }
  }
  const result = await service.processPayout(financialId)
  return { type: 'process-payout', ...result }
}

async function handleSetHold(job, { service }) {
  const { financialId, actorId } = job?.data || {}
  if (!financialId) {
    logger.warn(
      { jobId: job?.id, action: 'payout_set_hold_missing_id' },
      'set-hold job missing financialId'
    )
    return { type: 'set-hold', skipped: true }
  }
  const result = await service.setHold(financialId, actorId || null)
  return { type: 'set-hold', ...result }
}

async function handleReleaseHold(job, { service }) {
  const { financialId, actorId } = job?.data || {}
  if (!financialId) {
    logger.warn(
      { jobId: job?.id, action: 'payout_release_hold_missing_id' },
      'release-hold job missing financialId'
    )
    return { type: 'release-hold', skipped: true }
  }
  const result = await service.releaseHold(financialId, actorId || null)
  return { type: 'release-hold', ...result }
}

/**
 * Register the weekly payout cron on a queue.
 *
 * Pattern: `0 2 * * 1` → minute 0, hour 2, every Monday in UTC — i.e.
 * Monday 02:00 UTC (Req 8.1). Stable jobId keeps successive cron
 * registrations idempotent across restarts.
 *
 * @param {import('bullmq').Queue} queue
 * @returns {Promise<void>}
 */
export async function schedulePayoutCron(queue) {
  if (!queue) return
  await queue.add(
    'weekly-run',
    { type: 'weekly-run' },
    {
      repeat: { pattern: '0 2 * * 1', tz: 'UTC' },
      jobId: 'payout-weekly-cron',
      removeOnComplete: true,
      removeOnFail: false,
    }
  )
  logger.info(
    { action: 'payout_cron_registered', pattern: '0 2 * * 1 (UTC)' },
    'Payout weekly cron registered'
  )
}
