/**
 * Vendor Scope Middleware — Enforces resource isolation for Vendor domain entities
 * Source of truth: Blueprint §04.4, §05.1
 *
 * ARCHITECTURAL CONSTRAINTS:
 *   1. Depends ONLY on core layers: auth payload (request.user), database query/pool, logger,
 *      cache utility, role constants, error constants.
 *   2. MUST NOT import or depend directly on domain modules (orders, products, inventory,
 *      payments, notifications, sockets, workers).
 *
 * Resolution Rules (`requireVendorScope`):
 *   1. Vendor-scoped JWT (request.user.vendorId present)
 *      → validates active vendor staff membership (cache-through, TTL 300s)
 *      → attaches request.vendorId = JWT vendorId
 *   2. Platform / Admin User (SUPER_ADMIN, ADMIN, HQ_MANAGER)
 *      → if X-Vendor-Id header present: validates UUID shape and active vendor status
 *      → attaches request.vendorId = header value
 *      → otherwise allows with request.vendorId = null (platform-wide ops)
 *   3. Vendor staff user without JWT vendor claims (e.g. OTP-login vendor app)
 *      → resolves active vendor_users memberships for the user
 *      → exactly one membership: attaches request.vendorId = that vendor
 *      → multiple memberships: X-Vendor-Id header / :vendorId param must select
 *        one of them, otherwise 409 VENDOR_SELECTION_REQUIRED
 *   4. Non-vendor non-admin users
 *      → attaches request.vendorId = null
 *      → if options.requireVendor === true, rejects 403 CROSS_SCOPE_ACCESS_DENIED
 *
 * @module middlewares/vendor-scope
 */

import { query } from '../config/database.js'
import { logger } from '../config/logger.js'
import { cacheDel, cacheGet, cacheSet } from '../utils/cache.js'
import { ROLES, ROLE_GROUPS } from '../constants/roles.js'
import { ERROR_CODES, HTTP_STATUS } from '../constants/errors.js'

const VENDOR_STAFF_ACTIVE_CACHE_PREFIX = 'meet-commerce:vendor-staff-active:v1:'
const VENDOR_STAFF_ACTIVE_TTL_SECONDS = 300
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Check if user holds a platform/admin role
 * @param {object} user
 * @returns {boolean}
 */
export function isPlatformUser(user) {
  if (!user) return false
  if (user.role === ROLES.SUPER_ADMIN || user.role === ROLES.ADMIN) return true
  if (user.platform_role && ROLE_GROUPS.PLATFORM.includes(user.platform_role)) return true
  return false
}

/**
 * Compute cache key for user-vendor active membership
 * @param {string} userId
 * @param {string} vendorId
 * @returns {string}
 */
export function vendorStaffCacheKey(userId, vendorId) {
  return `${VENDOR_STAFF_ACTIVE_CACHE_PREFIX}${userId}:${vendorId}`
}

/**
 * Invalidate staff active cache entry
 * @param {string} userId
 * @param {string} vendorId
 */
export async function invalidateVendorStaffCache(userId, vendorId) {
  if (!userId || !vendorId) return
  await cacheDel(vendorStaffCacheKey(userId, vendorId))
}

/**
 * Validate active vendor staff membership via cache-through DB check
 * @param {string} userId
 * @param {string} vendorId
 * @returns {Promise<boolean>}
 */
export async function isVendorStaffActive(userId, vendorId) {
  const cacheKey = vendorStaffCacheKey(userId, vendorId)
  const cached = await cacheGet(cacheKey)
  if (cached !== null && cached !== undefined) {
    return cached === true
  }

  // Active check against vendor_users (or legacy shops table if vendor_users fallback required)
  const { rows } = await query(
    `SELECT vu.id
       FROM vendor_users vu
       JOIN vendors v ON v.id = vu.vendor_id
      WHERE vu.user_id = $1
        AND vu.vendor_id = $2
        AND vu.is_active = true
        AND vu.deleted_at IS NULL
        AND v.is_active = true
        AND v.deleted_at IS NULL
      LIMIT 1`,
    [userId, vendorId]
  ).catch(async () => {
    // Fallback query for legacy compatibility before migration 095
    return await query(
      `SELECT id FROM shops
        WHERE id = $1 AND is_active = true AND deleted_at IS NULL
        LIMIT 1`,
      [vendorId]
    )
  })

  const active = rows.length > 0
  await cacheSet(cacheKey, active, VENDOR_STAFF_ACTIVE_TTL_SECONDS)
  return active
}

/**
 * Validate that vendor exists and is active
 * @param {string} vendorId
 * @returns {Promise<boolean>}
 */
export async function isVendorActive(vendorId) {
  const { rows } = await query(
    `SELECT id FROM vendors
      WHERE id = $1 AND is_active = true AND deleted_at IS NULL
      LIMIT 1`,
    [vendorId]
  ).catch(async () => {
    // Fallback query for legacy shops table
    return await query(
      `SELECT id FROM shops
        WHERE id = $1 AND is_active = true AND deleted_at IS NULL
        LIMIT 1`,
      [vendorId]
    )
  })
  return rows.length > 0
}

/**
 * Pure helper extracting vendorId from JWT payload, header, or route params
 * Priority: 1. JWT vendorId -> 2. X-Vendor-Id header -> 3. :vendorId param
 * @param {object} req Fastify request object
 * @returns {{ vendorId: string | null, source: 'jwt' | 'header' | 'path' | null }}
 */
