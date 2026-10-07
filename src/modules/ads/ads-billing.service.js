/**
 * Ad billing — click charging, the vendor ad wallet, top-ups and refunds.
 *
 * Invariants (see ADS_DESIGN.md):
 *  - A click is billed at most once: ad_clicks.nonce is UNIQUE and the charge ledger row is
 *    idempotent on `click:<id>`.
 *  - The price is the one baked into the signed impression token, never client-supplied.
 *  - Lock order is always campaign → wallet, so concurrent clicks cannot deadlock.
 *  - Daily / lifetime budgets are enforced under the campaign row lock, so concurrent clicks
 *    can never overspend a budget.
 *  - The wallet never goes negative (DB CHECK + explicit INSUFFICIENT_FUNDS).
 *
 * @module modules/ads/ads-billing.service
 */

import { query } from '../../config/database.js'
import { fromPaise, remainingBudgetPaise, toPaise, withGst } from './ads-engine.js'
import {
  AdsError, getSettings, IST_DAY_SQL, lockWallet, logEvent, postWalletEntry, verifyImpression, withTx,
} from './ads.shared.js'

// ── Click handling ──────────────────────────────────────────────────────

/**
 * Redeem an impression token.
 * @returns {Promise<{productId:string, charged:boolean, reason:string|null}>}
 */
export async function registerClick({ token, userId = null, ip = null }) {
  const p = verifyImpression(token)
  if (!p) throw new AdsError('INVALID_TOKEN', 'This ad link is invalid or has expired', 400)
  const s = await getSettings()

  return withTx(async (client) => {
    // Lock the campaign FIRST. Inserting the click row first would take a key-share lock on the
    // campaign (FK) and then deadlock two concurrent clicks when both upgrade to FOR UPDATE.
    const { rows: cr } = await client.query(`SELECT * FROM ad_campaigns WHERE id = $1 FOR UPDATE`, [p.c])
    const c = cr[0]
    if (!c) return { productId: p.p, charged: false, reason: 'INACTIVE' } // campaign deleted since the impression

    const ins = await client.query(
      `INSERT INTO ad_clicks (nonce, campaign_id, vendor_id, product_id, user_id, keyword, query_text, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (nonce) DO NOTHING RETURNING id`,
      [p.n, p.c, c.vendor_id, p.p, userId, p.k || null, p.q || null, ip]
    )
    // Same impression redeemed twice (double tap / replay) → already handled, never charged again.
    if (!ins.rows[0]) return { productId: p.p, charged: false, reason: 'DUPLICATE' }
    const clickId = ins.rows[0].id

    const notCharged = async (reason, { pause = false } = {}) => {
      await client.query(`UPDATE ad_clicks SET not_charged_reason = $2 WHERE id = $1`, [clickId, reason])
      await bumpStats(client, p.c, p.p, { clicks: 1, spendPaise: 0 })
      if (pause) {
        await client.query(
          `UPDATE ad_campaigns SET status = 'PAUSED', paused_reason = 'OUT_OF_FUNDS', updated_at = NOW() WHERE id = $1 AND status = 'ACTIVE'`, [p.c])
        await logEvent(client, { campaignId: p.c, vendorId: c.vendor_id, event: 'AUTO_PAUSED', payload: { reason: 'OUT_OF_FUNDS' } })
      }
      return { productId: p.p, charged: false, reason }
    }

    const { rows: today } = await client.query(`SELECT ${IST_DAY_SQL} AS d`)
    const day = today[0].d
    if (!c || c.status !== 'ACTIVE' || (c.ends_on && c.ends_on < day) || c.starts_on > day) return notCharged('INACTIVE')

    // Vendor staff clicking their own ads is free (and not counted as demand).
    if (userId) {
      const { rows: staff } = await client.query(
        `SELECT 1 FROM vendor_users WHERE vendor_id = $1 AND user_id = $2 LIMIT 1`, [c.vendor_id, userId])
      if (staff[0]) return notCharged('SELF_CLICK')
    }

    // One billable click per shopper per ad per window.
    if (s.click_dedupe_minutes > 0) {
      const who = userId ? ['user_id = $4', userId] : ip ? ['ip = $4', ip] : null
      if (who) {
        const { rows: dupe } = await client.query(
          `SELECT 1 FROM ad_clicks WHERE campaign_id = $1 AND product_id = $2 AND charged = TRUE AND id <> $3 AND ${who[0]}
              AND created_at > NOW() - make_interval(mins => $5) LIMIT 1`,
          [p.c, p.p, clickId, who[1], s.click_dedupe_minutes])
        if (dupe[0]) return notCharged('DUPLICATE')
      }
    }

    const netPaise = toPaise(p.b)
    const { rows: sp } = await client.query(
      `SELECT COALESCE(SUM(spend) FILTER (WHERE day = ${IST_DAY_SQL}), 0) AS today, COALESCE(SUM(spend), 0) AS total
         FROM ad_stats_daily WHERE campaign_id = $1`, [p.c])
    const remaining = remainingBudgetPaise({
      dailyBudgetPaise: toPaise(c.daily_budget), spentTodayPaise: toPaise(sp[0].today),
      totalBudgetPaise: c.total_budget == null ? null : toPaise(c.total_budget), spentTotalPaise: toPaise(sp[0].total),
    })
    if (remaining < netPaise) return notCharged('BUDGET_EXHAUSTED')

    const { taxPaise, grossPaise } = withGst(netPaise, s.gst_pct)
    try {
      await postWalletEntry(client, {
        vendorId: c.vendor_id, entryType: 'CLICK_CHARGE', amountPaise: -grossPaise, taxPaise,
        campaignId: c.id, clickId, idempotencyKey: `click:${clickId}`, reason: p.k ? `Click · "${p.k}"` : 'Click · auto targeting',
      })
    } catch (err) {
      if (err instanceof AdsError && err.code === 'INSUFFICIENT_FUNDS') return notCharged('NO_FUNDS', { pause: true })
      throw err
    }

    await client.query(
      `UPDATE ad_clicks SET charged = TRUE, cpc = $2, tax_amount = $3 WHERE id = $1`,
      [clickId, fromPaise(netPaise), fromPaise(taxPaise)])
    await bumpStats(client, p.c, p.p, { clicks: 1, spendPaise: netPaise })
    return { productId: p.p, charged: true, reason: null }
  })
}

