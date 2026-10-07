import { query } from '../../config/database.js'

/**
 * Audit Logs repository — read-only access to the append-only `audit_logs`
 * table created by migration 043.
 *
 * Append-only contract (R28.3, design §12.4):
 *   - This repository contains **only INSERT-free SELECT queries**. The
 *     INSERT path for `audit_logs` lives in `src/utils/audit-log.js` (the
 *     `emit` / `emitInTx` helpers) and is invoked from every mutating
 *     service per design §12.2. There are no UPDATE or DELETE methods, by
 *     design — the static-grep CI check (design §17 Property 7) and the
 *     deploy-time DB role grant (`bakaloo_app` holds INSERT+SELECT only)
 *     enforce the same invariant operationally.
 *
 * Conventions (project-standards.md):
 *   - NEVER `SELECT *` — every column is named explicitly via
 *     {@link AuditLogsRepository.SELECT_COLUMNS}.
 *   - All queries use parameterized placeholders ($1, $2…). No string
 *     concatenation of user input ever reaches the SQL text.
 *   - List queries are paginated (default 20, max 100 — enforced by the
 *     Zod schema in `audit-logs.schema.js`).
 *
 * Index alignment (migration 043):
 *   - `actor_user_id` filter      → idx_audit_logs_actor_user
 *   - `actor_shop_id` filter      → idx_audit_logs_actor_shop
 *   - `target_type` + `target_id` → idx_audit_logs_target
 *   - `action` + `created_at`     → idx_audit_logs_action_created
 *   - default ORDER BY created_at → idx_audit_logs_created
 *
 * Requirements: R28.3, R28.6, R28.7
 * Design:       §10, §12.3 of .kiro/specs/multi-vendor-system/design.md
 */
export class AuditLogsRepository {
  // ────────────────────────────────────────────────────────
  // Column projection — keep in sync with migration 043.
  // No SELECT *; every read endpoint returns exactly these fields.
  // ────────────────────────────────────────────────────────
  static SELECT_COLUMNS = `
    id, actor_user_id, actor_role, actor_shop_id,
    target_type, target_id, action,
    before, after,
    ip_address, user_agent, created_at
  `

  /**
   * Paginated, filterable list of audit log entries sorted by `created_at`
   * descending (R28.6 / R28.7).
   *
   * Filter semantics (all optional, combined with AND):
   *   - `actor_user_id` / `actor_shop_id`              equality
   *   - `target_type`                                  equality
   *   - `target_id`                                    equality
   *   - `action`                                       equality
   *   - `fromDate`                                     created_at >= fromDate
   *   - `toDate`                                       created_at <= toDate
   *
   * Pagination: `page` (1-indexed), `limit` (default 20, max 100). The Zod
   * schema in `audit-logs.schema.js` is the canonical defender of these
   * bounds; this method coerces and clamps defensively so misuse from a
   * future caller cannot bypass the project-wide pagination cap.
   *
   * Returns `{ items, total }`. The total is computed in parallel with the
   * page query (single round-trip via `Promise.all`) so list endpoints stay
   * inside the 200ms p95 budget.
   *
   * @param {object} filters
   * @param {string} [filters.actor_user_id]
   * @param {string} [filters.actor_shop_id]
   * @param {string} [filters.target_type]
   * @param {string} [filters.target_id]
   * @param {string} [filters.action]
   * @param {Date}   [filters.fromDate] - inclusive lower bound on created_at
   * @param {Date}   [filters.toDate]   - inclusive upper bound on created_at
   * @param {number} [filters.page=1]
   * @param {number} [filters.limit=20]
   * @returns {Promise<{ items: object[], total: number }>}
   */
  async findMany({
    actor_user_id,
    actor_shop_id,
    target_type,
    target_id,
    action,
    fromDate,
    toDate,
    page = 1,
    limit = 20,
  } = {}) {
    // Defensive normalisation — the Zod schema is the source of truth, but
    // bypassed callers (background jobs, future internal use) must still hit
    // the project-wide pagination cap.
    const safePage = Number.isInteger(page) && page > 0 ? page : 1
    const rawLimit = Number.isInteger(limit) && limit > 0 ? limit : 20
    const safeLimit = Math.min(rawLimit, 100)
    const offset = (safePage - 1) * safeLimit

    const conditions = []
    const params = []
    let idx = 1

    if (actor_user_id) {
      conditions.push(`actor_user_id = $${idx++}`)
      params.push(actor_user_id)
    }
    if (actor_shop_id) {
      conditions.push(`actor_shop_id = $${idx++}`)
      params.push(actor_shop_id)
    }
    if (target_type) {
      conditions.push(`target_type = $${idx++}`)
      params.push(target_type)
    }
    if (target_id) {
      conditions.push(`target_id = $${idx++}`)
      params.push(target_id)
    }
    if (action) {
      conditions.push(`action = $${idx++}`)
      params.push(action)
    }
    if (fromDate instanceof Date) {
      conditions.push(`created_at >= $${idx++}`)
      params.push(fromDate)
    }
    if (toDate instanceof Date) {
      conditions.push(`created_at <= $${idx++}`)
      params.push(toDate)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    // Run the page query and the count in parallel — same conditions, same
    // params; the count omits the LIMIT/OFFSET parameters so we slice here.
    const listSql = `
      SELECT ${AuditLogsRepository.SELECT_COLUMNS}
        FROM audit_logs
        ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $${idx} OFFSET $${idx + 1}
    `
    const countSql = `
      SELECT COUNT(*)::int AS total
        FROM audit_logs
        ${where}
    `

    const [dataResult, countResult] = await Promise.all([
      query(listSql, [...params, safeLimit, offset]),
      query(countSql, params),
    ])

    return {
      items: dataResult.rows,
      total: countResult.rows[0]?.total ?? 0,
    }
  }

  // No update*, delete*, or softDelete* methods exist on this repository.
  // The append-only invariant (R28.3, design §12.4) is enforced structurally
  // here, by DB role grants at deploy time, and by the static-grep CI check.
}
