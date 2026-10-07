import bcrypt from 'bcrypt'
import { getClient } from '../../../config/database.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import { emit as emitAudit, emitInTx as emitAuditInTx } from '../../../utils/audit-log.js'
import {
  HQ_ROLE_PERMISSIONS,
  PERMISSIONS,
} from '../../../utils/permissions.js'
import { ERROR_CODES } from '../../../constants/errors.js'

/**
 * AdminAuthService
 *
 * Service layer for the unified dashboard authentication module
 * (`/api/v1/admin/auth/*`). Handles login, profile retrieval and
 * password management for HQ users (`platform_role IS NOT NULL`)
 * and shop-staff users (`platform_role IS NULL` with active
 * Shop_Staff_Records).
 *
 * `getProfile` and `setPassword` are preserved verbatim for backward
 * compatibility with the existing dashboard `/me` and `/password`
 * routes — task 3.4 / 3.5 introduce the multi-vendor variants.
 */
export class AdminAuthService {
  constructor(repository) {
    this.repository = repository
  }

  /**
   * Unified dashboard login (R18, R29.3 / R29.9, design §5.1).
   *
   * Sequence (matches design §5.1 verbatim):
   *
   *   1. Case-insensitive email lookup via
   *      `repository.findUserByEmailCI(email)` — uses the functional
   *      index `idx_users_email_lower` so casing in the submitted
   *      email never breaks index usage (R29.3).
   *   2. Generic 401 INVALID_CREDENTIALS for unknown email
   *      (R18.15, R29.9). The response body must NOT reveal whether
   *      the email exists — both unknown-email and wrong-password
   *      branches return the same code/message.
   *   3. 403 USER_INACTIVE when `is_active=false` OR `is_blocked=true`
   *      (R18.13).
   *   4. 401 INVALID_CREDENTIALS when the row has no `password_hash`
   *      (legacy OTP-only accounts) — same generic message so the
   *      response does not leak account-state information.
   *   5. `bcrypt.compare(password, password_hash)` — wrong password
   *      → 401 INVALID_CREDENTIALS.
   *
   * Branching after authentication:
   *
   *   • HQ user (`platform_role IS NOT NULL`): emit `login_success`,
   *     return a 24h token payload carrying
   *     `{ id, role, platform_role, full_name, email, permissions,
   *        session_version }`. `permissions` is the canonical HQ
   *     permission set from `HQ_ROLE_PERMISSIONS` (R18.2).
   *   • Shop-staff user (`platform_role IS NULL`):
   *       – 0 active shops → 403 NO_ACTIVE_SHOP_ASSIGNMENTS (R18.14).
   *       – 1 active shop → 24h shop-scoped token payload carrying
   *         `{ id, role, shopId, shopRole, full_name, email,
   *            permissions, session_version }` (R18.4).
   *       – 2+ active shops → 5-minute STORE_PENDING interim token
   *         payload carrying only `{ id, email, full_name, role:
   *         'STORE_PENDING', session_version }` (R18.5). The client
   *         must call `/admin/auth/select-shop` to upgrade to a final
   *         shop-scoped token.
   *
   * Response shape (returned to the controller):
   *
   *   {
   *     tokenPayload,            // payload to sign with fastify.jwt
   *     tokenExpiry,             // '24h' or '5m'
   *     user,                    // sanitized user (no password_hash)
   *     shops,                   // active assignments (empty for HQ)
   *     isSuperAdmin,            // true iff platform_role==='SUPER_ADMIN'
   *     requiresShopSelection,   // true iff shops.length >= 2
   *     // ── back-compat fields consumed by the legacy controller
   *     // ── (`auth.controller.js`); task 3.6 rewrites the controller
   *     // ── to use `tokenPayload` / `tokenExpiry` directly.
   *     id, phone, role,
   *   }
   *
   * Audit (R18.17, R18.18): every branch — success and all four
   * failure paths — emits exactly one audit row via the fire-and-forget
   * `audit-log#emit`. The submitted password is NEVER included in the
   * payload (R18.18). The audit-log helper redacts `password_hash`
   * automatically per R28.5 even if it were ever passed through.
   *
   * Secret handling (R18.11): the returned `user` object is built
   * field-by-field from the repository row and explicitly excludes
   * `password_hash`. The repository returns the hash for bcrypt
   * verification only.
   *
   * @param {{ email: string, password: string }} body
   *        Validated credentials. Zod validation occurs at the route
   *        layer (task 3.6) — this service trusts the schema upstream.
   * @param {string|null} [ip]         Client IP for audit context.
   * @param {string|null} [userAgent]  Client user-agent for audit context.
   *
   * @returns {Promise<{
   *   tokenPayload: object,
   *   tokenExpiry: string,
   *   user: object,
   *   shops: object[],
   *   isSuperAdmin: boolean,
   *   requiresShopSelection: boolean,
   *   id: string,
   *   phone: string|null,
   *   role: string,
   * }>}
   *
   * @throws {{ statusCode: 401, code: 'INVALID_CREDENTIALS', message: string }}
   *         Unknown email, missing password_hash, or bcrypt mismatch.
   * @throws {{ statusCode: 403, code: 'USER_INACTIVE', message: string }}
   *         Row exists but `is_active=false` or `is_blocked=true`.
   * @throws {{ statusCode: 403, code: 'NO_ACTIVE_SHOP_ASSIGNMENTS', message: string }}
   *         Non-HQ user with zero active Shop_Staff_Records.
   *
   * Requirements: R18.2, R18.3, R18.4, R18.5, R18.13, R18.14, R18.17,
   *               R18.18, R29.3, R29.9
   * Design:       §5.1
   */
  async login({ email, password }, ip = null, userAgent = null) {
    const user = await this.repository.findUserByEmailCI(email)

    // ── 1. Unknown email ────────────────────────────────────────────
    // R18.15 / R29.9: generic 401 — never disclose whether email exists.
    if (!user) {
      emitAudit('login_failure', {
        actor_user_id: null,
        target_type: 'user',
        target_id: null,
        before: null,
        after: { email, reason: 'unknown_email' },
        ip_address: ip,
        user_agent: userAgent,
      })
      throw {
        statusCode: 401,
        code: ERROR_CODES.INVALID_CREDENTIALS,
        message: 'Invalid email or password',
      }
    }

    // ── 2. Inactive / blocked ───────────────────────────────────────
    // R18.13: `is_active=false` OR `is_blocked=true` → 403 USER_INACTIVE.
    if (user.is_active === false || user.is_blocked === true) {
      emitAudit('login_failure', {
        actor_user_id: user.id,
        target_type: 'user',
        target_id: user.id,
        before: null,
        after: { email, reason: 'inactive' },
        ip_address: ip,
        user_agent: userAgent,
      })
      throw {
        statusCode: 403,
        code: ERROR_CODES.USER_INACTIVE,
        message: 'Account is inactive',
      }
    }

    // ── 3. Row exists but has no password set ───────────────────────
    // Same generic 401 message so the response cannot be used to
    // distinguish "no-password account" from "wrong password".
    if (!user.password_hash) {
      emitAudit('login_failure', {
        actor_user_id: user.id,
        target_type: 'user',
        target_id: user.id,
        before: null,
        after: { email, reason: 'no_password_set' },
        ip_address: ip,
        user_agent: userAgent,
      })
      throw {
        statusCode: 401,
        code: ERROR_CODES.INVALID_CREDENTIALS,
        message: 'Invalid email or password',
      }
    }

    // ── 4. Bcrypt verify ────────────────────────────────────────────
    const ok = await bcrypt.compare(password, user.password_hash)
    if (!ok) {
      emitAudit('login_failure', {
        actor_user_id: user.id,
        target_type: 'user',
        target_id: user.id,
        before: null,
        after: { email, reason: 'wrong_password' },
        ip_address: ip,
        user_agent: userAgent,
      })
      throw {
        statusCode: 401,
        code: ERROR_CODES.INVALID_CREDENTIALS,
        message: 'Invalid email or password',
      }
    }

    // Build the response-safe user view. R18.11: password_hash MUST
    // never appear in any response body or log line — we copy fields
    // explicitly rather than spread `user` to make this invariant
    // structurally enforced at the call site.
    const safeUser = sanitizeUser(user)

    // ── 5a. HQ branch (R18.2) ──────────────────────────────────────
    if (user.platform_role) {
      const permsSet = HQ_ROLE_PERMISSIONS[user.platform_role]
      // Defensive: an unrecognised platform_role would be a data
      // integrity issue (CHECK constraint on users.platform_role
      // already enforces the five legal values), but treat it as
      // "no permissions" rather than crashing the request path.
      const permissions = permsSet ? Array.from(permsSet) : []
      const isSuperAdmin = user.platform_role === 'SUPER_ADMIN' || user.platform_role === 'ADMIN'

      const tokenPayload = {
        id: user.id,
        role: user.role,
        platform_role: user.platform_role,
        full_name: user.full_name,
        email: user.email,
        permissions,
        session_version: user.session_version,
      }

      emitAudit('login_success', {
        actor_user_id: user.id,
        actor_role: user.platform_role,
        target_type: 'user',
        target_id: user.id,
        before: null,
        after: { email, kind: 'HQ', platform_role: user.platform_role },
        ip_address: ip,
        user_agent: userAgent,
      })

      logAdminActivity(user.id, 'Dashboard login', 'auth', user.id, null, { email, kind: 'HQ' }, ip)

      return {
        tokenPayload,
        tokenExpiry: '24h',
        user: safeUser,
        shops: [],
        isSuperAdmin,
        requiresShopSelection: false,
        // back-compat for the legacy controller (task 3.6 supersedes)
        id: user.id,
        phone: user.phone,
        role: user.role,
      }
    }

    // ── 5b. Shop-staff branch (R18.3, R18.4, R18.5, R18.14) ────────
    const shops = await this.repository.loadActiveShopAssignments(user.id)

    // Zero active shops → 403 NO_ACTIVE_SHOP_ASSIGNMENTS (R18.14).
    if (shops.length === 0) {
      emitAudit('login_failure', {
        actor_user_id: user.id,
        target_type: 'user',
        target_id: user.id,
        before: null,
        after: { email, reason: 'no_shop_assignments' },
        ip_address: ip,
        user_agent: userAgent,
      })
      throw {
        statusCode: 403,
        code: ERROR_CODES.NO_ACTIVE_SHOP_ASSIGNMENTS,
        message: 'No active shop assignments found for this account',
      }
    }

    // Single active shop → final 24h shop-scoped token (R18.4).
    if (shops.length === 1) {
      const a = shops[0]
      // R17.11: filter the assignment's permissions JSONB array
      // against the canonical 37-string vocabulary so unknown
      // strings (data drift from older seeds, manual SQL edits,
      // etc.) never propagate into the JWT.
      const permissions = filterCanonicalPermissions(a.permissions)

      const tokenPayload = {
        id: user.id,
        role: user.role,
        shopId: a.shop_id,
        shopRole: a.shop_role,
        full_name: user.full_name,
        email: user.email,
        permissions,
        session_version: user.session_version,
      }

      emitAudit('login_success', {
        actor_user_id: user.id,
        actor_role: a.shop_role,
        actor_shop_id: a.shop_id,
        target_type: 'user',
        target_id: user.id,
        before: null,
        after: { email, kind: 'STORE_SINGLE', shop_id: a.shop_id, shop_role: a.shop_role },
        ip_address: ip,
        user_agent: userAgent,
      })

      logAdminActivity(
        user.id,
        'Dashboard login',
        'auth',
        user.id,
        null,
        { email, kind: 'STORE_SINGLE', shop_id: a.shop_id },
        ip,
      )

      return {
        tokenPayload,
        tokenExpiry: '24h',
        user: safeUser,
        shops,
        isSuperAdmin: false,
        requiresShopSelection: false,
        // back-compat for the legacy controller (task 3.6 supersedes)
        id: user.id,
        phone: user.phone,
        role: user.role,
      }
    }

    // Multi-shop → 5-minute STORE_PENDING interim token (R18.5).
    // Carries no `shopId`, no `shopRole`, no `permissions`. The
    // client must POST `/api/v1/admin/auth/select-shop` to upgrade.
    const tokenPayload = {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: 'STORE_PENDING',
      session_version: user.session_version,
    }

    emitAudit('login_success', {
      actor_user_id: user.id,
      target_type: 'user',
      target_id: user.id,
      before: null,
      after: {
        email,
        kind: 'STORE_MULTI',
        reason: 'multi_shop_pending',
        count: shops.length,
      },
      ip_address: ip,
      user_agent: userAgent,
    })

    logAdminActivity(
      user.id,
      'Dashboard login',
      'auth',
      user.id,
      null,
      { email, kind: 'STORE_MULTI', count: shops.length },
      ip,
    )

    return {
      tokenPayload,
      tokenExpiry: '5m',
      user: safeUser,
      shops,
      isSuperAdmin: false,
      requiresShopSelection: true,
      // back-compat for the legacy controller (task 3.6 supersedes)
      id: user.id,
      phone: user.phone,
      role: 'STORE_PENDING',
    }
  }