async function bumpStats(client, campaignId, productId, { clicks = 0, spendPaise = 0 }) {
  await client.query(
    `INSERT INTO ad_stats_daily (campaign_id, product_id, day, clicks, spend)
     VALUES ($1,$2,${IST_DAY_SQL},$3,$4)
     ON CONFLICT (campaign_id, product_id, day)
     DO UPDATE SET clicks = ad_stats_daily.clicks + EXCLUDED.clicks, spend = ad_stats_daily.spend + EXCLUDED.spend`,
    [campaignId, productId, clicks, fromPaise(spendPaise)]
  )
}

/** Platform: refund an invalid / fraudulent click (credits GST too). Idempotent. */
export async function refundClick(actor, clickId, reason) {
  if (!reason || String(reason).trim().length < 3) throw new AdsError('VALIDATION', 'A reason is required', 422)
  return withTx(async (client) => {
    const { rows } = await client.query(`SELECT * FROM ad_clicks WHERE id = $1`, [clickId])
    const k = rows[0]
    if (!k) throw new AdsError('NOT_FOUND', 'Click not found', 404)
    await client.query(`SELECT id FROM ad_campaigns WHERE id = $1 FOR UPDATE`, [k.campaign_id])
    const fresh = (await client.query(`SELECT charged, refunded FROM ad_clicks WHERE id = $1 FOR UPDATE`, [clickId])).rows[0]
    if (!fresh.charged) throw new AdsError('NOT_CHARGED', 'This click was not charged', 409)
    if (fresh.refunded) return { refunded: false, alreadyRefunded: true }
    const net = toPaise(k.cpc)
    const tax = toPaise(k.tax_amount)
    await postWalletEntry(client, {
      vendorId: k.vendor_id, entryType: 'CLICK_REFUND', amountPaise: net + tax, taxPaise: tax, campaignId: k.campaign_id,
      clickId, reason, actorId: actor.userId, idempotencyKey: `clickrefund:${clickId}`,
    })
    await client.query(`UPDATE ad_clicks SET refunded = TRUE WHERE id = $1`, [clickId])
    await client.query(
      `UPDATE ad_stats_daily SET spend = GREATEST(0, spend - $4)
        WHERE campaign_id = $1 AND product_id = $2 AND day = ($3::timestamptz AT TIME ZONE 'Asia/Kolkata')::date`,
      [k.campaign_id, k.product_id, k.created_at, k.cpc])
    await logEvent(client, { campaignId: k.campaign_id, vendorId: k.vendor_id, actor, event: 'CLICK_REFUNDED', payload: { clickId, reason, amount: fromPaise(net + tax) } })
    return { refunded: true, amount: fromPaise(net + tax) }
  })
}

// ── Wallet ──────────────────────────────────────────────────────────────

const settlementBalance = async (client, vendorId) => {
  const { rows } = await client.query(`SELECT COALESCE(SUM(amount), 0) AS bal FROM settlement_ledger WHERE vendor_id = $1`, [vendorId])
  return toPaise(rows[0].bal)
}

