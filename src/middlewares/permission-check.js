/**
 * Permission-check middleware — server-side enforcement of the canonical
 * 37-string Permission_String vocabulary on every protected dashboard
 * route.
 *
 * `requirePermission(perm)` is a Fastify preHandler factory. At factory
 * call time (boot) it asserts that `perm` is a member of the canonical
 * vocabulary defined in `src/utils/permissions.js`; an unknown string
 * throws synchronously so the bug surfaces during route registration
 * rather than at runtime (this is the hook task 2.7 walks via
 * `fastify.printRoutes()` to enforce R17 AC#9 — every protected route
 * MUST declare a `requiredPermission` drawn from the canonical
 * vocabulary).
 *
 * The factory attaches the validated `perm` string as
 * `preHandler.requiredPermission` so the boot-time route audit (task
 * 2.7) can introspect declared permissions without re-parsing route
 * metadata. Route authors typically also stash the same string under
 * `routeOptions.config.requiredPermission` for OpenAPI emission; both
 * sources must agree.
 *
 * Per-request, the returned preHandler:
 *
 *   1. Computes the requester's effective permission set following
 *      design §4.1:
 *        - HQ_User (request.user.platform_role ∈ HQ_ROLES) →
 *          `HQ_ROLE_PERMISSIONS[platform_role]`
 *        - Shop staff (request.user.permissions array hydrated from
 *          the active Shop_Staff_Record JSONB by login) →
 *          the array filtered to elements present in
 *          `CANONICAL_PERMISSIONS` (R17 AC#11)
 *        - Otherwise → empty set
 *   2. Emits a fire-and-forget `invalid_permission_string_detected`
 *      audit row per offending element when filtering shop-staff
 *      permissions (R17 AC#11). Computation uses the filtered set
 *      regardless of whether emission succeeds.
 *   3. If `perm` is not in the effective set, emits a fire-and-forget
 *      `permission_denied` audit row capturing requester id, shop id,
 *      method, path, required permission, IP, and user-agent
 *      (R17 AC#10), then returns HTTP 403 with the canonical body
 *      `{ success:false, message, code: 'PERMISSION_DENIED',
 *        ...(isHQ ? { required: perm } : {}) }` (R17 AC#7).
 *      The `required` field is included only for HQ_Users so non-HQ
 *      callers cannot enumerate permission names by probing endpoints.
 *   4. Otherwise resolves with `undefined` to allow the route handler
 *      to proceed.
 *
 * Must be registered AFTER `fastify.authenticate` (which populates
 * `request.user`) and AFTER `requireShopScope` (which populates
 * `request.shopId`). The middleware does NOT itself extract shop
 * scope — it reads the values prepared by upstream preHandlers per
 * design §4.4 / §4.5.
 *
 * Requirements: R17.2, R17.3, R17.7, R17.10
 *               (with R17.11 invalid-string handling as a side-effect)
 * Design:       §4.1, §4.5 of .kiro/specs/multi-vendor-system/design.md
 *
 * @module middlewares/permission-check
 */

import { CANONICAL_PERMISSIONS, HQ_ROLE_PERMISSIONS, HQ_ROLES } from '../utils/permissions.js'
import { emit as emitAudit } from '../utils/audit-log.js'
import { ERROR_CODES } from '../constants/errors.js'
import { logger } from '../config/logger.js'

/**
 * Frozen empty permission set returned when the requester has no
 * effective permissions (e.g., unauthenticated, or a shop staff
 * member whose JWT carries an empty / missing `permissions` claim).
 *
 * Reused by every miss to avoid allocating a new Set on every
 * request — `Set.prototype.has` is the only operation called on
 * the result and treating it as read-only is safe.
 *
 * @type {Readonly<Set<string>>}
 */
const EMPTY_SET = Object.freeze(new Set())

/**
 * True when `user` carries an HQ_Role on `platform_role`. The five
 * legal values are listed in `HQ_ROLES` (design §4.2). Note that the
 * legacy `role === 'ADMIN'` JWT field is intentionally NOT checked
 * here — design §4.5 keys HQ detection off `platform_role` because
 * the canonical 37-string vocabulary maps role → permissions via
 * `HQ_ROLE_PERMISSIONS[platform_role]`. Tokens still carrying only
 * the legacy `role: 'ADMIN'` claim without `platform_role` will
 * resolve to the empty effective set and be denied — by design —
 * which forces the auth layer to populate `platform_role` per
 * design §5.1.
 *
 * @param {{ platform_role?: string } | null | undefined} user
 * @returns {boolean}
 */
