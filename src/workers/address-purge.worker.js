import { logger } from '../config/logger.js'
import { AddressesRepository } from '../modules/addresses/addresses.repository.js'
import { ADDRESS_RETENTION_DAYS } from '../modules/addresses/addresses.service.js'

/**
 * Address-purge worker — processes BullMQ `address-purge` queue jobs.
 *
 * A customer's "delete address" action is a soft-delete (`deleted_at` set,
 * see `AddressesRepository.delete`) — the row stays queryable by admins for
 * delivery-dispute/security review. This worker's `purge` job is the other
 * half of that lifecycle: once a soft-deleted row is older than
 * `ADDRESS_RETENTION_DAYS`, it's hard-deleted for good.
 *
 * Recurring scheduling — see `scheduleAddressPurgeCron(queue)` below; the
 * runtime calls it once at startup so BullMQ owns the cron metadata.
 */
export function createAddressPurgeProcessor(deps = {}) {
  const repo = deps.repo || new AddressesRepository()

  return async function processAddressPurgeJob(job) {
    const type = job?.data?.type || job?.name

    if (type === 'purge') {
      const purged = await repo.purgeDeletedOlderThan(ADDRESS_RETENTION_DAYS)
      logger.info(
        { purged, retentionDays: ADDRESS_RETENTION_DAYS, action: 'address_purge' },
        'Purged expired soft-deleted addresses'
      )
      return { type: 'purge', purged }
    }

    logger.warn({ jobId: job?.id, type }, 'Unknown address-purge job type')
    return { type: 'unknown', skipped: true }
  }
}

/**
 * Register the daily address-purge cron on a queue.
 *
 * `jobId` keeps successive cron registrations idempotent — calling this on
 * every startup will not accumulate duplicate cron entries (same pattern
 * as `scheduleSettlementCron`).
 *
 * Pattern: `0 3 * * *` → 03:00 UTC daily, an hour after the settlement
 * cron so the two don't contend for DB connections at the same instant.
 *
 * @param {import('bullmq').Queue} queue
 * @returns {Promise<void>}
 */
export async function scheduleAddressPurgeCron(queue) {
  if (!queue) return
  await queue.add(
    'purge',
    { type: 'purge' },
    {
      repeat: { pattern: '0 3 * * *', tz: 'UTC' },
      jobId: 'address-purge-daily-cron',
      removeOnComplete: true,
      removeOnFail: false,
    }
  )
  logger.info(
    { action: 'address_purge_cron_registered', pattern: '0 3 * * * (UTC)' },
    'Address-purge daily cron registered'
  )
}
