import crypto from 'node:crypto'

import { query, getClient } from '../../config/database.js'

/**
 * Shop Staff repository — all SQL queries for shop_staff
 * NEVER uses SELECT * — always named columns
 * All queries use parameterized placeholders ($1, $2...)
 */
export class ShopStaffRepository {
  /**
   * Create a new shop staff record.
   * Caller is responsible for limit checks and duplicate detection.
   * @param {object} data - { user_id, shop_id, role, permissions, invited_by }
   * @returns {Promise<object>} Created record
   */
  async create(data) {
    const { rows } = await query(
      `INSERT INTO shop_staff (
        user_id, shop_id, role, permissions, invited_by
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING id, user_id, shop_id, role, permissions,
        is_active, invited_by, created_at, updated_at`,
      [
        data.user_id,
        data.shop_id,
        data.role,
        JSON.stringify(data.permissions || []),
        data.invited_by || null,
      ]
    )
    return rows[0]
  }

  /**
   * Find shop staff record by ID, scoped to shop_id.
   *
   * Requirement 15.3 — soft-deleted rows are excluded by default. Pass
   * `includeDeleted: true` to surface soft-deleted staff for admin
   * restoration / audit paths.
   *
   * Pass shopId=null to fetch without scope (e.g., super admin lookup).
   *
   * Connection routing (mirrors `incrementSessionVersion` in the auth
   * repository): when the caller passes `client` — a `pg.PoolClient`
   * bound to an open transaction — the lookup runs on that client so it
   * observes the same isolation level as the surrounding writes (used by
   * `deactivate()`'s tx wrapping the soft-delete + audit emit per task
   * 5.4 / R28 AC#6). When omitted, the lookup runs on the pool directly.
   *
   * @param {string} id - Staff record UUID
   * @param {string|null} shopId - Optional shop scope filter
   * @param {object} [opts]
   * @param {boolean} [opts.includeDeleted=false]
   * @param {import('pg').PoolClient|null} [opts.client=null] - Optional pg
   *        client bound to an open transaction.
   * @returns {Promise<object|null>}
   */
  async findById(
    id,
    shopId = null,
    { includeDeleted = false, client = null } = {}
  ) {
    const runner = client ? client.query.bind(client) : query
    const deletedClause = includeDeleted ? '' : ' AND deleted_at IS NULL'
    if (shopId) {
      const { rows } = await runner(
        `SELECT id, user_id, shop_id, role, permissions,
          is_active, invited_by, deleted_at, created_at, updated_at
        FROM shop_staff
        WHERE id = $1 AND shop_id = $2${deletedClause}`,
        [id, shopId]
      )
      return rows[0] || null
    }

    const { rows } = await runner(
      `SELECT id, user_id, shop_id, role, permissions,
        is_active, invited_by, deleted_at, created_at, updated_at
      FROM shop_staff
      WHERE id = $1${deletedClause}`,
      [id]
    )
    return rows[0] || null
  }

  /**
   * Find an active shop staff record by user_id and shop_id (excludes soft-deleted).
   * Used for duplicate-assignment detection.
   * @param {string} userId
   * @param {string} shopId
   * @returns {Promise<object|null>}
   */
  async findByUserAndShop(userId, shopId) {
    const { rows } = await query(
      `SELECT id, user_id, shop_id, role, permissions,
        is_active, invited_by, deleted_at, created_at, updated_at
      FROM shop_staff
      WHERE user_id = $1 AND shop_id = $2 AND deleted_at IS NULL`,
      [userId, shopId]
    )
    return rows[0] || null
  }

