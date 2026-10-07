import { cacheGet, cacheSet, cacheDel } from '../utils/cache.js'
import { query } from '../config/database.js'
import { logger } from '../config/logger.js'
import { ROLES } from '../constants/roles.js'
import { HQ_ROLES } from '../utils/permissions.js'
import { ERROR_CODES } from '../constants/errors.js'
import { emit as emitAudit } from '../utils/audit-log.js'

/**
 * Shop scope middleware — derives `request.shopId` from the authenticated user's
 * JWT payload (shop staff) or the `X-Shop-Id` header (HQ_Users), and rejects
 * requests where the caller's scope does not match the target resource's
 * shop_id (R17 AC#4, R17 AC#5).
 *
 * Requirements: R17.4, R17.5, R17.6, R17.8
 * Design:       §4.4 of .kiro/specs/multi-vendor-system/design.md
 *
 * Resolution rules (`requireShopScope`):
 *   1. Shop-scoped JWT (request.user.shopId present)
 *      → validate the staff record is still active (Redis cache, TTL 300s,
 *        falling back to DB on miss); reject 403 STAFF_INACTIVE if not.
 *      → set request.shopId = JWT shopId
 *
 *   2. HQ_User (legacy `role === 'ADMIN'` OR any HQ_Role on `platform_role`)
 *      → if X-Shop-Id header present:
 *          - must be a UUID → 400 INVALID_SHOP_ID otherwise
 *          - shop must exist, is_active=true, deleted_at IS NULL → 400 INVALID_SHOP_ID
 *          - set request.shopId to the header value
 *      → otherwise allow with request.shopId = null (HQ-wide ops)
 *
 *   3. Non-staff non-HQ users (e.g., CUSTOMER, RIDER)
 *      → set request.shopId = null
 *      → if `requireShop: true`, reject 403 SHOP_SCOPE_REQUIRED
 *
 * Cross-shop enforcement (`requireShopMatch`):
 *   For shop-owned resources, compare the caller's effective shop scope to the
 *   resource's shop_id. HQ_Users (legacy `role === 'ADMIN'`) always pass. Any
 *   other role whose JWT shop_id differs from the resource shop_id is rejected
 *   with 403 CROSS_SHOP_ACCESS_DENIED (R17 AC#5) and a fire-and-forget
 *   `cross_shop_access_blocked` audit row.
 *
 *   The legacy code name `SHOP_SCOPE_MISMATCH` continues to resolve to the
 *   same string value (`'CROSS_SHOP_ACCESS_DENIED'`) via the alias in
 *   `src/constants/errors.js`, so older callers reading
 *   `ERROR_CODES.SHOP_SCOPE_MISMATCH` are unaffected.
 */

const STAFF_ACTIVE_CACHE_PREFIX = 'bakaloo:staff-active:v1:'
const STAFF_ACTIVE_TTL_SECONDS = 300
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * True when `user` carries an HQ_Role on either the legacy `role === 'ADMIN'`
 * field or the canonical `platform_role` field. The legacy `'ADMIN'` value
 * remains accepted for backward compatibility while the platform migrates
 * issued JWTs to populate `platform_role` per design §5.1.
 *
 * @param {{ role?: string, platform_role?: string } | null | undefined} user
 * @returns {boolean}
 */
function isHqUser(user) {
  if (!user) return false
  if (user.role === ROLES.ADMIN) return true
  if (user.platform_role && HQ_ROLES.includes(user.platform_role)) return true
  return false
}

/**
 * Compute the cache key for a (user_id, shop_id) staff-active flag.
 * Exported so other modules (shop-staff service) can invalidate consistently.
 * @param {string} userId
 * @param {string} shopId
 * @returns {string}
 */
export function staffActiveCacheKey(userId, shopId) {
  return `${STAFF_ACTIVE_CACHE_PREFIX}${userId}:${shopId}`
}

/**
 * Invalidate the staff-active cache for a user/shop pair.
 * Called by shop-staff service when a staff record's is_active changes
 * or the record is soft-deleted.
 * @param {string} userId
 * @param {string} shopId
 */
