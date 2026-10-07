/**
 * Referrals Service — dedicated referral program (spec §13).
 *
 * Status flow: CLICKED → REGISTERED → ORDER_PLACED → QUALIFIED → REWARDED
 * (or REJECTED / REVERSED). Rewards are granted only after the configured
 * qualification event on the referred user's first qualifying order, exactly
 * once (UNIQUE idempotency_key on referral_reward_events), and reverse
 * exactly once if the qualifying order is refunded.
 *
 * @module modules/referrals/referrals.service
 */

import { query, getClient } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import crypto from 'node:crypto'

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export class ReferralsService {
  // ── Settings ──────────────────────────────────────────────────────────

  async getSettings() {
    const { rows } = await query('SELECT * FROM referral_program_settings WHERE id = TRUE')
    return rows[0] || { enabled: true }
  }

  async updateSettings(patch, actorId = null) {
    const allowed = [
      'enabled', 'referrer_reward_type', 'referrer_reward_amount',
      'referrer_reward_coupon_id', 'referee_reward_type', 'referee_reward_amount',
      'referee_reward_coupon_id', 'min_first_order_value', 'qualification_event',
      'max_referrals_per_month', 'reward_expiry_days', 'campaign_starts_at',
      'campaign_ends_at',
    ]
    const sets = ['updated_at = NOW()']
    const params = []
    for (const key of allowed) {
      if (patch[key] === undefined) continue
      params.push(patch[key] === '' ? null : patch[key])
      sets.push(`${key} = $${params.length}`)
    }
    if (actorId) {
      params.push(actorId)
      sets.push(`updated_by = $${params.length}`)
    }
    if (sets.length > 1) {
      await query(`UPDATE referral_program_settings SET ${sets.join(', ')} WHERE id = TRUE`, params)
    }
    return this.getSettings()
  }

  // ── Codes ─────────────────────────────────────────────────────────────

  async ensureCode(userId) {
    const { rows: existing } = await query(
      `SELECT * FROM referral_codes WHERE user_id = $1 LIMIT 1`, [userId]
    )
    if (existing[0]) return existing[0]
    for (let attempt = 0; attempt < 8; attempt++) {
      let code = ''
      const bytes = crypto.randomBytes(8)
      for (let i = 0; i < 8; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
      try {
        const { rows } = await query(
          `INSERT INTO referral_codes (user_id, code) VALUES ($1, $2) RETURNING *`,
          [userId, code]
        )
        return rows[0]
      } catch (err) {
        if (err.code !== '23505') throw err // 23505: unique violation → retry a new code
      }
    }
    throw new Error('Could not allocate a unique referral code')
  }

  /**
   * Attribute a new signup to a referrer via code. One attribution per
   * account, self-referral blocked, campaign window + monthly cap honored.
   */
  async claimCode(referredUserId, code) {
    const settings = await this.getSettings()
    if (!settings.enabled) return { claimed: false, reason: 'PROGRAM_DISABLED' }
    if (settings.campaign_starts_at && new Date() < new Date(settings.campaign_starts_at)) {
      return { claimed: false, reason: 'CAMPAIGN_NOT_STARTED' }
    }
    if (settings.campaign_ends_at && new Date() > new Date(settings.campaign_ends_at)) {
      return { claimed: false, reason: 'CAMPAIGN_ENDED' }
    }

    const { rows: codeRows } = await query(
      `SELECT * FROM referral_codes WHERE code = $1 AND is_active = TRUE LIMIT 1`,
      [String(code || '').toUpperCase()]
    )
    const codeRow = codeRows[0]
    if (!codeRow) return { claimed: false, reason: 'INVALID_CODE' }
    if (codeRow.user_id === referredUserId) return { claimed: false, reason: 'SELF_REFERRAL' }

    const { rows: existing } = await query(
      `SELECT id FROM referrals WHERE referred_user_id = $1 LIMIT 1`, [referredUserId]
    )
    if (existing[0]) return { claimed: false, reason: 'ALREADY_ATTRIBUTED' }

    if (settings.max_referrals_per_month) {
      const { rows: cap } = await query(
        `SELECT COUNT(*) AS n FROM referrals
          WHERE referrer_id = $1 AND created_at >= date_trunc('month', NOW())`,
        [codeRow.user_id]
      )
      if (Number(cap[0]?.n || 0) >= Number(settings.max_referrals_per_month)) {
        return { claimed: false, reason: 'MONTHLY_CAP_REACHED' }
      }
    }

    const { rows } = await query(
      `INSERT INTO referrals (referrer_id, referred_user_id, referral_code_id, status, registered_at)
       VALUES ($1, $2, $3, 'REGISTERED', NOW())
       RETURNING *`,
      [codeRow.user_id, referredUserId, codeRow.id]
    )
    return { claimed: true, referral: rows[0] }
  }

  // ── Order lifecycle hooks (called from orders / payments / refunds) ───

  async markOrderPlaced(orderId, customerId, orderTotal) {
    const { rows } = await query(
      `UPDATE referrals
          SET status = 'ORDER_PLACED', qualifying_order_id = $1, updated_at = NOW()
        WHERE referred_user_id = $2 AND status = 'REGISTERED'
        RETURNING *`,
      [orderId, customerId]
    )
    if (!rows[0]) return null
    // Referee welcome reward (if configured to fire at order placement) is
    // handled by checkQualification via the configured qualification_event.
    const settings = await this.getSettings()
    if (settings.qualification_event === 'ORDER_PLACED') {
      await this.#qualify(rows[0], orderTotal)
    }
    return rows[0]
  }

  /**
   * Called when the configured qualification event fires for the referred
   * customer's first order: ORDER_CONFIRMED / ORDER_DELIVERED /
   * RETURN_WINDOW_CLOSED. Grants rewards exactly once.
   */
  async checkQualification(orderId, customerId, event, orderTotal) {
    const settings = await this.getSettings()
    if (!settings.enabled) return null
    if (settings.qualification_event !== event) return null

    const { rows } = await query(
      `SELECT * FROM referrals WHERE referred_user_id = $1 AND status IN ('REGISTERED', 'ORDER_PLACED') ORDER BY created_at LIMIT 1`,
      [customerId]
    )
    const referral = rows[0]
    if (!referral) return null
    return this.#qualify(referral, orderTotal)
  }

  async #qualify(referral, orderTotal) {
    const settings = await this.getSettings()
    if (Number(orderTotal || 0) < Number(settings.min_first_order_value || 0)) {
      logger.info({ referralId: referral.id, orderTotal }, 'Referral order below minimum — not qualified')
      return null
    }
    await query(
      `UPDATE referrals SET status = 'QUALIFIED', qualified_at = NOW(), updated_at = NOW() WHERE id = $1 AND status <> 'QUALIFIED'`,
      [referral.id]
    )
    await this.#grantRewards(referral.id, referral.referrer_id, referral.referred_user_id)
    return { ...referral, status: 'QUALIFIED' }
  }

  async #grantRewards(referralId, referrerId, referredUserId) {
    const settings = await this.getSettings()
    const grants = [
      {
        eventType: 'REFERRER_REWARD', userId: referrerId,
        type: settings.referrer_reward_type, amount: Number(settings.referrer_reward_amount || 0),
        couponId: settings.referrer_reward_coupon_id || null,
        key: `referral:reward:referrer:${referralId}`,
      },
      {
        eventType: 'REFEREE_REWARD', userId: referredUserId,
        type: settings.referee_reward_type, amount: Number(settings.referee_reward_amount || 0),
        couponId: settings.referee_reward_coupon_id || null,
        key: `referral:reward:referee:${referralId}`,
      },
    ]
    const client = await getClient()
    try {
      await client.query('BEGIN')
      for (const grant of grants) {
        if (grant.type === 'COUPON' && !grant.couponId) continue
        if (grant.type !== 'COUPON' && grant.amount <= 0) continue
        const { rows: dupe } = await client.query(
          `SELECT id FROM referral_reward_events WHERE idempotency_key = $1 LIMIT 1`, [grant.key]
        )
        if (dupe[0]) continue
        await client.query(
          `INSERT INTO referral_reward_events
             (referral_id, event_type, beneficiary_user_id, reward_type, reward_amount, coupon_id, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [referralId, grant.eventType, grant.userId, grant.type, grant.amount, grant.couponId, grant.key]
        )
        await this.#deliverReward(client, grant)
      }
      await client.query(
        `UPDATE referrals SET status = 'REWARDED', reward_generated_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status <> 'REWARDED'`,
        [referralId]
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  /** Deliver the reward through the target system (points / wallet / coupon). */
  async #deliverReward(client, grant) {
    if (grant.type === 'POINTS') {
      const { rows: acc } = await client.query(
        `INSERT INTO loyalty_accounts (customer_id, points_balance) VALUES ($1, 0)
         ON CONFLICT (customer_id) DO UPDATE SET updated_at = NOW() RETURNING *`,
        [grant.userId]
      )
      const { rows: bal } = await client.query(
        `SELECT points_balance FROM loyalty_accounts WHERE id = $1 FOR UPDATE`, [acc[0].id]
      )
      const after = Number(bal[0].points_balance) + grant.amount
      await client.query(`UPDATE loyalty_accounts SET points_balance = $2, updated_at = NOW() WHERE id = $1`, [acc[0].id, after])
      await client.query(
        `INSERT INTO loyalty_transactions (loyalty_account_id, transaction_type, points, balance_after, idempotency_key)
         VALUES ($1, 'REFERRAL_BONUS', $2, $3, $4)`,
        [acc[0].id, grant.amount, after, grant.key + ':ledger']
      )
    } else if (grant.type === 'WALLET_CREDIT') {
      const { WalletRepository } = await import('../wallet/wallet.repository.js')
      const walletRepo = new WalletRepository()
      const wallet = await walletRepo.getOrCreate(grant.userId)
      await walletRepo.credit(null, wallet.id, grant.amount, 'Referral reward', grant.key)
    } else if (grant.type === 'COUPON') {
      // Grant via the coupon individual-targeting table (coupons module, 067).
      await client.query(
        `INSERT INTO coupon_target_users (coupon_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [grant.couponId, grant.userId]
      )
    }
  }

  /**
   * Qualifying order refunded/cancelled → reverse rewards exactly once.
   */
  async reverseForOrder(orderId) {
    const { rows: referrals } = await query(
      `SELECT * FROM referrals WHERE qualifying_order_id = $1 AND status IN ('QUALIFIED', 'REWARDED')`,
      [orderId]
    )
    if (!referrals[0]) return null
    const referral = referrals[0]
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows: events } = await client.query(
        `SELECT * FROM referral_reward_events WHERE referral_id = $1 AND event_type <> 'REVERSAL' FOR UPDATE`,
        [referral.id]
      )
      for (const event of events) {
        const key = `referral:reverse:${event.id}`
        const { rows: dupe } = await client.query(`SELECT id FROM referral_reward_events WHERE idempotency_key = $1 LIMIT 1`, [key])
        if (dupe[0]) continue
        await client.query(
          `INSERT INTO referral_reward_events
             (referral_id, event_type, beneficiary_user_id, reward_type, reward_amount, coupon_id, idempotency_key)
           VALUES ($1, 'REVERSAL', $2, $3, $4, $5, $6)`,
          [referral.id, event.beneficiary_user_id, event.reward_type, event.reward_amount, event.coupon_id, key]
        )
        if (event.reward_type === 'POINTS') {
          const { rows: acc } = await client.query(
            `SELECT * FROM loyalty_accounts WHERE customer_id = $1`, [event.beneficiary_user_id]
          )
          if (acc[0]) {
            const { rows: bal } = await client.query(
              `SELECT points_balance FROM loyalty_accounts WHERE id = $1 FOR UPDATE`, [acc[0].id]
            )
            const after = Math.max(0, Number(bal[0].points_balance) - Number(event.reward_amount))
            await client.query(`UPDATE loyalty_accounts SET points_balance = $2, updated_at = NOW() WHERE id = $1`, [acc[0].id, after])
            await client.query(
              `INSERT INTO loyalty_transactions (loyalty_account_id, transaction_type, points, balance_after, idempotency_key)
               VALUES ($1, 'REVERSAL', $2, $3, $4)`,
              [acc[0].id, -Number(event.reward_amount), after, key + ':ledger']
            )
          }
        } else if (event.reward_type === 'WALLET_CREDIT') {
          const { WalletRepository } = await import('../wallet/wallet.repository.js')
          const walletRepo = new WalletRepository()
          const wallet = await walletRepo.getOrCreate(event.beneficiary_user_id)
          // Clamped debit — the wallet never goes negative (wallet repo CHECK).
          await walletRepo.debit(null, wallet.id, Math.min(Number(event.reward_amount), Number(wallet.balance)), 'Referral reward reversal', key)
        }
      }
      await client.query(
        `UPDATE referrals SET status = 'REVERSED', reversed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [referral.id]
      )
      await client.query('COMMIT')
      return referral.id
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  // ── Reads ─────────────────────────────────────────────────────────────

  async myReferrals(userId) {
    const code = await this.ensureCode(userId)
    const { rows: referred } = await query(
      `SELECT r.*, u.name AS referred_name, r.created_at
         FROM referrals r JOIN users u ON u.id = r.referred_user_id
        WHERE r.referrer_id = $1 ORDER BY r.created_at DESC LIMIT 100`,
      [userId]
    )
    const { rows: rewards } = await query(
      `SELECT event_type, reward_type, reward_amount, created_at
         FROM referral_reward_events e
         JOIN referrals r ON r.id = e.referral_id
        WHERE (e.beneficiary_user_id = $1 OR r.referrer_id = $1)
        ORDER BY e.created_at DESC LIMIT 50`,
      [userId]
    )
    return { code: code.code, referrals: referred, rewards }
  }

  async adminList({ page = 1, limit = 20, status = '', search = '' } = {}) {
    const offset = (Math.max(1, page) - 1) * limit
    const params = []
    const where = []
    if (status) { params.push(status); where.push(`r.status = $${params.length}`) }
    if (search) {
      params.push(`%${search}%`)
      where.push(`(ru.name ILIKE $${params.length} OR ru.phone ILIKE $${params.length} OR rr.name ILIKE $${params.length})`)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const { rows } = await query(
      `SELECT r.*, rr.name AS referrer_name, ru.name AS referred_name, o.order_number
         FROM referrals r
         JOIN users rr ON rr.id = r.referrer_id
         JOIN users ru ON ru.id = r.referred_user_id
         LEFT JOIN orders o ON o.id = r.qualifying_order_id
         ${whereSql}
        ORDER BY r.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )
    const { rows: count } = await query(
      `SELECT COUNT(*) AS total FROM referrals r
         JOIN users rr ON rr.id = r.referrer_id
         JOIN users ru ON ru.id = r.referred_user_id
         LEFT JOIN orders o ON o.id = r.qualifying_order_id
         ${whereSql}`,
      params
    )
    const { rows: stats } = await query(
      `SELECT status, COUNT(*) AS n FROM referrals GROUP BY status`
    )
    return {
      data: rows,
      stats,
      pagination: { page, limit, total: Number(count[0]?.total || 0) },
    }
  }
}
