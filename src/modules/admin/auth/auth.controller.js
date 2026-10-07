import { success, error } from '../../../utils/apiResponse.js'
import { ERROR_CODES, httpStatusFor } from '../../../constants/errors.js'
import { logger } from '../../../config/logger.js'

/**
 * AdminAuthController
 *
 * HTTP-layer adapter for the unified dashboard auth module
 * (`/api/v1/admin/auth/*`). Each handler:
 *
 *   1. Pulls the validated body / verified JWT claims.
 *   2. Calls the corresponding service method.
 *   3. Signs the returned `tokenPayload` with `reply.jwtSign(payload,
 *      { expiresIn: tokenExpiry })` — the route is the only layer
 *      that ever touches the JWT secret.
 *   4. Mirrors the token onto two cookies (httpOnly `accessToken` for
 *      API auth, non-httpOnly `auth_session` marker for the Next.js
 *      middleware) with `maxAge` derived from the service's expiry.
 *   5. Returns a sanitized response that NEVER echoes `password_hash`
 *      or the submitted password (R18.11, R18.16).
 *
 * Errors thrown from the service are shaped `{ statusCode, code, message }`.
 * `mapError` maps the canonical `code` to its HTTP status via
 * `httpStatusFor()`, falling back to `err.statusCode` when the code is
 * missing (legacy throws). All other exceptions fall through to a
 * generic 500 INTERNAL_ERROR with the original error left in the
 * structured log only — never echoed in the response body.
 *
 * Design: §5.1, §5.2, §5.3, §5.5
 */

/** Cookie max-age (seconds) for a final 24-hour shop-scoped or HQ JWT. */
const COOKIE_MAXAGE_24H = 24 * 60 * 60 // 86,400 s

/** Cookie max-age (seconds) for the 5-minute STORE_PENDING interim JWT. */
const COOKIE_MAXAGE_5M = 5 * 60 // 300 s

/** Frozen base options shared by both cookies for consistency. */
const COOKIE_BASE = Object.freeze({
  path: '/',
  sameSite: 'lax',
})

/**
 * Translate a service expiry string ('24h' / '5m') into the matching
 * cookie maxAge in seconds. Anything unexpected falls back to the
 * 24-hour default — service methods only ever return one of the two
 * values, so the fallback is purely defensive.
 *
 * @param {string} tokenExpiry
 * @returns {number} cookie maxAge in seconds
 */
function cookieMaxAgeFor(tokenExpiry) {
  if (tokenExpiry === '5m') return COOKIE_MAXAGE_5M
  return COOKIE_MAXAGE_24H
}

/**
 * Set the `accessToken` (httpOnly) and `auth_session` (marker) cookies
 * on the reply. Splitting them is intentional:
 *
 *   - `accessToken` is httpOnly so JS in the browser can never read it
 *     (XSS mitigation per project-standards.md security checklist).
 *   - `auth_session` is non-httpOnly so the Next.js middleware can
 *     gate dashboard routes without a server round-trip.
 *
 * `secure: true` is enabled in production only so local HTTP dev
 * keeps working.
 *
 * @param {import('fastify').FastifyReply} reply
 * @param {string} token  signed JWT
 * @param {number} maxAge maxAge in seconds
 */
function setAuthCookies(reply, token, maxAge) {
  const secure = process.env.NODE_ENV === 'production'
  reply.setCookie('accessToken', token, {
    ...COOKIE_BASE,
    httpOnly: true,
    secure,
    maxAge,
  })
  reply.setCookie('auth_session', '1', {
    ...COOKIE_BASE,
    httpOnly: false,
    secure,
    maxAge,
  })
}

/**
 * Map a thrown service error to a Fastify reply.
 *
 * Service throws are shaped `{ statusCode, code, message }`. The
 * canonical mapping is `httpStatusFor(code)` (per design §16); if the
 * code is missing we fall back to the throw's `statusCode`, then 500.
 *
 * The original error message is logged at `warn` (with no `password`
 * / `password_hash` fields — those never appear on the throw path)
 * so operators can see what happened without leaking secrets to the
 * client.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @param {{ statusCode?: number, code?: string, message?: string } | Error} err
 * @param {string} action  short string for the log context
 */