export async function getWallet(vendorId) {
  const s = await getSettings()
  const [{ rows: w }, { rows: sb }, { rows: tx }, { rows: act }] = await Promise.all([
    query(`SELECT balance, lifetime_topup, lifetime_spend FROM ad_wallets WHERE vendor_id = $1`, [vendorId]),
    query(`SELECT COALESCE(SUM(amount), 0) AS bal FROM settlement_ledger WHERE vendor_id = $1`, [vendorId]),
    query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE entry_type = 'TOPUP_SETTLEMENT'), 0)
            + COALESCE(SUM(amount) FILTER (WHERE entry_type = 'WITHDRAW_SETTLEMENT'), 0) AS from_settlement
         FROM ad_wallet_ledger WHERE vendor_id = $1`, [vendorId]),
    query(
      `SELECT COALESCE(SUM(c.daily_budget), 0) AS daily_commitment, COUNT(*)::int AS active
         FROM ad_campaigns c WHERE c.vendor_id = $1 AND c.status = 'ACTIVE'`, [vendorId]),
  ])
  const balance = Number(w[0]?.balance || 0)
  const withdrawable = Math.max(0, Math.min(balance, Number(tx[0].from_settlement)))
  return {
    balance,
    lifetime_topup: Number(w[0]?.lifetime_topup || 0),
    lifetime_spend: Number(w[0]?.lifetime_spend || 0),
    settlement_balance: Number(sb[0].bal),
    withdrawable,
    active_campaigns: act[0].active,
    daily_commitment: Number(act[0].daily_commitment),
    low_balance: balance < Number(s.low_balance_threshold) || (act[0].active > 0 && balance < Number(act[0].daily_commitment)),
    gst_pct: Number(s.gst_pct), min_topup: Number(s.min_topup), max_topup: Number(s.max_topup),
  }
}

export async function statement(vendorId, { page = 1, limit = 25, entryType = '' } = {}) {
  const params = [vendorId]
  let where = 'l.vendor_id = $1'
  if (entryType) { params.push(entryType); where += ` AND l.entry_type = $${params.length}` }
  const offset = (Math.max(1, page) - 1) * limit
  const [{ rows }, { rows: cnt }] = await Promise.all([
    query(
      `SELECT l.id, l.entry_type, l.amount, l.tax_amount, l.balance_after, l.reason, l.campaign_id, l.created_at, c.name AS campaign_name
         FROM ad_wallet_ledger l LEFT JOIN ad_campaigns c ON c.id = l.campaign_id
        WHERE ${where} ORDER BY l.id DESC LIMIT ${limit} OFFSET ${offset}`, params),
    query(`SELECT COUNT(*)::int AS total FROM ad_wallet_ledger l WHERE ${where}`, params),
  ])
  return { data: rows, pagination: { page: Number(page), limit, total: cnt[0].total } }
}

/** Vendor: move money from settlement balance into the ad wallet. */
export async function topUpFromSettlement(vendorId, actor, { amount, idempotencyKey = null }) {
  const s = await getSettings()
  const amountPaise = toPaise(amount)
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) throw new AdsError('VALIDATION', 'Enter a valid amount', 422)
  if (amountPaise < toPaise(s.min_topup)) throw new AdsError('VALIDATION', `Minimum top-up is ₹${Number(s.min_topup)}`, 422)
  if (amountPaise > toPaise(s.max_topup)) throw new AdsError('VALIDATION', `Maximum top-up is ₹${Number(s.max_topup)}`, 422)
  const key = idempotencyKey ? `topup:${vendorId}:${String(idempotencyKey).slice(0, 60)}` : null

  return withTx(async (client) => {
    if (key) {
      const { rows } = await client.query(`SELECT 1 FROM ad_wallet_ledger WHERE idempotency_key = $1`, [key])
      if (rows[0]) return { replayed: true, ...(await getWalletTx(client, vendorId)) }
    }
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`settlement:${vendorId}`])
    const { rows: holds } = await client.query(`SELECT 1 FROM settlement_holds WHERE vendor_id = $1 AND is_active = TRUE LIMIT 1`, [vendorId])
    if (holds[0]) throw new AdsError('SETTLEMENT_HOLD', 'Your settlements are on hold. Contact support.', 409)
    const bal = await settlementBalance(client, vendorId)
    if (bal < amountPaise) throw new AdsError('INSUFFICIENT_SETTLEMENT', 'Not enough settlement balance to move this amount', 402, { settlement_balance: fromPaise(bal) })
    await client.query(
      `INSERT INTO settlement_ledger (vendor_id, entry_type, amount, balance_after, reason, actor_id, idempotency_key)
       VALUES ($1,'ADJUSTMENT',$2,$3,'Moved to ad wallet',$4,$5)`,
      [vendorId, -fromPaise(amountPaise), fromPaise(bal - amountPaise), actor.userId || null, `adtopup:${key || `${vendorId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`}`])
    await postWalletEntry(client, {
      vendorId, entryType: 'TOPUP_SETTLEMENT', amountPaise, actorId: actor.userId || null,
      idempotencyKey: key, reason: 'Top-up from settlement balance',
    })
    await logEvent(client, { vendorId, actor, event: 'WALLET_TOPUP', payload: { amount: fromPaise(amountPaise), source: 'SETTLEMENT' } })
    return getWalletTx(client, vendorId)
  })
}

/** Vendor: return unused settlement-funded balance to the settlement ledger. */
export async function withdrawToSettlement(vendorId, actor, { amount }) {
  const amountPaise = toPaise(amount)
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) throw new AdsError('VALIDATION', 'Enter a valid amount', 422)
  return withTx(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`settlement:${vendorId}`])
    const wallet = await lockWallet(client, vendorId)
    const { rows } = await client.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE entry_type = 'TOPUP_SETTLEMENT'), 0)
            + COALESCE(SUM(amount) FILTER (WHERE entry_type = 'WITHDRAW_SETTLEMENT'), 0) AS from_settlement
         FROM ad_wallet_ledger WHERE vendor_id = $1`, [vendorId])
    const max = Math.min(toPaise(wallet.balance), Math.max(0, toPaise(rows[0].from_settlement)))
    if (amountPaise > max) throw new AdsError('NOT_WITHDRAWABLE', 'Only unused, settlement-funded balance can be moved back', 409, { withdrawable: fromPaise(max) })
    await postWalletEntry(client, { vendorId, entryType: 'WITHDRAW_SETTLEMENT', amountPaise: -amountPaise, actorId: actor.userId || null, reason: 'Moved back to settlement' })
    const bal = await settlementBalance(client, vendorId)
    await client.query(
      `INSERT INTO settlement_ledger (vendor_id, entry_type, amount, balance_after, reason, actor_id, idempotency_key)
       VALUES ($1,'ADJUSTMENT',$2,$3,'Returned from ad wallet',$4,$5)`,
      [vendorId, fromPaise(amountPaise), fromPaise(bal + amountPaise), actor.userId || null, `adwd:${vendorId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`])
    await logEvent(client, { vendorId, actor, event: 'WALLET_WITHDRAW', payload: { amount: fromPaise(amountPaise) } })
    return getWalletTx(client, vendorId)
  })
}