  async getProfile(userId) {
    return this.repository.findAdminById(userId)
  }

  /**
   * Unified dashboard `/me` endpoint backing
   * `GET /api/v1/admin/auth/me` (R19, design §5.3).
   *
   * Returns the requester's profile, role context, and shop scope so
   * the dashboard can render the correct mode (HQ_MODE, STORE_MODE,
   * or UNSELECTED — design §14). This method is the runtime trust
   * boundary for **session revocation since token issuance** (R19.6 /
   * design §5.7): the row is re-read from `users` on every call and
   * any state change that invalidates the token surfaces here as
   * 401 `SESSION_INVALID`. The auth plugin (task 3.7) already
   * compares the JWT `session_version` against the row before this
   * service runs, so we focus on the orthogonal "row deactivated
   * since issuance" cases here.
   *
   * Branch matrix (design §5.3):
   *
   *   ┌─────────────────────────┬───────────────────┬──────────────────┐
   *   │ token kind              │ shops             │ permissions      │
   *   ├─────────────────────────┼───────────────────┼──────────────────┤
   *   │ HQ (platform_role NOT   │ []                │ HQ_ROLE_PERMS    │
   *   │   NULL)                 │                   │ for platform_role│
   *   ├─────────────────────────┼───────────────────┼──────────────────┤
   *   │ STORE (jwtShopId set)   │ [matched          │ canonical-       │
   *   │                         │  assignment only] │ filtered set     │
   *   ├─────────────────────────┼───────────────────┼──────────────────┤
   *   │ STORE_PENDING           │ all active        │ []               │
   *   │ (jwtShopId null)        │ assignments       │ (R19.4)          │
   *   └─────────────────────────┴───────────────────┴──────────────────┘
   *
   * Sequence:
   *
   *   1. Re-read the user via `repository.findUserById(userId)`. If
   *      the row has been hard-deleted (extremely rare — the
   *      platform soft-deletes via `deleted_at` and `is_active`),
   *      throw 401 `SESSION_INVALID` and emit `session_revoked`
   *      with `reason='user_not_found'` (R19.6).
   *   2. If `is_active=false` OR `is_blocked=true`, the account was
   *      deactivated since token issuance → 401 `SESSION_INVALID`
   *      and `session_revoked` with `reason='user_inactive'`
   *      (R19.6). This is distinct from the login-time
   *      `USER_INACTIVE` 403 because mid-session we are revoking
   *      an existing session, not denying initial authentication.
   *   3. Load active assignments via
   *      `repository.loadActiveShopAssignments(userId)` — the same
   *      filters used by login (`ss.is_active`, `ss.deleted_at`,
   *      `s.is_active`, `s.deleted_at`).
   *   4. HQ branch (`platform_role IS NOT NULL`): return
   *      `{ user, isSuperAdmin, shops: [], permissions, active_shop:
   *      null }` (R19.2). `permissions` is the canonical HQ
   *      permission set from `HQ_ROLE_PERMISSIONS`.
   *   5. Shop-staff branch (`platform_role IS NULL`):
   *        a. `jwtShopId` set (final shop-scoped JWT): find the
   *           matching active assignment. If absent → the staff
   *           link or the shop was deactivated since issuance →
   *           401 `SESSION_INVALID` and `session_revoked` with
   *           `reason='staff_assignment_revoked'` (R19.6).
   *           Otherwise return the single matched assignment in
   *           `shops`, the canonical-filtered permissions, and a
   *           full `active_shop` summary (R19.3).
   *        b. `jwtShopId` falsy (interim STORE_PENDING token):
   *           return all active assignments, `permissions=[]`,
   *           `active_shop=null` (R19.4). Multi-shop users in this
   *           state cannot exercise any shop-scoped permission
   *           until they call `/select-shop`.
   *
   * Response body (returned to the controller — task 3.6):
   *
   *   {
   *     user: {                          // sanitizeUser(...) — no
   *       id, email, full_name, phone,   // password_hash etc.
   *       role, platform_role,
   *       is_active, is_blocked,
   *       force_password_change,
   *     },
   *     isSuperAdmin: boolean,
   *     shops: Array<{
   *       shop_id, shop_name, branch_code, shop_role,
   *     }>,
   *     permissions: string[],           // canonical-only
   *     active_shop: {
   *       shop_id, shop_name, branch_code, shop_role,
   *     } | null,
   *   }
   *
   * Secret handling (R19.7): the response is built field-by-field
   * via {@link sanitizeUser} and explicit picks on each assignment;
   * `password_hash`, `force_password_change_token`, and
   * `bank_account_number` cannot reach the response by construction.
   * `findUserById` further excludes `password_hash` at the
   * repository boundary as a defense in depth.
   *
   * Audit (R19.6 / R28.4): every 401 path emits exactly one
   * `session_revoked` audit row via the fire-and-forget helper
   * before throwing. Successful calls do NOT emit an audit row —
   * `/me` is a read-only profile lookup hit on every dashboard
   * page render and would otherwise dominate the audit log.
   *
   * Forward compatibility: extra fields passed by the controller
   * (e.g. `userRole`, `sessionVersion`, future device-binding
   * claims) are accepted and ignored via the rest pattern so this
   * method can absorb new JWT claims without a signature change.
   *
   * @param {{
   *   userId: string,
   *   jwtShopId?: string|null,
   *   ip?: string|null,
   *   userAgent?: string|null,
   *   [key: string]: unknown,
   * }} input
   *        Identity fields lifted from the verified JWT plus the
   *        request context. `jwtShopId` is the `shopId` claim from
   *        a final shop-scoped JWT, or null/undefined for HQ and
   *        STORE_PENDING tokens. `ip` and `userAgent` are used for
   *        audit context on the 401 paths only.
   *
   * @returns {Promise<{
   *   user: object,
   *   isSuperAdmin: boolean,
   *   shops: Array<{
   *     shop_id: string,
   *     shop_name: string,
   *     branch_code: string,
   *     shop_role: 'SHOP_ADMIN'|'SHOP_MANAGER'|'SHOP_STAFF'|'SHOP_VIEWER',
   *   }>,
   *   permissions: string[],
   *   active_shop: {
   *     shop_id: string,
   *     shop_name: string,
   *     branch_code: string,
   *     shop_role: 'SHOP_ADMIN'|'SHOP_MANAGER'|'SHOP_STAFF'|'SHOP_VIEWER',
   *   } | null,
   * }>}
   *
   * @throws {{ statusCode: 401, code: 'SESSION_INVALID', message: string }}
   *         User row missing, deactivated/blocked since token
   *         issuance, or the JWT-bound shop_id no longer maps to an
   *         active Shop_Staff_Record (R19.6).
   *
   * Requirements: R19.1, R19.2, R19.3, R19.4, R19.6, R19.7
   * Design:       §5.3, §5.7
   */
  async me({ userId, jwtShopId = null, ip = null, userAgent = null } = {}) {
    // ── 1. Re-read the user row (R19.6) ────────────────────────────
    // Re-reading on every call is what catches deactivations that
    // happened AFTER token issuance — the JWT itself carries no
    // is_active/is_blocked claim.
    const user = await this.repository.findUserById(userId)
    if (!user) {
      emitAudit('session_revoked', {
        actor_user_id: userId,
        target_type: 'user',
        target_id: userId,
        before: null,
        after: { reason: 'user_not_found' },
        ip_address: ip,
        user_agent: userAgent,
      })
      throw {
        statusCode: 401,
        code: ERROR_CODES.SESSION_INVALID,
        message: 'Session is no longer valid',
      }
    }

    // ── 2. Account deactivated / blocked since token issuance ──────
    // Distinct from the login-time USER_INACTIVE 403: here we are
    // revoking an existing session, not denying initial auth, so the
    // canonical code is SESSION_INVALID (R19.6, design §5.7).
    if (user.is_active === false || user.is_blocked === true) {
      emitAudit('session_revoked', {
        actor_user_id: user.id,
        actor_role: user.platform_role || null,
        target_type: 'user',
        target_id: user.id,
        before: null,
        after: { reason: 'user_inactive' },
        ip_address: ip,
        user_agent: userAgent,
      })
      throw {
        statusCode: 401,
        code: ERROR_CODES.SESSION_INVALID,
        message: 'Session is no longer valid',
      }
    }

    const safeUser = sanitizeUser(user)

    // ── 3. Load active assignments (filters: ss.is_active, ──────────
    //      ss.deleted_at, s.is_active, s.deleted_at) — same source
    //      of truth as login() and selectShop().
    const assignments = await this.repository.loadActiveShopAssignments(user.id)

    // ── 4. HQ branch (R19.2) ───────────────────────────────────────
    if (user.platform_role) {
      const permsSet = HQ_ROLE_PERMISSIONS[user.platform_role]
      // Defensive: an unknown platform_role would be a CHECK
      // constraint violation upstream; treat as no permissions
      // rather than throwing here so the dashboard can still render
      // a "no permissions" empty state instead of erroring out.
      const permissions = permsSet ? Array.from(permsSet) : []
      return {
        user: safeUser,
        isSuperAdmin: user.platform_role === 'SUPER_ADMIN' || user.platform_role === 'ADMIN',
        shops: [],
        permissions,
        active_shop: null,
      }
    }

    // ── 5. Shop-staff branch (R19.3, R19.4, R19.6) ─────────────────
    if (jwtShopId) {
      // Final shop-scoped JWT: the assignment must still be active.
      // If it is not, the staff record (or the shop) was deactivated
      // since token issuance per R19.6.
      const assignment = assignments.find((a) => a.shop_id === jwtShopId)
      if (!assignment) {
        emitAudit('session_revoked', {
          actor_user_id: user.id,
          actor_shop_id: jwtShopId,
          target_type: 'user',
          target_id: user.id,
          before: null,
          after: { reason: 'staff_assignment_revoked', shop_id: jwtShopId },
          ip_address: ip,
          user_agent: userAgent,
        })
        throw {
          statusCode: 401,
          code: ERROR_CODES.SESSION_INVALID,
          message: 'Session is no longer valid',
        }
      }
      const summary = sanitizeAssignment(assignment)
      return {
        user: safeUser,
        isSuperAdmin: false,
        shops: [summary],
        permissions: filterCanonicalPermissions(assignment.permissions),
        active_shop: summary,
      }
    }

    // Interim STORE_PENDING token: jwtShopId is absent because the
    // user has multiple shops and has not yet called /select-shop.
    // Per R19.4, return all active assignments but no permissions
    // and no active_shop — the client must select one before any
    // shop-scoped permission becomes effective.
    return {
      user: safeUser,
      isSuperAdmin: false,
      shops: assignments.map(sanitizeAssignment),
      permissions: [],
      active_shop: null,
    }
  }

