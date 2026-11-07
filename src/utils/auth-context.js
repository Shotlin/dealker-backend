/**
 * Per-request auth lookups, collapsed and cached.
 *
 * `fastify.authenticate` used to run, on EVERY request: SELECT users (blocked / session_version / role), then a
 * second SELECT user_device_sessions (revocation), then an UPDATE attempt for last_active_at. A vendor opening the
 * home screen sends ~15 requests at once, so that was ~45 sequential DB round-trips before any real work started.
 *
 * Now: ONE statement answers both gates, the answer is shared for a few seconds (and by every request that arrives
 * while it is loading), and last_active_at is stamped at most once per 10 minutes per user per process.
 *
 * Revocation latency: a blocked user / revoked session is rejected immediately when the change goes through
 * `invalidateAuthContext()` (session revoke, block toggle) and within AUTH_CACHE_TTL_MS (default 5 s) otherwise.
 *
 * @module utils/auth-context
 */

import { query } from '../config/database.js'
import { logger } from '../config/logger.js'
import { createTtlCache, envTtl } from './ttl-cache.js'

const cache = createTtlCache({ ttlMs: envTtl('AUTH_CACHE_TTL_MS', 5000), max: 10000 })

const STAMP_EVERY_MS = 10 * 60 * 1000
const MAX_STAMPS = 20000
const lastStamped = new Map() // userId -> ms of the last last_active_at UPDATE issued by this process

const SQL_WITH_SESSION = `
  SELECT (u.id IS NOT NULL) AS found, u.is_blocked, u.session_version, u.platform_role,
         EXISTS (SELECT 1 FROM user_device_sessions s
                  WHERE s.id = $2 AND s.is_revoked = false AND s.expires_at > NOW()) AS session_active
    FROM (SELECT 1) AS one
    LEFT JOIN users u ON u.id = $1`

const SQL_NO_SESSION = `
  SELECT (u.id IS NOT NULL) AS found, u.is_blocked, u.session_version, u.platform_role,
         NULL::boolean AS session_active
    FROM (SELECT 1) AS one
    LEFT JOIN users u ON u.id = $1`

/**
 * @param {string} userId
 * @param {string|null} sessionId device session id from the JWT (null when the token has none)
 * @returns {Promise<{found: boolean, is_blocked: boolean|null, session_version: number|null,
 *                    platform_role: string|null, session_active: boolean|null}>}
 */
export function loadAuthContext(userId, sessionId = null) {
  const key = `${userId}:${sessionId || ''}`
  return cache.get(key, async () => {
    const { rows } = await query(sessionId ? SQL_WITH_SESSION : SQL_NO_SESSION, sessionId ? [userId, sessionId] : [userId])
    return rows[0]
  })
}

/** Call after anything that changes who may act: block/unblock, session revoke, session_version bump. */
export function invalidateAuthContext(userId) {
  if (userId) cache.invalidatePrefix(`${userId}:`)
}

export function clearAuthContextCache() {
  cache.clear()
  lastStamped.clear()
}

/** Fire-and-forget "daily active" stamp, issued at most once per STAMP_EVERY_MS per user (per process). */
export function stampLastActive(userId) {
  const now = Date.now()
  const prev = lastStamped.get(userId)
  if (prev && now - prev < STAMP_EVERY_MS) return
  if (lastStamped.size >= MAX_STAMPS) lastStamped.delete(lastStamped.keys().next().value)
  lastStamped.set(userId, now)
  try {
    Promise.resolve(
      query(
        `UPDATE users SET last_active_at = NOW()
          WHERE id = $1 AND (last_active_at IS NULL OR last_active_at < NOW() - INTERVAL '10 minutes')`,
        [userId]
      )
    ).catch((err) => {
      lastStamped.delete(userId) // try again on the next request
      logger.warn({ err: err.message, userId }, 'last_active_at stamp failed (non-critical)')
    })
  } catch (err) {
    // A throwing/odd query implementation must never fail the request this stamp rides on.
    lastStamped.delete(userId)
    logger.warn({ err: err.message, userId }, 'last_active_at stamp failed (non-critical)')
  }
}
