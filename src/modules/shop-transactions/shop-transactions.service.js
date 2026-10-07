import { cacheGet, cacheSet, cacheDeletePattern } from '../../utils/cache.js'
import { logger } from '../../config/logger.js'
import { emitInTx as emitAuditInTx } from '../../utils/audit-log.js'
import { ShopTransactionsRepository } from './shop-transactions.repository.js'
import {
  CREDIT_TYPES,
  DEBIT_TYPES,
  ledgerAppendDataSchema,
  ledgerRecordEntrySchema,
  ledgerRecordPairSchema,
} from './shop-transactions.schema.js'

/**
 * Shop Transactions services.
 *
 * Two services share this file because they collaborate around the same
 * append-only ledger:
 *
 *   1. `ShopTransactionsService` — read-only public surface used by the
 *      controller. Wraps the repository in a Redis cache with a short TTL
 *      (60s) — short enough that ledger pages stay near-real-time, long
 *      enough to absorb dashboard refresh storms.
 *
 *   2. `LedgerWriteService` — internal append-only writer used by the
 *      orders, refunds, and payouts modules. Runs inside a caller-owned
 *      transaction with SELECT … FOR UPDATE on the previous balance row
 *      (Requirement 7.7). On failure it propagates to the caller so the
 *      outer transaction is rolled back (Requirement 7.9).
 *
 * The append-only invariant (Requirements 7.3, 7.4, 15.1) is enforced
 * structurally — the repository does not export update/delete methods,
 * and this service exposes no API for mutating existing rows.
 */

const CACHE_PREFIX = 'bakaloo:shop-transactions:v1'
const CACHE_TTL_SECONDS = 60

const READ_ROLES_PLATFORM = new Set(['ADMIN'])
const READ_ROLES_SHOP = new Set(['SHOP_ADMIN', 'SHOP_MANAGER'])

// ─── Decimal helpers ─────────────────────────────────────
// We work in integer cents to dodge IEEE-754 rounding when summing dozens of
// ledger entries. balance_after is DECIMAL(12,2) so it always rounds to 2dp.
function toCents(value) {
  // Accept number, numeric string, or null.
  if (value === null || value === undefined) return 0
  const n = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(n)) {
    throw new TypeError(
      `Invalid decimal value: ${JSON.stringify(value)} — expected number or numeric string`
    )
  }
  // Round to nearest cent. Use Math.round on (n*100) for symmetric rounding.
  return Math.round(n * 100)
}

function fromCents(cents) {
  // Format integer cents as a fixed-2 decimal string ("0.00", "12.34").
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const whole = Math.trunc(abs / 100)
  const frac = abs % 100
  return `${sign}${whole}.${frac.toString().padStart(2, '0')}`
}

// ════════════════════════════════════════════════════════
// 1. READ-ONLY PUBLIC SURFACE
// ════════════════════════════════════════════════════════

export class ShopTransactionsService {
  /**
   * @param {import('./shop-transactions.repository.js').ShopTransactionsRepository} repository
   */
  constructor(repository) {
    if (!repository) {
      throw new TypeError('ShopTransactionsService requires a repository')
    }
    this.repo = repository
  }

  // ── Authorization ────────────────────────────────────
  /**
   * Read access (Req 13.5):
   *   - Platform ADMIN (Super Admin) — always.
   *   - SHOP_ADMIN / SHOP_MANAGER for the active shop. The `requireShopScope`
   *     middleware already enforces that the JWT shop matches request.shopId,
   *     so checking the shopRole alone is sufficient here.
   *
   * @param {object} actor - { id, role, shopRole }
   * @returns {{ ok: boolean, message?: string, code?: string }}
   */
  authorizeRead(actor) {
    if (!actor) return { ok: false, message: 'Unauthorized', code: 'UNAUTHORIZED' }
    if (READ_ROLES_PLATFORM.has(actor.role)) return { ok: true }
    if (READ_ROLES_SHOP.has(actor.shopRole)) return { ok: true }
    return {
      ok: false,
      message:
        'Only Shop Admin, Shop Manager, or Super Admin can read shop transactions',
      code: 'FORBIDDEN',
    }
  }

  // ── Cache helpers ────────────────────────────────────
  /**
   * Build the canonical cache key for a list response.
   * Format: bakaloo:shop-transactions:v1:{shop_id}[:t{type}][:rt{ref_type}][:r{ref_id}][:f{from}][:t2{to}]:p{page}:l{limit}
   */
  cacheKeyForList(shopId, filters) {
    const parts = [`${CACHE_PREFIX}:${shopId}`]
    if (filters.type) parts.push(`t${filters.type}`)
    if (filters.reference_type) parts.push(`rt${filters.reference_type}`)
    if (filters.reference_id) parts.push(`r${filters.reference_id}`)
    if (filters.from instanceof Date) parts.push(`f${filters.from.getTime()}`)
    if (filters.to instanceof Date) parts.push(`t2${filters.to.getTime()}`)
    parts.push(`p${filters.page}`, `l${filters.limit}`)
    return parts.join(':')
  }

