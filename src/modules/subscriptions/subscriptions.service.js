/**
 * Subscriptions — Free / Paid / Premium / Unlimited vendor plans.
 *
 * A vendor with no live ACTIVE row is on Free. Rows are history: changing
 * plan cancels the old row and inserts a new one; renewing the same plan
 * stacks time onto the current expiry. Listing limits come from the plan.
 *
 * @module modules/subscriptions/subscriptions.service
 */

import { query, getClient } from '../../config/database.js'
import { emitAlert } from '../alerts/alerts.service.js'

export const TIERS = ['FREE', 'PAID', 'PREMIUM', 'UNLIMITED']
const CYCLES = ['MONTHLY', 'YEARLY', 'COMPLIMENTARY']
const EXPIRING_DAYS = 7
const httpError = (statusCode, message, code = 'SUBSCRIPTION_ERROR') => Object.assign(new Error(message), { statusCode, code })

/** One row per vendor: its live subscription (or null → Free). */
const LIVE = `
  LEFT JOIN LATERAL (
    SELECT vs.id AS sub_id, vs.started_at, vs.expires_at, vs.billing_cycle, vs.auto_renew, vs.amount_paid,
           sp.tier AS live_tier, sp.name AS live_plan, sp.listing_limit AS live_limit
      FROM vendor_subscriptions vs JOIN subscription_plans sp ON sp.id = vs.plan_id
     WHERE vs.vendor_id = v.id AND vs.status = 'ACTIVE' AND (vs.expires_at IS NULL OR vs.expires_at > NOW())
     ORDER BY vs.started_at DESC LIMIT 1
  ) cur ON TRUE`
const CURRENT = `${LIVE}
  JOIN subscription_plans fp ON fp.tier = 'FREE'`

const USED = `(SELECT COUNT(*)::int FROM shop_products sp JOIN products p ON p.id = sp.product_id
                WHERE p.owner_vendor_id = v.id AND sp.deleted_at IS NULL AND p.deleted_at IS NULL)`

const num = (v) => (v == null ? null : Number(v))

export class SubscriptionsService {
  // ── plans ───────────────────────────────────────────────────────────
  async plans() {
    const { rows } = await query(
      `SELECT sp.*, (SELECT COUNT(*)::int FROM vendors v ${LIVE}
                      WHERE COALESCE(cur.live_tier, 'FREE') = sp.tier) AS vendor_count
         FROM subscription_plans sp ORDER BY sp.sort_order`)
    return rows.map((r) => ({ ...r, price_monthly: Number(r.price_monthly), price_yearly: Number(r.price_yearly) }))
  }

