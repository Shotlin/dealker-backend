/**
 * Audit Logs service — read-only orchestration over the
 * {@link AuditLogsRepository}. Two reader endpoints share this service
 * (design §12.3):
 *
 *   - HQ reader      `GET /api/v1/admin/audit-logs`     (task 10.2)
 *     Permission `audit_logs.view`. No shop predicate is appended; HQ
 *     users see every row, optionally narrowed by the standard filters.
 *
 *   - Shop reader    `GET /api/v1/shop-audit-logs`      (task 10.3)
 *     Permission `audit_logs.view` AND active shop scope. The current
 *     scaffold appends `actor_shop_id = scope.shopId` only; the second
 *     clause from R28.7 ("OR target resource's shop_id matches") requires
 *     joining each `target_type` to its owning table and is implemented
 *     in task 10.3.
 *
 * Append-only contract (R28.3, design §12.4): this service exposes no
 * mutation methods. Audit row writes happen in `src/utils/audit-log.js`,
 * which is invoked from every mutating service per design §12.2.
 *
 * Requirements: R28.3, R28.6, R28.7
 * Design:       §10, §12.3 of .kiro/specs/multi-vendor-system/design.md
 */
export class AuditLogsService {
  /**
   * @param {import('./audit-logs.repository.js').AuditLogsRepository} repository
   */
  constructor(repository) {
    if (!repository) {
      throw new TypeError('AuditLogsService requires a repository')
    }
    this.repo = repository
  }

  /**
   * Paginated list of audit log entries.
   *
   * Scope semantics:
   *   - `scope.isHQ === true`: no shop filter is forced; the HQ reader
   *     receives every row that matches `filters`. The caller may still
   *     pass `filters.actor_shop_id` to narrow voluntarily.
   *   - `scope.isHQ === false`: a non-HQ caller is shop-scoped. The
   *     service forces `actor_shop_id = scope.shopId`, overriding any
   *     `filters.actor_shop_id` supplied by the caller (defence-in-depth
   *     against a forged query string). When `scope.shopId` is missing
   *     for a non-HQ caller, the service throws so the controller can
   *     translate the error to HTTP 400 SHOP_SCOPE_REQUIRED — by design
   *     this should be unreachable because the route's
   *     `requireShopScope` middleware rejects scopeless requests first.
   *
   * Pagination defaults to 20 / capped at 100 (R28.6 / R28.7); both the
   * Zod schema and the repository enforce the cap.
   *
   * @param {object} filters - validated by `listAuditLogsQuerySchema`
   * @param {{ isHQ: boolean, shopId: string|null }} scope
   * @returns {Promise<{ items: object[], total: number, page: number, limit: number }>}
   */
  async list(filters, scope) {
    if (!scope || typeof scope.isHQ !== 'boolean') {
      throw new TypeError(
        'AuditLogsService.list requires scope = { isHQ: boolean, shopId: string|null }',
      )
    }

    const repoFilters = {
      actor_user_id: filters.actor_user_id,
      actor_shop_id: filters.actor_shop_id,
      target_type: filters.target_type,
      target_id: filters.target_id,
      action: filters.action,
      fromDate: filters.from,
      toDate: filters.to,
      page: filters.page,
      limit: filters.limit,
    }

    if (!scope.isHQ) {
      if (!scope.shopId) {
        // The shop-scope middleware on task-10.3's route should reject
        // scopeless requests before they reach the service; raise a
        // typed error so any future caller that bypasses middleware
        // surfaces the bug at the call site rather than leaking
        // unscoped audit rows.
        const err = new Error('shop scope is required for non-HQ audit-log reads')
        err.code = 'SHOP_SCOPE_REQUIRED'
        throw err
      }
      // Force the active shop_id, ignoring any caller-supplied value.
      // R28.7 also covers "target resource's shop_id matches"; that
      // second clause is the responsibility of task 10.3 and is
      // intentionally deferred from this scaffold.
      repoFilters.actor_shop_id = scope.shopId
    }

    const { items, total } = await this.repo.findMany(repoFilters)

    return {
      items,
      total,
      page: filters.page,
      limit: filters.limit,
    }
  }
}
