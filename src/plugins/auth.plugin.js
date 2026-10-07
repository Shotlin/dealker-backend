import fp from 'fastify-plugin'
import fjwt from '@fastify/jwt'
import cookie from '@fastify/cookie'
import { env } from '../config/env.js'
import { query } from '../config/database.js'
import { ERROR_CODES, HTTP_STATUS } from '../constants/errors.js'
import { logger } from '../config/logger.js'
import { ROLE_PERMISSIONS } from '../utils/permissions.js'
import { isSessionActive } from '../utils/session.js'

/**
 * Auth plugin — registers JWT + Cookie support
 * Decorates fastify with `authenticate` and `authorize` preHandlers
 */
async function authPlugin(fastify) {
  // Cookie support (for httpOnly refresh token cookie)
  await fastify.register(cookie, {
    secret: env.COOKIE_SECRET || env.JWT_ACCESS_SECRET,
    parseOptions: {},
  })

  // JWT support (only access token verification via this plugin)
  await fastify.register(fjwt, {
    secret: env.JWT_ACCESS_SECRET,
    sign: {
      expiresIn: env.JWT_ACCESS_EXPIRY,
    },
    cookie: {
      cookieName: 'accessToken',
      signed: false,
    },
  })

  /**
   * preHandler: Verify JWT from Authorization header or cookie.
   */
  fastify.decorate('authenticate', async function (request, reply) {
    try {
      await request.jwtVerify()

      const userId = request.user.id
      if (!userId) {
        return reply.code(401).send({
          success: false,
          message: 'Unauthorized — invalid token payload',
          code: ERROR_CODES.UNAUTHORIZED,
        })
      }

      // Single PK lookup fetches both gates in one round-trip.
      const { rows } = await query(
        'SELECT is_blocked, session_version, platform_role FROM users WHERE id = $1 LIMIT 1',
        [userId]
      )

      // Daily-active-customer stamp — fire-and-forget
      try {
        query(
          `UPDATE users SET last_active_at = NOW()
           WHERE id = $1 AND (last_active_at IS NULL OR last_active_at < NOW() - INTERVAL '10 minutes')`,
          [userId]
        ).catch((err) => {
          logger.warn({ err: err.message, userId }, 'last_active_at stamp failed (non-critical)')
        })
      } catch (err) {
        logger.warn({ err: err.message, userId }, 'last_active_at stamp failed (non-critical)')
      }

      // ── 1. Blocked-account gate ─────────────────────────────────
      if (rows.length > 0 && rows[0].is_blocked) {
        return reply.code(403).send({
          success: false,
          message: 'Account is blocked. Contact support.',
          code: 'ACCOUNT_BLOCKED',
        })
      }

      // ── 2. session_version gate ────────────────────────────────
      const jwtSessionVersion = request.user.session_version
      if (jwtSessionVersion !== undefined && jwtSessionVersion !== null) {
        const rowSessionVersion = rows[0]?.session_version
        if (rowSessionVersion !== undefined && rowSessionVersion !== null && rowSessionVersion !== jwtSessionVersion) {
          return reply.code(401).send({
            success: false,
            message: 'Session is no longer valid',
            code: ERROR_CODES.SESSION_INVALID,
          })
        }
      } else if (env.STRICT_SESSION_VERSION_CHECK) {
        return reply.code(401).send({
          success: false,
          message: 'Session is no longer valid',
          code: ERROR_CODES.SESSION_INVALID,
        })
      }

      // ── 3. Device session revocation gate ──────────────────────
      const sessionId = request.user.sessionId || request.user.session_id || null
      if (sessionId) {
        const active = await isSessionActive(sessionId)
        if (!active) {
          return reply.code(401).send({
            success: false,
            message: 'Session has been revoked or expired',
            code: ERROR_CODES.SESSION_INVALID,
          })
        }
      }

      // ── 4. Request Context Attachment (Blueprint §05.1) ────────
      const role = request.user.platform_role || request.user.role || rows[0]?.platform_role || 'CUSTOMER'
      const permissionsSet = ROLE_PERMISSIONS[role] ? Array.from(ROLE_PERMISSIONS[role]) : []

      request.userId = userId
      request.roles = [role]
      request.permissions = permissionsSet
      request.session = {
        id: sessionId,
        version: jwtSessionVersion || rows[0]?.session_version || 1,
      }
      request.auth = {
        authenticated: true,
        method: 'JWT',
        userId,
        role,
        scopes: {
          vendorId: request.vendorId || request.user.vendorId || request.user.shopId || null,
          warehouseId: request.warehouseId || request.user.warehouseId || null,
        },
      }
    } catch (err) {
      logger.warn(
        { err: err.message, name: err.name, path: request.url },
        'Authenticate preHandler rejected request'
      )
      reply.code(401).send({
        success: false,
        message: 'Unauthorized — invalid or expired token',
        code: 'UNAUTHORIZED',
      })
    }
  })

  /**
   * preHandler factory: Check if user has one of the allowed roles
   */
  fastify.decorate('authorize', function (allowedRoles) {
    return async function (request, reply) {
      const role = request.user?.role || request.user?.platform_role
      if (!allowedRoles.includes(role)) {
        reply.code(403).send({
          success: false,
          message: 'Forbidden — insufficient permissions',
          code: 'FORBIDDEN',
        })
      }
    }
  })

  /**
   * preHandler: Check if user has ADMIN role
   */
  fastify.decorate('requireAdmin', async function (request, reply) {
    const role = request.user?.role || request.user?.platform_role
    if (role !== 'ADMIN' && role !== 'SUPER_ADMIN') {
      reply.code(403).send({
        success: false,
        message: 'Forbidden — admin access required',
        code: 'FORBIDDEN',
      })
    }
  })

  /**
   * preHandler factory: Check if user has a specific permission via their role
   */
  fastify.decorate('requirePermission', function (permission) {
    return async function (request, reply) {
      const userPerms = request.permissions || []
      if (!userPerms.includes(permission)) {
        reply.code(403).send({
          success: false,
          message: `Forbidden — requires '${permission}' permission`,
          code: 'PERMISSION_DENIED',
        })
      }
    }
  })
}

export default fp(authPlugin, { name: 'auth' })
