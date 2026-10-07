import { query } from '../../../config/database.js'
import { logger } from '../../../config/logger.js'

/**
 * AdminAuthRepository
 *
 * Repository for the unified dashboard authentication module. Owns every
 * SQL touch-point used by the login → select-shop → /me → change-password
 * pipeline (design §5).
 *
 * All queries are parameterized ($1, $2, ...) and explicitly enumerate
 * columns — never `SELECT *` — per project-standards.md.
 *
 * Backward compatibility: the legacy `findAdminByEmail`, `findAdminById`,
 * and `setPassword` methods are preserved unchanged because the existing
 * `AdminAuthService` continues to import them. Multi-vendor work adds
 * three new methods (`findUserByEmailCI`, `loadActiveShopAssignments`,
 * `incrementSessionVersion`) alongside the legacy ones.
 */
export class AdminAuthRepository {
  // ──────────────────────────────────────────────────────────────────
  // Legacy methods (single-tenant ADMIN flow) — DO NOT REMOVE.
  // Used by the existing auth.service.js until task 3.2/3.5 swap it
  // over to the new multi-vendor methods below.
  // ──────────────────────────────────────────────────────────────────

  async findAdminByEmail(email) {
    const { rows } = await query(
      `SELECT u.id, u.phone, u.email, u.name, u.role, u.password_hash, u.is_blocked, u.block_reason,
              COALESCE(r.name, 'No Role') AS role_name,
              COALESCE(r.permissions, '[]'::jsonb) AS permissions
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.email = $1 AND u.role = 'ADMIN'`,
      [email]
    )
    return rows[0] || null
  }

  async findAdminById(id) {
    const { rows } = await query(
      `SELECT u.id, u.phone, u.email, u.name, u.role,
              COALESCE(r.name, 'No Role') AS role_name,
              COALESCE(r.permissions, '[]'::jsonb) AS permissions
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = $1 AND u.role = 'ADMIN' AND (u.is_blocked = false OR u.is_blocked IS NULL)`,
      [id]
    )
    return rows[0] || null
  }

