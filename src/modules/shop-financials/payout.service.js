// Feature: multi-vendor-system, task 9.2
// Validates Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 14.6
//
// Payout service — drives the Payout_Worker state machine.
//
// Responsibilities (mapped to acceptance criteria):
//   * `runWeeklyPayouts({ asOf })` — Req 8.1: identify PENDING rows whose
//     period_end <= the preceding Sunday and enqueue one `process-payout`
//     job per row. Idempotent — re-running for the same week skips rows
//     already processed because the row-level guarded transition refuses
//     non-PENDING starts.
//   * `processPayout(financialId)` — Req 8.2, 8.3, 8.5, 8.6: in a single
//     transaction, lock the row → validate bank details → transition
//     PENDING→PROCESSING → run disbursement → on success transition
//     PROCESSING→PAID + write a PAYOUT_CREDIT ledger entry, on failure
//     increment attempt_count and set back to PENDING (or HELD after the
//     3rd attempt) — all rolled into one DB transaction so a partial
//     failure leaves no orphan ledger row.
//   * `setHold` / `releaseHold` — Req 8.7: Super Admin guarded transitions
//     PENDING|PROCESSING→HELD and HELD→PENDING.
//
// Pure helper:
//   * `nextPayoutState(state, event)` re-exported from
//     `payout-state-machine.js` for completeness; Property 16 already drives
//     the machine directly.
//
// Resource budget (Req 14.6): each candidate is processed in its own
// transaction so the lock window stays under 30s; pagination keeps the
// candidate scan bounded; queue concurrency 1 in the BullMQ config means
// payouts and ledger writes never race with themselves.

import { logger } from '../../config/logger.js'
import { getClient } from '../../config/database.js'
import { ShopFinancialsWriteRepository } from './shop-financials.write.repository.js'
import { ShopFinancialsService } from './shop-financials.service.js'
import { ShopFinancialsRepository } from './shop-financials.repository.js'
import { emit as emitAudit } from '../../utils/audit-log.js'
import {
  LedgerWriteService,
  ShopTransactionsService,
} from '../shop-transactions/shop-transactions.service.js'
import { ShopTransactionsRepository } from '../shop-transactions/shop-transactions.repository.js'
import {
  PAYOUT_MAX_ATTEMPTS,
  nextPayoutState,
} from './payout-state-machine.js'

/** Re-exported for callers (worker, admin routes, tests). */
export { nextPayoutState, PAYOUT_MAX_ATTEMPTS }

/**
 * The preceding Sunday at 23:59:59 UTC for `now`. Returned as YYYY-MM-DD
 * because shop_financials.period_end is a DATE column. When `now` is itself
 * a Sunday the function returns the Sunday before it (Req 8.1: we settle
 * weeks whose entire window has closed, so a Monday 02:00 UTC run targets
 * the previous Mon..Sun window).
 *
 * @param {Date} now
 * @returns {string} YYYY-MM-DD (UTC)
 */