  async updatePlan(id, input) {
    const cur = (await query(`SELECT * FROM subscription_plans WHERE id = $1`, [id])).rows[0]
    if (!cur) throw httpError(404, 'Plan not found', 'NOT_FOUND')
    const name = input.name !== undefined ? String(input.name).trim() : cur.name
    if (!name || name.length > 60) throw httpError(400, 'Name is required (max 60 characters)', 'VALIDATION')
    const pm = input.priceMonthly !== undefined ? Number(input.priceMonthly) : Number(cur.price_monthly)
    const py = input.priceYearly !== undefined ? Number(input.priceYearly) : Number(cur.price_yearly)
    if (!(pm >= 0) || !(py >= 0)) throw httpError(400, 'Prices cannot be negative', 'VALIDATION')
    if (cur.tier === 'FREE' && (pm !== 0 || py !== 0)) throw httpError(400, 'The Free plan must cost ₹0', 'VALIDATION')
    let limit = cur.listing_limit
    if (input.listingLimit !== undefined) {
      if (input.listingLimit === null) limit = null
      else if (Number.isInteger(input.listingLimit) && input.listingLimit >= 0) limit = input.listingLimit
      else throw httpError(400, 'Listing limit must be a whole number, or empty for unlimited', 'VALIDATION')
    }
    if (cur.tier === 'UNLIMITED' && limit !== null) throw httpError(400, 'The Unlimited plan cannot have a listing limit', 'VALIDATION')
    if (cur.tier !== 'UNLIMITED' && limit === null) throw httpError(400, 'Only the Unlimited plan can have no listing limit', 'VALIDATION')
    const features = input.features !== undefined ? input.features : cur.features
    if (!Array.isArray(features) || features.some((f) => typeof f !== 'string' || f.length > 120)) throw httpError(400, 'Features must be a list of short texts', 'VALIDATION')
    const active = input.isActive !== undefined ? !!input.isActive : cur.is_active
    if (cur.tier === 'FREE' && !active) throw httpError(400, 'The Free plan cannot be switched off', 'VALIDATION')
    const { rows } = await query(
      `UPDATE subscription_plans SET name=$2, description=$3, price_monthly=$4, price_yearly=$5, listing_limit=$6,
              features=$7::jsonb, is_active=$8, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [id, name, input.description !== undefined ? input.description : cur.description, pm, py, limit, JSON.stringify(features), active])
    return rows[0]
  }

  // ── overview / lists ────────────────────────────────────────────────
  async overview() {
    const { rows } = await query(
      `SELECT COALESCE(cur.live_tier, 'FREE') AS tier, COUNT(*)::int AS vendors,
              COUNT(*) FILTER (WHERE cur.expires_at IS NOT NULL AND cur.expires_at <= NOW() + interval '${EXPIRING_DAYS} days')::int AS expiring
         FROM vendors v ${CURRENT} WHERE v.deleted_at IS NULL GROUP BY 1`)
    const by = Object.fromEntries(rows.map((r) => [r.tier, r]))
    const money = (await query(
      `SELECT COALESCE(SUM(CASE vs.billing_cycle WHEN 'MONTHLY' THEN sp.price_monthly WHEN 'YEARLY' THEN sp.price_yearly / 12 ELSE 0 END), 0) AS mrr
         FROM vendor_subscriptions vs JOIN subscription_plans sp ON sp.id = vs.plan_id
        WHERE vs.status = 'ACTIVE' AND (vs.expires_at IS NULL OR vs.expires_at > NOW())`)).rows[0]
    const month = (await query(
      `SELECT COALESCE(SUM(amount_paid), 0) AS collected, COUNT(*)::int AS started
         FROM vendor_subscriptions WHERE created_at >= date_trunc('month', NOW())`)).rows[0]
    const lapsed = (await query(
      `SELECT COUNT(DISTINCT vendor_id)::int AS n FROM vendor_subscriptions vs
        WHERE vs.status = 'EXPIRED' AND NOT EXISTS (SELECT 1 FROM vendor_subscriptions x WHERE x.vendor_id = vs.vendor_id AND x.status = 'ACTIVE')`)).rows[0]
    return {
      tiers: TIERS.map((t) => ({ tier: t, vendors: by[t]?.vendors ?? 0, expiring: by[t]?.expiring ?? 0 })),
      totalVendors: rows.reduce((s, r) => s + r.vendors, 0),
      expiringSoon: rows.reduce((s, r) => s + r.expiring, 0),
      lapsed: lapsed.n,
      mrr: Number(money.mrr), collectedThisMonth: Number(month.collected), startedThisMonth: month.started,
    }
  }

  async vendors({ tier = '', search = '', expiring = false, page = 1, limit = 25 } = {}) {
    const where = ['v.deleted_at IS NULL']
    const params = []
    const p = (x) => { params.push(x); return `$${params.length}` }
    if (tier) where.push(`COALESCE(cur.live_tier, 'FREE') = ${p(tier)}`)
    if (search) { const s = p(`%${search}%`); where.push(`(v.name ILIKE ${s} OR v.email ILIKE ${s})`) }
    if (expiring) where.push(`cur.expires_at IS NOT NULL AND cur.expires_at <= NOW() + interval '${EXPIRING_DAYS} days'`)
    const lim = Math.min(100, Math.max(1, Number(limit) || 25))
    const off = (Math.max(1, Number(page)) - 1) * lim
    const from = `FROM vendors v ${CURRENT} WHERE ${where.join(' AND ')}`
    const total = (await query(`SELECT COUNT(*)::int n ${from}`, params)).rows[0].n
    const { rows } = await query(
      `SELECT v.id, v.name, v.email, v.status AS vendor_status, COALESCE(cur.live_tier, 'FREE') AS tier,
              COALESCE(cur.live_plan, fp.name) AS plan_name, COALESCE(cur.live_limit, fp.listing_limit) AS listing_limit,
              cur.sub_id, cur.started_at, cur.expires_at, cur.billing_cycle, cur.auto_renew, ${USED} AS listings_used,
              CASE WHEN cur.expires_at IS NULL THEN NULL ELSE CEIL(EXTRACT(EPOCH FROM (cur.expires_at - NOW())) / 86400)::int END AS days_left
         ${from} ORDER BY (cur.expires_at IS NULL), cur.expires_at, v.name LIMIT ${lim} OFFSET ${off}`, params)
    return { data: rows, meta: { page: Number(page), limit: lim, total, totalPages: Math.ceil(total / lim) } }
  }

  async vendor(vendorId) {
    const { rows } = await query(
      `SELECT v.id, v.name, v.email, v.phone, v.status AS vendor_status, COALESCE(cur.live_tier, 'FREE') AS tier,
              COALESCE(cur.live_plan, fp.name) AS plan_name, COALESCE(cur.live_limit, fp.listing_limit) AS listing_limit,
              cur.sub_id, cur.started_at, cur.expires_at, cur.billing_cycle, cur.auto_renew, cur.amount_paid, ${USED} AS listings_used
         FROM vendors v ${CURRENT} WHERE v.id = $1 AND v.deleted_at IS NULL`, [vendorId])
    if (!rows[0]) throw httpError(404, 'Vendor not found', 'NOT_FOUND')
    const history = (await query(
      `SELECT vs.id, sp.tier, sp.name AS plan_name, vs.status, vs.billing_cycle, vs.started_at, vs.expires_at, vs.amount_paid,
              vs.payment_ref, vs.notes, vs.cancelled_at, vs.cancel_reason, u.name AS created_by_name
         FROM vendor_subscriptions vs JOIN subscription_plans sp ON sp.id = vs.plan_id LEFT JOIN users u ON u.id = vs.created_by
        WHERE vs.vendor_id = $1 ORDER BY vs.created_at DESC LIMIT 50`, [vendorId])).rows
    const events = (await query(
      `SELECT e.id, e.event, e.from_tier, e.to_tier, e.detail, e.created_at, u.name AS actor_name
         FROM subscription_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.vendor_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 50`, [vendorId])).rows
    return { ...rows[0], amount_paid: num(rows[0].amount_paid), history: history.map((h) => ({ ...h, amount_paid: Number(h.amount_paid) })), events }
  }

  // ── changes ─────────────────────────────────────────────────────────
  async assign(vendorId, input, actorId) {
    const tier = String(input.tier || '').toUpperCase()
    if (!TIERS.includes(tier)) throw httpError(400, `tier must be one of ${TIERS.join(', ')}`, 'VALIDATION')
    const cycle = String(input.cycle || (tier === 'FREE' ? 'COMPLIMENTARY' : 'MONTHLY')).toUpperCase()
    if (tier !== 'FREE' && !CYCLES.includes(cycle)) throw httpError(400, `cycle must be one of ${CYCLES.join(', ')}`, 'VALIDATION')
    const days = input.days !== undefined ? Number(input.days) : null
    if (cycle === 'COMPLIMENTARY' && tier !== 'FREE' && !(Number.isInteger(days) && days >= 1 && days <= 1095)) {
      throw httpError(400, 'A complimentary plan needs a duration of 1 to 1095 days', 'VALIDATION')
    }
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const vendor = (await client.query(`SELECT id, name FROM vendors WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [vendorId])).rows[0]
      if (!vendor) throw httpError(404, 'Vendor not found', 'NOT_FOUND')
      const plan = (await client.query(`SELECT * FROM subscription_plans WHERE tier = $1`, [tier])).rows[0]
      if (!plan.is_active && tier !== 'FREE') throw httpError(409, `The ${plan.name} plan is switched off`, 'PLAN_INACTIVE')
      const active = (await client.query(`SELECT vs.*, sp.tier FROM vendor_subscriptions vs JOIN subscription_plans sp ON sp.id = vs.plan_id WHERE vs.vendor_id = $1 AND vs.status = 'ACTIVE' FOR UPDATE OF vs`, [vendorId])).rows[0]
      const live = active && (!active.expires_at || new Date(active.expires_at) > new Date())
      const fromTier = live ? active.tier : 'FREE'

