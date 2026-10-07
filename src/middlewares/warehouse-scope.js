/**
 * Warehouse Scope Middleware — Enforces resource isolation for Warehouse operations
 * Source of truth: Blueprint §04.4, §05.1
 *
 * ARCHITECTURAL CONSTRAINTS:
 *   1. Depends ONLY on core layers: auth payload (request.user), database query/pool, logger,
 *      cache utility, role constants, error constants.
 *   2. MUST NOT import or depend directly on domain modules (orders, products, inventory,
 *      payments, notifications, sockets, workers).
 *
 * Resolution Rules (`requireWarehouseScope`):
 *   1. Warehouse-scoped JWT (request.user.warehouseId present)
 *      → validates active warehouse assignment
 *      → attaches request.warehouseId = JWT warehouseId
 *   2. Platform / Admin User (SUPER_ADMIN, ADMIN, HQ_MANAGER)
 *      → if X-Warehouse-Id header present: validates UUID shape and active warehouse status
 *      → attaches request.warehouseId = header value
 *      → otherwise allows with request.warehouseId = null (platform-wide ops)
 *   3. Non-warehouse non-admin users
 *      → attaches request.warehouseId = null
 *      → if options.requireWarehouse === true, rejects 403 CROSS_SCOPE_ACCESS_DENIED
 *
 * @module middlewares/warehouse-scope
 */

import { query } from '../config/database.js'
import { logger } from '../config/logger.js'
import { cacheDel, cacheGet, cacheSet } from '../utils/cache.js'
import { ROLES, ROLE_GROUPS } from '../constants/roles.js'
import { ERROR_CODES, HTTP_STATUS } from '../constants/errors.js'

const WAREHOUSE_ACTIVE_CACHE_PREFIX = 'meet-commerce:warehouse-active:v1:'
const WAREHOUSE_ACTIVE_TTL_SECONDS = 300
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
 * Compute cache key for warehouse active state
 * @param {string} warehouseId
 * @returns {string}
 */
export function warehouseCacheKey(warehouseId) {
  return `${WAREHOUSE_ACTIVE_CACHE_PREFIX}${warehouseId}`
}

/**
 * Invalidate warehouse active cache entry
 * @param {string} warehouseId
 */
export async function invalidateWarehouseCache(warehouseId) {
  if (!warehouseId) return
  await cacheDel(warehouseCacheKey(warehouseId))
}

/**
 * Validate active warehouse status via cache-through DB check
 * @param {string} warehouseId
 * @returns {Promise<boolean>}
 */
export async function isWarehouseActive(warehouseId) {
  const cacheKey = warehouseCacheKey(warehouseId)
  const cached = await cacheGet(cacheKey)
  if (cached !== null && cached !== undefined) {
    return cached === true
  }

  const { rows } = await query(
    `SELECT id FROM warehouses
      WHERE id = $1 AND is_active = true
      LIMIT 1`,
    [warehouseId]
  ).catch(async () => {
    // Fallback query for legacy compatibility before migration 096
    return await query(
      `SELECT id FROM shops
        WHERE id = $1 AND is_active = true AND deleted_at IS NULL
        LIMIT 1`,
      [warehouseId]
    )
  })

  const active = rows.length > 0
  await cacheSet(cacheKey, active, WAREHOUSE_ACTIVE_TTL_SECONDS)
  return active
}

/**
 * Pure helper extracting warehouseId from JWT payload, header, or route params
 * Priority: 1. JWT warehouseId -> 2. X-Warehouse-Id header -> 3. :warehouseId param
 * @param {object} req Fastify request object
 * @returns {{ warehouseId: string | null, source: 'jwt' | 'header' | 'path' | null }}
 */
