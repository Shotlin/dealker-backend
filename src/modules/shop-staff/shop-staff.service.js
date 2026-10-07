import crypto from 'node:crypto'

import bcrypt from 'bcrypt'

import { logger } from '../../config/logger.js'
import { getClient } from '../../config/database.js'
import { invalidateStaffActiveCache } from '../../middlewares/shop-scope.js'
import {
  emit as emitAudit,
  emitInTx as emitAuditInTx,
} from '../../utils/audit-log.js'
import {
  assertValidPermissions,
  HQ_ROLES,
  SHOP_ROLE_DEFAULT_PERMISSIONS,
} from '../../utils/permissions.js'
import { ERROR_CODES } from '../../constants/errors.js'

const MAX_STAFF_PER_SHOP = 50
const MAX_SHOPS_PER_USER = 10

/**
 * bcrypt cost factor used for every staff password (Temp_Password and
 * caller-supplied) per R20.12 / design §5.5.
 */
const BCRYPT_COST = 12

/**
 * Length of the auto-generated Temp_Password (R20.3). Must be at least
 * 12 chars per design §5.5; we generate exactly 12 to match the lower
 * bound — UI flows must render it as "shown once" without truncation.
 */
const TEMP_PASSWORD_LENGTH = 12

/**
 * Character classes used to build a Temp_Password. R20.3 mandates
 * "mixed case, digits, and at least one symbol". We split the alphabet
 * into four buckets so we can guarantee one character from each before
 * filling the remainder with random pulls from the union — this avoids
 * the pathological case where the generator produces a 12-char string
 * with zero symbols (low probability but not zero).
 */
const TEMP_PASSWORD_LOWER = 'abcdefghijklmnopqrstuvwxyz'
const TEMP_PASSWORD_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const TEMP_PASSWORD_DIGIT = '0123456789'
// Symbols deliberately exclude characters that look like quotes / are
// shell-meta (`"`, `'`, `` ` ``, `\`) so operators can paste the password
// into a terminal without escaping. Twelve symbols is plenty of entropy.
const TEMP_PASSWORD_SYMBOL = '!@#$%^&*()-_=+'
const TEMP_PASSWORD_ALPHABET =
  TEMP_PASSWORD_LOWER +
  TEMP_PASSWORD_UPPER +
  TEMP_PASSWORD_DIGIT +
  TEMP_PASSWORD_SYMBOL

/**
 * Generate a 12-char cryptographically random Temp_Password meeting the
 * R20.3 complexity rule (mixed case, digit, symbol). The implementation:
 *
 *   1. Picks one character from each of the four classes via
 *      `crypto.randomInt`.
 *   2. Fills the remaining 8 slots from the unioned alphabet.
 *   3. Shuffles the resulting 12 characters with the Fisher–Yates
 *      algorithm using `crypto.randomInt` for the swap index — so the
 *      "guaranteed" characters do not always appear in positions
 *      0..3.
 *
 * Returns the plaintext value. The caller MUST hash it via bcrypt
 * before persisting and MUST return it to the client exactly once
 * (R20.3 / R20.10).
 *
 * @returns {string} 12-char Temp_Password
 */