  async setPassword(userId, newPassword) {
    if (!newPassword || newPassword.length < 8) {
      throw { statusCode: 400, message: 'Password must be at least 8 characters' }
    }
    const hash = await bcrypt.hash(newPassword, 12)
    await this.repository.setPassword(userId, hash)
    logAdminActivity(userId, 'Admin password set/changed', 'auth', userId)
  }

  /**
   * Upgrade a `STORE_PENDING` interim session to a final, 24-hour
   * shop-scoped session by selecting one of the caller's active
   * Shop_Staff_Records (design §5.2).
   *
   * This service method is invoked by the route handler for
   * `POST /api/v1/admin/auth/select-shop` (task 3.6). The route is
   * the trust boundary for the interim JWT — it verifies the
   * 5-minute `STORE_PENDING` token (signed by `login()` in the
   * multi-shop branch), extracts `userId`, `email`, `full_name`,
   * `session_version`, and the user's underlying `users.role` (the
   * shop-scoped role token claim — see design §5.6), and forwards
   * them to this method along with the `shopId` from the request body.
   * The service trusts these inputs and never re-reads the user row;
   * the auth plugin (task 3.7) is responsible for verifying that
   * `session_version` still matches the row on every authenticated
   * request, which means a password change between login and
   * select-shop will reject the interim token before it reaches us.
   *
   * Sequence (matches design §5.2):
   *
   *   1. Load `repository.loadActiveShopAssignments(userId)` and find
   *      the assignment whose `shop_id === shopId`. The repository
   *      already filters out deactivated/soft-deleted staff links
   *      and paused/soft-deleted shops, so any match is guaranteed
   *      to be an active, currently-valid assignment.
   *   2. If no match → 403 `SHOP_NOT_ASSIGNED` with a
   *      `shop_select_failure` audit row carrying
   *      `after: { reason: 'not_assigned' }` (R18.8). The selected
   *      shop_id is recorded as `target_id` so SOC reviewers can
   *      pivot directly from the audit row to the shop.
   *   3. Filter the assignment's `permissions` JSONB against the
   *      canonical 37-string Permission_String vocabulary using
   *      the same `filterCanonicalPermissions` helper used by
   *      `login()` (R17.11). Stale or unknown strings from older
   *      seeds are silently dropped and never propagate into the
   *      JWT — the permission-check middleware emits the
   *      `invalid_permission_string_detected` audit (design §4.5),
   *      not this path.
   *   4. Build the final 24-hour shop-scoped tokenPayload exactly
   *      per design §5.6: `{ id, role, shopId, shopRole, full_name,
   *      email, permissions, session_version }`. The caller is
   *      responsible for signing this payload with `fastify.jwt`;
   *      this method never touches signing keys.
   *   5. Emit a `shop_selected` audit row with
   *      `actor_role: assignment.shop_role`, `actor_shop_id: shopId`,
   *      `target_type: 'shop'`, `target_id: shopId`,
   *      `after: { shop_id, shop_role }`. The audit-log helper is
   *      fire-and-forget — emit failures never fail the request.
   *
   * Response shape (returned to the controller — task 3.6):
   *
   *   {
   *     tokenPayload,                 // payload to sign with fastify.jwt
   *     tokenExpiry: '24h',
   *     shop: {                       // selected assignment, sanitized
   *       shop_id, shop_name, branch_code, shop_role,
   *     },
   *     permissions,                  // canonical-only filtered set
   *   }
   *
   * @param {{
   *   userId: string,
   *   shopId: string,
   *   fullName: string|null,
   *   email: string,
   *   userRole: string,
   *   sessionVersion: number,
   * }} input
   *        Identity fields lifted from the verified interim JWT plus
   *        the requested `shopId` from the request body. The route
   *        handler (task 3.6) is the sole caller and is the trust
   *        boundary for these values.
   * @param {string|null} [ip]         Client IP for audit context.
   * @param {string|null} [userAgent]  Client user-agent for audit context.
   *
   * @returns {Promise<{
   *   tokenPayload: {
   *     id: string,
   *     role: string,
   *     shopId: string,
   *     shopRole: 'SHOP_ADMIN'|'SHOP_MANAGER'|'SHOP_STAFF'|'SHOP_VIEWER',
   *     full_name: string|null,
   *     email: string,
   *     permissions: string[],
   *     session_version: number,
   *   },
   *   tokenExpiry: '24h',
   *   shop: {
   *     shop_id: string,
   *     shop_name: string,
   *     branch_code: string,
   *     shop_role: 'SHOP_ADMIN'|'SHOP_MANAGER'|'SHOP_STAFF'|'SHOP_VIEWER',
   *   },
   *   permissions: string[],
   * }>}
   *
   * @throws {{ statusCode: 403, code: 'SHOP_NOT_ASSIGNED', message: string }}
   *         The requested `shopId` is not present in the caller's
   *         active Shop_Staff_Records (R18.8).
   *
   * Requirements: R18.6, R18.7, R18.8
   * Design:       §5.2
   */
  async selectShop(
    { userId, shopId, fullName, email, userRole, sessionVersion },
    ip = null,
    userAgent = null,
  ) {
    const assignments = await this.repository.loadActiveShopAssignments(userId)
    const assignment = assignments.find((a) => a.shop_id === shopId)

    // ── 1. Shop not in caller's active assignments (R18.8) ─────────
    if (!assignment) {
      emitAudit('shop_select_failure', {
        actor_user_id: userId,
        target_type: 'shop',
        target_id: shopId,
        before: null,
        after: { reason: 'not_assigned' },
        ip_address: ip,
        user_agent: userAgent,
      })
      throw {
        statusCode: 403,
        code: ERROR_CODES.SHOP_NOT_ASSIGNED,
        message: 'Selected shop is not assigned to this user',
      }
    }

    // ── 2. Canonical-only permissions (R17.11) ─────────────────────
    const permissions = filterCanonicalPermissions(assignment.permissions)

    // ── 3. Final 24h shop-scoped token payload (design §5.6) ───────
    const tokenPayload = {
      id: userId,
      role: userRole,
      shopId: assignment.shop_id,
      shopRole: assignment.shop_role,
      full_name: fullName,
      email,
      permissions,
      session_version: sessionVersion,
    }

    // ── 4. Audit (R18.17 / R28.4) ──────────────────────────────────
    emitAudit('shop_selected', {
      actor_user_id: userId,
      actor_role: assignment.shop_role,
      actor_shop_id: assignment.shop_id,
      target_type: 'shop',
      target_id: assignment.shop_id,
      before: null,
      after: {
        shop_id: assignment.shop_id,
        shop_role: assignment.shop_role,
      },
      ip_address: ip,
      user_agent: userAgent,
    })

    logAdminActivity(
      userId,
      'Shop selected',
      'auth',
      assignment.shop_id,
      null,
      { shop_id: assignment.shop_id, shop_role: assignment.shop_role },
      ip,
    )

    return {
      tokenPayload,
      tokenExpiry: '24h',
      shop: {
        shop_id: assignment.shop_id,
        shop_name: assignment.shop_name,
        branch_code: assignment.branch_code,
        shop_role: assignment.shop_role,
      },
      permissions,
    }
  }

