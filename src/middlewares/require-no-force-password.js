/**
 * Force-password-change gate — server-side enforcement of R20 AC#7.
 *
 * While the authenticated User has `users.force_password_change = true`,
 * THE Platform SHALL reject every API request other than:
 *
 *   - GET  `/api/v1/admin/auth/me`
 *   - POST `/api/v1/admin/auth/change-password`
 *   - POST `/api/v1/admin/auth/logout`
 *
 * with HTTP 403 and the error code `PASSWORD_CHANGE_REQUIRED`.
 *
 * Allow-list matching is by route-template suffix so the middleware is
 * decoupled from the API version prefix. The dashboard-auth router is
 * mounted at `/api/v1/admin/auth/*`; matching `/me`, `/change-password`,
 * and `/logout` against `request.routeOptions.url` (registered path
 * template, not the raw URL with query string) is unambiguous within
 * the dashboard scope where this middleware is wired.
 *
 * Source-of-truth for the `force_password_change` flag is
 * `users.force_password_change` (column added by migration 039,
 * R20 AC#6). The JWT may carry the boolean as a forward-compat claim
 * — if it does, the middleware uses it directly to avoid a DB hop.
 * Otherwise it executes a single primary-key SELECT against `users`
 * via the parameterized `query()` helper. No Redis caching: the read
 * is a single-row PK lookup whose latency is well under the 5 ms
 * Redis budget and the value flips at most once per session
 * (change-password clears it and increments `users.session_version`,
 * invalidating every previously issued JWT — see design §5.5).
 *
 * Order of registration: this preHandler MUST run AFTER
 * `fastify.authenticate` so `request.user` is populated. It is wired
 * onto every protected dashboard route by `auth.routes.js` (task 3.6)
 * and onto the broader dashboard router tree as routes ship.
 *
 * Failure mode: if the DB fallback fails (connectivity, timeout), the
 * gate fails CLOSED — returning 500 INTERNAL_ERROR rather than
 * silently allowing the request. R20 AC#7 is a security boundary: a
 * temporary infrastructure failure must not let a User with
 * `force_password_change=true` reach unrelated endpoints.
 *
 * Requirements: R20.7
 * Design:       §5.5 of .kiro/specs/multi-vendor-system/design.md
 *
 * @module middlewares/require-no-force-password
 */

import { query } from '../config/database.js'
import { logger } from '../config/logger.js'
import { ERROR_CODES } from '../constants/errors.js'

/**
 * Route-template suffixes that remain accessible while
 * `force_password_change=true`. Frozen so route authors can import
 * the list for tests / boot-time documentation without risking
 * runtime mutation.
 *
 * The leading `/` is required: matching `'me'` against
 * `/api/v1/users/welcome.me` would yield a false positive,
 * whereas `'/me'` only matches a route segment boundary.
 *
 * @type {Readonly<readonly string[]>}
 */
export const FORCE_PASSWORD_ALLOWED_SUFFIXES = Object.freeze([
  '/me',
  '/change-password',
  '/logout',
])

/**
 * True when the registered route template (or raw URL fallback)
 * ends with one of the allow-listed suffixes. Suffix matching is
 * intentional: the dashboard-auth router is mounted under
 * `/api/v1/admin/auth/*`, so the registered template is e.g.
 * `/api/v1/admin/auth/change-password` and the suffix
 * `/change-password` matches.
 *
 * Pure helper exported for unit tests.
 *
 * @param {string | null | undefined} routePath
 * @returns {boolean}
 */
export function isForcePasswordAllowedPath(routePath) {
  if (typeof routePath !== 'string' || routePath.length === 0) return false
  for (const suffix of FORCE_PASSWORD_ALLOWED_SUFFIXES) {
    if (routePath === suffix || routePath.endsWith(suffix)) return true
  }
  return false
}

/**
 * Fallback DB lookup when the JWT does not carry the
 * `force_password_change` claim. Single-row PK SELECT, parameterized.
 *
 * Returns `false` when the user row is missing — the caller has
 * already passed `fastify.authenticate` which validated the JWT, so
 * a missing row points at a deleted user; downstream guards in the
 * auth plugin (e.g., is_blocked / session_version) handle that case.
 * Treating the absent row as "no force-change" here keeps the gate
 * scoped to the single concern R20 AC#7 calls out.
 *
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function loadForcePasswordChange(userId) {
  const { rows } = await query(
    'SELECT force_password_change FROM users WHERE id = $1 LIMIT 1',
    [userId],
  )
  if (rows.length === 0) return false
  return rows[0].force_password_change === true
}

/**
 * Fastify preHandler — gate every authenticated dashboard request
 * behind `users.force_password_change=false`, allowing only the
 * `/me`, `/change-password`, `/logout` route templates while the
 * flag is true (R20 AC#7).
 *
 * Decision flow:
 *
 *   1. Missing `request.user` → no-op (upstream `fastify.authenticate`
 *      is responsible for unauthenticated requests; this gate has
 *      nothing to enforce on them).
 *   2. `request.user.force_password_change` (or the camelCase
 *      `forcePasswordChange`) carries an explicit boolean → use it
 *      directly. This is forward-compat for task 3.x widening the
 *      JWT payload to carry the flag.
 *   3. Otherwise → single PK SELECT on `users.force_password_change`
 *      via the parameterized `query()` helper. DB errors fail
 *      CLOSED with 500 INTERNAL_ERROR.
 *   4. `force_password_change=false` → allow.
 *   5. `force_password_change=true` AND
 *      `request.routeOptions.url` matches one of
 *      `FORCE_PASSWORD_ALLOWED_SUFFIXES` → allow.
 *   6. Otherwise → 403 with the canonical envelope
 *      `{ success:false, message, code: 'PASSWORD_CHANGE_REQUIRED' }`.
 *
 * Requirements: R20.7
 * Design:       §5.5
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @returns {Promise<void>}
 */
export async function requireNoForcePassword(request, reply) {
  const user = request.user
  if (!user || !user.id) {
    // Not authenticated — `fastify.authenticate` should have rejected
    // already. Treat as no-op so registration-order mistakes surface
    // through the auth layer rather than this gate.
    return
  }

  // ── Resolve the flag ─────────────────────────────────────────
  let forcePasswordChange
  if (typeof user.force_password_change === 'boolean') {
    forcePasswordChange = user.force_password_change
  } else if (typeof user.forcePasswordChange === 'boolean') {
    forcePasswordChange = user.forcePasswordChange
  } else {
    try {
      forcePasswordChange = await loadForcePasswordChange(user.id)
    } catch (err) {
      // Fail closed: R20 AC#7 is a security boundary, do not let an
      // infrastructure hiccup hand the user a free pass through it.
      logger.error(
        {
          err,
          userId: user.id,
          action: 'require_no_force_password_lookup_failed',
        },
        'Failed to load users.force_password_change — failing closed',
      )
      return reply.code(500).send({
        success: false,
        message: 'Internal server error',
        code: ERROR_CODES.INTERNAL_ERROR,
      })
    }
  }

  if (forcePasswordChange !== true) {
    return // allow — flag is false / null / unknown
  }

  // ── Flag is true — only allow-listed routes may proceed ──────
  const routePath = request.routeOptions?.url ?? request.url ?? ''
  if (isForcePasswordAllowedPath(routePath)) {
    return
  }

  return reply.code(403).send({
    success: false,
    message: 'Password change required before continuing',
    code: ERROR_CODES.PASSWORD_CHANGE_REQUIRED,
  })
}