export async function invalidateStaffActiveCache(userId, shopId) {
  if (!userId || !shopId) return
  await cacheDel(staffActiveCacheKey(userId, shopId))
}

/**
 * Check whether a (user_id, shop_id) staff record is active.
 * Cache-through with TTL 300s; on miss queries the DB.
 * Joined with shops to also reject when the parent shop is deactivated/deleted.
 *
 * @param {string} userId
 * @param {string} shopId
 * @returns {Promise<boolean>}
 */
async function isStaffActive(userId, shopId) {
  const key = staffActiveCacheKey(userId, shopId)
  const cached = await cacheGet(key)
  if (cached !== null && cached !== undefined) {
    return cached === true
  }

  const { rows } = await query(
    `SELECT ss.id
       FROM shop_staff ss
       JOIN shops s ON s.id = ss.shop_id
      WHERE ss.user_id = $1
        AND ss.shop_id = $2
        AND ss.is_active = true
        AND ss.deleted_at IS NULL
        AND s.is_active = true
        AND s.deleted_at IS NULL
      LIMIT 1`,
    [userId, shopId]
  )
  const active = rows.length > 0
  await cacheSet(key, active, STAFF_ACTIVE_TTL_SECONDS)
  return active
}

/**
 * Validate that a shop_id from the X-Shop-Id header refers to an active shop.
 * @param {string} shopId
 * @returns {Promise<boolean>}
 */
async function isShopActive(shopId) {
  const { rows } = await query(
    `SELECT id FROM shops
      WHERE id = $1 AND is_active = true AND deleted_at IS NULL
      LIMIT 1`,
    [shopId]
  )
  return rows.length > 0
}

/**
 * Resolve the caller's intended shop_id from a Fastify-shaped request,
 * following the priority order defined in R17 AC#4:
 *
 *   1. JWT (`request.user.shopId` or `request.user.shop_id`)
 *   2. `X-Shop-Id` header
 *   3. `:shopId` route param
 *
 * The first source that yields a non-empty value wins; remaining sources
 * are ignored. Returns `{ shopId: null, source: null }` when nothing is
 * present so callers can branch without checking individual fields.
 *
 * Pure helper — does NOT validate UUID shape, does NOT touch Redis or the
 * DB. UUID validation, shop-active checks, and HQ_User gating are the
 * responsibility of `requireShopScope` and the route handler.
 *
 * Requirements: R17.4
 * Design:       §4.4
 *
 * @param {{ user?: object, headers?: object, params?: object }} req
 * @returns {{ shopId: string | null, source: 'jwt' | 'header' | 'path' | null }}
 */
export function extractShopId(req) {
  if (!req || typeof req !== 'object') {
    return { shopId: null, source: null }
  }

  // 1. JWT — accept both camelCase (Fastify @fastify/jwt convention) and
  //    snake_case (raw token claim) so call sites do not need to know which
  //    layer hydrated the user object.
  const jwtShopId = req.user?.shopId ?? req.user?.shop_id ?? null
  if (jwtShopId) {
    return { shopId: String(jwtShopId), source: 'jwt' }
  }

  // 2. X-Shop-Id header — Fastify lowercases header names.
  const headerShopId = req.headers?.['x-shop-id']
  if (headerShopId) {
    const trimmed = String(headerShopId).trim()
    if (trimmed) return { shopId: trimmed, source: 'header' }
  }

  // 3. :shopId route param.
  const pathShopId = req.params?.shopId ?? null
  if (pathShopId) {
    return { shopId: String(pathShopId), source: 'path' }
  }

  return { shopId: null, source: null }
}

/**
 * Fastify preHandler factory — derive and attach `request.shopId`.
 *
 * Must be used AFTER `fastify.authenticate` so `request.user` is populated.
 *
 * @param {object} [options]
 * @param {boolean} [options.requireShop=false] - If true, reject when no shop
 *   scope can be derived (e.g., a customer hitting a shop-scoped endpoint).
 * @returns {import('fastify').preHandlerHookHandler}
 */
