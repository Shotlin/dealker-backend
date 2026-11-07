import fp from 'fastify-plugin'
import fjwt from '@fastify/jwt'
import cookie from '@fastify/cookie'
import { env } from '../config/env.js'
import { ERROR_CODES, HTTP_STATUS } from '../constants/errors.js'
import { logger } from '../config/logger.js'
import { ROLE_PERMISSIONS } from '../utils/permissions.js'
import { loadAuthContext, stampLastActive } from '../utils/auth-context.js'

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

      // ONE statement answers the blocked / session_version / device-session gates, and its answer is shared
      // for a few seconds (see utils/auth-context.js) — a 15-request screen open costs one lookup, not 45.
      const sessionId = request.user.sessionId || request.user.session_id || null
      const ctx = await loadAuthContext(userId, sessionId)
      const rows = ctx && ctx.found !== false ? [ctx] : [] // found === false only when the user row is missing

      // Daily-active-customer stamp — fire-and-forget, at most once per 10 min per user
      stampLastActive(userId)

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
      if (sessionId && !ctx?.session_active) {
        return reply.code(401).send({
          success: false,
          message: 'Session has been revoked or expired',
          code: ERROR_CODES.SESSION_INVALID,
        })
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
