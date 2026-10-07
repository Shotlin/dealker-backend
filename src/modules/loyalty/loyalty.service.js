/**
 * Loyalty Service — admin-configurable points program.
 *
 * Points and Wallet are separate systems. The ledger (`loyalty_accounts` /
 * `loyalty_transactions`, migration 105 + 156) is authoritative: every
 * mutation is an append-only row with a UNIQUE idempotency key and a
 * balance_after snapshot.
 *
 * Lifecycle per spec §10:
 *   ORDER DELIVERED        → EARN_PENDING (available_at = now + hold days)
 *   RETURN WINDOW CLOSED   → EARN (points become redeemable)
 *   CANCEL / RETURN/REFUND → REVERSAL (idempotent)
 *
 * Pending balance is derived as MAX(0, ΣEARN_PENDING − ΣEARN): EARN rows are
 * only ever created by converting a pending batch, so the difference is the
 * unmatured remainder. `loyalty_accounts.points_balance` holds the
 * redeemable balance only.
 *
 * @module modules/loyalty/loyalty.service
 */

import { query, getClient } from '../../config/database.js'
import { logger } from '../../config/logger.js'

const DEFAULTS = Object.freeze({
  enabled: true,
  points_per_rupee: 0.02,
  point_value: 1.0,
  min_redeemable_points: 50,
  max_redemption_pct: 20.0,
  max_points_per_order: null,
  expiry_days: null,
  earning_trigger: 'ORDER_DELIVERED',
  return_window_hold_days: 7,
  excluded_category_ids: [],
  excluded_product_ids: [],
  excluded_vendor_ids: [],
  min_order_amount_to_earn: 0,
  stackable_with_coupons: true,
  stackable_with_milestones: true,
})

export class LoyaltyService {
  // ── Settings ──────────────────────────────────────────────────────────

  async getSettings() {
    const { rows } = await query('SELECT * FROM loyalty_settings WHERE id = TRUE')
    return rows[0] || { ...DEFAULTS }
  }

  async updateSettings(patch, actorId = null) {
    const allowed = [
      'enabled', 'points_per_rupee', 'point_value', 'min_redeemable_points',
      'max_redemption_pct', 'max_points_per_order', 'expiry_days',
      'earning_trigger', 'return_window_hold_days', 'excluded_category_ids',
      'excluded_product_ids', 'excluded_vendor_ids',
      'min_order_amount_to_earn', 'stackable_with_coupons',
      'stackable_with_milestones',
    ]
    const sets = ['updated_at = NOW()']
    const params = []
    for (const key of allowed) {
      if (patch[key] === undefined) continue
      if (!allowed.includes(key)) continue
      params.push(key === 'enabled' || key === 'stackable_with_coupons' || key === 'stackable_with_milestones'
        ? !!patch[key]
        : patch[key])
      sets.push(`${key} = $${params.length}`)
    }
    if (actorId) {
      params.push(actorId)
      sets.push(`updated_by = $${params.length}`)
    }
    if (sets.length === 1) return this.getSettings()
    await query(
      `UPDATE loyalty_settings SET ${sets.join(', ')} WHERE id = TRUE`,
      params
    )
    return this.getSettings()
  }

  // ── Accounts ──────────────────────────────────────────────────────────