function mapError(request, reply, err, action) {
  const code = err && err.code ? err.code : ERROR_CODES.INTERNAL_ERROR
  const status = err && err.code
    ? httpStatusFor(err.code)
    : (err && err.statusCode) || 500
  const message = (err && err.message) || 'Internal server error'

  // Structured log without echoing any password value.
  request.log.warn(
    {
      action,
      code,
      status,
      userId: request.user ? request.user.id : null,
      err: err && err.message,
    },
    `auth.${action} failed`,
  )

  return reply.code(status).send(error(message, code))
}

export class AdminAuthController {
  constructor(service) {
    this.service = service
  }

  /**
   * `POST /api/v1/admin/auth/login` (PUBLIC).
   *
   * Body validated by `adminLoginSchema` (Zod-style JSON Schema).
   * Calls `service.login` which returns the canonical
   * `{ tokenPayload, tokenExpiry, user, shops, isSuperAdmin,
   * requiresShopSelection }` shape per design §5.1. Signs the JWT
   * with the service-supplied expiry, sets cookies, and returns the
   * response body — never including `password_hash` or the submitted
   * password (R18.11).
   */
  async login(request, reply) {
    const { email, password } = request.body
    const ip = request.ip
    const userAgent = request.headers['user-agent'] || null

    try {
      const result = await this.service.login(
        { email, password },
        ip,
        userAgent,
      )

      const accessToken = await reply.jwtSign(result.tokenPayload, {
        expiresIn: result.tokenExpiry,
      })

      setAuthCookies(reply, accessToken, cookieMaxAgeFor(result.tokenExpiry))

      // Whitelist response fields. The service may include legacy
      // back-compat keys (`id`, `phone`, `role`) on the result object
      // — we deliberately drop them here to keep the response surface
      // aligned with design §5.1: { accessToken, user, shops,
      // isSuperAdmin, requiresShopSelection }. password_hash never
      // existed on `result.user` (sanitizeUser strips it), so this is
      // a defense-in-depth shape rather than an active filter.
      return reply.code(200).send(
        success(
          {
            accessToken,
            user: result.user,
            shops: result.shops,
            isSuperAdmin: result.isSuperAdmin,
            requiresShopSelection: result.requiresShopSelection,
          },
          'Login successful',
        ),
      )
    } catch (err) {
      return mapError(request, reply, err, 'login')
    }
  }

  /**
   * `POST /api/v1/admin/auth/select-shop` (AUTH required).
   *
   * Caller must hold a STORE_PENDING interim token (multi-shop login
   * branch). Body validated by `selectShopSchema`
   * (`{ shop_id: uuid }`).
   *
   * The interim JWT carries `role: 'STORE_PENDING'`, but the FINAL
   * shop-scoped JWT must carry the user's underlying `users.role`
   * (design §5.6). We re-read `users.role` via
   * `service.repository.findUserById(userId)` — the lookup is a
   * single-row PK SELECT and excludes `password_hash` by construction.
   *
   * On success, mints a 24-hour shop-scoped JWT, overwrites the
   * interim cookies, and returns `{ accessToken, shop, permissions }`.
   */
  async selectShop(request, reply) {
    const ip = request.ip
    const userAgent = request.headers['user-agent'] || null

    try {
      // Defense-in-depth: only STORE_PENDING tokens may use this
      // endpoint. A final shop-scoped JWT or HQ JWT has no business
      // re-selecting a shop and we reject it before any DB hop.
      if (request.user.role !== 'STORE_PENDING') {
        return reply.code(403).send(
          error(
            'Shop selection is only available for multi-shop pending sessions',
            ERROR_CODES.PERMISSION_DENIED,
          ),
        )
      }

      const { shop_id: shopId } = request.body
      const userId = request.user.id

      // The interim token does NOT carry the user's underlying role
      // (only `STORE_PENDING`), so we re-read it from `users` to
      // populate the final JWT's `role` claim per design §5.6. This
      // is a single-row PK lookup (well under the 50ms p95 query
      // budget) and excludes password_hash by construction.
      const userRow = await this.service.repository.findUserById(userId)
      if (!userRow) {
        return reply.code(401).send(
          error('Session is no longer valid', ERROR_CODES.SESSION_INVALID),
        )
      }

      const result = await this.service.selectShop(
        {
          userId,
          shopId,
          fullName: userRow.full_name,
          email: userRow.email,
          userRole: userRow.role,
          sessionVersion: userRow.session_version,
        },
        ip,
        userAgent,
      )

      const accessToken = await reply.jwtSign(result.tokenPayload, {
        expiresIn: result.tokenExpiry,
      })

      setAuthCookies(reply, accessToken, cookieMaxAgeFor(result.tokenExpiry))

      return reply.code(200).send(
        success(
          {
            accessToken,
            shop: result.shop,
            permissions: result.permissions,
          },
          'Shop selected',
        ),
      )
    } catch (err) {
      return mapError(request, reply, err, 'selectShop')
    }
  }