function isHqUser(user) {
  if (!user || typeof user !== 'object') return false
  return typeof user.platform_role === 'string' && HQ_ROLES.includes(user.platform_role)
}

/**
 * Best-effort extraction of the actor's role label for the audit row.
 * Mirrors the precedence used by other security audit emitters in the
 * codebase (shop-scope.js → cross_shop_access_blocked): prefer the
 * canonical platform_role for HQ_Users, fall back to shopRole for
 * shop staff, then the legacy `role` claim.
 *
 * @param {{ platform_role?: string, shopRole?: string, role?: string } | null | undefined} user
 * @returns {string | null}
 */
function actorRoleOf(user) {
  if (!user || typeof user !== 'object') return null
  return user.platform_role ?? user.shopRole ?? user.role ?? null
}

/**
 * Split a raw shop-staff permissions array (the JSONB stored on the
 * Shop_Staff_Record, hydrated onto the JWT at login) into the
 * canonical-membership subset and the list of offending values.
 *
 * Used by the preHandler to compute the effective set AND to emit one
 * `invalid_permission_string_detected` audit row per invalid element
 * (R17 AC#11). Exposed for tests so the partitioning behaviour can be
 * asserted directly without spinning up a Fastify request.
 *
 * Non-string elements (numbers, nulls, objects) are also reported as
 * invalid — the canonical vocabulary contains only strings, so any
 * other JSON value cannot match.
 *
 * @param {unknown[]} arr
 * @returns {{ valid: Set<string>, invalid: unknown[] }}
 */
export function partitionShopPermissions(arr) {
  const valid = new Set()
  const invalid = []
  for (const perm of arr) {
    if (typeof perm === 'string' && CANONICAL_PERMISSIONS.has(perm)) {
      valid.add(perm)
    } else {
      invalid.push(perm)
    }
  }
  return { valid, invalid }
}

/**
 * Compute the requester's effective permission set per design §4.1.
 *
 * Pure function: depends only on `user`, performs no I/O, and emits
 * no audit rows. Detection of invalid Permission_String elements in
 * the stored shop-staff JSONB array (R17 AC#11) is delegated to
 * {@link partitionShopPermissions} so the preHandler can emit the
 * required audit row for each offending value while keeping this
 * helper side-effect free for unit and property tests.
 *
 * Resolution rules:
 *
 *   1. HQ_User (`user.platform_role` ∈ `HQ_ROLES`) →
 *      `HQ_ROLE_PERMISSIONS[platform_role]` (already a frozen Set
 *      drawn entirely from the canonical vocabulary, so no filter
 *      is required).
 *   2. Shop staff (anything with a `permissions` array on the JWT
 *      payload) → the array filtered to elements in
 *      `CANONICAL_PERMISSIONS`.
 *   3. Otherwise → frozen empty set.
 *
 * The Sets returned for HQ_Users are the frozen exports from
 * `src/utils/permissions.js` and MUST NOT be mutated. The Set
 * returned for shop staff is freshly allocated on each call.
 *
 * Requirements: R17.3, R17.11
 * Design:       §4.1
 *
 * @param {{ platform_role?: string, permissions?: unknown } | null | undefined} user
 * @returns {Set<string>} the effective permission set
 */
export function computeEffectivePermissions(user) {
  if (isHqUser(user)) {
    // `HQ_ROLE_PERMISSIONS[role]` is a frozen Set whose elements are
    // already canonical, so no filtering is needed. Treat as read-only.
    return HQ_ROLE_PERMISSIONS[user.platform_role] ?? EMPTY_SET
  }

  if (user && Array.isArray(user.permissions)) {
    const { valid } = partitionShopPermissions(user.permissions)
    return valid
  }

  return EMPTY_SET
}

