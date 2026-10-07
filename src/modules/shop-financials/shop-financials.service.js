import { cacheGet, cacheSet, cacheDeletePattern } from '../../utils/cache.js'

/**
 * Shop Financials service — read-only business logic with Redis caching.
 *
 * Read-only by design (Requirement 6.1, 6.5):
 *   - The Settlement_Worker (task 9.1) writes daily/weekly/monthly rows.
 *   - The Payout_Worker (task 9.2) advances payout_status.
 *   - This module exposes paginated listings and single-record reads only.
 *
 * Authorization (project-standards.md, design.md role table):
 *   Only platform ADMIN, SHOP_ADMIN, or SHOP_MANAGER may view financials.
 *   Routes enforce this defensively before invoking the service; the service
 *   exposes `authorizeRead` so unit tests and the controller can share the
 *   same decision.
 *
 * Caching (design.md Caching Strategy):
 *   Key shape — bakaloo:financials:v1:{shop_id}:{period_type}:{from}:{to}:p{page}
 *   TTL       — 900 seconds (15 minutes)
 *   Invalidation — `invalidateForShop(shopId)` is called by the
 *     Settlement_Worker after writing rows for that shop, so reads see
 *     fresh aggregates within one settlement run.
 */

const CACHE_PREFIX = 'bakaloo:financials:v1'
const CACHE_TTL_SECONDS = 900

const STAFF_ROLES_ALLOWED_TO_READ = new Set(['SHOP_ADMIN', 'SHOP_MANAGER'])

export class ShopFinancialsService {
  /**
   * @param {import('./shop-financials.repository.js').ShopFinancialsRepository} repository
   */
  constructor(repository) {
    this.repo = repository
  }

  // ────────────────────────────────────────────────────────
  // Authorization
  // ────────────────────────────────────────────────────────

  /**
   * Decide whether `actor` may read shop financials.
   * Allowed: platform ADMIN OR shop staff with SHOP_ADMIN/MANAGER role.
   * Explicitly NOT staff/viewer (Requirement 14.5/14.7 — only those with
   * view_financials in the design.md role table).
   *
   * Pure function (no I/O) so the controller and unit tests share semantics.
   *
   * @param {object|null} actor - { role, shopRole }
   * @returns {{ ok: boolean, message?: string, code?: string }}
   */
  authorizeRead(actor) {
    if (!actor) {
      return { ok: false, message: 'Unauthorized', code: 'UNAUTHORIZED' }
    }
    if (actor.role === 'ADMIN') return { ok: true }
    if (STAFF_ROLES_ALLOWED_TO_READ.has(actor.shopRole)) return { ok: true }
    return {
      ok: false,
      message:
        'Only Shop Admin, Shop Manager, or Super Admin can view financials',
      code: 'FORBIDDEN',
    }
  }

  // ────────────────────────────────────────────────────────
  // Cache helpers
  // ────────────────────────────────────────────────────────

  /**
   * Build the canonical Redis key for a paginated listing.
   *
   * Filters that aren't set are recorded as the literal "all" so the same
   * filter combination always yields the same key (no aliasing).
   *
   * @param {string} shopId
   * @param {object} filters
   * @returns {string}
   */
  cacheKeyForList(shopId, filters) {
    const periodType = filters.period_type || 'all'
    const from = filters.from || 'all'
    const to = filters.to || 'all'
    const status = filters.payout_status || 'all'
    const page = filters.page
    const limit = filters.limit
    return [
      CACHE_PREFIX,
      shopId,
      periodType,
      from,
      to,
      status,
      `p${page}`,
      `l${limit}`,
    ].join(':')
  }

  /**
   * Invalidate every cached financials listing for a shop.
   * Called by the Settlement_Worker after a write so subsequent reads do not
   * return stale aggregates. Pattern-based SCAN, never KEYS *.
   *
   * @param {string} shopId
   */
  async invalidateForShop(shopId) {
    if (!shopId) return
    await cacheDeletePattern(`${CACHE_PREFIX}:${shopId}:*`)
  }

  // ────────────────────────────────────────────────────────
  // Reads
  // ────────────────────────────────────────────────────────

  /**
   * List shop_financials records for a shop with pagination, filters, and
   * Redis caching.
   *
   * @param {string} shopId
   * @param {{
   *   page: number, limit: number,
   *   period_type?: string, from?: string, to?: string,
   *   payout_status?: string
   * }} filters - Already validated by Zod
   * @returns {Promise<{items: Array<object>, total: number, page: number, limit: number}>}
   */
  async list(shopId, filters) {
    const key = this.cacheKeyForList(shopId, filters)

    const cached = await cacheGet(key)
    if (cached) return cached

    const { items, total } = await this.repo.findMany({
      shopId,
      page: filters.page,
      limit: filters.limit,
      period_type: filters.period_type,
      from: filters.from,
      to: filters.to,
      payout_status: filters.payout_status,
    })

    const result = {
      items,
      total,
      page: filters.page,
      limit: filters.limit,
    }

    await cacheSet(key, result, CACHE_TTL_SECONDS)
    return result
  }

  /**
   * Get a single shop_financials record (scoped to shop).
   *
   * Single-record reads are not cached — they are infrequent (drill-down on
   * a row already shown in a list page) and the row is small enough that the
   * extra Redis hop would not pay off.
   *
   * @param {string} shopId
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getById(shopId, id) {
    return this.repo.findById(id, shopId)
  }
}

// Export the constants so workers and tests can reference them without
// duplicating string literals.
export const SHOP_FINANCIALS_CACHE_PREFIX = CACHE_PREFIX
export const SHOP_FINANCIALS_CACHE_TTL_SECONDS = CACHE_TTL_SECONDS
