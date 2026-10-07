/**
 * Socket.IO Authentication & Authorization Infrastructure for Meet Commerce Platform
 * Source of truth: Blueprint §05.1, §09.2, Phase 1F
 *
 * ARCHITECTURAL CONSTRAINTS:
 *   1. Depends ONLY on core layers: database query/pool, logger, env, jwt, session, roles, permissions, errors.
 *   2. MUST NOT import or depend directly on domain modules (orders, products, inventory,
 *      payments, notifications, vendors, warehouses, workers).
 *
 * @module socket/auth
 */

import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { query } from '../config/database.js'
import { logger } from '../config/logger.js'
import { ROLE_PERMISSIONS } from '../utils/permissions.js'
import { isSessionActive } from '../utils/session.js'

/**
 * Socket.IO Handshake Authentication Middleware
 * Reuses core session/auth checks: JWT verification, blocked user check, session version check, device session revocation check.
 *
 * Populates socket context:
 *   socket.user
 *   socket.userId
 *   socket.roles
 *   socket.permissions
 *   socket.session
 *   socket.auth
 *
 * @param {import('socket.io').Socket} socket
 * @param {(err?: Error) => void} next
 */
export async function socketAuthMiddleware(socket, next) {
  const authHeader = socket.handshake.headers?.authorization
  const bearerToken = authHeader ? authHeader.replace(/^Bearer\s+/i, '') : null
  const token = socket.handshake.auth?.token || bearerToken

  if (!token) {
    logger.warn({ socketId: socket.id }, 'Socket auth rejected — missing token')
    return next(new Error('Authentication required'))
  }

  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET)
    const userId = decoded.id

    if (!userId) {
      return next(new Error('Invalid token payload'))
    }

    // 1. Single DB query checking blocked account & session_version
    const { rows } = await query(
      'SELECT is_blocked, session_version, platform_role FROM users WHERE id = $1 LIMIT 1',
      [userId]
    )

    if (rows.length === 0) {
      return next(new Error('User not found'))
    }

    const userRow = rows[0]

    // Blocked Account Check
    if (userRow.is_blocked) {
      logger.warn({ userId, socketId: socket.id }, 'Socket connection rejected — account is blocked')
      return next(new Error('ACCOUNT_BLOCKED'))
    }

    // Session Version Mismatch Check
    const jwtSessionVersion = decoded.session_version
    if (jwtSessionVersion !== undefined && jwtSessionVersion !== null) {
      if (userRow.session_version !== undefined && userRow.session_version !== null && userRow.session_version !== jwtSessionVersion) {
        logger.warn({ userId, socketId: socket.id }, 'Socket connection rejected — session version mismatch')
        return next(new Error('SESSION_INVALID'))
      }
    } else if (env.STRICT_SESSION_VERSION_CHECK) {
      return next(new Error('SESSION_INVALID'))
    }

    // Revoked Device Session Check
    const sessionId = decoded.sessionId || decoded.session_id || null
    if (sessionId) {
      const active = await isSessionActive(sessionId)
      if (!active) {
        logger.warn({ userId, sessionId, socketId: socket.id }, 'Socket connection rejected — revoked device session')
        return next(new Error('SESSION_INVALID'))
      }
    }

    // Context Population
    const role = decoded.platform_role || decoded.role || userRow.platform_role || 'CUSTOMER'
    const permissionsSet = ROLE_PERMISSIONS[role] ? Array.from(ROLE_PERMISSIONS[role]) : []

    socket.user = decoded
    socket.userId = userId
    socket.roles = [role]
    socket.permissions = permissionsSet
    socket.session = {
      id: sessionId,
      version: jwtSessionVersion || userRow.session_version || 1,
    }
    socket.auth = {
      authenticated: true,
      method: 'JWT',
      userId,
      role,
      scopes: {
        vendorId: decoded.vendorId || decoded.shopId || null,
        warehouseId: decoded.warehouseId || null,
      },
    }

    logger.debug({ userId, socketId: socket.id, role }, 'Socket handshake authenticated successfully')
    next()
  } catch (err) {
    logger.warn({ err: err.message, socketId: socket.id }, 'Socket auth failed')
    return next(new Error('Invalid or expired token'))
  }
}

/**
 * Authorization Helper: Assert socket is authenticated
 * @param {import('socket.io').Socket} socket
 * @returns {boolean}
 */
export function assertSocketAuth(socket) {
  if (!socket.auth?.authenticated || !socket.userId) {
    throw new Error('Unauthorized — socket is not authenticated')
  }
  return true
}

/**
 * Authorization Helper: Assert socket user holds required role
 * @param {import('socket.io').Socket} socket
 * @param {string[]} allowedRoles
 * @returns {boolean}
 */
export function assertSocketRole(socket, allowedRoles) {
  assertSocketAuth(socket)
  const role = socket.auth.role || socket.roles?.[0]
  if (!allowedRoles.includes(role)) {
    throw new Error('Forbidden — insufficient role permissions')
  }
  return true
}

/**
 * Authorization Helper: Assert socket user holds required permission
 * @param {import('socket.io').Socket} socket
 * @param {string} requiredPermission
 * @returns {boolean}
 */
export function assertSocketPermission(socket, requiredPermission) {
  assertSocketAuth(socket)
  const userPerms = socket.permissions || []
  if (!userPerms.includes(requiredPermission)) {
    throw new Error(`Forbidden — requires '${requiredPermission}' permission`)
  }
  return true
}