/**
 * Fastify preHandler factory: enforce that the authenticated requester
 * carries `perm` in their effective permission set. See the module
 * header for the full per-request decision flow.
 *
 * Boot-time validation: `perm` MUST be a member of
 * `CANONICAL_PERMISSIONS`. An unknown string throws a `TypeError`
 * synchronously so the misconfigured route fails registration —
 * leveraged by task 2.7's boot-time route audit (R17 AC#9).
 *
 * Returned function exposes `.requiredPermission = perm` so the boot
 * audit can introspect every preHandler attached to a route without
 * re-parsing route metadata.
 *
 * Requirements: R17.2, R17.3, R17.7, R17.10
 * Design:       §4.5
 *
 * @param {string} perm — canonical Permission_String required by the route
 * @returns {((request: import('fastify').FastifyRequest,
 *             reply:  import('fastify').FastifyReply) => Promise<void>) &
 *           { requiredPermission: string }}
 * @throws {TypeError} when `perm` is not in the canonical vocabulary
 */
export function requirePermission(perm) {
  if (typeof perm !== 'string' || !CANONICAL_PERMISSIONS.has(perm)) {
    throw new TypeError(
      `requirePermission: '${perm}' is not in the canonical Permission_String vocabulary ` +
        '(see src/utils/permissions.js / design §4.2)',
    )
  }

  /**
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   */
  async function permissionPreHandler(request, reply) {
    const user = request.user ?? null

    // ── R17 AC#11: emit invalid_permission_string_detected per offending
    // element BEFORE the membership check so the audit row exists even
    // when the request would otherwise succeed (the offending values are
    // dropped from the effective set regardless).
    if (!isHqUser(user) && user && Array.isArray(user.permissions)) {
      const { invalid } = partitionShopPermissions(user.permissions)
      if (invalid.length > 0) {
        const actorShopId = request.shopId ?? user.shopId ?? user.shop_id ?? null
        for (const offending of invalid) {
          try {
            emitAudit('invalid_permission_string_detected', {
              actor_user_id: user.id ?? null,
              actor_role: actorRoleOf(user),
              actor_shop_id: actorShopId,
              target_type: 'shop_staff',
              target_id: user.id ?? null,
              before: null,
              after: { offending_value: offending },
              ip_address: request.ip ?? null,
              user_agent: request.headers?.['user-agent'] ?? null,
            })
          } catch (err) {
            // Audit emit validates synchronously; swallow any caller-bug
            // errors so the security path stays open. The logger.error
            // ensures the failure is still observable.
            logger.error(
              { err, userId: user.id ?? null, action: 'invalid_permission_string_detected' },
              'audit emit failed for invalid_permission_string_detected',
            )
          }
        }
      }
    }

    const effective = computeEffectivePermissions(user)
    if (effective.has(perm)) {
      return // allow — route handler runs next
    }

    // ── R17 AC#10: persist permission_denied audit before responding.
    // Emission is fire-and-forget (setImmediate inside emitAudit) so the
    // 403 response is not delayed. The audit row carries everything
    // R17 AC#10 requires: requester id (or null), resolved shop_id,
    // attempted method+path, the required Permission_String, plus IP
    // and user-agent for forensic context.
    const isHQ = isHqUser(user)
    const routePath = request.routeOptions?.url ?? request.url
    try {
      emitAudit('permission_denied', {
        actor_user_id: user?.id ?? null,
        actor_role: actorRoleOf(user),
        actor_shop_id: request.shopId ?? user?.shopId ?? user?.shop_id ?? null,
        target_type: 'route',
        target_id: null,
        before: null,
        after: {
          method: request.method,
          path: routePath,
          required: perm,
        },
        ip_address: request.ip ?? null,
        user_agent: request.headers?.['user-agent'] ?? null,
      })
    } catch (err) {
      logger.error(
        { err, userId: user?.id ?? null, required: perm, action: 'permission_denied' },
        'audit emit failed for permission_denied',
      )
    }

    return reply.code(403).send({
      success: false,
      message: 'Forbidden — permission denied',
      code: ERROR_CODES.PERMISSION_DENIED,
      ...(isHQ ? { required: perm } : {}),
    })
  }

  // Boot-time route audit (task 2.7) reads this property to assert every
  // protected route declares a canonical Permission_String. Defined as
  // a non-writable own property so accidental reassignment fails fast.
  Object.defineProperty(permissionPreHandler, 'requiredPermission', {
    value: perm,
    writable: false,
    enumerable: true,
    configurable: false,
  })

  return permissionPreHandler
}