  /**
   * Change the authenticated user's password and rotate their session
   * (R20.7, R20.8, design §5.5).
   *
   * Backs `POST /api/v1/admin/auth/change-password { currentPassword,
   * newPassword }`. The route handler (task 3.6) is the trust boundary
   * for the existing JWT — it verifies the token, extracts the
   * identity/scope claims, and forwards them to this method along
   * with the two passwords from the request body. The service trusts
   * those claims and never re-derives them from the database (the
   * auth plugin's session_version check has already ensured the token
   * is still valid for the row).
   *
   * Sequence (matches design §5.5 verbatim):
   *
   *   BEGIN
   *     1. `findUserByIdWithHash(userId, client)` — re-load the row
   *        on the transactional client so the entire change-password
   *        operation observes a consistent snapshot. If the row is
   *        gone (hard-delete is rare; soft-delete via `deleted_at`
   *        is the platform default) → 401 SESSION_INVALID +
   *        `session_revoked` audit emitted via the fire-and-forget
   *        helper so the row survives the rollback.
   *     2. `bcrypt.compare(currentPassword, row.password_hash)` —
   *        wrong password → 401 INVALID_CREDENTIALS +
   *        `password_change_failure` audit. The audit is emitted
   *        via fire-and-forget `emit()` (NOT `emitInTx`) because the
   *        transaction is about to roll back; if we used the
   *        transactional helper the audit row would roll back too,
   *        defeating the purpose of recording the failed attempt.
   *     3. `bcrypt.hash(newPassword, 12)` — cost 12 matches the rest
   *        of the platform (login verify path, staff-create temp
   *        password hash) per design §5.5.
   *     4. `setPasswordTx(userId, hash, client)` — single UPDATE that
   *        also flips `force_password_change=false` so the user can
   *        immediately resume normal API access (R20.7 unblocks every
   *        non-/me, non-/change-password, non-/logout route once this
   *        flag clears).
   *     5. `incrementSessionVersion(userId, client)` — atomically
   *        bumps the column the auth plugin compares on every
   *        authenticated request (task 3.7). Every previously-issued
   *        JWT (including the one the caller just used to reach this
   *        endpoint) becomes 401 SESSION_INVALID the moment the
   *        transaction commits.
   *     6. `emitInTx(client, 'password_changed', ...)` — the audit
   *        for the SUCCESS path commits atomically with the password
   *        update, so we cannot log a successful change that did not
   *        actually happen.
   *   COMMIT
   *
   *   On any throw between BEGIN and COMMIT we ROLLBACK and re-throw
   *   the original error so the controller's error mapper translates
   *   it to the right HTTP response.
   *
   * After commit, build a fresh JWT payload that mirrors the existing
   * token's scope so the dashboard can keep operating without a
   * second login round-trip (design §5.5: "Issues a fresh 24h JWT in
   * the response"). The shape decision matches design §5.6:
   *
   *   • HQ token: `{ id, role, platform_role, full_name, email,
   *     permissions, session_version }` — `permissions` came from the
   *     caller's existing token claim (the route handler forwards it
   *     verbatim) so we don't re-derive HQ_ROLE_PERMISSIONS here. The
   *     permission set is bound to the platform_role at login time and
   *     does not change on a password rotation.
   *   • Shop-scoped token: `{ id, role, shopId, shopRole, full_name,
   *     email, permissions, session_version }` — same forwarding rule.
   *   • STORE_PENDING interim token: `{ id, role: 'STORE_PENDING',
   *     full_name, email, session_version }` — realistically this
   *     branch is unreachable because the require-no-force-password
   *     gate restricts STORE_PENDING sessions to /me, /change-password,
   *     and /logout, but the symmetry keeps the contract clean and
   *     defensive against any future flow that lets STORE_PENDING
   *     reach this method.
   *
   * Token expiry: 24h for HQ and shop-scoped tokens, 5m for the
   * defensive STORE_PENDING branch (matches the original interim
   * token's lifetime).
   *
   * Validation (belt-and-suspenders): the route's Zod schema enforces
   * `newPassword.length >= 12` upstream, but the service repeats the
   * check so direct in-process callers can't bypass it. Anything
   * shorter throws 400 VALIDATION_ERROR before bcrypt runs.
   *
   * Connection lifecycle (project-standards.md "RESOURCE EFFICIENCY"):
   * we acquire a pooled client via `getClient()`, run BEGIN, do the
   * work, COMMIT or ROLLBACK on the same client, and `client.release()`
   * in a `finally` block so the connection is always returned even if
   * a downstream throw occurs after COMMIT (e.g. a logger crash).
   *
   * Secret handling (R18.11, R28.5): the service receives the
   * plaintext `currentPassword`/`newPassword` solely to feed
   * `bcrypt.compare`/`bcrypt.hash`. They are never logged, never put
   * into audit `before`/`after` snapshots, and the raw `password_hash`
   * column from `findUserByIdWithHash` is not echoed back to the
   * client — the response contains only `tokenPayload`, `tokenExpiry`,
   * and the new `sessionVersion`.
   *
   * @param {{
   *   userId: string,
   *   currentPassword: string,
   *   newPassword: string,
   *   fullName?: string|null,
   *   email?: string,
   *   role?: string,
   *   platformRole?: string|null,
   *   shopId?: string|null,
   *   shopRole?: 'SHOP_ADMIN'|'SHOP_MANAGER'|'SHOP_STAFF'|'SHOP_VIEWER'|null,
   *   permissions?: string[],
   * }} input
   *        Identity claims lifted from the verified JWT (forwarded by
   *        the route handler — task 3.6) plus the two passwords from
   *        the request body. The `permissions`, `platformRole`,
   *        `shopId`, and `shopRole` fields determine which JWT shape
   *        we mint on the way out.
   * @param {string|null} [ip]         Client IP for audit context.
   * @param {string|null} [userAgent]  Client user-agent for audit context.
   *
   * @returns {Promise<{
   *   tokenPayload: object,
   *   tokenExpiry: '24h' | '5m',
   *   sessionVersion: number,
   * }>}
   *
   * @throws {{ statusCode: 400, code: 'VALIDATION_ERROR', message: string }}
   *         `newPassword` shorter than 12 characters.
   * @throws {{ statusCode: 401, code: 'SESSION_INVALID', message: string }}
   *         User row no longer exists.
   * @throws {{ statusCode: 401, code: 'INVALID_CREDENTIALS', message: string }}
   *         `currentPassword` does not match the stored bcrypt hash,
   *         or the row has no password set.
   *
   * Requirements: R20.7, R20.8
   * Design:       §5.5
   */
  async changePassword(
    {
      userId,
      currentPassword,
      newPassword,
      fullName = null,
      email,
      role,
      platformRole = null,
      shopId = null,
      shopRole = null,
      permissions,
    },
    ip = null,
    userAgent = null,
  ) {
    // ── 0. Belt-and-suspenders length check ────────────────────────
    // The route layer Zod schema enforces this too (task 3.6); we
    // repeat it so any direct in-process call still gets validated.
    // The 12-character floor matches the platform's auto-generated
    // Temp_Password length and the design §5.5 minimum.
    if (typeof newPassword !== 'string' || newPassword.length < 12) {
      throw {
        statusCode: 400,
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'New password must be at least 12 characters',
      }
    }

    const client = await getClient()
    let newSessionVersion
    try {
      await client.query('BEGIN')

      // ── 1. Re-load the user row (with hash) on the tx client ───
      // Using the same client means this read participates in the
      // same transaction as the update below — partial / interleaved
      // states are impossible.
      const user = await this.repository.findUserByIdWithHash(userId, client)
      if (!user) {
        // Hard-delete (or unknown id forwarded by a forged claim).
        // Treat as session revocation rather than 404 so the client
        // gets routed back through /login. Audit emit is fire-and-
        // forget so it survives the imminent ROLLBACK.
        await client.query('ROLLBACK')
        emitAudit('session_revoked', {
          actor_user_id: userId,
          target_type: 'user',
          target_id: userId,
          before: null,
          after: { reason: 'user_not_found' },
          ip_address: ip,
          user_agent: userAgent,
        })
        throw {
          statusCode: 401,
          code: ERROR_CODES.SESSION_INVALID,
          message: 'Session is no longer valid',
        }
      }

      // ── 2. Verify current password ─────────────────────────────
      // A row with no password_hash (legacy OTP-only account) is
      // treated identically to "wrong password" so the response can
      // never be used to probe account state (mirrors login()).
      const ok = user.password_hash
        ? await bcrypt.compare(currentPassword, user.password_hash)
        : false
      if (!ok) {
        await client.query('ROLLBACK')
        // Fire-and-forget so the failure audit survives the
        // ROLLBACK we just issued — emitInTx would have rolled the
        // audit row back along with everything else.
        emitAudit('password_change_failure', {
          actor_user_id: user.id,
          actor_role: platformRole || shopRole || role || null,
          actor_shop_id: shopId || null,
          target_type: 'user',
          target_id: user.id,
          before: null,
          after: { reason: 'wrong_current_password' },
          ip_address: ip,
          user_agent: userAgent,
        })
        throw {
          statusCode: 401,
          code: ERROR_CODES.INVALID_CREDENTIALS,
          message: 'Current password is incorrect',
        }
      }

      // ── 3. Re-hash the new password (cost 12, design §5.5) ─────
      const newHash = await bcrypt.hash(newPassword, 12)

      // ── 4. Update password_hash + clear force_password_change ──
      await this.repository.setPasswordTx(userId, newHash, client)

      // ── 5. Increment session_version (R20.8) ───────────────────
      // Every previously issued JWT becomes 401 SESSION_INVALID at
      // the auth plugin (task 3.7) the moment we COMMIT below.
      newSessionVersion = await this.repository.incrementSessionVersion(
        userId,
        client,
      )

      // ── 6. Audit (transactional) ───────────────────────────────
      // emitInTx so the success audit row commits atomically with
      // the password update — there must be no commit path where the
      // hash changes without an audit record proving why.
      await emitAuditInTx(client, 'password_changed', {
        actor_user_id: userId,
        actor_role: platformRole || shopRole || role || null,
        actor_shop_id: shopId || null,
        target_type: 'user',
        target_id: userId,
        before: null,
        after: { reason: 'self_change' },
        ip_address: ip,
        user_agent: userAgent,
      })

      await client.query('COMMIT')
    } catch (err) {
      // The wrong-password / not-found branches already issued their
      // own ROLLBACK; an extra ROLLBACK on a finished transaction is
      // a no-op-ish error in pg, so guard it.
      try {
        await client.query('ROLLBACK')
      } catch (_rollbackErr) {
        // intentionally swallowed — the original `err` is what matters
      }
      throw err
    } finally {
      client.release()
    }

    // ── 7. Build a fresh JWT payload mirroring the caller's scope ─
    // Permissions are forwarded verbatim from the caller's existing
    // token (the route handler trust-boundary). They do not change on
    // password rotation; only `session_version` does.
    const safePermissions = Array.isArray(permissions) ? permissions : []

    let tokenPayload
    let tokenExpiry
    if (platformRole) {
      // HQ JWT (24h) — design §5.6
      tokenPayload = {
        id: userId,
        role,
        platform_role: platformRole,
        full_name: fullName,
        email,
        permissions: safePermissions,
        session_version: newSessionVersion,
      }
      tokenExpiry = '24h'
    } else if (shopId) {
      // Shop-scoped JWT (24h) — design §5.6
      tokenPayload = {
        id: userId,
        role,
        shopId,
        shopRole,
        full_name: fullName,
        email,
        permissions: safePermissions,
        session_version: newSessionVersion,
      }
      tokenExpiry = '24h'
    } else {
      // STORE_PENDING interim JWT (5m) — design §5.6.
      // Realistically unreachable because require-no-force-password
      // restricts STORE_PENDING to a tiny set of routes that doesn't
      // include change-password mid-flow, but kept symmetrical for
      // forward compatibility.
      tokenPayload = {
        id: userId,
        role: 'STORE_PENDING',
        full_name: fullName,
        email,
        session_version: newSessionVersion,
      }
      tokenExpiry = '5m'
    }

    logAdminActivity(
      userId,
      'Password changed',
      'auth',
      userId,
      null,
      { kind: platformRole ? 'HQ' : shopId ? 'STORE' : 'STORE_PENDING' },
      ip,
    )

    return {
      tokenPayload,
      tokenExpiry,
      sessionVersion: newSessionVersion,
    }
  }
}

