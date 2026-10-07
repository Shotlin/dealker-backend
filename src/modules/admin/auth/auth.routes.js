import { AdminAuthRepository } from './auth.repository.js'
import { AdminAuthService } from './auth.service.js'
import { AdminAuthController } from './auth.controller.js'
import {
  adminLoginSchema,
  selectShopSchema,
  meSchema,
  changePasswordSchema,
} from './auth.schema.js'
import { requireNoForcePassword } from '../../../middlewares/require-no-force-password.js'

/**
 * Unified dashboard auth routes — design §5 of multi-vendor-system.
 *
 * Mount prefix (set by parent router): `/api/v1/admin/auth`.
 *
 *   POST /login            (PUBLIC)               R18 — email + password
 *   POST /select-shop      (AUTH, STORE_PENDING)  R18.6 — multi-shop upgrade
 *   GET  /me               (AUTH + force-pwd OK)  R19   — profile + scope
 *   POST /change-password  (AUTH, force-pwd OK)   R20.7 — rotate + bump SV
 *   POST /logout           (AUTH, force-pwd OK)   clear cookies
 *
 * All four protected routes mount `requireNoForcePassword` AFTER
 * `fastify.authenticate`. The middleware allow-lists `/me`,
 * `/change-password`, and `/logout` so a user with
 * `force_password_change=true` can still reach those three; every
 * other authenticated route on this router (currently `/select-shop`)
 * is blocked with 403 PASSWORD_CHANGE_REQUIRED until they rotate
 * (design §5.5, R20.7).
 *
 * Rate limits (Redis-backed via `@fastify/rate-limit`):
 *
 *   /login           — 10 req / 60s / IP   (R18.11)
 *   /select-shop     — 20 req / 60s / IP   (defensive)
 *   /me              — 60 req / 60s / IP   (existing budget)
 *   /change-password —  5 req / 60s / IP   (mirrors prior /password)
 *   /logout          — 20 req / 5min / IP  (existing budget)
 *
 * Body validation: every body is validated by an AJV-compiled schema
 * mounted on the route's `schema.body` (R18.1). Fastify rejects
 * mismatches with 400 VALIDATION_ERROR before the handler runs and
 * never echoes the submitted password values back (R18.16).
 *
 * Module: src/modules/admin/auth/auth.routes.js
 */
export default async function adminAuthRoutes(fastify) {
  const repository = new AdminAuthRepository()
  const service = new AdminAuthService(repository)
  const controller = new AdminAuthController(service)

  // ── PUBLIC ────────────────────────────────────────────────────────
  // POST /login — 10 req / 60s / IP per R18.11. No preHandler: this
  // is the entry point; auth is established by a successful response.
  fastify.post(
    '/login',
    {
      schema: adminLoginSchema,
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '60 seconds',
        },
      },
    },
    controller.login.bind(controller),
  )

  // ── PROTECTED ─────────────────────────────────────────────────────
  // POST /select-shop — STORE_PENDING token only. The controller
  // additionally verifies `request.user.role === 'STORE_PENDING'`.
  // requireNoForcePassword sits AFTER authenticate so it runs against
  // a verified `request.user`, and it rejects /select-shop with
  // PASSWORD_CHANGE_REQUIRED when the flag is set (the user must
  // rotate before being granted a final shop-scoped session).
  fastify.post(
    '/select-shop',
    {
      schema: selectShopSchema,
      preHandler: [fastify.authenticate, requireNoForcePassword],
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '60 seconds',
        },
      },
    },
    controller.selectShop.bind(controller),
  )

  // GET /me — accessible to HQ, shop-scoped, and STORE_PENDING tokens.
  // The `/me` suffix is on the requireNoForcePassword allow-list so a
  // user with force_password_change=true can still load their profile
  // while the dashboard surfaces the password-change UI (R20.7).
  fastify.get(
    '/me',
    {
      schema: meSchema,
      preHandler: [fastify.authenticate, requireNoForcePassword],
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '60 seconds',
        },
      },
    },
    controller.me.bind(controller),
  )

  // POST /change-password — the one route that must remain reachable
  // while force_password_change=true (it's how the user clears the
  // flag). The middleware allow-lists `/change-password` for exactly
  // this reason.
  fastify.post(
    '/change-password',
    {
      schema: changePasswordSchema,
      preHandler: [fastify.authenticate, requireNoForcePassword],
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '60 seconds',
        },
      },
    },
    controller.changePassword.bind(controller),
  )

  // POST /logout — also allow-listed by requireNoForcePassword so a
  // user stuck on the password-change screen can still sign out.
  fastify.post(
    '/logout',
    {
      preHandler: [fastify.authenticate, requireNoForcePassword],
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '5 minutes',
        },
      },
    },
    controller.logout.bind(controller),
  )
}