export function extractWarehouseId(req) {
  if (!req || typeof req !== 'object') {
    return { warehouseId: null, source: null }
  }

  // 1. JWT claims
  const jwtWarehouseId = req.user?.warehouseId ?? req.user?.warehouse_id ?? null
  if (jwtWarehouseId) {
    return { warehouseId: String(jwtWarehouseId), source: 'jwt' }
  }

  // 2. X-Warehouse-Id header
  const headerWarehouseId = req.headers?.['x-warehouse-id']
  if (headerWarehouseId) {
    const trimmed = String(headerWarehouseId).trim()
    if (trimmed) return { warehouseId: trimmed, source: 'header' }
  }

  // 3. :warehouseId route param
  const pathWarehouseId = req.params?.warehouseId ?? null
  if (pathWarehouseId) {
    return { warehouseId: String(pathWarehouseId), source: 'path' }
  }

  return { warehouseId: null, source: null }
}

/**
 * Fastify preHandler middleware enforcing warehouse scope isolation
 * @param {object} [options]
 * @param {boolean} [options.requireWarehouse=false] Rejects non-warehouse requests with 403
 * @returns {import('fastify').preHandlerHookHandler}
 */
export function requireWarehouseScope(options = {}) {
  const requireWarehouse = options.requireWarehouse === true

  return async function warehouseScopePreHandler(request, reply) {
    const user = request.user
    if (!user || !user.id) {
      return reply.status(HTTP_STATUS[ERROR_CODES.UNAUTHORIZED]).send({
        success: false,
        code: ERROR_CODES.UNAUTHORIZED,
        message: 'Unauthorized — authentication required',
      })
    }

    const { warehouseId: candidateWarehouseId, source } = extractWarehouseId(request)

    // 1. Warehouse-scoped JWT caller
    if (source === 'jwt' && candidateWarehouseId) {
      const active = await isWarehouseActive(candidateWarehouseId)
      if (!active) {
        logger.warn(
          { userId: user.id, warehouseId: candidateWarehouseId, action: 'warehouse_scope_rejected_inactive' },
          'Rejected request — warehouse inactive or missing'
        )
        return reply.status(403).send({
          success: false,
          code: ERROR_CODES.CROSS_SHOP_ACCESS_DENIED,
          message: 'Warehouse assignment is inactive or invalid',
        })
      }
      request.warehouseId = candidateWarehouseId
      return
    }

    // 2. Platform / Admin User
    if (isPlatformUser(user)) {
      if (candidateWarehouseId && (source === 'header' || source === 'path')) {
        if (!UUID_REGEX.test(candidateWarehouseId)) {
          return reply.status(400).send({
            success: false,
            code: 'INVALID_WAREHOUSE_ID',
            message: 'Warehouse ID must be a valid UUID',
          })
        }
        const exists = await isWarehouseActive(candidateWarehouseId)
        if (!exists) {
          return reply.status(404).send({
            success: false,
            code: 'WAREHOUSE_NOT_FOUND',
            message: 'Target warehouse refers to an unknown or inactive warehouse',
          })
        }
        request.warehouseId = candidateWarehouseId
        return
      }
      request.warehouseId = null
      return
    }

    // 3. Non-warehouse non-admin user
    request.warehouseId = null
    if (requireWarehouse) {
      return reply.status(403).send({
        success: false,
        code: ERROR_CODES.CROSS_SHOP_ACCESS_DENIED,
        message: 'Forbidden — warehouse-scoped access required',
      })
    }
  }
}

/**
 * Assert warehouse scope match between caller context and resource target
 * @param {object} args
 * @param {string} args.role
 * @param {string|null} args.callerWarehouseId
 * @param {string|null} args.resourceWarehouseId
 * @returns {{ allowed: boolean, status?: number, code?: string, message?: string }}
 */
export function assertWarehouseMatch({ role, callerWarehouseId, resourceWarehouseId }) {
  if (role === ROLES.SUPER_ADMIN || role === ROLES.ADMIN) {
    return { allowed: true }
  }

  if (!resourceWarehouseId || !callerWarehouseId || callerWarehouseId !== resourceWarehouseId) {
    return {
      allowed: false,
      status: 403,
      code: ERROR_CODES.CROSS_SHOP_ACCESS_DENIED,
      message: 'Forbidden — resource is not scoped to your warehouse',
    }
  }

  return { allowed: true }
}
