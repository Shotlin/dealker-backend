import { redis } from '../config/redis.js'
import { logger } from '../config/logger.js'

// Read-through Redis cache with two protections the plain get/set pattern lacks:
//
//  1. Single-flight — when an entry is missing, concurrent requests share ONE build
//     instead of each running the full set of queries (a "thundering herd" right after
//     a cache flush or restart).
//  2. Stale-while-revalidate — an entry older than `freshSeconds` is still served
//     immediately while a single background refresh rebuilds it, so a customer is not
//     the one who pays for the rebuild every `freshSeconds`.
//
// Admin edits and product changes keep working exactly as before: they delete the key
// (cacheDeletePattern), so the next request rebuilds synchronously and never sees the
// pre-edit value. Entries written by older code (no `_swr` stamp) are treated as fresh.

const inflight = new Map()

/** Run `build` once per key at a time; callers arriving meanwhile await the same promise. */
export function singleFlight(key, build) {
  const existing = inflight.get(key)
  if (existing) return existing
  const promise = Promise.resolve()
    .then(build)
    .finally(() => inflight.delete(key))
  inflight.set(key, promise)
  return promise
}

async function readEntry(key) {
  try {
    const raw = await redis.get(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && '_swr' in parsed) {
      return { value: parsed.value, storedAt: parsed._swr }
    }
    return { value: parsed, storedAt: Date.now() } // legacy entry: treat as fresh
  } catch (err) {
    logger.warn({ err, key }, 'swr-cache read failed; rebuilding')
    return null
  }
}

async function writeEntry(key, value, hardSeconds) {
  try {
    await redis.set(key, JSON.stringify({ _swr: Date.now(), value }), 'EX', hardSeconds)
  } catch (err) {
    logger.warn({ err, key }, 'swr-cache write failed')
  }
}

/**
 * @param {object}   opts
 * @param {string}   opts.key           Redis key
 * @param {number}   opts.freshSeconds  serve without refreshing for this long
 * @param {number}   opts.hardSeconds   Redis TTL; between fresh and hard the entry is served stale
 * @param {Function} opts.build         async () => value  (return `null`/`undefined` to skip caching)
 * @returns {Promise<{ value: any, state: 'fresh' | 'stale' | 'miss' }>}
 */
export async function readThrough({ key, freshSeconds, hardSeconds, build }) {
  const entry = await readEntry(key)

  if (entry) {
    const ageMs = Date.now() - entry.storedAt
    if (ageMs < freshSeconds * 1000) return { value: entry.value, state: 'fresh' }

    // Stale: answer now, refresh in the background (one refresh at a time per key).
    singleFlight(`refresh:${key}`, async () => {
      const value = await build()
      if (value != null) await writeEntry(key, value, hardSeconds)
    }).catch((err) => logger.warn({ err, key }, 'swr-cache background refresh failed'))
    return { value: entry.value, state: 'stale' }
  }

  const value = await singleFlight(`build:${key}`, async () => {
    const built = await build()
    if (built != null) await writeEntry(key, built, hardSeconds)
    return built
  })
  return { value, state: 'miss' }
}