/** Platform: credit (paid top-up received offline / online, or promo credit) or correct a wallet. */
export async function adminCredit(vendorId, actor, { amount, kind = 'TOPUP_ADMIN', reason, idempotencyKey = null }) {
  if (!['TOPUP_ADMIN', 'PROMO_CREDIT', 'ADJUSTMENT'].includes(kind)) throw new AdsError('VALIDATION', 'Invalid credit type', 422)
  const amountPaise = toPaise(amount)
  if (!Number.isFinite(amountPaise) || amountPaise === 0) throw new AdsError('VALIDATION', 'Enter a valid amount', 422)
  if (kind !== 'ADJUSTMENT' && amountPaise < 0) throw new AdsError('VALIDATION', 'Credits must be positive', 422)
  if (!reason || String(reason).trim().length < 3) throw new AdsError('VALIDATION', 'A reason is required', 422)
  const { rows: v } = await query(`SELECT 1 FROM vendors WHERE id = $1`, [vendorId])
  if (!v[0]) throw new AdsError('NOT_FOUND', 'Vendor not found', 404)
  return withTx(async (client) => {
    await postWalletEntry(client, {
      vendorId, entryType: kind, amountPaise, actorId: actor.userId, reason,
      idempotencyKey: idempotencyKey ? `admin:${vendorId}:${String(idempotencyKey).slice(0, 60)}` : null,
    })
    await logEvent(client, { vendorId, actor, event: 'WALLET_ADMIN_CREDIT', payload: { kind, amount: fromPaise(amountPaise), reason } })
    return getWalletTx(client, vendorId)
  })
}

async function getWalletTx(client, vendorId) {
  const { rows } = await client.query(`SELECT balance, lifetime_topup, lifetime_spend FROM ad_wallets WHERE vendor_id = $1`, [vendorId])
  return { balance: Number(rows[0]?.balance || 0), lifetime_topup: Number(rows[0]?.lifetime_topup || 0), lifetime_spend: Number(rows[0]?.lifetime_spend || 0) }
}