export function precedingSundayDateString(now = new Date()) {
  const ref = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  )
  const dayOfWeek = ref.getUTCDay() // 0 = Sunday, 1 = Monday, …, 6 = Saturday
  // Distance back to the *previous* Sunday. On Sunday → 7 (skip today).
  const offsetDays = dayOfWeek === 0 ? 7 : dayOfWeek
  const prevSunday = new Date(ref.getTime() - offsetDays * 24 * 60 * 60 * 1000)
  const y = prevSunday.getUTCFullYear()
  const m = String(prevSunday.getUTCMonth() + 1).padStart(2, '0')
  const d = String(prevSunday.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * `bank_*` columns are nullable VARCHAR. Treat null/empty (after trim) as
 * "missing" — Req 8.6 routes such rows to HELD without burning an attempt.
 *
 * @param {object|null} bank
 * @returns {boolean}
 */
function hasCompleteBankDetails(bank) {
  if (!bank) return false
  const fields = [
    bank.bank_account_number,
    bank.bank_ifsc,
    bank.bank_name,
    bank.bank_holder_name,
  ]
  return fields.every(
    (v) => typeof v === 'string' && v.trim().length > 0
  )
}

/**
 * Default disbursement implementation — there is no real bank API in the
 * MVP, so the worker just confirms the payout. Production should inject a
 * disbursement function via the constructor that returns a payout
 * reference (e.g. RazorpayX payout id) or throws on failure.
 *
 * @param {object} financial - locked shop_financials row
 * @returns {Promise<{payoutRef: string}>}
 */
async function defaultDisbursement(financial) {
  // Stable, deterministic reference per financial row so retries land on
  // the same idempotency key in any future real disbursement adapter.
  return { payoutRef: `INTERNAL-${financial.id}` }
}

export class PayoutService {
  /**
   * @param {object} [deps]
   * @param {ShopFinancialsWriteRepository} [deps.writeRepository]
   * @param {LedgerWriteService} [deps.ledgerWriteService]
   * @param {ShopFinancialsService} [deps.financialsService]
   * @param {{ add: Function }} [deps.queue] - BullMQ payouts queue (optional in tests)
   * @param {(financial:object)=>Promise<{payoutRef:string}>} [deps.disburse]
   */
  constructor(deps = {}) {
    this.writeRepo =
      deps.writeRepository || new ShopFinancialsWriteRepository()

    if (deps.ledgerWriteService) {
      this.ledger = deps.ledgerWriteService
    } else {
      const txRepo = new ShopTransactionsRepository()
      const readService = new ShopTransactionsService(txRepo)
      this.ledger = new LedgerWriteService(txRepo, { readService })
    }

    this.financialsService =
      deps.financialsService ||
      new ShopFinancialsService(
        deps.financialsRepository || new ShopFinancialsRepository()
      )

    this.queue = deps.queue || null
    this.disburse = deps.disburse || defaultDisbursement
  }

  // ────────────────────────────────────────────────────────
  // Weekly run — enqueue a process-payout job per candidate
  // ────────────────────────────────────────────────────────

  /**
   * Identify every PENDING shop_financials row whose period_end is <= the
   * preceding Sunday and enqueue a `process-payout` job per row (Req 8.1).
   *
   * Idempotency:
   *   - We use a deterministic jobId (`process-payout:{rowId}`) so re-runs
   *     coalesce on the same job (BullMQ rejects duplicates by id).
   *   - The actual transition is guarded inside `processPayout`; even if a
   *     stale enqueue slips through, the row's current status will block
   *     a duplicate transition.
   *
   * @param {object} [options]
   * @param {Date|string} [options.asOf] - "settle as of" timestamp
   * @param {number} [options.batchSize=50]
   * @returns {Promise<{enqueued:number, skipped:number, asOfDate:string}>}
   */
  async runWeeklyPayouts({ asOf, batchSize = 50 } = {}) {
    const refDate =
      asOf instanceof Date ? asOf : asOf ? new Date(asOf) : new Date()
    const asOfDate = precedingSundayDateString(refDate)
    const summary = { enqueued: 0, skipped: 0, asOfDate }

    let cursor = null
    const MAX_PAGES = 5000 // 5000 * 50 = 250k rows cap

    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await this.writeRepo.findPendingPayouts({
        asOfDate,
        afterId: cursor,
        limit: batchSize,
      })
      if (page.length === 0) break

      for (const row of page) {
        if (!this.queue) {
          // No queue wired in (tests, dry-run): just count.
          summary.skipped += 1
          continue
        }
        try {
          await this.queue.add(
            'process-payout',
            { type: 'process-payout', financialId: row.id },
            {
              jobId: `process-payout:${row.id}`,
              removeOnComplete: { age: 7 * 24 * 3600 },
              removeOnFail: { age: 14 * 24 * 3600 },
            }
          )
          summary.enqueued += 1
        } catch (err) {
          summary.skipped += 1
          logger.warn(
            {
              financialId: row.id,
              shopId: row.shop_id,
              action: 'payout_enqueue_failed',
              err: err.message,
            },
            'Failed to enqueue process-payout job'
          )
        }
      }

      cursor = page[page.length - 1].id
      if (page.length < batchSize) break
    }

    logger.info(
      {
        action: 'payout_weekly_run_complete',
        ...summary,
      },
      'Weekly payout enqueue complete'
    )
    return summary
  }

  // ────────────────────────────────────────────────────────
  // Process a single payout — full state machine in one tx
  // ────────────────────────────────────────────────────────

  /**
   * Process one shop_financials row through PENDING → PROCESSING → PAID
   * (or PENDING → HELD on missing bank details / attempt-count overflow,
   * or back to PENDING on transient disbursement failure).
   *
   * Single transaction (Req 8.2, 8.3, 14.6, 14.8):
   *   - SELECT FOR UPDATE locks the row.
   *   - Bank-details check (Req 8.6) routes to HELD without disbursement.
   *   - Guarded UPDATE PENDING→PROCESSING (Req 8.2, idempotent under retry).
   *   - Disbursement runs. On success: UPDATE PROCESSING→PAID + append a
   *     PAYOUT_CREDIT ledger entry (Req 8.3) using the SAME client so they
   *     commit together.
   *   - On disbursement failure: increment attempt_count; if attempts >= 3,
   *     transition PROCESSING→HELD (Req 8.5); otherwise transition back to
   *     PENDING for the next scheduled run.
   *
   * @param {string} financialId
   * @returns {Promise<object>}
   */
  async processPayout(financialId) {
    if (!financialId) {
      throw new Error('processPayout: financialId is required')
    }

    const client = await getClient()
    let invalidateShopId = null
    let result

    try {
      await client.query('BEGIN')

      const locked = await this.writeRepo.lockFinancialById(client, financialId)
      if (!locked) {
        await client.query('ROLLBACK')
        return {
          financialId,
          shopId: null,
          outcome: 'NOT_FOUND',
        }
      }
      invalidateShopId = locked.shop_id

      // Already terminal / not eligible — nothing to do.
      if (locked.payout_status === 'PAID') {
        await client.query('ROLLBACK')
        return {
          financialId,
          shopId: locked.shop_id,
          outcome: 'INVALID_STATE',
          payoutStatus: 'PAID',
          reason: 'already_paid',
        }
      }
      if (
        locked.payout_status !== 'PENDING' &&
        locked.payout_status !== 'PROCESSING'
      ) {
        await client.query('ROLLBACK')
        return {
          financialId,
          shopId: locked.shop_id,
          outcome: 'INVALID_STATE',
          payoutStatus: locked.payout_status,
          reason: 'not_eligible',
        }
      }

      // ── Req 8.6 — bank details validation (no attempt burn) ──
      const bank = await this.writeRepo.findShopBankDetails(
        client,
        locked.shop_id
      )
      if (!hasCompleteBankDetails(bank)) {
        const held = await this.writeRepo.transitionPayoutStatus(
          client,
          locked.id,
          ['PENDING', 'PROCESSING'],
          'HELD',
          { failureReason: 'missing bank details' }
        )
        await client.query('COMMIT')
        logger.warn(
          {
            financialId,
            shopId: locked.shop_id,
            action: 'payout_held_missing_bank',
          },
          'Payout held — missing bank details'
        )

        // R28.4 — fire-and-forget audit for payout_held
        emitAudit('payout_held', {
          actor_user_id: null,
          actor_role: null,
          actor_shop_id: locked.shop_id,
          target_type: 'shop_financial',
          target_id: financialId,
          before: { payout_status: locked.payout_status },
          after: { payout_status: 'HELD', reason: 'missing bank details' },
        })

        result = {
          financialId,
          shopId: locked.shop_id,
          outcome: 'HELD_MISSING_BANK',
          payoutStatus: held?.payout_status || 'HELD',
          reason: 'missing bank details',
        }
        return result
      }

      // ── Req 8.2 — PENDING → PROCESSING ──
      const fromStatuses =
        locked.payout_status === 'PROCESSING'
          ? ['PROCESSING']
          : ['PENDING']
      const processing = await this.writeRepo.transitionPayoutStatus(
        client,
        locked.id,
        fromStatuses,
        'PROCESSING',
        { clearFailureReason: true }
      )
      if (!processing) {
        // Concurrent worker advanced the row; abort safely.
        await client.query('ROLLBACK')
        return {
          financialId,
          shopId: locked.shop_id,
          outcome: 'INVALID_STATE',
          reason: 'guard_failed_to_processing',
        }
      }

      // ── Disbursement ──
      let disbursement
      try {
        disbursement = await this.disburse(processing)
      } catch (disburseErr) {
        // Roll back the PENDING→PROCESSING transition we just did, then
        // open a fresh tx to record the failure under guarded transitions.
        await client.query('ROLLBACK')
        result = await this._handleDisbursementFailure(
          financialId,
          locked,
          disburseErr
        )
        return result
      }

      // ── Req 8.2/8.3 — PROCESSING → PAID + ledger entry ──
      const paid = await this.writeRepo.transitionPayoutStatus(
        client,
        locked.id,
        ['PROCESSING'],
        'PAID',
        {
          paidAt: new Date(),
          payoutRef: disbursement?.payoutRef || null,
          clearFailureReason: true,
        }
      )
      if (!paid) {
        // Should be impossible — we just locked the row and are inside the
        // same transaction. Defensive bail.
        await client.query('ROLLBACK')
        return {
          financialId,
          shopId: locked.shop_id,
          outcome: 'INVALID_STATE',
          reason: 'guard_failed_to_paid',
        }
      }

      const payoutAmount = Number(paid.payout_amount)
      // Req 8.3 — only write a ledger entry when there is a positive payout
      // amount; the ledger CHECK constraint forbids amount < 0.01.
      if (Number.isFinite(payoutAmount) && payoutAmount >= 0.01) {
        await this.ledger.recordEntry(client, {
          shop_id: paid.shop_id,
          type: 'PAYOUT_CREDIT',
          amount: payoutAmount,
          reference_type: 'PAYOUT',
          reference_id: paid.id,
          description: `Weekly payout ${paid.period_start} → ${paid.period_end}`,
        })
      } else {
        logger.warn(
          {
            financialId,
            shopId: paid.shop_id,
            payoutAmount,
            action: 'payout_skipped_zero_amount',
          },
          'Payout marked PAID with zero amount — no ledger entry written'
        )
      }

      await client.query('COMMIT')

      logger.info(
        {
          financialId,
          shopId: paid.shop_id,
          payoutRef: disbursement?.payoutRef || null,
          payoutAmount,
          action: 'payout_paid',
        },
        'Payout paid'
      )

      // R28.4 — fire-and-forget audit for payout_completed
      emitAudit('payout_completed', {
        actor_user_id: null,
        actor_role: null,
        actor_shop_id: paid.shop_id,
        target_type: 'shop_financial',
        target_id: financialId,
        before: { payout_status: 'PROCESSING' },
        after: {
          payout_status: 'PAID',
          payout_ref: disbursement?.payoutRef || null,
          payout_amount: payoutAmount,
        },
      })

      result = {
        financialId,
        shopId: paid.shop_id,
        outcome: 'PAID',
        payoutStatus: 'PAID',
        payoutRef: disbursement?.payoutRef || null,
        attemptCount: Number(paid.attempt_count) || 0,
      }
      return result
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore — surface original error */
      }
      throw err
    } finally {
      client.release()
      // Cache invalidation is best-effort and lives outside the tx.
      if (invalidateShopId) {
        await this._invalidateCache(invalidateShopId)
      }
    }
  }

  // ────────────────────────────────────────────────────────
  // Admin hold / release (Req 8.7)
  // ────────────────────────────────────────────────────────

  /**
   * Set a payout to HELD from PENDING or PROCESSING (Super Admin only —
   * caller is responsible for the role check at the route layer).
   *
   * @param {string} financialId
   * @param {string|null} actorId
   * @returns {Promise<{ok:boolean, row?:object, code?:string, message?:string}>}
   */
  async setHold(financialId, actorId = null) {
    return this._adminTransition(financialId, actorId, {
      from: ['PENDING', 'PROCESSING'],
      to: 'HELD',
      reason: 'admin hold',
      logAction: 'payout_admin_hold',
      errorCode: 'PAYOUT_INVALID_STATE',
      errorMessage:
        'Only PENDING or PROCESSING payouts can be moved to HELD',
    })
  }

  /**
   * Release a HELD payout back to PENDING (Super Admin only).
   *
   * @param {string} financialId
   * @param {string|null} actorId
   * @returns {Promise<{ok:boolean, row?:object, code?:string, message?:string}>}
   */
  async releaseHold(financialId, actorId = null) {
    return this._adminTransition(financialId, actorId, {
      from: ['HELD'],
      to: 'PENDING',
      reason: null,
      clearFailureReason: true,
      logAction: 'payout_admin_release',
      errorCode: 'PAYOUT_INVALID_STATE',
      errorMessage: 'Only HELD payouts can be released back to PENDING',
    })
  }

  // ────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────

  /**
   * Handle a disbursement failure in a fresh transaction. Increments
   * attempt_count and either transitions PROCESSING→HELD (>= 3 attempts)
   * or PROCESSING→PENDING (Req 8.5).
   *
   * @private
   */
  async _handleDisbursementFailure(financialId, originalRow, disburseErr) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      // Re-lock the row to get the latest attempt_count and current state.
      const current = await this.writeRepo.lockFinancialById(
        client,
        financialId
      )
      if (!current) {
        await client.query('ROLLBACK')
        return {
          financialId,
          shopId: originalRow.shop_id,
          outcome: 'NOT_FOUND',
        }
      }

      const newAttempts = await this.writeRepo.incrementAttemptCount(
        client,
        current.id
      )

      if (newAttempts >= PAYOUT_MAX_ATTEMPTS) {
        // Final failure → HELD for manual review (Req 8.5).
        await this.writeRepo.transitionPayoutStatus(
          client,
          current.id,
          ['PENDING', 'PROCESSING'],
          'HELD',
          { failureReason: `max attempts (${disburseErr.message})` }
        )
        await client.query('COMMIT')
        logger.error(
          {
            financialId,
            shopId: current.shop_id,
            attemptCount: newAttempts,
            err: disburseErr.message,
            action: 'payout_held_max_attempts',
          },
          'Payout held — max attempts reached'
        )

        // Task 8.11: emit payout_held audit for max-attempts case
        emitAudit('payout_held', {
          actor_user_id: null,
          actor_role: null,
          actor_shop_id: current.shop_id,
          target_type: 'shop_financial',
          target_id: financialId,
          before: { payout_status: 'PROCESSING' },
          after: { payout_status: 'HELD', reason: 'max_attempts', attempt_count: newAttempts },
        })

        return {
          financialId,
          shopId: current.shop_id,
          outcome: 'HELD_MAX_ATTEMPTS',
          payoutStatus: 'HELD',
          attemptCount: newAttempts,
          reason: disburseErr.message,
        }
      }

      // Transient failure → back to PENDING for next run (Req 8.5).
      await this.writeRepo.transitionPayoutStatus(
        client,
        current.id,
        ['PENDING', 'PROCESSING'],
        'PENDING',
        { failureReason: disburseErr.message }
      )
      await client.query('COMMIT')

      logger.warn(
        {
          financialId,
          shopId: current.shop_id,
          attemptCount: newAttempts,
          err: disburseErr.message,
          action: 'payout_retry_pending',
        },
        'Payout failed — retrying on next run'
      )

      return {
        financialId,
        shopId: current.shop_id,
        outcome: 'RETRY_PENDING',
        payoutStatus: 'PENDING',
        attemptCount: newAttempts,
        reason: disburseErr.message,
      }
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Shared admin-triggered transition runner used by `setHold` and
   * `releaseHold`. Lock the row, verify the current state, run a guarded
   * UPDATE, commit. Returns a discriminated result so the route handler
   * can map outcomes to HTTP status codes.
   *
   * @private
   */
  async _adminTransition(financialId, actorId, opts) {
    if (!financialId) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'financialId is required',
      }
    }
    const client = await getClient()
    let invalidateShopId = null
    try {
      await client.query('BEGIN')

      const current = await this.writeRepo.lockFinancialById(
        client,
        financialId
      )
      if (!current) {
        await client.query('ROLLBACK')
        return {
          ok: false,
          code: 'SHOP_FINANCIAL_NOT_FOUND',
          message: 'Shop financial not found',
        }
      }
      invalidateShopId = current.shop_id

      const updated = await this.writeRepo.transitionPayoutStatus(
        client,
        current.id,
        opts.from,
        opts.to,
        {
          failureReason: opts.reason ?? undefined,
          clearFailureReason: opts.clearFailureReason || false,
        }
      )
      if (!updated) {
        await client.query('ROLLBACK')
        return {
          ok: false,
          code: opts.errorCode,
          message: opts.errorMessage,
          row: current,
        }
      }

      await client.query('COMMIT')

      logger.info(
        {
          financialId: updated.id,
          shopId: updated.shop_id,
          payoutStatus: updated.payout_status,
          actorId,
          action: opts.logAction,
        },
        'Admin payout transition'
      )

      // R28.4 / Task 8.11 — fire-and-forget audit for payout state changes
      const auditAction = opts.to === 'HELD' ? 'payout_held' : 'payout_released'
      emitAudit(auditAction, {
        actor_user_id: actorId,
        actor_role: 'ADMIN',
        actor_shop_id: null,
        target_type: 'shop_financial',
        target_id: financialId,
        before: { payout_status: current.payout_status },
        after: { payout_status: updated.payout_status, shop_id: updated.shop_id },
      })

      return { ok: true, row: updated }
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    } finally {
      client.release()
      if (invalidateShopId) {
        await this._invalidateCache(invalidateShopId)
      }
    }
  }

  /**
   * Best-effort cache invalidation for a shop's financials read views.
   * @private
   */
  async _invalidateCache(shopId) {
    try {
      await this.financialsService.invalidateForShop(shopId)
    } catch (err) {
      logger.warn(
        {
          shopId,
          action: 'payout_cache_invalidate_failed',
          err: err.message,
        },
        'Payout cache invalidation failed (non-fatal)'
      )
    }
  }
}