  /**
   * Count active staff for a shop (for max-50 limit enforcement).
   * Uses idx_shop_staff_shop_active.
   * @param {string} shopId
   * @returns {Promise<number>}
   */
  async countActiveByShop(shopId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count
      FROM shop_staff
      WHERE shop_id = $1 AND deleted_at IS NULL AND is_active = true`,
      [shopId]
    )
    return rows[0].count
  }

  /**
   * Count active shop assignments for a user (for max-10 limit enforcement).
   * Uses idx_shop_staff_user_id.
   * @param {string} userId
   * @returns {Promise<number>}
   */
  async countActiveByUser(userId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count
      FROM shop_staff
      WHERE user_id = $1 AND deleted_at IS NULL AND is_active = true`,
      [userId]
    )
    return rows[0].count
  }

  /**
   * Find a user by case-insensitive email match.
   *
   * Used by the staff-create flow (R20 AC#5) to enforce uniqueness on
   * `users.email` before INSERT. The case-insensitive match (`LOWER`)
   * matches the lower-cased email persisted by the create path; it is
   * also defense-in-depth against historical rows that may carry mixed
   * case. The query is `LIMIT 1` because at most one User can hold a
   * given email per the unique index on `users.email`.
   *
   * @param {string} email — the email to search for (any case)
   * @returns {Promise<{id: string, email: string|null}|null>}
   */
  async findUserByEmailCI(email) {
    const { rows } = await query(
      `SELECT id, email
       FROM users
       WHERE LOWER(email) = LOWER($1)
       LIMIT 1`,
      [email]
    )
    return rows[0] || null
  }

  /**
   * Transactional duplicate-detection helper used by the new-user
   * staff-create path (R20 AC#5). Looks up the first existing user
   * row whose `email` matches case-insensitively OR whose `phone`
   * matches exactly. Bound to the caller's pg client so the SELECT
   * runs inside the same transaction as the subsequent
   * {@link createUserWithPassword} INSERT — preventing a TOCTOU
   * race where two concurrent invitations both pass the check and
   * then race the unique-index violation.
   *
   * Behaviour:
   *   - When `email` is supplied, matches `LOWER(email) = LOWER($1)`.
   *     Hits `idx_users_email_lower` (functional index from migration
   *     039) so the lookup is O(log n).
   *   - When `phone` is supplied, matches `phone = $N` exactly.
   *     Hits `idx_users_phone`.
   *   - When BOTH are supplied, the row is returned if EITHER
   *     matches (logical OR). Caller distinguishes "email collision"
   *     vs "phone collision" by comparing the returned row.
   *   - When NEITHER is supplied (defensive), returns null without
   *     issuing a query.
   *
   * Always returns a small projection — `id`, `email`, `phone` — so
   * the caller can format an error without leaking PII columns.
   *
   * @param {import('pg').PoolClient} client — pg client bound to an open transaction
   * @param {{ email?: string|null, phone?: string|null }} args
   * @returns {Promise<{id: string, email: string|null, phone: string|null}|null>}
   */
  async findUserByEmailOrPhone(client, { email = null, phone = null } = {}) {
    if (!client || typeof client.query !== 'function') {
      throw new Error(
        'shop-staff.repository.findUserByEmailOrPhone: `client` (pg PoolClient) is required'
      )
    }
    const hasEmail = typeof email === 'string' && email.length > 0
    const hasPhone = typeof phone === 'string' && phone.length > 0
    if (!hasEmail && !hasPhone) return null

    // Build the WHERE OR-chain dynamically so we never emit
    // `WHERE LOWER(email)=LOWER(NULL)` (always-false but wasteful).
    const conditions = []
    const params = []
    let idx = 1
    if (hasEmail) {
      conditions.push(`LOWER(email) = LOWER($${idx++})`)
      params.push(email)
    }
    if (hasPhone) {
      conditions.push(`phone = $${idx++}`)
      params.push(phone)
    }

    const { rows } = await client.query(
      `SELECT id, email, phone
       FROM users
       WHERE ${conditions.join(' OR ')}
       LIMIT 1`,
      params
    )
    return rows[0] || null
  }

  /**
   * Provision a brand-new `users` row inside the caller's
   * transaction (R20 AC#3 / R20 AC#4). The companion to
   * {@link findUserByEmailOrPhone}: the staff-create service runs
   *
   *   1. `findUserByEmailOrPhone(client, { email, phone })` — duplicate guard
   *   2. (when null) `bcrypt.hash(plaintext, 12)` — R20 AC#12
   *   3. `createUserWithPassword(client, { ...row })` — this method
   *
   * inside a single `BEGIN`...`COMMIT` block. Both writes commit
   * atomically with the subsequent `shop_staff` INSERT so we never
   * leave a "ghost" user with no shop assignment.
   *
   * `users.role` is hard-coded to `'ADMIN'` because the dashboard
   * email/password login plugin treats `role IN ('ADMIN', 'STORE')`
   * as eligible staff accounts (and the deployed `user_role` enum
   * does not include `'STORE'` yet — design §3.2.1). The caller's
   * actual shop role is stored on the corresponding `shop_staff`
   * row; `users.role` is purely the legacy column gate.
   *
   * `users.phone` is `VARCHAR(15) UNIQUE NOT NULL` per migration 001.
   * When the caller does not supply a real phone we generate a
   * collision-resistant synthetic placeholder using `crypto.randomBytes`
   * (6 random bytes = 48 bits → birthday-paradox risk at ≈16M rows) and
   * a `s:` prefix so operators can recognise placeholder rows. Total
   * length is 14 chars (`s:` + 12 hex), within the VARCHAR(15) limit.
   * The synthetic value is not a valid E.164 number (no `+`, contains
   * `:`) so it can never collide with a real customer phone.
   *
   * @param {import('pg').PoolClient} client — pg client inside an open transaction
   * @param {object} args
   * @param {string} args.email                   — lowercased email (R20 AC#2)
   * @param {string} args.full_name               — 1..200 chars (R20 AC#2)
   * @param {string|null} [args.phone]            — optional E.164-style phone
   * @param {string} args.password_hash           — bcrypt hash (cost 12, R20 AC#12)
   * @param {boolean} args.force_password_change  — true for Temp_Password flows (R20 AC#3)
   * @returns {Promise<object>} the newly inserted users row (no password_hash)
   */
  async createUserWithPassword(
    client,
    { email, full_name, phone = null, password_hash, force_password_change }
  ) {
    if (!client || typeof client.query !== 'function') {
      throw new Error(
        'shop-staff.repository.createUserWithPassword: `client` (pg PoolClient) is required'
      )
    }
    const safePhone =
      phone && phone.length > 0
        ? phone
        : `s:${crypto.randomBytes(6).toString('hex')}`

    const { rows } = await client.query(
      `INSERT INTO users (
         phone, email, name, role, password_hash,
         force_password_change, is_active
       )
       VALUES ($1, $2, $3, 'ADMIN', $4, $5, true)
       RETURNING id, name, email, phone, role,
                 force_password_change, is_active, created_at`,
      [safePhone, email, full_name, password_hash, force_password_change]
    )
    return rows[0]
  }

  /**
   * Insert a `shop_staff` row inside the caller's transaction. Mirror
   * of {@link create} that takes a pg client so the staff-create
   * service can chain it after {@link createUserWithPassword} in a
   * single atomic `BEGIN`...`COMMIT` block (R15.9, R15.10, R20.2).
   *
   * @param {import('pg').PoolClient} client — pg client inside an open transaction
   * @param {object} data — { user_id, shop_id, role, permissions, invited_by }
   * @returns {Promise<object>} the new shop_staff row
   */
  async createWithClient(client, data) {
    if (!client || typeof client.query !== 'function') {
      throw new Error(
        'shop-staff.repository.createWithClient: `client` (pg PoolClient) is required'
      )
    }
    const { rows } = await client.query(
      `INSERT INTO shop_staff (
        user_id, shop_id, role, permissions, invited_by
      ) VALUES ($1, $2, $3, $4::jsonb, $5)
      RETURNING id, user_id, shop_id, role, permissions,
        is_active, invited_by, created_at, updated_at`,
      [
        data.user_id,
        data.shop_id,
        data.role,
        JSON.stringify(data.permissions || []),
        data.invited_by || null,
      ]
    )
    return rows[0]
  }

  /**
   * Provision a brand-new user AND assign them as shop staff in a single
   * atomic transaction (R20.2, R20.3, R15.9, R15.10).
   *
   * Steps inside the transaction:
   *   1. INSERT INTO users (...) — populates email/name/phone/password_hash
   *      /role='ADMIN' (so the dashboard email/password login plugin
   *      treats the row as an eligible staff account) /
   *      force_password_change = passed flag.
   *   2. INSERT INTO shop_staff (...) — links the new user to the target
   *      shop with the chosen role and permissions JSON.
   *
   * Both writes commit together; either failure rolls back the whole
   * transaction so we never leave a "ghost" user with no shop assignment.
   *
   * The audit emit is intentionally NOT done here — the service layer
   * calls `emit('staff_created', ...)` after the commit returns, because
   * the audit row is fire-and-forget and this method is the write-only
   * persistence boundary.
   *
   * @param {object} args
   * @param {string} args.name              — full name (1..200 chars, R20.2)
   * @param {string} args.email             — lowercased email (R20.2)
   * @param {string|null} [args.phone]      — optional phone (E.164)
   * @param {string} args.passwordHash      — bcrypt hash (cost 12, R20.12)
   * @param {boolean} args.forcePasswordChange — true for Temp_Password flows
   * @param {string} args.shopId
   * @param {string} args.role              — SHOP_ADMIN | SHOP_MANAGER | SHOP_STAFF | SHOP_VIEWER
   * @param {string[]} args.permissions     — canonical Permission_Strings (validated upstream)
   * @param {string|null} [args.invitedBy]  — UUID of the User who issued the invite
   * @returns {Promise<{user: object, staff: object}>} both rows on success
   * @throws on any DB error; the caller's transaction has already rolled back.
   */
  async createUserAndAssign({
    name,
    email,
    phone = null,
    passwordHash,
    forcePasswordChange,
    shopId,
    role,
    permissions,
    invitedBy = null,
  }) {
    // `users.phone` is `VARCHAR(15) UNIQUE NOT NULL` per migration 001.
    // When the caller does not supply a real phone we generate a
    // collision-resistant synthetic placeholder using `crypto.randomBytes`
    // (6 random bytes = 48 bits → birthday-paradox risk at ≈16M rows) and
    // a `s:` prefix so operators can recognise placeholder rows. Total
    // length is 14 chars (`s:` + 12 hex), within the VARCHAR(15) limit.
    // The synthetic value is not a valid E.164 number (no `+` and contains
    // `:`) so it can never collide with a real customer phone.
    //
    // On the rare birthday-collision the INSERT will violate the
    // (phone) UNIQUE constraint and the transaction rolls back — the
    // service-layer error mapper surfaces this as a 500 INTERNAL_ERROR
    // and the caller can simply retry. We do not loop here because a
    // follow-up migration is expected to make `users.phone` nullable for
    // staff/HQ rows; this synthetic-phone bridge is intentionally simple.
    const safePhone =
      phone && phone.length > 0
        ? phone
        : `s:${crypto.randomBytes(6).toString('hex')}`

    const client = await getClient()
    try {
      await client.query('BEGIN')

      // ── 1. INSERT user ─────────────────────────────────────────
      const { rows: userRows } = await client.query(
        `INSERT INTO users (
           phone, email, name, role, password_hash,
           force_password_change, is_active
         )
         VALUES ($1, $2, $3, 'ADMIN', $4, $5, true)
         RETURNING id, name, email, phone, role,
                   force_password_change, is_active, created_at`,
        [safePhone, email, name, passwordHash, forcePasswordChange]
      )
      const user = userRows[0]

      // ── 2. INSERT shop_staff ───────────────────────────────────
      const { rows: staffRows } = await client.query(
        `INSERT INTO shop_staff (
           user_id, shop_id, role, permissions, invited_by
         )
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING id, user_id, shop_id, role, permissions,
                   is_active, invited_by, created_at, updated_at`,
        [user.id, shopId, role, JSON.stringify(permissions), invitedBy]
      )
      const staff = staffRows[0]

      await client.query('COMMIT')
      return { user, staff }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * List shop staff with filtering, pagination (scoped to shop_id).
   * Single LEFT JOIN to users to avoid N+1 lookups.
   *
   * Requirement 15.3 — soft-deleted rows are excluded by default. Pass
   * `include_deleted: 'true'` (matches the route schema) or
   * `includeDeleted: true` to surface soft-deleted staff for admin
   * restoration / audit views.
   *
   * @param {object} filters - { shopId, page, limit, role, is_active, include_deleted }
   * @returns {Promise<{staff: Array, total: number}>}
   */
  async findMany({
    shopId,
    page = 1,
    limit = 20,
    role,
    is_active,
    include_deleted,
    includeDeleted,
  }) {
    const offset = (page - 1) * limit
    const showDeleted =
      includeDeleted === true || include_deleted === 'true'
    const conditions = ['ss.shop_id = $1']
    const params = [shopId]
    let paramIdx = 2

    if (!showDeleted) {
      conditions.push('ss.deleted_at IS NULL')
    }

    if (role) {
      conditions.push(`ss.role = $${paramIdx++}`)
      params.push(role)
    }

    if (is_active === 'true') {
      conditions.push('ss.is_active = true')
    } else if (is_active === 'false') {
      conditions.push('ss.is_active = false')
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ss.id, ss.user_id, ss.shop_id, ss.role, ss.permissions,
          ss.is_active, ss.invited_by, ss.created_at, ss.updated_at,
          u.name AS user_name, u.email AS user_email, u.phone AS user_phone
        FROM shop_staff ss
        LEFT JOIN users u ON u.id = ss.user_id
        WHERE ${where}
        ORDER BY ss.created_at DESC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
        FROM shop_staff ss
        WHERE ${where}`,
        params
      ),
    ])

    return {
      staff: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }

  /**
   * Update shop staff record by ID, scoped to shop_id.
   * @param {string} id - Staff record UUID
   * @param {string} shopId - Shop UUID for scope enforcement
   * @param {object} data - Fields to update (role, permissions, is_active)
   * @returns {Promise<object|null>}
   */
  async update(id, shopId, data) {
    const fields = []
    const params = []
    let idx = 1

    if (data.role !== undefined) {
      fields.push(`role = $${idx++}`)
      params.push(data.role)
    }

    if (data.permissions !== undefined) {
      fields.push(`permissions = $${idx++}`)
      params.push(JSON.stringify(data.permissions))
    }

    if (data.is_active !== undefined) {
      fields.push(`is_active = $${idx++}`)
      params.push(data.is_active)
    }

    if (fields.length === 0) return this.findById(id, shopId)

    fields.push('updated_at = NOW()')
    params.push(id, shopId)

    const { rows } = await query(
      `UPDATE shop_staff SET ${fields.join(', ')}
       WHERE id = $${idx} AND shop_id = $${idx + 1} AND deleted_at IS NULL
       RETURNING id, user_id, shop_id, role, permissions,
         is_active, invited_by, created_at, updated_at`,
      params
    )
    return rows[0] || null
  }

  /**
   * Soft-delete shop staff record by ID, scoped to shop_id.
   * Sets deleted_at=NOW() and is_active=false.
   *
   * Connection routing: when the caller passes `client` — a `pg.PoolClient`
   * bound to an open transaction — the UPDATE runs on that client so the
   * mutation commits atomically with any sibling writes (used by
   * `ShopStaffService.deactivate()` to wrap the soft-delete and the
   * `staff_deactivated` audit insert per task 5.4 / R28 AC#6).
   *
   * @param {string} id - Staff record UUID
   * @param {string} shopId - Shop UUID for scope enforcement
   * @param {object} [opts]
   * @param {import('pg').PoolClient|null} [opts.client=null] - Optional pg
   *        client bound to an open transaction.
   * @returns {Promise<boolean>}
   */
  async softDelete(id, shopId, { client = null } = {}) {
    const runner = client ? client.query.bind(client) : query
    const { rowCount } = await runner(
      `UPDATE shop_staff
       SET deleted_at = NOW(), is_active = false, updated_at = NOW()
       WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL`,
      [id, shopId]
    )
    return rowCount > 0
  }

  /**
   * Reset a User's password — atomic UPDATE of `password_hash`,
   * `force_password_change=true`, and `session_version = session_version + 1`
   * inside the caller's transaction (R20 AC#9 / R20 AC#8).
   *
   * Bumping `session_version` is the global session-revocation mechanism
   * called out by R20 AC#8 / design §5.5: the auth plugin compares the JWT
   * claim against `users.session_version` on every authenticated request,
   * so the increment invalidates every previously issued JWT for the User
   * the moment the transaction commits.
   *
   * Mirrors `AdminAuthRepository.setPasswordTx` + `incrementSessionVersion`
   * but in a single statement so the password-reset path issues exactly
   * one UPDATE against `users` rather than two (avoids the race window
   * where the reset hash is visible while session_version still matches
   * an old token).
   *
   * @param {import('pg').PoolClient} client - Pg client bound to an open
   *        transaction. REQUIRED — this method intentionally has no pool
   *        fallback because it pairs with the audit insert in the same tx.
   * @param {string} userId - UUID of the user whose password to reset.
   * @param {string} passwordHash - bcrypt hash to store (cost 12).
   * @returns {Promise<{ session_version: number }>} New session version.
   * @throws {Error} when the user row does not exist.
   *
   * Requirements: R20.8, R20.9
   * Design: §5.5, §6.3
   */
  async resetPasswordTx(client, userId, passwordHash) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('resetPasswordTx: pg client (in transaction) is required')
    }
    const { rows } = await client.query(
      `UPDATE users
          SET password_hash         = $1,
              force_password_change = true,
              session_version       = session_version + 1,
              updated_at            = NOW()
        WHERE id = $2
      RETURNING session_version`,
      [passwordHash, userId]
    )
    if (rows.length === 0) {
      throw new Error(`resetPasswordTx: user ${userId} not found`)
    }
    return { session_version: rows[0].session_version }
  }

  /**
   * Find user_ids of all active staff in a shop matching any of the given
   * roles (Requirement 11.4, 11.9 — notify SHOP_ADMIN/SHOP_MANAGER on
   * stock-out and low stock).
   *
   * Uses idx_shop_staff_shop_active for the (shop_id, is_active=true) filter
   * and idx_shop_staff_shop_role for the role narrowing — no full table scan.
   *
   * @param {string} shopId
   * @param {string[]} roles - one or more of SHOP_ADMIN, SHOP_MANAGER, SHOP_STAFF, SHOP_VIEWER
   * @returns {Promise<string[]>} distinct user_ids
   */
  async findActiveUserIdsByShopAndRoles(shopId, roles) {
    if (!shopId || !Array.isArray(roles) || roles.length === 0) return []
    const { rows } = await query(
      `SELECT DISTINCT user_id
       FROM shop_staff
       WHERE shop_id = $1
         AND deleted_at IS NULL
         AND is_active = true
         AND role = ANY($2::text[])`,
      [shopId, roles]
    )
    return rows.map((r) => r.user_id)
  }
}