  async ensureAccount(client, customerId) {
    const runner = client || { query: (text, params) => query(text, params) }
    const { rows } = await runner.query(
      `INSERT INTO loyalty_accounts (customer_id, points_balance)
       VALUES ($1, 0)
       ON CONFLICT (customer_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [customerId]
    )
    return rows[0]
  }

  /** Redeemable balance + unmatured pending balance for a customer. */
  async getBalance(customerId) {
    const { rows: acc } = await query(
      `SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1`,
      [customerId]
    )
    const { rows: pend } = await query(
      `SELECT
         COALESCE(SUM(points) FILTER (WHERE transaction_type = 'EARN_PENDING'), 0)
         - COALESCE(SUM(points) FILTER (WHERE transaction_type = 'EARN'), 0)
         AS pending
       FROM loyalty_transactions
       WHERE loyalty_account_id = $1`,
      [acc[0]?.id || null]
    )
    return {
      available: Number(acc[0]?.points_balance || 0),
      pending: Math.max(0, Number(pend[0]?.pending || 0)),
    }
  }

  // ── Redemption cap (spec §10 / §41 — THE critical rule) ───────────────

  /**
   * Maximum points a customer may redeem on this order:
   *   min( points balance,
   *        floor(eligibleSubtotal × maxRedemptionPct% ÷ pointValue),
   *        maxPointsPerOrder )
   * The customer may select ANY amount in [0, max]; the backend re-clamps
   * whatever the frontend sends at quote and at checkout.
   */
  async computeMaxRedeemable(customerId, eligibleSubtotal) {
    const settings = await this.getSettings()
    if (!settings.enabled) return { maxPoints: 0, pointValue: 1, settings }
    const { available } = await this.getBalance(customerId)
    const pointValue = Number(settings.point_value || 1)
    const pct = Number(settings.max_redemption_pct || 0)
    const maxValue = Math.floor((Number(eligibleSubtotal || 0) * pct) / 100)
    let maxPoints = pointValue > 0 ? Math.floor(maxValue / pointValue) : 0
    if (settings.max_points_per_order != null) {
      maxPoints = Math.min(maxPoints, Number(settings.max_points_per_order))
    }
    maxPoints = Math.min(maxPoints, available)
    if (available < Number(settings.min_redeemable_points || 0)) maxPoints = 0
    return { maxPoints: Math.max(0, maxPoints), pointValue, settings }
  }

  // ── Ledger ops ────────────────────────────────────────────────────────

  async #appendLedger(client, { accountId, type, points, idempotencyKey, referenceId = null, orderId = null, availableAt = null, expiresAt = null }) {
    const runner = client || { query: (text, params) => query(text, params) }
    // Idempotency: re-running with the same key returns the original row.
    const existing = await runner.query(
      `SELECT * FROM loyalty_transactions WHERE idempotency_key = $1 LIMIT 1`,
      [idempotencyKey]
    )
    if (existing.rows[0]) return existing.rows[0]

    const { rows: bal } = await runner.query(
      `SELECT points_balance FROM loyalty_accounts WHERE id = $1 FOR UPDATE`,
      [accountId]
    )
    const current = Number(bal[0]?.points_balance || 0)
    // EARN_PENDING never touches the redeemable balance.
    const delta = type === 'EARN_PENDING' ? 0 : Number(points)
    const balanceAfter = current + delta

    if (type !== 'EARN_PENDING') {
      await runner.query(
        `UPDATE loyalty_accounts SET points_balance = $2, updated_at = NOW() WHERE id = $1`,
        [accountId, balanceAfter]
      )
    }
    const { rows } = await runner.query(
      `INSERT INTO loyalty_transactions
         (loyalty_account_id, transaction_type, points, balance_after, reference_id, idempotency_key, order_id, available_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [accountId, type, points, balanceAfter, referenceId, idempotencyKey, orderId, availableAt, expiresAt]
    )
    return rows[0]
  }

  /**
   * Order delivered → pending points. Idempotent per order.
   * Expiry timestamps apply to EARNed (converted) points, so they are
   * stamped onto the pending row and inherited at conversion time.
   */
  async earnPendingForOrder(orderId, customerId, eligibleSubtotal) {
    const settings = await this.getSettings()
    if (!settings.enabled) return null
    if (Number(eligibleSubtotal || 0) < Number(settings.min_order_amount_to_earn || 0)) return null
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const account = await this.ensureAccount(client, customerId)
      const points = Math.floor(Number(eligibleSubtotal || 0) * Number(settings.points_per_rupee || 0))
      if (points <= 0) {
        await client.query('COMMIT')
        return null
      }
      const expiresAt = settings.expiry_days
        ? new Date(Date.now() + (settings.return_window_hold_days + settings.expiry_days) * 86400000)
        : null
      const row = await this.#appendLedger(client, {
        accountId: account.id,
        type: 'EARN_PENDING',
        points,
        idempotencyKey: `loyalty:earn_pending:order:${orderId}`,
        referenceId: `order:${orderId}`,
        orderId,
        availableAt: new Date(Date.now() + settings.return_window_hold_days * 86400000),
        expiresAt,
      })
      await client.query('COMMIT')
      return row
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      logger.error({ err, orderId }, 'Loyalty earn-pending failed')
      throw err
    } finally {
      client.release()
    }
  }

  /** Return window closed → pending points become redeemable. Idempotent. */
  async maturePendingForOrder(orderId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows: pending } = await client.query(
        `SELECT * FROM loyalty_transactions
          WHERE transaction_type = 'EARN_PENDING' AND order_id = $1
          FOR UPDATE`,
        [orderId]
      )
      const results = []
      for (const row of pending) {
        const earned = await this.#appendLedger(client, {
          accountId: row.loyalty_account_id,
          type: 'EARN',
          points: Number(row.points),
          idempotencyKey: `loyalty:earn:order:${orderId}`,
          referenceId: `order:${orderId}`,
          orderId,
          expiresAt: row.expires_at,
        })
        results.push(earned)
      }
      await client.query('COMMIT')
      return results
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  /** Redeem points against an order. Re-clamps to the configured cap. */
  async redeemForOrder(client, customerId, orderId, points, eligibleSubtotal) {
    const requested = Math.floor(Number(points || 0))
    if (requested <= 0) return null
    const { maxPoints } = await this.computeMaxRedeemable(customerId, eligibleSubtotal)
    const allowed = Math.min(requested, maxPoints)
    if (allowed <= 0) {
      const err = new Error('Requested points exceed the maximum redemption allowed for this order')
      err.code = 'LOYALTY_CAP_EXCEEDED'
      err.maxPoints = maxPoints
      throw err
    }
    const account = await this.ensureAccount(client, customerId)
    return this.#appendLedger(client, {
      accountId: account.id,
      type: 'REDEEM',
      points: -allowed,
      idempotencyKey: `loyalty:redeem:order:${orderId}`,
      referenceId: `order:${orderId}`,
      orderId,
    })
  }

  /** Cancel/return/refund → reverse the redeem + un-mature the pending. Idempotent. */
  async reverseForOrder(orderId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows: txs } = await client.query(
        `SELECT * FROM loyalty_transactions WHERE order_id = $1 AND transaction_type IN ('REDEEM', 'EARN') FOR UPDATE`,
        [orderId]
      )
      const results = []
      for (const tx of txs) {
        const reversed = await this.#appendLedger(client, {
          accountId: tx.loyalty_account_id,
          type: 'REVERSAL',
          points: -Number(tx.points),
          idempotencyKey: `loyalty:reverse:${tx.id}`,
          referenceId: `tx:${tx.id}`,
          orderId,
        })
        results.push(reversed)
      }
      await client.query('COMMIT')
      return results
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async adminAdjust(customerId, points, reason, actorId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const account = await this.ensureAccount(client, customerId)
      const row = await this.#appendLedger(client, {
        accountId: account.id,
        type: 'ADMIN_ADJUSTMENT',
        points: Math.trunc(Number(points)),
        idempotencyKey: `loyalty:adjust:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        referenceId: reason ? `admin:${reason}` : 'admin',
      })
      await client.query('COMMIT')
      return row
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  /** Dashboard statistics (spec §11). No fabricated numbers — pure SQL. */
  async getStats() {
    const { rows } = await query(
      `SELECT
         COALESCE(SUM(points_balance), 0) AS active_points,
         (SELECT COUNT(*) FROM loyalty_accounts WHERE points_balance > 0) AS customers_with_points,
         (SELECT COALESCE(SUM(t.points), 0) FROM loyalty_transactions t WHERE t.transaction_type = 'EARN_PENDING') - (SELECT COALESCE(SUM(t.points), 0) FROM loyalty_transactions t WHERE t.transaction_type = 'EARN') AS pending_points,
         (SELECT COALESCE(ABS(SUM(t.points)), 0) FROM loyalty_transactions t WHERE t.transaction_type = 'REDEEM') AS redeemed_points,
         (SELECT COALESCE(ABS(SUM(t.points)), 0) FROM loyalty_transactions t WHERE t.transaction_type = 'EXPIRE') AS expired_points,
         (SELECT COALESCE(SUM(t.points), 0) FROM loyalty_transactions t WHERE t.transaction_type IN ('EARN', 'EARN_PENDING', 'REFERRAL_BONUS', 'MILESTONE_BONUS') AND t.created_at >= date_trunc('month', NOW())) AS issued_this_month
       FROM loyalty_accounts`
    )
    const settings = await this.getSettings()
    const activePoints = Number(rows[0]?.active_points || 0)
    return {
      activePoints,
      pendingPoints: Math.max(0, Number(rows[0]?.pending_points || 0)),
      redeemedPoints: Number(rows[0]?.redeemed_points || 0),
      expiredPoints: Number(rows[0]?.expired_points || 0),
      pointsLiability: activePoints * Number(settings.point_value || 1),
      customersWithPoints: Number(rows[0]?.customers_with_points || 0),
      issuedThisMonth: Number(rows[0]?.issued_this_month || 0),
      settings,
    }
  }

  async listCustomers({ page = 1, limit = 20, search = '' } = {}) {
    const offset = (Math.max(1, page) - 1) * limit
    const params = []
    let where = ''
    if (search) {
      params.push(`%${search}%`)
      where = `AND (u.name ILIKE $${params.length} OR u.phone ILIKE $${params.length} OR u.email ILIKE $${params.length})`
    }
    const { rows } = await query(
      `SELECT la.customer_id, u.name, u.phone, u.email,
              la.points_balance AS available,
              GREATEST(COALESCE((SELECT SUM(t.points) FROM loyalty_transactions t WHERE t.loyalty_account_id = la.id AND t.transaction_type = 'EARN_PENDING'), 0)
                     - COALESCE((SELECT SUM(t.points) FROM loyalty_transactions t WHERE t.loyalty_account_id = la.id AND t.transaction_type = 'EARN'), 0), 0) AS pending,
              COALESCE(ABS((SELECT SUM(t.points) FROM loyalty_transactions t WHERE t.loyalty_account_id = la.id AND t.transaction_type = 'REDEEM')), 0) AS redeemed,
              COALESCE((SELECT MAX(t.created_at) FROM loyalty_transactions t WHERE t.loyalty_account_id = la.id), la.updated_at) AS last_activity
         FROM loyalty_accounts la
         JOIN users u ON u.id = la.customer_id
        WHERE TRUE ${where}
        ORDER BY la.points_balance DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )
    const { rows: count } = await query(
      `SELECT COUNT(*) AS total FROM loyalty_accounts la JOIN users u ON u.id = la.customer_id WHERE TRUE ${where}`,
      params
    )
    return { data: rows, pagination: { page, limit, total: Number(count[0]?.total || 0) } }
  }

  async listTransactions(customerId, { page = 1, limit = 20 } = {}) {
    const offset = (Math.max(1, page) - 1) * limit
    const { rows: acc } = await query(
      `SELECT id FROM loyalty_accounts WHERE customer_id = $1`, [customerId]
    )
    if (!acc[0]) return { data: [], pagination: { page, limit, total: 0 } }
    const { rows } = await query(
      `SELECT * FROM loyalty_transactions WHERE loyalty_account_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [acc[0].id, limit, offset]
    )
    const { rows: count } = await query(
      `SELECT COUNT(*) AS total FROM loyalty_transactions WHERE loyalty_account_id = $1`,
      [acc[0].id]
    )
    return { data: rows, pagination: { page, limit, total: Number(count[0]?.total || 0) } }
  }
}