/**
 * Build a response-safe user view that explicitly excludes every
 * sensitive column. Whitelisting (rather than deleting from a clone)
 * makes it impossible to accidentally leak future columns added to
 * `findUserByEmailCI` — they have to be added here intentionally to
 * surface in any response body.
 *
 * Excluded by construction: `password_hash`,
 * `force_password_change_token`, `bank_account_number` (R18.11, R28.5).
 *
 * @param {object} u Row returned by `findUserByEmailCI`.
 * @returns {{
 *   id: string, email: string, full_name: string|null,
 *   phone: string|null, role: string, platform_role: string|null,
 *   is_active: boolean, is_blocked: boolean,
 *   force_password_change: boolean,
 * }}
 */
function sanitizeUser(u) {
  return {
    id: u.id,
    email: u.email,
    full_name: u.full_name,
    phone: u.phone,
    role: u.role,
    platform_role: u.platform_role,
    is_active: u.is_active,
    is_blocked: u.is_blocked,
    force_password_change: u.force_password_change,
  }
}

/**
 * Filter a JSONB permissions array against the canonical 37-string
 * Permission_String vocabulary (R17.1). Unknown strings are silently
 * dropped per R17.11 — this is the same effective-set rule applied
 * by the permission-check middleware and matches design §4.1.
 *
 * Unlike `assertValidPermissions`, this helper never throws — login
 * must succeed even when a Shop_Staff_Record contains a stale
 * permission string from an older seed. Emitting the
 * `invalid_permission_string_detected` audit is the responsibility
 * of the permission-check middleware (design §4.5), not the login
 * path.
 *
 * @param {unknown} arr
 * @returns {string[]} canonical-only subset, or [] if `arr` is not an array
 */