  async setPassword(userId, passwordHash) {
    await query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [passwordHash, userId]
    )
  }

  // ──────────────────────────────────────────────────────────────────
  // Multi-vendor methods (design §5.1, §5.2, §5.5)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Case-insensitive email lookup for the unified dashboard login flow.
   *
   * Used by `auth.service.js#login()` (task 3.2) to identify any user
   * who can log in to the dashboard — HQ users (platform_role NOT NULL)
   * and shop-staff users (platform_role NULL + active shop_staff rows).
   * Customer / rider rows are also matched and the service later rejects
   * them with USER_INACTIVE if `is_active=false` or `is_blocked=true`.
   *
   * Uses the functional index `idx_users_email_lower` (created in
   * migration 039) so `LOWER(email) = LOWER($1)` stays index-backed
   * regardless of how the caller cased the input (R29.3).
   *
   * `password_hash` is included because the service needs it for
   * `bcrypt.compare`. **The service must never echo this field back to
   * the client** — strip it before constructing the `/login` response
   * (R18.16, design §5.1).
   *
   * The aliased column `full_name` maps the underlying `users.name`
   * column to the contract used by the design and downstream JWT
   * payload — the schema column is `name` (migration 001) but the API
   * surface and JWT use `full_name` (design §5.1, §5.6).
   *
   * @param {string} email - Email address as submitted by the client.
   *                         Trimmed by the Zod schema upstream.
   * @returns {Promise<{
   *   id: string,
   *   email: string,
   *   full_name: string|null,
   *   phone: string|null,
   *   password_hash: string|null,
   *   role: string,
   *   platform_role: string|null,
   *   force_password_change: boolean,
   *   is_blocked: boolean,
   *   is_active: boolean,
   *   session_version: number
   * } | null>} The user row, or `null` if no match.
   *
   * Requirements: R18.1, R18.15, R29.3
   * Design: §5.1
   */
  async findUserByEmailCI(email) {
    try {
      const { rows } = await query(
        `SELECT id,
                email,
                name AS full_name,
                phone,
                password_hash,
                role,
                platform_role,
                force_password_change,
                is_blocked,
                is_active,
                session_version
           FROM users
          WHERE LOWER(email) = LOWER($1)
          LIMIT 1`,
        [email]
      )
      return rows[0] || null
    } catch (err) {
      logger.error(
        { err, action: 'findUserByEmailCI' },
        'Failed to look up user by email (case-insensitive)'
      )
      throw err
    }
  }

  /**
   * Look up a user by primary key for the unified dashboard `/me` flow.
   *
   * Used by `auth.service.js#me()` (task 3.4) to re-validate the
   * caller's row on every request so deactivations / soft-deletes
   * that happened **after** the JWT was issued surface as 401
   * `SESSION_INVALID` (R19.6, design §5.3 / §5.7). The legacy
   * `findAdminById` helper is unsuitable here because it filters by
   * `role='ADMIN'` and would mask shop-staff rows whose role is
   * `'STORE'`/`'CUSTOMER'`/`'RIDER'`.
   *
   * Returns the same field set as {@link findUserByEmailCI} **minus
   * `password_hash`** — the `/me` path never calls `bcrypt.compare`,
   * and excluding the hash structurally guarantees R19.7 (no secret
   * fields in the response body) at the repository boundary rather
   * than relying on the service to remember to strip it.
   *
   * No `is_active=true` / `is_blocked=false` / `deleted_at IS NULL`
   * filters are applied here; the service layer reads these flags
   * and decides between 401 SESSION_INVALID (deactivated since
   * token issuance) and a successful response. This keeps the
   * deactivation reason discoverable for the `session_revoked`
   * audit emit.
   *
   * The aliased `name AS full_name` mirrors `findUserByEmailCI` so
   * downstream `sanitizeUser` works identically across the login
   * and `/me` paths.
   *
   * @param {string} userId - UUID of the user to load.
   * @returns {Promise<{
   *   id: string,
   *   email: string,
   *   full_name: string|null,
   *   phone: string|null,
   *   role: string,
   *   platform_role: string|null,
   *   force_password_change: boolean,
   *   is_blocked: boolean,
   *   is_active: boolean,
   *   session_version: number
   * } | null>} The user row, or `null` if no match.
   *
   * Requirements: R19.1, R19.6, R19.7
   * Design: §5.3, §5.7
   */
  async findUserById(userId) {
    try {
      const { rows } = await query(
        `SELECT id,
                email,
                name AS full_name,
                phone,
                role,
                platform_role,
                force_password_change,
                is_blocked,
                is_active,
                session_version
           FROM users
          WHERE id = $1
          LIMIT 1`,
        [userId]
      )
      return rows[0] || null
    } catch (err) {
      logger.error(
        { err, userId, action: 'findUserById' },
        'Failed to look up user by id'
      )
      throw err
    }
  }

  /**
   * Load every active shop assignment for a given user.
   *
   * Used by `auth.service.js#login()` to decide between the
   * single-shop / multi-shop / no-shop branches (design §5.1) and by
   * `selectShop()` to validate the requested `shop_id` belongs to the
   * caller's active set (design §5.2). Also backs `GET /api/v1/auth/my-shops`
   * (design §5.4, task 3.8).
   *
   * Filters applied (all four are required — design §5.1, R18.15):
   *   • `ss.is_active = true`         — staff link not deactivated
   *   • `ss.deleted_at IS NULL`       — staff link not soft-deleted
   *   • `s.is_active  = true`         — shop not paused
   *   • `s.deleted_at IS NULL`        — shop not soft-deleted
   *
   * Ordering is `s.name ASC` so the dashboard's shop selector is
   * deterministic across requests (design §5.4).
   *
   * Returns the shop role and JSONB permission array verbatim — the
   * service combines them with `SHOP_ROLE_DEFAULT_PERMISSIONS` from
   * `src/utils/permissions.js` to compute the effective JWT claim.
   *
   * @param {string} userId - UUID of the user whose assignments to load.
   * @returns {Promise<Array<{
   *   shop_id: string,
   *   shop_name: string,
   *   branch_code: string,
   *   shop_role: 'SHOP_ADMIN'|'SHOP_MANAGER'|'SHOP_STAFF'|'SHOP_VIEWER',
   *   permissions: string[]
   * }>>} One row per active assignment, sorted by shop name.
   *
   * Requirements: R18.1, R18.15
   * Design: §5.1, §5.2, §5.4
   */
  async loadActiveShopAssignments(userId) {
    try {
      const { rows } = await query(
        `SELECT ss.shop_id        AS shop_id,
                s.name            AS shop_name,
                s.branch_code     AS branch_code,
                ss.role           AS shop_role,
                ss.permissions    AS permissions
           FROM shop_staff ss
           JOIN shops s ON s.id = ss.shop_id
          WHERE ss.user_id     = $1
            AND ss.is_active   = true
            AND ss.deleted_at IS NULL
            AND s.is_active    = true
            AND s.deleted_at  IS NULL
          ORDER BY s.name ASC`,
        [userId]
      )
      return rows
    } catch (err) {
      logger.error(
        { err, userId, action: 'loadActiveShopAssignments' },
        'Failed to load active shop assignments for user'
      )
      throw err
    }
  }

  /**
   * Look up a user by primary key and return the row INCLUDING
   * `password_hash` so the caller can run `bcrypt.compare`.
   *
   * Used exclusively by `auth.service.js#changePassword()` (task 3.5)
   * to verify the caller's current password before re-hashing the new
   * one. The legacy `findUserById` deliberately omits `password_hash`
   * to keep the `/me` response surface free of secrets (R19.7); this
   * variant exists precisely because the password-change path is the
   * one place that legitimately needs the hash.
   *
   * Connection routing mirrors {@link incrementSessionVersion}: when
   * the caller passes a `pg.PoolClient` bound to an open transaction
   * the lookup runs on that client (so it observes the same
   * snapshot/locks as the rest of the transaction); otherwise it
   * falls back to the pool-bound `query()` helper.
   *
   * Field set matches {@link findUserByEmailCI} so downstream code
   * that already consumes that shape (sanitizeUser, audit redaction)
   * works without modification.
   *
   * **Caller obligation (R18.11, R28.5):** the returned
   * `password_hash` must NEVER appear in any response body, log
   * payload, or audit snapshot. The audit-log helper already redacts
   * it from before/after snapshots as a defense in depth, but the
   * service must additionally avoid putting it on JSON paths that
   * reach the client.
   *
   * @param {string} userId - UUID of the user to load.
   * @param {import('pg').PoolClient | null | undefined} [client]
   *        Optional pg client bound to an open transaction. When
   *        omitted/null the lookup runs on the pool directly.
   * @returns {Promise<{
   *   id: string,
   *   email: string,
   *   full_name: string|null,
   *   phone: string|null,
   *   password_hash: string|null,
   *   role: string,
   *   platform_role: string|null,
   *   force_password_change: boolean,
   *   is_blocked: boolean,
   *   is_active: boolean,
   *   session_version: number
   * } | null>} The user row, or `null` if no match.
   *
   * Requirements: R20.7, R20.8
   * Design: §5.5
   */
  async findUserByIdWithHash(userId, client) {
    const sql = `SELECT id,
                        email,
                        name AS full_name,
                        phone,
                        password_hash,
                        role,
                        platform_role,
                        force_password_change,
                        is_blocked,
                        is_active,
                        session_version
                   FROM users
                  WHERE id = $1
                  LIMIT 1`
    try {
      const runner = client ? client.query.bind(client) : query
      const { rows } = await runner(sql, [userId])
      return rows[0] || null
    } catch (err) {
      logger.error(
        { err, userId, action: 'findUserByIdWithHash' },
        'Failed to look up user by id (with password_hash)'
      )
      throw err
    }
  }

  /**
   * Transactional password update for the change-password flow.
   *
   * Sets `password_hash`, clears `force_password_change`, and bumps
   * `updated_at` in a single statement on the caller's transaction
   * client. Pairs with {@link incrementSessionVersion} inside the
   * `changePassword` transaction so both writes commit (or roll back)
   * atomically — partial states (new hash but session still valid,
   * or old hash with bumped session) are impossible (design §5.5).
   *
   * Distinct from the legacy {@link setPassword} method, which runs
   * outside a transaction on the pool and does NOT clear
   * `force_password_change`. The legacy method is preserved for any
   * caller still using it; new code on the change-password path uses
   * this transactional variant.
   *
   * @param {string} userId       - UUID of the user.
   * @param {string} passwordHash - bcrypt hash to store (cost 12).
   * @param {import('pg').PoolClient} client
   *        Pg client bound to an open transaction. REQUIRED — this
   *        method intentionally does not fall back to the pool because
   *        the password update must be atomic with
   *        `incrementSessionVersion` and the audit emit.
   * @returns {Promise<void>}
   *
   * Requirements: R20.7, R20.8
   * Design: §5.5
   */
  async setPasswordTx(userId, passwordHash, client) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('setPasswordTx: pg client (in transaction) is required')
    }
    try {
      const result = await client.query(
        `UPDATE users
            SET password_hash         = $1,
                force_password_change = false,
                updated_at            = NOW()
          WHERE id = $2`,
        [passwordHash, userId]
      )
      if (result.rowCount === 0) {
        throw new Error(`setPasswordTx: user ${userId} not found`)
      }
    } catch (err) {
      logger.error(
        { err, userId, action: 'setPasswordTx' },
        'Failed to update password_hash transactionally'
      )
      throw err
    }
  }

  /**
   * Atomically increment a user's session version.
   *
   * Backs **global session revocation on password change** (R20.8,
   * design §5.5). The change-password handler runs inside a pg
   * transaction; the auth plugin compares the JWT-encoded
   * `session_version` against `users.session_version` on every
   * authenticated request, so bumping this column invalidates every
   * previously issued JWT for the user the moment the transaction
   * commits.
   *
   * Connection routing (design §5.5, task 3.5):
   *   • When called from inside an open transaction (the typical
   *     `changePassword` path), the caller passes a `pg.PoolClient`
   *     bound to that transaction. The increment commits or rolls back
   *     atomically with the password-hash update — partial states
   *     (new hash but old session_version, or vice versa) are
   *     impossible.
   *   • When called outside a transaction (e.g. an admin-initiated
   *     "force logout" path), `client` is null/undefined and the
   *     pool-bound `query()` helper is used.
   *
   * Both pool-bound `query()` and `PoolClient.query()` share the same
   * call signature, so the routing is a single ternary on the runner.
   *
   * @param {string} userId - UUID of the user whose session_version to bump.
   * @param {import('pg').PoolClient | null | undefined} [client]
   *        Optional pg client bound to an open transaction. When
   *        omitted/null the increment runs on the pool directly.
   * @returns {Promise<number>} The new `session_version` value.
   *
   * Requirements: R20.8
   * Design: §5.5
   */
  async incrementSessionVersion(userId, client) {
    const sql = `UPDATE users
                    SET session_version = session_version + 1,
                        updated_at      = NOW()
                  WHERE id = $1
                RETURNING session_version`
    try {
      const runner = client ? client.query.bind(client) : query
      const { rows } = await runner(sql, [userId])
      if (rows.length === 0) {
        // No row matched — the caller passed an unknown user_id. We
        // surface this as an explicit error rather than silently
        // returning undefined so the change-password transaction can
        // roll back cleanly.
        throw new Error(`incrementSessionVersion: user ${userId} not found`)
      }
      return rows[0].session_version
    } catch (err) {
      logger.error(
        { err, userId, action: 'incrementSessionVersion' },
        'Failed to increment session_version for user'
      )
      throw err
    }
  }
}