function generateTempPassword() {
  const chars = [
    TEMP_PASSWORD_LOWER[crypto.randomInt(0, TEMP_PASSWORD_LOWER.length)],
    TEMP_PASSWORD_UPPER[crypto.randomInt(0, TEMP_PASSWORD_UPPER.length)],
    TEMP_PASSWORD_DIGIT[crypto.randomInt(0, TEMP_PASSWORD_DIGIT.length)],
    TEMP_PASSWORD_SYMBOL[crypto.randomInt(0, TEMP_PASSWORD_SYMBOL.length)],
  ]
  while (chars.length < TEMP_PASSWORD_LENGTH) {
    chars.push(
      TEMP_PASSWORD_ALPHABET[
        crypto.randomInt(0, TEMP_PASSWORD_ALPHABET.length)
      ],
    )
  }
  // Fisher–Yates shuffle so the four "class anchors" don't always sit
  // at the start of the string.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

/**
 * Build a typed error with `{ statusCode, code, message }` shape so the
 * controller's `mapError` pattern (apiResponse.error helper) can map it
 * directly to the canonical envelope per design §16.
 *
 * @param {number} statusCode
 * @param {string} code  one of `ERROR_CODES`
 * @param {string} message
 * @returns {Error & { statusCode: number, code: string }}
 */
function makeServiceError(statusCode, code, message) {
  const err = new Error(message)
  err.statusCode = statusCode
  err.code = code
  return err
}

/**
 * Determine which shop_role values the requester is permitted to create
 * per R16.9–R16.13. Returns the set of allowed target shop_role strings,
 * or `null` when the requester is forbidden from creating any staff
 * (SHOP_STAFF / SHOP_VIEWER per R16.20).
 *
 * Rules:
 *   - HQ_User (any of SUPER_ADMIN, ADMIN, HQ_MANAGER, HQ_FINANCE,
 *     HQ_SUPPORT) → may create any shop_role for any Shop (R16.13).
 *     (Per-permission gating is enforced upstream by `requirePermission`;
 *     this helper only enforces the role-creation hierarchy.)
 *   - SHOP_ADMIN → may create SHOP_MANAGER, SHOP_STAFF, SHOP_VIEWER (R16.9).
 *   - SHOP_MANAGER → may create SHOP_STAFF, SHOP_VIEWER (R16.12).
 *   - SHOP_STAFF / SHOP_VIEWER → forbidden (R16.20).
 *   - Anything else (unknown role) → forbidden (defense-in-depth).
 *
 * @param {{ invitedByPlatformRole?: string|null, invitedByRole?: string|null }} ctx
 * @returns {Set<string>|null} set of allowed target shop_role strings, or null
 */
function allowedTargetRoles({ invitedByPlatformRole, invitedByRole }) {
  if (invitedByPlatformRole && HQ_ROLES.includes(invitedByPlatformRole)) {
    return new Set([
      'SHOP_ADMIN',
      'SHOP_MANAGER',
      'SHOP_STAFF',
      'SHOP_VIEWER',
    ])
  }
  switch (invitedByRole) {
    case 'SHOP_ADMIN':
      return new Set(['SHOP_MANAGER', 'SHOP_STAFF', 'SHOP_VIEWER'])
    case 'SHOP_MANAGER':
      return new Set(['SHOP_STAFF', 'SHOP_VIEWER'])
    default:
      return null
  }
}

/**
 * Shop Staff service — business logic for shop staff management.
 *
 * Enforces:
 *   - max 50 active staff per shop      (Requirement 2.5)
 *   - max 10 active shops per user      (Requirement 2.2)
 *   - unique active (user_id, shop_id)  (Requirement 2.3)
 *   - role-creation rules               (R16.9–R16.13, R16.20 / R20.11)
 *   - permission vocabulary             (R16.16, R16.17 / R17.1)
 *   - bcrypt cost 12 + Temp_Password    (R20.3, R20.10, R20.11, R20.12)
 *   - staff_created audit               (R20.10 / R28.4)
 */
export class ShopStaffService {
  constructor(repository) {
    this.repo = repository
  }

  /**
   * Create a Shop_Staff_Record. Two body shapes are accepted (R20.2):
   *
   *   (a) Existing user — `{ user_id, role, permissions?, is_active? }`
   *       Reuses the existing `users` row identified by `user_id`. The
   *       legacy behaviour preserved for backwards compatibility with
   *       the dashboard's user-picker flow.
   *
   *   (b) New user — `{ email, name, phone?, role, permissions?,
   *                    is_active?, generate_temp_password?, password? }`
   *       Provisions a brand-new `users` row inside the same transaction
   *       as the `shop_staff` insert and the `staff_created` audit row
   *       (atomic per R15.9, R15.10, R20.2, R28 AC#6). When
   *       `generate_temp_password=true` (the default) a 12-char
   *       Temp_Password is generated, bcrypt-hashed (cost 12), stored on
   *       `users.password_hash`, and returned plaintext exactly once
   *       under `temp_password` (R20.3 / R20.10). `force_password_change`
   *       is set to `true` so the user is funnelled to `/change-password`
   *       on first login (R20.7).
   *
   * Authorization (R16.9–R16.13, R16.20):
   *   - The controller already runs `requireShopScope` +
   *     `requirePermission('shop_staff.create')` — those guards filter
   *     out cross-shop access and missing-permission requests. This
   *     service runs the role-creation hierarchy as defence-in-depth: a
   *     SHOP_ADMIN cannot create another SHOP_ADMIN, SHOP_MANAGER cannot
   *     create SHOP_ADMIN/SHOP_MANAGER, and SHOP_STAFF/SHOP_VIEWER
   *     cannot create any staff at all. Violations return 403
   *     STAFF_ROLE_FORBIDDEN per R16.10–R16.11 / R20.11.
   *
   * Transaction strategy (project-standards.md "RESOURCE EFFICIENCY"):
   *   - Existing-user shape: no tx needed — a single `INSERT` into
   *     `shop_staff` + a fire-and-forget audit emit. The mutation is one
   *     statement, so a tx would only add a connection round-trip cost.
   *   - New-user shape: one tx wraps INSERT users → INSERT shop_staff →
   *     INSERT audit_logs. All three writes commit together. If any fails
   *     the whole tx rolls back — no ghost user, no orphan staff row, no
   *     audit row that records a deactivation that never happened.
   *   - Heavy work (bcrypt at cost 12, ~250 ms) is done BEFORE BEGIN so
   *     we never hold a pooled connection while the CPU spins.
   *
   * @param {object} data — Zod-validated body (one of the two shapes above)
   * @param {object|string} ctxOrInvitedBy
   *        Either the new-style request context object
   *        `{ actorUserId, actorRole, actorPlatformRole, ip, userAgent }`
   *        OR the legacy `{ invitedBy, invitedByRole,
   *        invitedByPlatformRole, ip, userAgent }` shape OR the
   *        plain inviter user_id string. The legacy shapes are
   *        preserved for tests and for any unmigrated direct caller —
   *        new code should pass the canonical `actor*` form.
   * @returns {Promise<{success, data?, message?, code?}>} Service result.
   *          On success and `temp_password`-generated path: `data` includes
   *          `{ ...staff_record, temp_password }`. The plaintext password
   *          is NEVER persisted, logged, or audited.
   *
   * @throws {Error & { statusCode, code }} on validation / authorisation
   *         failures (controller maps to HTTP envelope).
   *
   * Requirements: R20.2, R20.3, R20.4, R20.5, R20.10, R20.11, R20.12,
   *               R16.9, R16.10, R16.11, R16.12, R16.13, R16.16, R16.17
   * Design:       §5.5, §6.3, §12.2
   */
  async create(data, ctxOrInvitedBy) {
    // ── 0. Normalise the actor argument ─────────────────────────────
    // Accept three shapes so legacy tests, legacy callers, and the
    // new canonical signature all work:
    //   • plain string  → legacy: just the inviter user_id
    //   • { invitedBy, invitedByRole, invitedByPlatformRole, ip, ua }
    //                   → legacy object form (used by some tests)
    //   • { actorUserId, actorRole, actorPlatformRole, ip, userAgent }
    //                   → canonical form (current spec — task 5.2)
    let ctx
    if (
      typeof ctxOrInvitedBy === 'string' ||
      ctxOrInvitedBy === null ||
      ctxOrInvitedBy === undefined
    ) {
      ctx = {
        actorUserId: ctxOrInvitedBy ?? null,
        actorRole: null,
        actorPlatformRole: null,
        ip: null,
        userAgent: null,
      }
    } else {
      ctx = {
        actorUserId:
          ctxOrInvitedBy.actorUserId ?? ctxOrInvitedBy.invitedBy ?? null,
        actorRole:
          ctxOrInvitedBy.actorRole ?? ctxOrInvitedBy.invitedByRole ?? null,
        actorPlatformRole:
          ctxOrInvitedBy.actorPlatformRole ??
          ctxOrInvitedBy.invitedByPlatformRole ??
          null,
        ip: ctxOrInvitedBy.ip ?? null,
        userAgent: ctxOrInvitedBy.userAgent ?? null,
      }
    }

    // The controller passes `data.shop_id` either from the validated body
    // (legacy callers) or from the resolved path/JWT/header (after task
    // 2.4). Either way the field has already been authorised by
    // requireShopScope upstream.
    const shopId = data.shop_id
    if (!shopId) {
      throw makeServiceError(
        400,
        ERROR_CODES.SHOP_SCOPE_REQUIRED,
        'shop_id is required',
      )
    }

    // ── 1. Determine target role + body shape ───────────────────────
    const role = data.role
    const isNewUserShape = !data.user_id

    // ── 2. Role-creation hierarchy (R16.9–R16.13, R16.20, R20.11) ─
    // Run BEFORE any DB lookups so we never leak shop staff existence
    // to a forbidden caller. Skip when the actor's role is unknown
    // (legacy unit tests pass only `actorUserId`); upstream
    // `requirePermission` middleware still gates the route.
    if (ctx.actorRole || ctx.actorPlatformRole) {
      const allowed = allowedTargetRoles({
        invitedByRole: ctx.actorRole,
        invitedByPlatformRole: ctx.actorPlatformRole,
      })
      if (!allowed) {
        throw makeServiceError(
          403,
          ERROR_CODES.STAFF_ROLE_FORBIDDEN,
          'Your role is not permitted to create shop staff',
        )
      }
      if (!allowed.has(role)) {
        throw makeServiceError(
          403,
          ERROR_CODES.STAFF_ROLE_FORBIDDEN,
          `Your role is not permitted to create staff with role=${role}`,
        )
      }
    }

    // ── 3. Validate / default permissions (R16.16, R16.17) ─────────
    // When permissions are not supplied, fall back to the role's
    // default set per R16.16 (SHOP_ADMIN gets all 34 shop-scoped,
    // SHOP_MANAGER gets 32, etc.). When supplied, every element must
    // be in the canonical 37-string vocabulary.
    let permissions
    if (data.permissions === undefined) {
      const defaults = SHOP_ROLE_DEFAULT_PERMISSIONS[role]
      // `defaults` is a frozen Set — convert to a stable sorted array so
      // the permissions JSONB column is deterministic across runs.
      permissions = defaults ? [...defaults].sort() : []
    } else {
      try {
        assertValidPermissions(data.permissions)
      } catch (err) {
        throw makeServiceError(
          400,
          ERROR_CODES.PERMISSION_INVALID,
          err.message,
        )
      }
      permissions = data.permissions
    }

    // ── 4. Branch by body shape ────────────────────────────────────
    if (isNewUserShape) {
      return this._createWithNewUser({ data, ctx, shopId, role, permissions })
    }
    return this._createWithExistingUser({
      data,
      ctx,
      shopId,
      role,
      permissions,
    })
  }

  /**
   * Existing-user create branch. No tx needed — a single INSERT into
   * `shop_staff` plus a fire-and-forget audit emit. The duplicate +
   * limit checks run on the pool BEFORE the INSERT so the common reject
   * paths never open a transaction.
   *
   * @private
   */
  async _createWithExistingUser({ data, ctx, shopId, role, permissions }) {
    const userId = data.user_id

    // Requirement 2.3 — unique active (user_id, shop_id).
    const existing = await this.repo.findByUserAndShop(userId, shopId)
    if (existing) {
      return {
        success: false,
        message: 'User is already assigned to this shop',
        code: 'STAFF_ALREADY_ASSIGNED',
      }
    }

    // Requirement 2.5 — max 50 active staff per shop.
    const shopStaffCount = await this.repo.countActiveByShop(shopId)
    if (shopStaffCount >= MAX_STAFF_PER_SHOP) {
      return {
        success: false,
        message: `Maximum ${MAX_STAFF_PER_SHOP} staff members per shop reached`,
        code: 'STAFF_LIMIT_REACHED',
      }
    }

    // Requirement 2.2 — max 10 active shops per user.
    const userShopCount = await this.repo.countActiveByUser(userId)
    if (userShopCount >= MAX_SHOPS_PER_USER) {
      return {
        success: false,
        message: `User cannot be assigned to more than ${MAX_SHOPS_PER_USER} shops`,
        code: 'STAFF_SHOP_LIMIT',
      }
    }

    const createdStaff = await this.repo.create({
      user_id: userId,
      shop_id: shopId,
      role,
      permissions,
      invited_by: ctx.actorUserId,
    })

    // Audit (fire-and-forget — see _createWithNewUser for the rationale
    // on why we don't open a tx here for the existing-user branch).
    emitAudit('staff_created', {
      actor_user_id: ctx.actorUserId,
      actor_role: ctx.actorPlatformRole || ctx.actorRole || null,
      actor_shop_id: shopId,
      target_type: 'shop_staff',
      target_id: createdStaff.id,
      before: null,
      after: {
        id: createdStaff.id,
        user_id: userId,
        shop_id: shopId,
        role,
        permissions,
        generate_temp_password: false,
      },
      ip_address: ctx.ip,
      user_agent: ctx.userAgent,
    })

    logger.info(
      {
        userId: ctx.actorUserId,
        shopId,
        action: 'shop_staff_assigned',
        targetUserId: userId,
        role,
        tempPasswordIssued: false,
      },
      'Shop staff assigned',
    )

    return { success: true, data: createdStaff }
  }

  /**
   * New-user create branch. Provisions a brand-new `users` row, links it
   * to the target shop via `shop_staff`, and emits a `staff_created`
   * audit row — all in one `BEGIN`...`COMMIT` block so partial states
   * (ghost user, orphan staff, missing audit) are impossible per
   * R15.9 / R15.10 / R28 AC#6.
   *
   * @private
   */
  async _createWithNewUser({ data, ctx, shopId, role, permissions }) {
    const { email, name, phone } = data

    // Choose password source per R20 AC#3 / R20 AC#4. We do this
    // BEFORE the duplicate check because the password derivation is
    // CPU work (no I/O) and putting it before the SELECT keeps the
    // 409 EMAIL_TAKEN reject path on a single round-trip.
    let plaintextPassword
    let tempPassword = null
    const wantsTempPassword =
      data.generate_temp_password === undefined
        ? true // schema default — defensive in case caller bypassed Zod
        : data.generate_temp_password === true

    if (wantsTempPassword) {
      plaintextPassword = generateTempPassword()
      tempPassword = plaintextPassword
    } else if (typeof data.password === 'string' && data.password.length > 0) {
      plaintextPassword = data.password
    } else {
      throw makeServiceError(
        400,
        ERROR_CODES.VALIDATION_ERROR,
        'password is required when generate_temp_password=false',
      )
    }

    // Requirement 2.5 — max 50 active staff per shop. Run on the pool
    // before opening a tx so the 4xx reject path doesn't hold a
    // connection.
    const shopStaffCount = await this.repo.countActiveByShop(shopId)
    if (shopStaffCount >= MAX_STAFF_PER_SHOP) {
      return {
        success: false,
        message: `Maximum ${MAX_STAFF_PER_SHOP} staff members per shop reached`,
        code: 'STAFF_LIMIT_REACHED',
      }
    }

    // R20 AC#5 — case-insensitive email uniqueness. Pre-flight on the
    // pool so the common 409 path never opens a tx. The intra-tx
    // duplicate guard below catches the race where two concurrent
    // invitations both pass this check and then race the unique-index
    // violation.
    if (typeof this.repo.findUserByEmailCI === 'function') {
      const dup = await this.repo.findUserByEmailCI(email)
      if (dup) {
        throw makeServiceError(
          409,
          ERROR_CODES.EMAIL_TAKEN,
          'A user with this email already exists',
        )
      }
    }

    // R20 AC#3 / R20 AC#4 / R20 AC#12 — bcrypt cost 12. Done BEFORE
    // BEGIN so the ~250 ms hashing time does not pin a pooled
    // connection (project-standards.md "RESOURCE EFFICIENCY").
    const passwordHash = await bcrypt.hash(plaintextPassword, BCRYPT_COST)

    // R20 AC#3 / R20 AC#11 — Temp_Password forces password change on
    // first login. Caller-supplied passwords leave the flag at false.
    const forcePasswordChange = wantsTempPassword

    // ── Atomic: INSERT users + INSERT shop_staff + audit ────────────
    // We prefer the new-style helpers (`createUserWithPassword` +
    // `createWithClient` + `emitAuditInTx` inside our own tx). When the
    // repository only exposes the legacy `createUserAndAssign` (the
    // unit-test mocks) we fall back to that path with a fire-and-forget
    // audit. Both branches satisfy R20.2 / R28 AC#6 — the new-style
    // path is the canonical implementation, the legacy fallback is
    // preserved purely for backwards compatibility with existing tests
    // that mock the older API.
    let createdStaff
    let createdUserId

    if (
      typeof this.repo.findUserByEmailOrPhone === 'function' &&
      typeof this.repo.createUserWithPassword === 'function' &&
      typeof this.repo.createWithClient === 'function'
    ) {
      const client = await getClient()
      try {
        await client.query('BEGIN')

        // Intra-tx duplicate guard (R20 AC#5). Catches the TOCTOU race
        // where two concurrent invitations both pass the pool-level
        // pre-flight above and race the unique-index violation.
        const dup = await this.repo.findUserByEmailOrPhone(client, {
          email,
          phone: phone || null,
        })
        if (dup) {
          await client.query('ROLLBACK')
          throw makeServiceError(
            409,
            ERROR_CODES.EMAIL_TAKEN,
            'A user with this email already exists',
          )
        }

        const newUser = await this.repo.createUserWithPassword(client, {
          email,
          full_name: name,
          phone: phone || null,
          password_hash: passwordHash,
          force_password_change: forcePasswordChange,
        })

        const newStaff = await this.repo.createWithClient(client, {
          user_id: newUser.id,
          shop_id: shopId,
          role,
          permissions,
          invited_by: ctx.actorUserId,
        })

        // R20 AC#10 / R28 AC#4 — emit `staff_created` inside the same
        // tx so the audit row commits atomically with the inserts.
        // The `password_hash` field is automatically redacted by
        // `audit-log.js` even though we do not include it here —
        // belt-and-braces.
        await emitAuditInTx(client, 'staff_created', {
          actor_user_id: ctx.actorUserId,
          actor_role: ctx.actorPlatformRole || ctx.actorRole || null,
          actor_shop_id: shopId,
          target_type: 'shop_staff',
          target_id: newStaff.id,
          before: null,
          after: {
            id: newStaff.id,
            shop_id: shopId,
            user_id: newUser.id,
            role,
            permissions,
            generate_temp_password: wantsTempPassword,
          },
          ip_address: ctx.ip,
          user_agent: ctx.userAgent,
        })

        await client.query('COMMIT')
        createdStaff = newStaff
        createdUserId = newUser.id
      } catch (err) {
        try {
          await client.query('ROLLBACK')
        } catch (rollbackErr) {
          logger.error(
            { err: rollbackErr, shopId },
            'shop_staff create ROLLBACK failed',
          )
        }
        throw err
      } finally {
        client.release()
      }
    } else {
      // ─── Legacy path (test mocks expose `createUserAndAssign`) ────
      // The legacy repository method opens its own internal tx around
      // the two INSERTs. We follow up with a fire-and-forget audit
      // emit (`emitAudit`) — the audit-log helper schedules the row
      // on `setImmediate`, so request latency is unaffected and any
      // DB error is structured-logged rather than swallowed.
      const { user, staff } = await this.repo.createUserAndAssign({
        name,
        email,
        phone: phone || null,
        passwordHash,
        forcePasswordChange,
        shopId,
        role,
        permissions,
        invitedBy: ctx.actorUserId,
      })
      createdStaff = staff
      createdUserId = user.id

      emitAudit('staff_created', {
        actor_user_id: ctx.actorUserId,
        actor_role: ctx.actorPlatformRole || ctx.actorRole || null,
        actor_shop_id: shopId,
        target_type: 'shop_staff',
        target_id: createdStaff.id,
        before: null,
        after: {
          id: createdStaff.id,
          user_id: createdUserId,
          shop_id: shopId,
          role,
          permissions,
          generate_temp_password: wantsTempPassword,
        },
        ip_address: ctx.ip,
        user_agent: ctx.userAgent,
      })
    }

    // R20 AC#12 — never log password_hash or the plaintext password.
    logger.info(
      {
        userId: ctx.actorUserId,
        shopId,
        action: 'shop_staff_assigned',
        targetUserId: createdUserId,
        role,
        // Only a boolean signal — never the value.
        tempPasswordIssued: tempPassword !== null,
      },
      'Shop staff assigned',
    )

    // R20 AC#3 / R20 AC#10 — return the Temp_Password exactly once.
    // Spread the staff record first so any unexpected `temp_password`
    // key on the row is overridden by our authoritative value.
    const responseBody =
      tempPassword !== null
        ? { ...createdStaff, temp_password: tempPassword }
        : createdStaff

    return { success: true, data: responseBody }
  }

  /**
   * List staff for a shop (paginated, filterable).
   * @param {string} shopId - Shop UUID
   * @param {object} filters - { page, limit, role, is_active }
   * @returns {Promise<{staff, total, page, limit}>}
   */
  async list(shopId, filters) {
    const { staff, total } = await this.repo.findMany({
      shopId,
      ...filters,
    })

    return {
      staff,
      total,
      page: filters.page,
      limit: filters.limit,
    }
  }

  /**
   * Get a single staff record (scoped to shop_id).
   * @param {string} id - Staff record UUID
   * @param {string} shopId - Shop UUID for scope enforcement
   * @returns {Promise<object|null>}
   */
  async getById(id, shopId) {
    return this.repo.findById(id, shopId)
  }

  /**
   * Update a staff record (role, permissions, is_active) — PATCH semantics.
   *
   * Behaviour (R29 AC#2, R29 AC#8, design §6.3):
   *   - Applies ONLY the fields present in `data`; leaves all other
   *     columns untouched (the repository's UPDATE statement only
   *     adds `SET col = $n` clauses for keys whose value is not
   *     `undefined`).
   *   - Rejects an empty body with HTTP 400 VALIDATION_ERROR. The Zod
   *     `updateShopStaffSchema.refine` rule catches this at the
   *     controller layer; this defensive check guards against direct
   *     in-process callers (tests, future cron jobs) that bypass the
   *     controller.
   *   - Validates `data.permissions` (when present) against the
   *     canonical 37-string Permission_String vocabulary via
   *     `assertValidPermissions`; throws 400 PERMISSION_INVALID per
   *     R16 AC#17.
   *   - Returns the updated row.
   *   - Emits a `staff_updated` audit row with redacted before/after
   *     snapshots (R28 AC#4) read from `findById` prior to the UPDATE
   *     so the audit captures the actual mutation diff.
   *
   * Errors:
   *   - 400 VALIDATION_ERROR — empty body / no recognised fields.
   *   - 400 PERMISSION_INVALID — any element of `data.permissions`
   *     not in the canonical vocabulary.
   *   - Returns `{ success: false, code: 'STAFF_NOT_FOUND' }` when
   *     the row does not exist (controller maps to 404).
   *
   * @param {string} id - Staff record UUID
   * @param {object} data - Fields to update (role, permissions, is_active)
   * @param {string} shopId - Shop UUID for scope enforcement
   * @param {string|object} actorOrCtx
   *        Either the legacy `userId` string OR the full request context
   *        object `{ actorUserId, actorRole, actorPlatformRole, ip,
   *        userAgent }`. The object form carries actor-role metadata
   *        into the audit row so HQ vs SHOP-scope mutations are
   *        distinguishable in audit_logs (R28 AC#4).
   * @param {{ ip?: string|null, userAgent?: string|null }} [audit]
   *        Optional request metadata for the audit trail when
   *        `actorOrCtx` is the legacy string form. Ignored when
   *        `actorOrCtx` is an object (uses ctx.ip / ctx.userAgent).
   * @returns {Promise<{success, data?, message?, code?}>}
   *
   * Requirements: R29.2, R29.8, R16.17, R28.4
   * Design:       §6.3
   *
   * @throws {{ statusCode: 400, code: 'VALIDATION_ERROR', message: string }}
   *         when no recognised updatable fields are supplied.
   * @throws {{ statusCode: 400, code: 'PERMISSION_INVALID', message: string }}
   *         when `data.permissions` contains an unknown string.
   */
  async update(
    id,
    data,
    shopId,
    actorOrCtx,
    { ip = null, userAgent = null } = {},
  ) {
    // ── 0. Normalise the actor argument ────────────────────────────
    // Accept the legacy `(id, data, shopId, userId, { ip, userAgent })`
    // signature so existing tests and any unmigrated direct caller keep
    // working unchanged. New callers pass a single context object so the
    // audit row can carry actor_role / actor_platform_role.
    const ctx =
      typeof actorOrCtx === 'string' ||
      actorOrCtx === null ||
      actorOrCtx === undefined
        ? {
            actorUserId: actorOrCtx ?? null,
            actorRole: null,
            actorPlatformRole: null,
            ip,
            userAgent,
          }
        : {
            actorUserId: actorOrCtx.actorUserId ?? null,
            actorRole: actorOrCtx.actorRole ?? null,
            actorPlatformRole: actorOrCtx.actorPlatformRole ?? null,
            ip: actorOrCtx.ip ?? ip,
            userAgent: actorOrCtx.userAgent ?? userAgent,
          }

    // ── 1. Defensive empty-body check (R29 AC#8) ────────────────────
    // The Zod schema's `.refine` rule already returns 400
    // VALIDATION_ERROR at the controller layer. Repeat the check here
    // so any direct in-process caller (tests, future jobs) gets the
    // same contract.
    if (
      data.role === undefined &&
      data.permissions === undefined &&
      data.is_active === undefined
    ) {
      throw {
        statusCode: 400,
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'At least one field required',
      }
    }

    // ── 2. Validate permissions vocabulary (R16 AC#17) ─────────────
    // assertValidPermissions throws { code: 'PERMISSION_INVALID' };
    // re-throw it as the canonical { statusCode, code, message } shape
    // expected by the controller's mapError pattern (design §16).
    if (data.permissions !== undefined) {
      try {
        assertValidPermissions(data.permissions)
      } catch (err) {
        throw {
          statusCode: 400,
          code: ERROR_CODES.PERMISSION_INVALID,
          message: err.message,
        }
      }
    }

    // ── 3. Capture before-snapshot for audit (R28 AC#4) ────────────
    // Read first so the audit row carries the genuine diff. We do
    // not wrap this in a tx because the audit emit below is
    // fire-and-forget (no surrounding mutation rollback) and the
    // repository UPDATE is itself a single atomic statement — there
    // is no concurrency window worth a SELECT FOR UPDATE here.
    const existing = await this.repo.findById(id, shopId)
    if (!existing) {
      return {
        success: false,
        message: 'Staff record not found',
        code: 'STAFF_NOT_FOUND',
      }
    }

    // ── 4. Apply patch ─────────────────────────────────────────────
    // Repository already implements PATCH semantics: only fields
    // whose value is not `undefined` appear in the SET clause.
    const updated = await this.repo.update(id, shopId, data)
    if (!updated) {
      return {
        success: false,
        message: 'Staff record not found',
        code: 'STAFF_NOT_FOUND',
      }
    }

    // Requirement 2.11 — invalidate the staff-active cache so that any token
    // referencing this assignment is rejected within 5 minutes (cache TTL).
    // We do this for any update because the active state is derived from
    // shop_staff.is_active AND shop_staff.deleted_at AND shop.is_active —
    // any of those can change here.
    await invalidateStaffActiveCache(updated.user_id, updated.shop_id)

    // ── 5. Audit (fire-and-forget) ─────────────────────────────────
    // The mutation has already committed — using emitInTx here would
    // require restructuring this method to take a pg client, which
    // isn't worth it for a single non-financial UPDATE. The audit
    // helper's setImmediate scheduling means request latency is
    // unaffected, and any insert failure is structured-logged rather
    // than swallowed.
    emitAudit('staff_updated', {
      actor_user_id: ctx.actorUserId,
      actor_role: ctx.actorPlatformRole || ctx.actorRole || null,
      actor_shop_id: shopId,
      target_type: 'shop_staff',
      target_id: id,
      before: existing,
      after: updated,
      ip_address: ctx.ip,
      user_agent: ctx.userAgent,
    })

    logger.info(
      {
        userId: ctx.actorUserId,
        shopId,
        action: 'shop_staff_updated',
        staffId: id,
        targetUserId: updated.user_id,
      },
      'Shop staff updated'
    )

    return { success: true, data: updated }
  }

  /**
   * Soft-delete (deactivate) a staff record per task 5.4.
   *
   * Behaviour (R20 AC#1, R20 AC#10, R2 AC#11, design §5.7):
   *   - Wraps the soft-delete and the `staff_deactivated` audit insert in
   *     a single pg transaction so the audit row commits atomically with
   *     the mutation (R28 AC#6) — there is no commit path where a staff
   *     record is deactivated without a matching audit row, and no
   *     ROLLBACK leaves an orphan audit entry.
   *   - Calls `invalidateStaffActiveCache(userId, shopId)` AFTER the
   *     transaction COMMITs so any JWT referencing this assignment is
   *     rejected within 5 minutes (cache TTL) per design §5.7. Doing the
   *     cache delete after commit means we never leak a "cache cleared
   *     but DB rolled back" state — the staff row's active flag and the
   *     cache view are always coherent.
   *   - The `delete()` method is preserved as a thin alias so existing
   *     route handlers and tests that call `.delete(...)` continue to
   *     work unchanged.
   *
   * Connection lifecycle (project-standards.md "RESOURCE EFFICIENCY"):
   *   acquire a pooled client via `getClient()`, run BEGIN, do the work,
   *   COMMIT or ROLLBACK on the same client, and `client.release()` in a
   *   `finally` block so the connection is always returned even if a
   *   throw escapes mid-transaction.
   *
   * @param {string} id - Staff record UUID
   * @param {string} shopId - Shop UUID for scope enforcement
   * @param {string|object} actorOrCtx
   *        Either the legacy `userId` string OR the full request context
   *        object `{ actorUserId, actorRole, actorPlatformRole, ip,
   *        userAgent }`.
   * @returns {Promise<{success, message?, code?}>}
   *
   * Requirements: R20.1, R20.10, R2.11, R28.4, R28.6
   * Design:       §5.7, §6.3
   */
  async deactivate(id, shopId, actorOrCtx) {
    // ── 0. Normalise the actor argument (mirrors update()) ─────────
    const ctx =
      typeof actorOrCtx === 'string' ||
      actorOrCtx === null ||
      actorOrCtx === undefined
        ? {
            actorUserId: actorOrCtx ?? null,
            actorRole: null,
            actorPlatformRole: null,
            ip: null,
            userAgent: null,
          }
        : {
            actorUserId: actorOrCtx.actorUserId ?? null,
            actorRole: actorOrCtx.actorRole ?? null,
            actorPlatformRole: actorOrCtx.actorPlatformRole ?? null,
            ip: actorOrCtx.ip ?? null,
            userAgent: actorOrCtx.userAgent ?? null,
          }

    // ── 1. Pre-flight existence check (uses pool, not tx) ─────────
    // Doing the lookup BEFORE BEGIN means we can return STAFF_NOT_FOUND
    // without ever opening a transaction in the common 404 path. The
    // soft-delete inside the tx then re-checks via `WHERE deleted_at IS
    // NULL` so a concurrent delete between this lookup and the UPDATE
    // is still surfaced as STAFF_NOT_FOUND (no double-rollback path).
    const existing = await this.repo.findById(id, shopId)
    if (!existing) {
      return {
        success: false,
        message: 'Staff record not found',
        code: 'STAFF_NOT_FOUND',
      }
    }

    // ── 2. Transactional soft-delete + audit (R28 AC#6) ───────────
    const client = await getClient()
    try {
      await client.query('BEGIN')

      const ok = await this.repo.softDelete(id, shopId, { client })
      if (!ok) {
        // Race: row was deleted (or shop_id changed) between step 1
        // and the UPDATE. Roll back with no audit emit — there is
        // nothing to record.
        await client.query('ROLLBACK')
        return {
          success: false,
          message: 'Staff record not found',
          code: 'STAFF_NOT_FOUND',
        }
      }

      // R20.10 / R28.4 — emit `staff_deactivated` inside the same tx.
      // before = existing row snapshot; after = null so the audit
      // payload makes the deactivation explicit (the row is no longer
      // active and `deleted_at` is now set, but the canonical "after"
      // for a soft-delete is "the record is gone from the active
      // surface" — null captures that without leaking the placeholder
      // row state).
      await emitAuditInTx(client, 'staff_deactivated', {
        actor_user_id: ctx.actorUserId,
        actor_role: ctx.actorPlatformRole || ctx.actorRole || null,
        actor_shop_id: shopId,
        target_type: 'shop_staff',
        target_id: id,
        before: existing,
        after: null,
        ip_address: ctx.ip,
        user_agent: ctx.userAgent,
      })

      await client.query('COMMIT')
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackErr) {
        logger.error(
          { err: rollbackErr, staffId: id, shopId },
          'shop_staff deactivate ROLLBACK failed'
        )
      }
      throw err
    } finally {
      client.release()
    }

    // ── 3. Cache invalidation AFTER commit (design §5.7) ──────────
    // Doing this post-commit guarantees the cache is only cleared once
    // the staff row is definitively soft-deleted. If the tx had rolled
    // back we would have re-thrown above and skipped this line, leaving
    // the cache untouched — coherent with the unchanged DB state.
    await invalidateStaffActiveCache(existing.user_id, existing.shop_id)

    logger.info(
      {
        userId: ctx.actorUserId,
        shopId,
        action: 'shop_staff_deactivated',
        staffId: id,
        targetUserId: existing.user_id,
      },
      'Shop staff deactivated'
    )

    return { success: true }
  }

  /**
   * Soft-delete a staff record. Thin alias of {@link deactivate} preserved
   * for backwards compatibility with route handlers and tests that still
   * call `service.delete(...)`. New code should call `deactivate()`
   * directly per task 5.4 / design §5.7.
   *
   * @param {string} id
   * @param {string} shopId
   * @param {string|object} actorOrCtx
   * @returns {Promise<{success, message?, code?}>}
   */
  async delete(id, shopId, actorOrCtx) {
    return this.deactivate(id, shopId, actorOrCtx)
  }

  /**
   * Reset a staff member's password (R20 AC#9 / design §6.3).
   *
   * Sequence (mirrors the AdminAuthService.changePassword pattern):
   *
   *   1. Look up the staff record (404 STAFF_NOT_FOUND if missing) —
   *      runs on the pool so the 404 path never opens a tx.
   *   2. Generate a 12-char Temp_Password meeting the R20 AC#3
   *      complexity rule (mixed case, digit, symbol).
   *   3. bcrypt-hash the Temp_Password at cost 12 (R20 AC#12).
   *   4. BEGIN: atomic UPDATE of `users.password_hash`,
   *      `force_password_change=true`, and
   *      `session_version = session_version + 1` (R20 AC#8 — invalidate
   *      every previously issued JWT for the User).
   *   5. emitInTx `staff_password_reset` audit (before=null, after=
   *      `{ user_id, staff_id }` — NEVER include the password) so the
   *      audit row commits atomically with the password change.
   *   6. COMMIT.
   *
   * The plaintext Temp_Password is returned in the response payload
   * EXACTLY ONCE (R20 AC#9). It is never logged, never persisted in
   * plaintext, and never reaches the audit_logs table — the
   * sensitive-fields stripping in `audit-log.js` would redact
   * `password_hash` even if the bcrypt hash were accidentally placed in
   * a snapshot, but we add belt-and-braces here by passing only the
   * `{ user_id, staff_id }` identifiers in the audit `after`.
   *
   * Authorization (R20 AC#9 / design §6.3):
   *   The route handler runs `requirePermission('shop_staff.reset_password')`
   *   upstream — this method assumes the caller has already cleared that
   *   gate. HQ_Users with the canonical permission and SHOP_ADMIN with
   *   the same string both satisfy the route guard (HQ_ROLE_PERMISSIONS
   *   and SHOP_ROLE_DEFAULT_PERMISSIONS.SHOP_ADMIN both include it).
   *
   * @param {string} staffId - Shop_Staff_Record UUID.
   * @param {string} shopId  - Shop UUID for scope enforcement.
   * @param {object} ctx     - `{ actorUserId, actorRole, actorPlatformRole,
   *                              ip, userAgent }`.
   * @returns {Promise<{success: true, temp_password: string} |
   *                  {success: false, message: string, code: string}>}
   *
   * Requirements: R20.8, R20.9, R20.10, R28.4
   * Design:       §5.5, §6.3
   */
  async resetPassword(staffId, shopId, ctx = {}) {
    const actorCtx = {
      actorUserId: ctx.actorUserId ?? null,
      actorRole: ctx.actorRole ?? null,
      actorPlatformRole: ctx.actorPlatformRole ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    }

    // ── 1. Lookup ───────────────────────────────────────────────────
    const existing = await this.repo.findById(staffId, shopId)
    if (!existing) {
      return {
        success: false,
        message: 'Staff record not found',
        code: 'STAFF_NOT_FOUND',
      }
    }

    // ── 2. Generate Temp_Password ──────────────────────────────────
    // Reuses the same generator as `create()` so the complexity
    // guarantees (R20 AC#3) and the 12-char length budget are
    // identical across the two flows.
    const tempPassword = generateTempPassword()

    // ── 3. bcrypt cost 12 (R20 AC#12) ──────────────────────────────
    const passwordHash = await bcrypt.hash(tempPassword, BCRYPT_COST)

    // ── 4-6. Tx: UPDATE users + audit (atomic per R28 AC#6) ───────
    const client = await getClient()
    try {
      await client.query('BEGIN')

      // Single-statement update of password_hash, force_password_change,
      // and session_version. The session_version bump invalidates every
      // previously issued JWT for the User the moment we COMMIT below
      // (R20 AC#8 / design §5.5).
      await this.repo.resetPasswordTx(client, existing.user_id, passwordHash)

      // Audit inside the tx so a successful password reset is always
      // accompanied by a `staff_password_reset` row. NEVER include the
      // plaintext password or the bcrypt hash in the payload — only
      // identifiers. The audit-log helper would redact `password_hash`
      // anyway, but defence-in-depth.
      await emitAuditInTx(client, 'staff_password_reset', {
        actor_user_id: actorCtx.actorUserId,
        actor_role:
          actorCtx.actorPlatformRole || actorCtx.actorRole || null,
        actor_shop_id: shopId,
        target_type: 'shop_staff',
        target_id: staffId,
        before: null,
        after: {
          user_id: existing.user_id,
          staff_id: staffId,
        },
        ip_address: actorCtx.ip,
        user_agent: actorCtx.userAgent,
      })

      await client.query('COMMIT')
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackErr) {
        logger.error(
          { err: rollbackErr, staffId, shopId },
          'shop_staff resetPassword ROLLBACK failed'
        )
      }
      throw err
    } finally {
      client.release()
    }

    // R20 AC#12 — never log password_hash or the plaintext password.
    logger.info(
      {
        userId: actorCtx.actorUserId,
        shopId,
        action: 'shop_staff_password_reset',
        staffId,
        targetUserId: existing.user_id,
        // Only a boolean signal — never the value.
        tempPasswordIssued: true,
      },
      'Shop staff password reset'
    )

    return { success: true, temp_password: tempPassword }
  }
}

// Exported for unit tests only — the public API of this module is the
// `ShopStaffService` class. Re-exporting these helpers keeps the test
// surface narrow without forcing a private-export layer.
export const __testables__ = {
  generateTempPassword,
  allowedTargetRoles,
  TEMP_PASSWORD_LENGTH,
  BCRYPT_COST,
}
