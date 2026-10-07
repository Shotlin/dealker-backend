import { logger } from '../config/logger.js'
import {
  OPEN_ASSIGNMENT_STATUSES,
  sqlInList,
} from '../constants/delivery-statuses.js'

// A rider is dispatch-eligible only while their last known GPS fix is
// fresh enough (blueprint §5: "location fix is fresh enough for
// dispatch"). The Redis cache `rider:location:<id>` carries `updatedAt`
// and expires on its own (TTL); the DB column
// `rider_profiles.location_updated_at` is the durable fallback.
export const RIDER_LOCATION_STALE_MINUTES =
  Number(process.env.RIDER_LOCATION_STALE_MINUTES) || 10

/**
 * Pure freshness decision for one dispatch candidate.
 *
 * @param {object} input
 * @param {number|null} input.redisUpdatedAt  epoch ms from the Redis
 *   location cache, or null when the cache has no entry for the rider.
 * @param {Date|string|null} input.dbLocationUpdatedAt  value of
 *   `rider_profiles.location_updated_at`, or null when the rider never
 *   reported a fix through the DB path.
 * @param {number} [input.nowMs]  current epoch ms (injectable for tests).
 * @param {number} [input.staleMinutes]  max accepted fix age in minutes.
 * @returns {{ fresh: boolean, source: 'redis'|'db'|null, ageSeconds: number|null }}
 */
export function evaluateLocationFreshness({
  redisUpdatedAt,
  dbLocationUpdatedAt,
  nowMs = Date.now(),
  staleMinutes = RIDER_LOCATION_STALE_MINUTES,
}) {
  const maxAgeMs = staleMinutes * 60 * 1000

  if (Number.isFinite(redisUpdatedAt) && redisUpdatedAt > 0) {
    const ageMs = nowMs - redisUpdatedAt
    if (ageMs >= 0 && ageMs <= maxAgeMs) {
      return { fresh: true, source: 'redis', ageSeconds: Math.round(ageMs / 1000) }
    }
    return { fresh: false, source: 'redis', ageSeconds: ageMs >= 0 ? Math.round(ageMs / 1000) : null }
  }

  const dbTime = dbLocationUpdatedAt ? new Date(dbLocationUpdatedAt).getTime() : Number.NaN
  if (Number.isFinite(dbTime) && dbTime > 0) {
    const ageMs = nowMs - dbTime
    if (ageMs >= 0 && ageMs <= maxAgeMs) {
      return { fresh: true, source: 'db', ageSeconds: Math.round(ageMs / 1000) }
    }
    return { fresh: false, source: 'db', ageSeconds: ageMs >= 0 ? Math.round(ageMs / 1000) : null }
  }

  return { fresh: false, source: null, ageSeconds: null }
}

/**
 * Logs (once per skipped batch, not per rider) why candidates were
 * dropped for stale/missing location, so dispatch gaps stay debuggable.
 */
export function logStaleLocationSkips({ skipped, total, orderId, source }) {
  if (!skipped) return
  logger.info(
    { skipped, total, orderId, source, staleMinutes: RIDER_LOCATION_STALE_MINUTES },
    'Auto-assign: candidates skipped for stale or missing location'
  )
}

/**
 * Builds the dispatch candidate SQL for the auto-assign worker.
 *
 * Baseline eligibility (Task 12.2): approved + online + active user +
 * no open assignment. Big Phase 6 additions live here:
 * - `location_updated_at` is selected for the freshness gate.
 * - when `storeScoping` is true, the rider must hold an active
 *   assignment for the order's pickup shop.
 *
 * @param {object} input
 * @param {boolean} input.storeScoping
 * @param {string|null} input.shopId  order pickup shop id (required
 *   when storeScoping is true).
 * @returns {{ sql: string, params: any[] }}
 */
export function buildCandidateQuery({ storeScoping, shopId }) {
  const params = []
  let sql = `SELECT rp.user_id, rp.current_lat, rp.current_lng, rp.updated_at,
            rp.location_updated_at
     FROM rider_profiles rp
     JOIN users u ON u.id = rp.user_id
     WHERE rp.is_approved = true
       AND rp.is_online = true
       AND u.is_active = true
       AND NOT EXISTS (
         SELECT 1 FROM delivery_assignments da
         WHERE da.rider_id = rp.user_id
           AND da.status IN (${sqlInList(OPEN_ASSIGNMENT_STATUSES)})
       )`
  if (storeScoping) {
    if (!shopId) {
      throw new Error('storeScoping requires the order shop id')
    }
    params.push(shopId)
    sql += `
       AND EXISTS (
         SELECT 1 FROM rider_store_assignments rsa
         WHERE rsa.rider_id = rp.user_id
           AND rsa.shop_id = $1
           AND rsa.is_active = true
       )`
  }
  sql += `
     ORDER BY rp.updated_at ASC NULLS LAST
     LIMIT 10000`
  return { sql, params }
}

// Architecture §9: a sensible default architecture offers the order to
// a configured pool of the nearest eligible riders instead of fanning
// out to every online rider in range. `0` (or any non-positive value)
// disables the cap and restores uncapped fanout.
export const AUTO_ASSIGN_POOL_SIZE =
  Number(process.env.AUTO_ASSIGN_POOL_SIZE) || 10

/**
 * Pure pool cap: nearest-first candidates in, at most `poolSize` out.
 * A non-positive/invalid cap means unlimited. The input array is not
 * mutated; when no truncation happens the same array is returned.
 */
export function applyPoolCap(candidates, poolSize = AUTO_ASSIGN_POOL_SIZE) {
  if (!Array.isArray(candidates)) return []
  if (!Number.isFinite(poolSize) || poolSize <= 0) return candidates
  if (candidates.length <= poolSize) return candidates
  return candidates.slice(0, poolSize)
}