function filterCanonicalPermissions(arr) {
  if (!Array.isArray(arr)) return []
  const out = []
  for (const p of arr) {
    if (typeof p === 'string' && PERMISSIONS.has(p)) out.push(p)
  }
  return out
}

/**
 * Build a response-safe shop-assignment summary from a row returned
 * by `repository.loadActiveShopAssignments`. Whitelisted picks only
 * — the JSONB `permissions` array on the assignment is intentionally
 * dropped from the summary because the response body exposes the
 * effective permission set in the top-level `permissions` field
 * instead (design §5.3). Keeping the summary narrow also keeps the
 * `/me` payload small for hot-path dashboard renders.
 *
 * @param {{
 *   shop_id: string,
 *   shop_name: string,
 *   branch_code: string,
 *   shop_role: 'SHOP_ADMIN'|'SHOP_MANAGER'|'SHOP_STAFF'|'SHOP_VIEWER',
 * }} a
 * @returns {{
 *   shop_id: string,
 *   shop_name: string,
 *   branch_code: string,
 *   shop_role: 'SHOP_ADMIN'|'SHOP_MANAGER'|'SHOP_STAFF'|'SHOP_VIEWER',
 * }}
 */
function sanitizeAssignment(a) {
  return {
    shop_id: a.shop_id,
    shop_name: a.shop_name,
    branch_code: a.branch_code,
    shop_role: a.shop_role,
  }
}