export function requireShopScope(options = {}) {
  const requireShop = options.requireShop === true

  return async function shopScopePreHandler(request, reply) {
    const user = request.user
    if (!user || !user.id) {
      return reply.code(401).send({
        success: false,
        message: 'Unauthorized — authentication required',
        code: ERROR_CODES.UNAUTHORIZED,
      })
    }

    const tokenShopId = user.shopId || user.shop_id || null

    // ── 1. Shop-scoped staff JWT ────────────────────────────────
    if (tokenShopId) {
      const active = await isStaffActive(user.id, tokenShopId)
      if (!active) {
        logger.warn(
          {
            userId: user.id,
            shopId: tokenShopId,
            action: 'shop_scope_rejected_inactive_staff',
          },
          'Rejected request — staff record inactive'
        )
        return reply.code(403).send({
          success: false,
          message: 'Shop assignment is no longer active',
          code: ERROR_CODES.STAFF_INACTIVE,
        })
      }
      request.shopId = tokenShopId
      return
    }

    // ── 2. HQ_User with optional X-Shop-Id ──────────────────────
    // Accept any user carrying an HQ_Role (legacy `role === 'ADMIN'` or any
    // value of `platform_role` listed in HQ_ROLES) per design §4.4 and
    // R17 AC#4. The X-Shop-Id UUID-shape and is-active-shop checks are
    // preserved verbatim from the previous implementation.
    if (isHqUser(user)) {
      const headerShopId = request.headers['x-shop-id']
      if (headerShopId) {
        const candidate = String(headerShopId).trim()
        if (!UUID_REGEX.test(candidate)) {
          return reply.code(400).send({
            success: false,
            message: 'X-Shop-Id header must be a valid UUID',
            code: ERROR_CODES.INVALID_SHOP_ID,
          })
        }
        const exists = await isShopActive(candidate)
        if (!exists) {
          return reply.code(400).send({
            success: false,
            message: 'X-Shop-Id refers to an unknown or inactive shop',
            code: ERROR_CODES.INVALID_SHOP_ID,
          })
        }
        request.shopId = candidate
        return
      }
      request.shopId = null
      return
    }

    // ── 3. Non-staff non-HQ (customers, riders) ─────────────────
    request.shopId = null

    if (requireShop) {
      return reply.code(403).send({
        success: false,
        message: 'Forbidden — shop-scoped access required',
        code: ERROR_CODES.SHOP_SCOPE_REQUIRED,
      })
    }
  }
}

/**
 * Pure decision function for cross-shop access (R17 AC#5).
 *
 * Inputs are intentionally primitive (no Fastify request/reply) so the
 * decision can be unit- and property-tested in isolation, and reused from
 * both Fastify preHandlers and service layer guards.
 *
 * On denial, the returned `code` is `'CROSS_SHOP_ACCESS_DENIED'` per
 * R17 AC#5; the legacy alias `ERROR_CODES.SHOP_SCOPE_MISMATCH` resolves
 * to the same string so older callers continue to work unchanged.
 *
 * @param {object} args
 * @param {string} args.role - JWT user role (e.g., 'ADMIN', 'CUSTOMER',
 *   'RIDER'). Shop staff carry their platform role here, not their shop role.
 * @param {string|null|undefined} args.jwtShopId - shop_id derived from the JWT
 *   (or null for HQ_Users / non-staff).
 * @param {string|null|undefined} args.resourceShopId - shop_id of the target
 *   resource being accessed (e.g., shop_products.shop_id, orders.shop_id).
 * @returns {{allowed: true} | {allowed: false, status: number, code: string, message: string}}
 */