      if (tier === 'FREE') {
        if (active) {
          await client.query(`UPDATE vendor_subscriptions SET status = 'CANCELLED', cancelled_at = NOW(), cancel_reason = $2 WHERE id = $1`, [active.id, input.notes || 'Moved to the Free plan'])
          await client.query(`INSERT INTO subscription_events (vendor_id, subscription_id, event, from_tier, to_tier, detail, actor_id) VALUES ($1,$2,'CANCELLED',$3,'FREE',$4,$5)`,
            [vendorId, active.id, fromTier, JSON.stringify({ reason: input.notes || 'Moved to the Free plan' }), actorId || null])
        }
        await client.query('COMMIT')
        return this.vendor(vendorId)
      }

      const amount = input.amountPaid !== undefined ? Number(input.amountPaid)
        : cycle === 'YEARLY' ? Number(plan.price_yearly) : cycle === 'MONTHLY' ? Number(plan.price_monthly) : 0
      if (!(amount >= 0)) throw httpError(400, 'Amount paid cannot be negative', 'VALIDATION')
      if (cycle !== 'COMPLIMENTARY' && amount > 0 && !String(input.paymentRef || '').trim()) {
        throw httpError(400, 'Add the payment reference (UTR / transaction id) for a paid subscription', 'PAYMENT_REF_REQUIRED')
      }
      const interval = cycle === 'YEARLY' ? '1 year' : cycle === 'MONTHLY' ? '1 month' : `${days} days`
      const renewing = live && active.tier === tier
      const startBase = renewing && active.expires_at ? active.expires_at : null  // stack onto the current expiry
      if (active) {
        await client.query(
          `UPDATE vendor_subscriptions SET status = $2, cancelled_at = NOW(), cancel_reason = $3 WHERE id = $1`,
          [active.id, renewing ? 'EXPIRED' : 'CANCELLED', renewing ? 'Renewed' : `Changed to ${plan.name}`])
      }
      const sub = (await client.query(
        `INSERT INTO vendor_subscriptions (vendor_id, plan_id, billing_cycle, started_at, expires_at, amount_paid, payment_ref, auto_renew, notes, created_by)
         VALUES ($1,$2,$3, COALESCE($4::timestamp, NOW()), COALESCE($4::timestamp, NOW()) + $5::interval, $6, $7, $8, $9, $10) RETURNING id, expires_at`,
        [vendorId, plan.id, cycle, startBase, interval, amount, String(input.paymentRef || '').trim() || null,
          !!input.autoRenew, input.notes || null, actorId || null])).rows[0]
      await client.query(
        `INSERT INTO subscription_events (vendor_id, subscription_id, event, from_tier, to_tier, detail, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [vendorId, sub.id, renewing ? 'RENEWED' : (live ? 'CHANGED' : 'ASSIGNED'), fromTier, tier,
          JSON.stringify({ cycle, amount, paymentRef: input.paymentRef || null, expiresAt: sub.expires_at }), actorId || null])
      await client.query('COMMIT')
      return this.vendor(vendorId)
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      if (e.code === '23505') throw httpError(409, 'The vendor was changed by someone else just now — reload and try again', 'CONFLICT')
      throw e
    } finally {
      client.release()
    }
  }

  async extend(vendorId, days, reason, actorId) {
    const d = Number(days)
    if (!(Number.isInteger(d) && d >= 1 && d <= 365)) throw httpError(400, 'Extend by 1 to 365 days', 'VALIDATION')
    if (String(reason || '').trim().length < 5) throw httpError(400, 'Give a reason for the extension (at least 5 characters)', 'REASON_REQUIRED')
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const sub = (await client.query(
        `SELECT vs.*, sp.tier FROM vendor_subscriptions vs JOIN subscription_plans sp ON sp.id = vs.plan_id
          WHERE vs.vendor_id = $1 AND vs.status = 'ACTIVE' FOR UPDATE OF vs`, [vendorId])).rows[0]
      if (!sub || !sub.expires_at) throw httpError(409, 'This vendor has no running paid subscription to extend', 'NO_SUBSCRIPTION')
      const base = new Date(sub.expires_at) > new Date() ? 'expires_at' : 'NOW()'
      const { rows } = await client.query(`UPDATE vendor_subscriptions SET expires_at = ${base} + ($2 || ' days')::interval WHERE id = $1 RETURNING expires_at`, [sub.id, String(d)])
      await client.query(`INSERT INTO subscription_events (vendor_id, subscription_id, event, from_tier, to_tier, detail, actor_id) VALUES ($1,$2,'EXTENDED',$3,$3,$4,$5)`,
        [vendorId, sub.id, sub.tier, JSON.stringify({ days: d, reason: String(reason).trim(), expiresAt: rows[0].expires_at }), actorId || null])
      await client.query('COMMIT')
      return this.vendor(vendorId)
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  async cancel(vendorId, reason, actorId) {
    if (String(reason || '').trim().length < 5) throw httpError(400, 'Give a reason for cancelling (at least 5 characters)', 'REASON_REQUIRED')
    return this.assign(vendorId, { tier: 'FREE', notes: String(reason).trim() }, actorId)
  }

  // ── limits ──────────────────────────────────────────────────────────
  /** Throws 409 LISTING_LIMIT when a vendor has used up its plan. */
  async assertCanList(vendorId) {
    const { rows } = await query(
      `SELECT COALESCE(cur.live_limit, fp.listing_limit) AS lim, COALESCE(cur.live_plan, fp.name) AS plan_name, ${USED} AS used
         FROM vendors v ${CURRENT} WHERE v.id = $1`, [vendorId])
    const r = rows[0]
    if (!r || r.lim === null) return
    if (Number(r.used) >= Number(r.lim)) {
      throw httpError(409, `Your ${r.plan_name} plan allows ${r.lim} listings and you have ${r.used}. Upgrade your subscription to list more.`, 'LISTING_LIMIT')
    }
  }

  async me(vendorId) {
    const d = await this.vendor(vendorId)
    return { tier: d.tier, planName: d.plan_name, listingLimit: d.listing_limit, listingsUsed: d.listings_used, expiresAt: d.expires_at, daysLeft: d.expires_at ? Math.ceil((new Date(d.expires_at) - Date.now()) / 86400000) : null }
  }

  // ── expiry sweep (runs from the worker; safe to run twice) ──────────
  async sweep() {
    const client = await getClient()
    const out = { expired: 0, expiring: 0 }
    try {
      const lock = (await client.query(`SELECT pg_try_advisory_lock(hashtext('subscription-sweep')) AS ok`)).rows[0].ok
      if (!lock) return out
      try {
        const expired = (await client.query(
          `UPDATE vendor_subscriptions vs SET status = 'EXPIRED' FROM subscription_plans sp, vendors v
            WHERE vs.status = 'ACTIVE' AND vs.expires_at IS NOT NULL AND vs.expires_at <= NOW() AND sp.id = vs.plan_id AND v.id = vs.vendor_id
        RETURNING vs.id, vs.vendor_id, sp.tier, sp.name AS plan_name, v.name AS vendor_name`)).rows
        for (const e of expired) {
          await client.query(`INSERT INTO subscription_events (vendor_id, subscription_id, event, from_tier, to_tier, detail) VALUES ($1,$2,'EXPIRED',$3,'FREE','{}')`, [e.vendor_id, e.id, e.tier])
          await emitAlert({ type: 'SUBSCRIPTION_EXPIRED', severity: 'WARNING', title: `${e.vendor_name}'s ${e.plan_name} plan has expired`, body: 'The vendor moved back to the Free plan.', entityType: 'vendor', entityId: e.vendor_id, link: '/subscriptions', dedupeKey: `sub-expired:${e.id}` })
        }
        out.expired = expired.length