export function extractVendorId(req) {
  if (!req || typeof req !== 'object') {
    return { vendorId: null, source: null }
  }

  // 1. JWT claims
  const jwtVendorId = req.user?.vendorId ?? req.user?.vendor_id ?? req.user?.shopId ?? req.user?.shop_id ?? null
  if (jwtVendorId) {
    return { vendorId: String(jwtVendorId), source: 'jwt' }
  }

  // 2. X-Vendor-Id header (fallback X-Shop-Id)
  const headerVendorId = req.headers?.['x-vendor-id'] ?? req.headers?.['x-shop-id']
  if (headerVendorId) {
    const trimmed = String(headerVendorId).trim()
    if (trimmed) return { vendorId: trimmed, source: 'header' }
  }

  // 3. :vendorId or :shopId route param
  const pathVendorId = req.params?.vendorId ?? req.params?.shopId ?? null
  if (pathVendorId) {
    return { vendorId: String(pathVendorId), source: 'path' }
  }

  return { vendorId: null, source: null }
}

/**
 * Resolve the active vendor memberships of a user (no caching — used at most
 * once per request when the JWT carries no vendor claim)
 * @param {string} userId
 * @returns {Promise<string[]>} active vendor UUIDs
 */
export async function findActiveVendorMemberships(userId) {
  const { rows } = await query(
    `SELECT vu.vendor_id
       FROM vendor_users vu
       JOIN vendors v ON v.id = vu.vendor_id
      WHERE vu.user_id = $1
        AND vu.is_active = true
        AND vu.deleted_at IS NULL
        AND v.is_active = true
        AND v.deleted_at IS NULL
      ORDER BY vu.created_at`,
    [userId]
  )
  return rows.map((row) => row.vendor_id)
}

/**
 * Fastify preHandler middleware enforcing vendor scope isolation
 * @param {object} [options]
 * @param {boolean} [options.requireVendor=false] Rejects non-vendor requests with 403
 * @returns {import('fastify').preHandlerHookHandler}
 */
export function requireVendorScope(options = {}) {
  const requireVendor = options.requireVendor === true

  return async function vendorScopePreHandler(request, reply) {
    const user = request.user
    if (!user || !user.id) {
      return reply.status(HTTP_STATUS[ERROR_CODES.UNAUTHORIZED]).send({
        success: false,
        code: ERROR_CODES.UNAUTHORIZED,
        message: 'Unauthorized — authentication required',
      })
    }

    const { vendorId: candidateVendorId, source } = extractVendorId(request)

    // 1. Vendor-scoped JWT caller
    if (source === 'jwt' && candidateVendorId) {
      const active = await isVendorStaffActive(user.id, candidateVendorId)
      if (!active) {
        logger.warn(
          { userId: user.id, vendorId: candidateVendorId, action: 'vendor_scope_rejected_inactive_staff' },
          'Rejected request — vendor staff record inactive'
        )
        return reply.status(403).send({
          success: false,
          code: ERROR_CODES.STAFF_INACTIVE,
          message: 'Vendor assignment is no longer active',
        })
      }
      request.vendorId = candidateVendorId
      return
    }

    // 2. Platform / Admin User
    if (isPlatformUser(user)) {
      if (candidateVendorId && (source === 'header' || source === 'path')) {
        if (!UUID_REGEX.test(candidateVendorId)) {
          return reply.status(400).send({
            success: false,
            code: 'INVALID_VENDOR_ID',
            message: 'Vendor ID must be a valid UUID',
          })
        }
        const exists = await isVendorActive(candidateVendorId)
        if (!exists) {
          return reply.status(404).send({
            success: false,
            code: 'VENDOR_NOT_FOUND',
            message: 'Target vendor refers to an unknown or inactive vendor',
          })
        }
        request.vendorId = candidateVendorId
        return
      }
      request.vendorId = null
      return
    }

    // 3. Vendor staff user without JWT vendor claims — resolve memberships
    const memberships = await findActiveVendorMemberships(user.id)
    if (memberships.length === 1) {
      request.vendorId = memberships[0]
      return
    }
    if (memberships.length > 1) {
      if (candidateVendorId && memberships.includes(candidateVendorId)) {
        request.vendorId = candidateVendorId
        return
      }
      return reply.status(409).send({
        success: false,
        code: 'VENDOR_SELECTION_REQUIRED',
        message: 'This account belongs to multiple vendors — select a vendor context',
      })
    }

    // 4. Non-vendor non-admin user
    request.vendorId = null
    if (requireVendor) {
      return reply.status(403).send({
        success: false,
        code: ERROR_CODES.CROSS_SHOP_ACCESS_DENIED,
        message: 'Forbidden — vendor-scoped access required',
      })
    }
  }
}

/**
 * Assert vendor scope match between caller context and resource target
 * @param {object} args
 * @param {string} args.role
 * @param {string|null} args.callerVendorId
 * @param {string|null} args.resourceVendorId
 * @returns {{ allowed: boolean, status?: number, code?: string, message?: string }}
 */
export function assertVendorMatch({ role, callerVendorId, resourceVendorId }) {
  if (role === ROLES.SUPER_ADMIN || role === ROLES.ADMIN) {
    return { allowed: true }
  }

  if (!resourceVendorId || !callerVendorId || callerVendorId !== resourceVendorId) {
    return {
      allowed: false,
      status: 403,
      code: ERROR_CODES.CROSS_SHOP_ACCESS_DENIED,
      message: 'Forbidden — resource is not scoped to your vendor',
    }
  }

  return { allowed: true }
}