export function assertShopMatch({ role, jwtShopId, resourceShopId }) {
  // HQ_Users (legacy ADMIN role) bypass shop-scope checks entirely.
  if (role === ROLES.ADMIN) {
    return { allowed: true }
  }

  // Resource shop_id must be present for the comparison to be meaningful.
  // A missing resource shop_id is treated as a configuration error and
  // rejected the same way as a mismatch — fail closed.
  if (!resourceShopId) {
    return {
      allowed: false,
      status: 403,
      code: ERROR_CODES.CROSS_SHOP_ACCESS_DENIED,
      message: 'Forbidden — resource is not scoped to your shop',
    }
  }

  // Non-admin caller without a shop-scoped JWT cannot access shop resources.
  if (!jwtShopId) {
    return {
      allowed: false,
      status: 403,
      code: ERROR_CODES.CROSS_SHOP_ACCESS_DENIED,
      message: 'Forbidden — resource is not scoped to your shop',
    }
  }

  if (jwtShopId !== resourceShopId) {
    return {
      allowed: false,
      status: 403,
      code: ERROR_CODES.CROSS_SHOP_ACCESS_DENIED,
      message: 'Forbidden — resource is not scoped to your shop',
    }
  }

  return { allowed: true }
}

/**
 * Fastify preHandler factory enforcing cross-shop access (R17 AC#5).
 *
 * Must run AFTER `requireShopScope` so `request.shopId` is populated for
 * staff JWTs and `request.user.role` is available.
 *
 * On denial: emits a fire-and-forget `cross_shop_access_blocked` audit row
 * (per R17 AC#5 and design §4.4) in addition to the existing structured
 * `logger.warn`, then sends 403 CROSS_SHOP_ACCESS_DENIED.
 *
 * @param {(request: import('fastify').FastifyRequest) => (string|null|undefined|Promise<string|null|undefined>)} getResourceShopId
 *   Callback that returns the target resource's shop_id, typically loaded
 *   from the route param's owning row. Must be a parameterized query in the
 *   caller — this middleware does not execute SQL itself.
 * @returns {import('fastify').preHandlerHookHandler}
 */
export function requireShopMatch(getResourceShopId) {
  if (typeof getResourceShopId !== 'function') {
    throw new TypeError(
      'requireShopMatch(getResourceShopId): callback must be a function'
    )
  }

  return async function shopMatchPreHandler(request, reply) {
    const user = request.user
    if (!user || !user.id) {
      return reply.code(401).send({
        success: false,
        message: 'Unauthorized — authentication required',
        code: ERROR_CODES.UNAUTHORIZED,
      })
    }

    const resourceShopId = await getResourceShopId(request)
    const jwtShopId =
      request.shopId ?? user.shopId ?? user.shop_id ?? null

    const decision = assertShopMatch({
      role: user.role,
      jwtShopId,
      resourceShopId,
    })

    if (!decision.allowed) {
      logger.warn(
        {
          userId: user.id,
          jwtShopId: request.shopId ?? null,
          resourceShopId: resourceShopId ?? null,
          action: 'shop_scope_mismatch_rejected',
        },
        'Rejected request — JWT shop_id does not match resource shop_id'
      )

      // R17 AC#5 / design §4.4: fire-and-forget audit row alongside the
      // existing logger.warn. Synchronous validation errors from emitAudit
      // are swallowed so the security path stays open and the 403 always
      // returns; the DB INSERT itself is non-blocking via setImmediate.
      try {
        emitAudit('cross_shop_access_blocked', {
          actor_user_id: user.id ?? null,
          actor_role:
            user.platform_role ?? user.shopRole ?? user.role ?? null,
          actor_shop_id: request.shopId ?? null,
          target_type: 'route',
          target_id: null,
          before: null,
          after: {
            method: request.method,
            path: request.routeOptions?.url ?? request.url,
            attempted_shop_id: resourceShopId ?? null,
            jwt_shop_id: jwtShopId,
          },
          ip_address: request.ip ?? null,
          user_agent: request.headers?.['user-agent'] ?? null,
        })
      } catch (err) {
        logger.error(
          { err, userId: user.id },
          'audit emit failed for cross_shop_access_blocked'
        )
      }

      return reply.code(decision.status).send({
        success: false,
        message: decision.message,
        code: decision.code,
      })
    }
  }
}