        const soon = (await client.query(
          `SELECT vs.id, vs.vendor_id, vs.expires_at, sp.tier, sp.name AS plan_name, v.name AS vendor_name
             FROM vendor_subscriptions vs JOIN subscription_plans sp ON sp.id = vs.plan_id JOIN vendors v ON v.id = vs.vendor_id
            WHERE vs.status = 'ACTIVE' AND vs.expires_at > NOW() AND vs.expires_at <= NOW() + interval '${EXPIRING_DAYS} days'
              AND NOT EXISTS (SELECT 1 FROM subscription_events e WHERE e.subscription_id = vs.id AND e.event = 'EXPIRING_SOON')`)).rows
        for (const s of soon) {
          await client.query(`INSERT INTO subscription_events (vendor_id, subscription_id, event, from_tier, to_tier, detail) VALUES ($1,$2,'EXPIRING_SOON',$3,$3,$4)`, [s.vendor_id, s.id, s.tier, JSON.stringify({ expiresAt: s.expires_at })])
          await emitAlert({ type: 'SUBSCRIPTION_EXPIRING', severity: 'WARNING', title: `${s.vendor_name}'s ${s.plan_name} plan expires soon`, body: `Ends ${new Date(s.expires_at).toISOString().slice(0, 10)}.`, entityType: 'vendor', entityId: s.vendor_id, link: '/subscriptions', dedupeKey: `sub-expiring:${s.id}` })
        }
        out.expiring = soon.length
      } finally {
        await client.query(`SELECT pg_advisory_unlock(hashtext('subscription-sweep'))`)
      }
      return out
    } finally {
      client.release()
    }
  }
}
