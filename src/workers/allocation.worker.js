import { logger } from '../config/logger.js'
import { AllocationRepository } from '../modules/allocation/allocation.repository.js'
import { AllocationService } from '../modules/allocation/allocation.service.js'

/**
 * Allocation worker — processes BullMQ `allocation` queue jobs.
 *
 * Job types:
 *   - `recompute-by-shop` — Triggered when a shop's serviceable_pincodes
 *     or delivery_radius_km changes. Pages through customers whose default
 *     address pincode matches the shop's serviceable_pincodes OR whose
 *     coords fall within the shop's delivery_radius_km, and recomputes each
 *     customer's allocations.
 *
 * Resource budget (Requirement 4.8, design.md Background Job Architecture):
 *   - Concurrency 2, attempts 3, exponential backoff (queue-level config)
 *   - Per-job target: process within 30 seconds
 *   - Pagination batch size: 200 users — keeps memory bounded for the
 *     2-core/4GB target. Inner recomputes are awaited sequentially per
 *     batch to avoid spawning hundreds of concurrent DB transactions on
 *     a small pool (max 15 connections per project standards).
 *
 * Idempotency: each user's allocations are atomically replaced; running
 * the same job twice converges to the same end state.
 */

const DEFAULT_BATCH_SIZE = 200
// Per-batch concurrency keeps DB connections under 15 (project standard).
const PER_BATCH_CONCURRENCY = 4

/**
 * Build a job processor bound to fresh repository/service instances.
 * The factory lets tests substitute a mock repo or service if needed and
 * keeps module imports side-effect free.
 *
 * @param {object} [deps]
 * @param {import('../modules/allocation/allocation.repository.js').AllocationRepository} [deps.repository]
 * @param {import('../modules/allocation/allocation.service.js').AllocationService} [deps.service]
 * @returns {(job: import('bullmq').Job) => Promise<object>}
 */
export function createAllocationProcessor(deps = {}) {
  const repository = deps.repository || new AllocationRepository()
  const service = deps.service || new AllocationService(repository)

  return async function processAllocationJob(job) {
    const type = job?.data?.type || job?.name

    if (type === 'recompute-by-shop') {
      return handleRecomputeByShop(job, { repository, service })
    }

    logger.warn(
      { jobId: job?.id, type, action: 'allocation_unknown_job_type' },
      'Unknown allocation job type'
    )
    return { ignored: true }
  }
}

/**
 * Recompute allocations for every customer affected by a shop's
 * serviceable_pincodes or delivery_radius_km change.
 *
 * Pagination: keyset cursor over users.id, batch size 200. The DB query
 * (repository.findUsersAffectedByShop) does the pincode/radius filtering
 * server-side so we never load all users into memory.
 *
 * Each user's allocations are recomputed via the same service path used by
 * the HTTP recompute endpoint, so behaviour stays consistent and the user's
 * Redis cache is invalidated as a side effect.
 *
 * @param {import('bullmq').Job} job
 * @param {{ repository: AllocationRepository, service: AllocationService }} ctx
 * @returns {Promise<{shopId: string, processedUsers: number, action: string}>}
 */
async function handleRecomputeByShop(job, { repository, service }) {
  const shopId = job?.data?.shopId
  if (!shopId) {
    logger.warn(
      { jobId: job?.id, action: 'allocation_recompute_missing_shop_id' },
      'recompute-by-shop job missing shopId'
    )
    return { shopId: null, processedUsers: 0, action: 'noop' }
  }

  let processed = 0
  let cursor = null
  // Hard cap on iterations as a defensive guardrail in case the DB returns
  // an unbounded set (e.g., misconfigured WHERE clause). 5000 batches of 200
  // = 1M users, well above any realistic single-shop change.
  const MAX_ITERATIONS = 5000

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const batch = await repository.findUsersAffectedByShop(shopId, {
      afterUserId: cursor,
      limit: DEFAULT_BATCH_SIZE,
    })

    if (batch.length === 0) break

    // Process each batch with bounded concurrency to keep DB connections
    // well within the pool limit (max 15) on a 2-core/4GB box.
    for (let j = 0; j < batch.length; j += PER_BATCH_CONCURRENCY) {
      const slice = batch.slice(j, j + PER_BATCH_CONCURRENCY)
      const results = await Promise.allSettled(
        slice.map((row) =>
          row.lat !== null &&
          row.lng !== null &&
          row.pincode !== null &&
          row.pincode !== undefined
            ? service.computeAndUpsertForUser(row.user_id, {
                lat: row.lat,
                lng: row.lng,
                pincode: row.pincode,
              })
            : Promise.resolve({
                success: false,
                code: 'NO_COORDINATES',
                message: 'Skipped — incomplete address',
              })
        )
      )

      for (let k = 0; k < results.length; k++) {
        const r = results[k]
        const userId = slice[k].user_id
        if (r.status === 'fulfilled' && r.value?.success) {
          processed += 1
        } else if (r.status === 'rejected') {
          logger.error(
            {
              shopId,
              userId,
              err: r.reason?.message || String(r.reason),
              action: 'allocation_recompute_user_failed',
            },
            'Per-user recompute failed during shop recompute'
          )
        } else {
          logger.debug(
            {
              shopId,
              userId,
              code: r.value?.code,
              action: 'allocation_recompute_user_skipped',
            },
            'Per-user recompute skipped'
          )
        }
      }
    }

    cursor = batch[batch.length - 1].user_id
    if (batch.length < DEFAULT_BATCH_SIZE) break
  }

  logger.info(
    { shopId, processedUsers: processed, action: 'allocation_recompute_by_shop' },
    'Completed allocation recompute for shop area change'
  )

  return { shopId, processedUsers: processed, action: 'allocation_recompute_by_shop' }
}