  cacheKeyForBalance(shopId) {
    return `${CACHE_PREFIX}:${shopId}:balance`
  }

  /**
   * Drop every cached read for a shop. Called by `LedgerWriteService.append()`
   * after a successful insert so dashboards see the new entry immediately.
   * SCAN-based pattern delete (never KEYS *).
   */
  async invalidateShopCache(shopId) {
    await cacheDeletePattern(`${CACHE_PREFIX}:${shopId}:*`)
  }

  // ── Read endpoints ───────────────────────────────────

  /**
   * Paginated list of ledger entries for a shop.
   * @param {string} shopId
   * @param {object} filters - already validated by the controller
   * @returns {Promise<{items, total, page, limit}>}
   */
  async list(shopId, filters) {
    const key = this.cacheKeyForList(shopId, filters)
    const cached = await cacheGet(key)
    if (cached) return cached

    const { items, total } = await this.repo.findManyByShop({
      shopId,
      page: filters.page,
      limit: filters.limit,
      type: filters.type,
      reference_type: filters.reference_type,
      reference_id: filters.reference_id,
      from: filters.from,
      to: filters.to,
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
   * Get the current balance for a shop (latest balance_after).
   * Returns "0.00" when no entries exist yet (Requirement 7.8).
   * @param {string} shopId
   * @returns {Promise<{ balance: string, last_entry_at: Date|null }>}
   */
  async getCurrentBalance(shopId) {
    const key = this.cacheKeyForBalance(shopId)
    const cached = await cacheGet(key)
    if (cached) return cached

    const result = await this.repo.findCurrentBalance(shopId)
    await cacheSet(key, result, CACHE_TTL_SECONDS)
    return result
  }

  /**
   * Single-entry lookup, scoped to the shop (Requirement 13.6).
   * @param {string} shopId
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getById(shopId, id) {
    return this.repo.findById(id, shopId)
  }
}

// ════════════════════════════════════════════════════════
// 2. INTERNAL LEDGER WRITE SERVICE
// ════════════════════════════════════════════════════════

export class LedgerWriteService {
  /**
   * @param {import('./shop-transactions.repository.js').ShopTransactionsRepository} repository
   * @param {object} [options]
   * @param {ShopTransactionsService} [options.readService] - Used to invalidate
   *   the public-read cache after a successful append. Optional so callers can
   *   construct the writer without a Redis client (e.g., in unit tests).
   */
  constructor(repository, options = {}) {
    if (!repository) {
      throw new TypeError('LedgerWriteService requires a repository')
    }
    this.repo = repository
    this.readService = options.readService || null
  }

  /**
   * Compute the new balance_after for an entry, given the previous balance
   * (in cents) and the entry's signed amount.
   *
   * Credits (ORDER_REVENUE, PAYOUT_CREDIT, ADJUSTMENT) → previous + amount
   * Debits  (COMMISSION_DEBIT, DELIVERY_COST, REFUND_DEBIT, EXPENSE) → previous - amount
   *
   * (Requirement 7.7)
   *
   * @param {number} prevCents - integer cents
   * @param {string} type
   * @param {number} amountCents - integer cents (always non-negative)
   * @returns {number} new balance in integer cents (may be negative — debits
   *   can legitimately push a shop into the red mid-cycle, e.g., DELIVERY_COST
   *   posted before ORDER_REVENUE; the DB column is signed DECIMAL(12,2)).
   */
  static computeBalanceCents(prevCents, type, amountCents) {
    if (CREDIT_TYPES.has(type)) return prevCents + amountCents
    if (DEBIT_TYPES.has(type)) return prevCents - amountCents
    // Schema validation should have rejected this already; defence-in-depth.
    throw new Error(`Unknown ledger transaction type: ${type}`)
  }

  /**
   * Append a ledger entry inside the caller's transaction.
   *
   * The caller MUST:
   *   - have already issued BEGIN on `client`
   *   - hand the SAME `client` to any other writes that must be atomic with
   *     this ledger entry (paired ORDER_REVENUE + COMMISSION_DEBIT, etc.)
   *   - COMMIT or ROLLBACK after this method returns or throws (Req 7.9)
   *
   * Lock ordering (avoids deadlocks across concurrent appends to the same shop):
   *   1. SELECT FOR UPDATE on the latest row for `shopId` (or no row if first).
   *   2. Compute balance_after = previous +/- amount  (Req 7.7, 7.8).
   *   3. INSERT the new row, returning the inserted record.
   *   4. Emit a `transaction_posted` audit on the same `client` so the audit
   *      row commits or rolls back atomically with the ledger row
   *      (R24.13, design §9.2).
   *
   * @param {import('pg').PoolClient} client
   * @param {object} data
   * @param {string} data.shopId
   * @param {string} data.type - one of TRANSACTION_TYPES
   * @param {number} data.amount - DECIMAL(10,2), 0.01..99999999.99
   * @param {string} data.referenceType - one of REFERENCE_TYPES
   * @param {string|null} [data.referenceId]
   * @param {string|null} [data.description]
   * @param {string|null} [data.createdBy]
   * @returns {Promise<object>} the inserted row
   */
  async append(client, data) {
    if (!client || typeof client.query !== 'function') {
      throw new TypeError(
        'LedgerWriteService.append requires a transactional pg client (BEGIN already issued by the caller)'
      )
    }

    // Validate inputs once, against the same schema used by callers.
    const parsed = ledgerAppendDataSchema.safeParse(data)
    if (!parsed.success) {
      const detail = parsed.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ')
      const err = new Error(`Invalid ledger entry: ${detail}`)
      err.code = 'LEDGER_VALIDATION_ERROR'
      throw err
    }
    const v = parsed.data

    // 1) Lock the previous row for this shop (or none if first entry — Req 7.8)
    const previous = await this.repo.lockLatestForShop(client, v.shopId)
    const prevCents = previous ? toCents(previous.balance_after) : 0

    // 2) Compute new balance_after (Req 7.7)
    const amountCents = toCents(v.amount)
    const newCents = LedgerWriteService.computeBalanceCents(
      prevCents,
      v.type,
      amountCents
    )

    // 3) Append
    const inserted = await this.repo.insertEntry(client, {
      shop_id: v.shopId,
      type: v.type,
      amount: fromCents(amountCents),
      balance_after: fromCents(newCents),
      reference_type: v.referenceType,
      reference_id: v.referenceId ?? null,
      description: v.description ?? null,
      created_by: v.createdBy ?? null,
    })

    // 3b) Emit `transaction_posted` audit on the SAME transactional client
    //     so the audit row commits or rolls back together with the ledger
    //     row (R24.13, design §9.2). The audit `after` snapshot is run
    //     through `normalizeType` to surface the V2 canonical `type_v2`
    //     value alongside the stored legacy `type` (R24.15). Sensitive-
    //     field redaction is handled by `emitInTx` itself; ledger rows
    //     never contain password_hash/bank_account_number anyway, but
    //     the pipeline is consistent with every other mutating audit.
    const normalized = ShopTransactionsRepository.normalizeType(inserted)
    await emitAuditInTx(client, 'transaction_posted', {
      actor_user_id: v.createdBy ?? null,
      actor_role: null,
      actor_shop_id: v.shopId,
      target_type: 'shop_transaction',
      target_id: inserted.id,
      before: null,
      after: {
        type: inserted.type,
        type_v2: normalized?.type_v2 ?? inserted.type,
        direction: normalized?.direction ?? inserted.direction ?? null,
        amount: inserted.amount,
        balance_after: inserted.balance_after,
        reference_type: inserted.reference_type,
        reference_id: inserted.reference_id ?? null,
        status: inserted.status ?? null,
        order_id: inserted.order_id ?? null,
        rider_id: inserted.rider_id ?? null,
      },
      ip_address: null,
      user_agent: null,
    })

    // 4) Best-effort cache invalidation. We do NOT await this in a way that
    //    can break the outer transaction — Redis is independent of Postgres.
    //    If it fails we log but still return the inserted row; the next read
    //    will hit Redis with a stale value at most for CACHE_TTL_SECONDS.
    if (this.readService) {
      try {
        await this.readService.invalidateShopCache(v.shopId)
      } catch (cacheErr) {
        logger.warn(
          {
            shopId: v.shopId,
            action: 'ledger_cache_invalidate_failed',
            err: cacheErr?.message,
          },
          'Ledger append succeeded but cache invalidation failed'
        )
      }
    }

    logger.info(
      {
        shopId: v.shopId,
        action: 'ledger_appended',
        type: v.type,
        amount: fromCents(amountCents),
        balance_after: fromCents(newCents),
        reference_type: v.referenceType,
        reference_id: v.referenceId ?? null,
        ledger_entry_id: inserted.id,
      },
      'Ledger entry appended'
    )

    return inserted
  }

  /**
   * Canonical snake_case ledger-write API surface (Requirements 7.1, 7.2,
   * 7.7, 7.8, 7.9). Mirrors the column names in `shop_transactions` so other
   * modules can pass payloads that read like SQL rows.
   *
   * Behavior is identical to `append()`:
   *   - runs inside the caller's transaction (never opens its own),
   *   - SELECT FOR UPDATE on the latest row for `shop_id` to read the prior
   *     balance (0 if no prior row),
   *   - computes balance_after = prev +/- amount based on type,
   *   - INSERTs the new row and returns it,
   *   - propagates DB / validation errors so the caller can ROLLBACK.
   *
   * @param {import('pg').PoolClient} client
   * @param {object} data
   * @param {string} data.shop_id
   * @param {string} data.type
   * @param {number} data.amount - DECIMAL(10,2), 0.01..99999999.99 (sign implied by type)
   * @param {string} data.reference_type
   * @param {string|null} [data.reference_id]
   * @param {string|null} [data.description]
   * @param {string|null} [data.created_by]
   * @returns {Promise<object>} the inserted row
   */
  async recordEntry(client, data) {
    const parsed = ledgerRecordEntrySchema.safeParse(data)
    if (!parsed.success) {
      const detail = parsed.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ')
      const err = new Error(`Invalid ledger entry: ${detail}`)
      err.code = 'LEDGER_VALIDATION_ERROR'
      throw err
    }
    const v = parsed.data
    return this.append(client, {
      shopId: v.shop_id,
      type: v.type,
      amount: v.amount,
      referenceType: v.reference_type,
      referenceId: v.reference_id ?? null,
      description: v.description ?? null,
      createdBy: v.created_by ?? null,
    })
  }

  /**
   * Convenience helper for Requirement 7.5 — on order completion, atomically
   * record an ORDER_REVENUE entry followed by the matching COMMISSION_DEBIT.
   * Both entries share the same `reference_id` (order ID) and run on the same
   * caller-owned transactional client, so they either both commit or both
   * roll back together (Property 12).
   *
   * Commission is computed as `revenue_amount * commission_rate / 100`,
   * rounded half-up to the nearest cent. The arithmetic happens in integer
   * cents to avoid IEEE-754 drift and is bounded by the same DECIMAL(10,2)
   * envelope as the underlying ledger entries.
   *
   * @param {import('pg').PoolClient} client
   * @param {object} data
   * @param {string} data.shop_id
   * @param {number} data.revenue_amount - net total of the order (DECIMAL(10,2))
   * @param {number} data.commission_rate - percentage in [0, 100]
   * @param {string|null} [data.reference_id] - the order ID
   * @param {string|null} [data.description]
   * @param {string|null} [data.created_by]
   * @returns {Promise<{ revenue: object, commission: object|null }>}
   */
  async recordPair(client, data) {
    if (!client || typeof client.query !== 'function') {
      throw new TypeError(
        'LedgerWriteService.recordPair requires a transactional pg client (BEGIN already issued by the caller)'
      )
    }

    const parsed = ledgerRecordPairSchema.safeParse(data)
    if (!parsed.success) {
      const detail = parsed.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ')
      const err = new Error(`Invalid ledger pair: ${detail}`)
      err.code = 'LEDGER_VALIDATION_ERROR'
      throw err
    }
    const v = parsed.data

    // Commission in integer cents so we never lose half-cent precision when
    // commission_rate produces a fractional value (e.g. 99.99 * 7.5%).
    const revenueCents = toCents(v.revenue_amount)
    const commissionCents = Math.round((revenueCents * v.commission_rate) / 100)
    const commissionAmount = Number(fromCents(commissionCents))

    const revenue = await this.append(client, {
      shopId: v.shop_id,
      type: 'ORDER_REVENUE',
      amount: v.revenue_amount,
      referenceType: 'ORDER',
      referenceId: v.reference_id ?? null,
      description: v.description ?? null,
      createdBy: v.created_by ?? null,
    })

    let commission = null
    if (commissionCents > 0) {
      commission = await this.append(client, {
        shopId: v.shop_id,
        type: 'COMMISSION_DEBIT',
        amount: commissionAmount,
        referenceType: 'ORDER',
        referenceId: v.reference_id ?? null,
        description: v.description ?? null,
        createdBy: v.created_by ?? null,
      })
    }

    return { revenue, commission }
  }
}

// Internal helpers exported for unit tests only.
export const __internals = { toCents, fromCents }