  /**
   * `GET /api/v1/admin/auth/me` (AUTH required).
   *
   * Returns the dashboard "who am I" payload per design §5.3. The
   * route allows STORE_PENDING tokens through (the dashboard renders
   * the shop-picker from this payload), and the
   * `requireNoForcePassword` gate whitelists `/me` so the user can
   * render their profile while forced to change.
   */
  async me(request, reply) {
    const ip = request.ip
    const userAgent = request.headers['user-agent'] || null

    try {
      const result = await this.service.me({
        userId: request.user.id,
        // shop-scoped JWTs use `shopId`; HQ and STORE_PENDING omit it.
        jwtShopId: request.user.shopId || null,
        ip,
        userAgent,
      })

      return reply.code(200).send(success(result, 'Profile fetched'))
    } catch (err) {
      return mapError(request, reply, err, 'me')
    }
  }

  /**
   * `POST /api/v1/admin/auth/change-password` (AUTH required).
   *
   * Body validated by `changePasswordSchema`. Verifies the caller's
   * current password, re-hashes the new one with bcrypt cost 12,
   * clears `force_password_change`, and bumps `users.session_version`
   * — atomically in a single transaction (design §5.5). Then issues a
   * fresh 24-hour JWT in the response so the dashboard can keep
   * operating without a second login round-trip.
   *
   * The route is reachable while `force_password_change=true`
   * (the `requireNoForcePassword` gate whitelists it) so users
   * stuck on a Temp_Password can clear the flag.
   *
   * Never echoes any password value (R18.11). The response body
   * carries only `{ accessToken, sessionVersion }`.
   */
  async changePassword(request, reply) {
    const ip = request.ip
    const userAgent = request.headers['user-agent'] || null

    try {
      const { currentPassword, newPassword } = request.body
      const u = request.user

      const result = await this.service.changePassword(
        {
          userId: u.id,
          currentPassword,
          newPassword,
          fullName: u.full_name || null,
          email: u.email,
          role: u.role,
          platformRole: u.platform_role || null,
          shopId: u.shopId || null,
          shopRole: u.shopRole || null,
          permissions: Array.isArray(u.permissions) ? u.permissions : [],
        },
        ip,
        userAgent,
      )

      const accessToken = await reply.jwtSign(result.tokenPayload, {
        expiresIn: result.tokenExpiry,
      })

      setAuthCookies(reply, accessToken, cookieMaxAgeFor(result.tokenExpiry))

      return reply.code(200).send(
        success(
          {
            accessToken,
            sessionVersion: result.sessionVersion,
          },
          'Password changed',
        ),
      )
    } catch (err) {
      return mapError(request, reply, err, 'changePassword')
    }
  }

  /**
   * `POST /api/v1/admin/auth/logout` (AUTH required).
   *
   * Clears both auth cookies. The JWT itself remains technically
   * valid until expiry — clients enforce logout by dropping their
   * stored token, and any subsequent request without the
   * `accessToken` cookie / Authorization header is rejected by the
   * auth plugin. For a hard server-side revocation use
   * change-password, which bumps `session_version` (design §5.5).
   */
  async logout(request, reply) {
    try {
      reply.clearCookie('accessToken', { path: '/' })
      reply.clearCookie('auth_session', { path: '/' })
      return reply.code(200).send(success(null, 'Logged out'))
    } catch (err) {
      // Logout is best-effort — failures here are essentially never
      // user-actionable, but log + return 500 to surface them.
      logger.warn(
        { err, action: 'logout', userId: request.user ? request.user.id : null },
        'auth.logout failed',
      )
      return reply.code(500).send(
        error('Internal server error', ERROR_CODES.INTERNAL_ERROR),
      )
    }
  }
}
