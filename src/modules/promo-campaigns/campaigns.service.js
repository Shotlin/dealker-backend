/**
 * Promotional campaigns.
 *
 *   DRAFT → SCHEDULED → ACTIVE → ENDED          (or CANCELLED before it starts)
 *
 * Starting a campaign applies its discount as a normal price batch (so it is
 * visible and revertible in Price & Stock Control) and places the matched
 * listings in a section; ending it reverts both. Listings already inside
 * another running campaign are skipped, so campaigns never fight over a price.
 * Sales are attributed through the listings the campaign touched.
 *
 * @module modules/promo-campaigns/campaigns.service
 */

import { query, getClient } from '../../config/database.js'
import { PricingService } from '../pricing/pricing.service.js'
import { MerchandisingService, SECTIONS } from '../merchandising/merchandising.service.js'
import { validatePriceParams } from '../pricing/price.engine.js'

export const CAMPAIGN_TYPES = ['GENERAL', 'VENDOR', 'PRODUCT', 'DISCOUNT', 'FLASH_SALE', 'DEAL_OF_THE_DAY', 'CLEARANCE_SALE', 'COUPON']
const TYPE_SECTION = { FLASH_SALE: 'FLASH_SALE', DEAL_OF_THE_DAY: 'DEAL_OF_THE_DAY', CLEARANCE_SALE: 'CLEARANCE_SALE' }
const DISCOUNT_OPS = ['PERCENT', 'FIXED', 'DISCOUNT_FROM_MRP']
const httpError = (statusCode, message, code = 'CAMPAIGN_ERROR') => Object.assign(new Error(message), { statusCode, code })

const pricing = new PricingService()
const merch = new MerchandisingService()

function normalise(input, { forSchedule = false } = {}) {
  const type = String(input.type || 'GENERAL').toUpperCase()
  if (!CAMPAIGN_TYPES.includes(type)) throw httpError(400, `type must be one of ${CAMPAIGN_TYPES.join(', ')}`, 'VALIDATION')
  const name = String(input.name || '').trim()
  if (name.length < 3 || name.length > 120) throw httpError(400, 'Campaign name must be 3 to 120 characters', 'VALIDATION')

  const startsAt = input.startsAt ? new Date(input.startsAt) : null
  const endsAt = input.endsAt ? new Date(input.endsAt) : null
  if ((startsAt && Number.isNaN(startsAt.getTime())) || (endsAt && Number.isNaN(endsAt.getTime()))) throw httpError(400, 'Invalid start or end time', 'VALIDATION')
  if (startsAt && endsAt && endsAt <= startsAt) throw httpError(400, 'The end time must be after the start time', 'VALIDATION')
  if (forSchedule) {
    if (!startsAt || !endsAt) throw httpError(400, 'Set both a start and an end time to schedule the campaign', 'VALIDATION')
    if (endsAt.getTime() <= Date.now()) throw httpError(400, 'The end time must be in the future', 'VALIDATION')
  }

  let discount = null
  let section = input.section ? String(input.section).toUpperCase() : (TYPE_SECTION[type] ?? null)
  if (section && !SECTIONS[section]) throw httpError(400, 'Unknown section', 'VALIDATION')
  const scope = input.scope && typeof input.scope === 'object' ? input.scope : {}

  if (type === 'COUPON') {
    if (!input.couponId) throw httpError(400, 'Pick the coupon this campaign promotes', 'VALIDATION')
    section = null
  } else {
    if (input.discount) {
      const d = { operation: input.discount.operation, value: Number(input.discount.value), rounding: input.discount.rounding || 'NONE', allowBelowCost: !!input.discount.allowBelowCost, allowLargeChange: true, target: 'RETAIL' }
      if (!DISCOUNT_OPS.includes(d.operation)) throw httpError(400, 'A campaign discount is a percentage or ₹ reduction, or a discount off MRP', 'VALIDATION')
      if (d.operation !== 'DISCOUNT_FROM_MRP' && !(d.value < 0)) throw httpError(400, 'A campaign must lower prices — use a negative value (e.g. −10)', 'VALIDATION')
      if (d.operation === 'PERCENT' && d.value < -90) throw httpError(400, 'A campaign cannot take more than 90% off', 'VALIDATION')
      const err = validatePriceParams(d)
      if (err) throw httpError(400, err, 'VALIDATION')
      discount = d
    }
    if (!discount && !section) throw httpError(400, 'Give the campaign a discount, a section, or both', 'VALIDATION')
    if (type === 'FLASH_SALE' || type === 'DEAL_OF_THE_DAY' || type === 'CLEARANCE_SALE' || type === 'DISCOUNT') {
      if (!discount) throw httpError(400, 'This campaign type needs a discount', 'VALIDATION')
    }
  }
  const narrowed = scope.all || ['vendorIds', 'categoryIds', 'brands', 'listingIds'].some((k) => Array.isArray(scope[k]) && scope[k].length) || scope.owner || scope.channel
  if (type !== 'COUPON' && !narrowed) throw httpError(400, 'Choose which products take part (all products, a vendor, a category, a brand or specific products)', 'SCOPE_REQUIRED')
  if (type === 'VENDOR' && !(scope.vendorIds?.length)) throw httpError(400, 'A vendor campaign needs at least one vendor', 'VALIDATION')
  if (type === 'PRODUCT' && !(scope.listingIds?.length)) throw httpError(400, 'A product campaign needs at least one product', 'VALIDATION')
  return { type, name, description: input.description ? String(input.description).slice(0, 1000) : null, startsAt, endsAt, scope, discount, section, couponId: input.couponId || null }
}

const LIST_SQL = `
  SELECT c.*, cp.code AS coupon_code, u.name AS created_by_name
    FROM promo_campaigns c LEFT JOIN coupons cp ON cp.id = c.coupon_id LEFT JOIN users u ON u.id = c.created_by`

export class CampaignsService {
  async overview() {
    const counts = (await query(`SELECT status, COUNT(*)::int n FROM promo_campaigns GROUP BY status`)).rows
    const by = Object.fromEntries(counts.map((r) => [r.status, r.n]))
    const money = (await query(
      `SELECT COALESCE(SUM(COALESCE(oi.total, oi.subtotal)), 0) AS revenue, COUNT(DISTINCT oi.order_id)::int AS orders,
              COUNT(DISTINCT o.customer_id)::int AS customers
         FROM promo_campaigns c
         JOIN promo_campaign_listings l ON l.campaign_id = c.id
         JOIN order_items oi ON oi.shop_product_id = l.shop_product_id
         JOIN orders o ON o.id = oi.order_id
        WHERE c.status IN ('ACTIVE', 'ENDED') AND c.activated_at IS NOT NULL
          AND o.created_at >= c.activated_at AND o.created_at <= COALESCE(c.ended_at, NOW()) AND o.status NOT IN ('CANCELLED', 'REFUNDED')`)).rows[0]
    const vendors = (await query(
      `SELECT COUNT(DISTINCT p.owner_vendor_id)::int AS n
         FROM promo_campaigns c JOIN promo_campaign_listings l ON l.campaign_id = c.id
         JOIN shop_products sp ON sp.id = l.shop_product_id JOIN products p ON p.id = sp.product_id
        WHERE c.status = 'ACTIVE' AND p.owner_vendor_id IS NOT NULL`)).rows[0]
    return {
      active: by.ACTIVE ?? 0, scheduled: by.SCHEDULED ?? 0, draft: by.DRAFT ?? 0, ended: by.ENDED ?? 0, cancelled: by.CANCELLED ?? 0,
      revenue: Number(money.revenue), orders: money.orders, customers: money.customers, vendorsInvolved: vendors.n,
    }
  }

  async list({ status = '', type = '', search = '', page = 1, limit = 20 } = {}) {
    const where = []
    const params = []
    const p = (v) => { params.push(v); return `$${params.length}` }
    if (status) where.push(`c.status = ${p(status)}`)
    if (type) where.push(`c.type = ${p(type)}`)
    if (search) where.push(`c.name ILIKE ${p(`%${search}%`)}`)
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const lim = Math.min(100, Math.max(1, Number(limit) || 20))
    const off = (Math.max(1, Number(page)) - 1) * lim
    const total = (await query(`SELECT COUNT(*)::int n FROM promo_campaigns c ${w}`, params)).rows[0].n
    const { rows } = await query(
      `${LIST_SQL} ${w}
        ORDER BY CASE c.status WHEN 'ACTIVE' THEN 1 WHEN 'SCHEDULED' THEN 2 WHEN 'DRAFT' THEN 3 ELSE 4 END, COALESCE(c.starts_at, c.created_at) DESC
        LIMIT ${lim} OFFSET ${off}`, params)
    return { data: rows, meta: { page: Number(page), limit: lim, total, totalPages: Math.ceil(total / lim) } }
  }

  async stats(c) {
    if (!c.activated_at) return { orders: 0, units: 0, revenue: 0, customers: 0, vendors: 0, savings: 0, couponUses: 0, couponDiscount: 0 }
    const end = c.ended_at || new Date()
    const { rows } = await query(
      `SELECT COUNT(DISTINCT oi.order_id)::int AS orders, COALESCE(SUM(oi.quantity), 0) AS units,
              COALESCE(SUM(COALESCE(oi.total, oi.subtotal)), 0) AS revenue, COUNT(DISTINCT o.customer_id)::int AS customers,
              COUNT(DISTINCT so.vendor_id)::int AS vendors,
              COALESCE(SUM(GREATEST(l.price_before - oi.unit_price, 0) * oi.quantity), 0) AS savings
         FROM promo_campaign_listings l
         JOIN order_items oi ON oi.shop_product_id = l.shop_product_id
         JOIN orders o ON o.id = oi.order_id
         LEFT JOIN seller_orders so ON so.id = oi.seller_order_id
        WHERE l.campaign_id = $1 AND o.created_at >= $2 AND o.created_at <= $3 AND o.status NOT IN ('CANCELLED', 'REFUNDED')`,
      [c.id, c.activated_at, end])
    const r = rows[0]
    let couponUses = 0; let couponDiscount = 0
    if (c.coupon_id) {
      const cu = (await query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(discount_amount), 0) AS d FROM coupon_usages WHERE coupon_id = $1 AND COALESCE(used_at, created_at) >= $2 AND COALESCE(used_at, created_at) <= $3`,
        [c.coupon_id, c.activated_at, end])).rows[0]
      couponUses = cu.n; couponDiscount = Number(cu.d)
    }
    return { orders: r.orders, units: Number(r.units), revenue: Number(r.revenue), customers: r.customers, vendors: r.vendors, savings: Number(r.savings), couponUses, couponDiscount }
  }

  async get(id) {
    const c = (await query(`${LIST_SQL} WHERE c.id = $1`, [id])).rows[0]
    if (!c) throw httpError(404, 'Campaign not found', 'NOT_FOUND')
    const listings = (await query(
      `SELECT l.shop_product_id AS id, l.price_before, l.price_after, p.name, p.brand, COALESCE(v.name, 'Dealker') AS owner_name
         FROM promo_campaign_listings l JOIN shop_products sp ON sp.id = l.shop_product_id JOIN products p ON p.id = sp.product_id
         LEFT JOIN vendors v ON v.id = p.owner_vendor_id WHERE l.campaign_id = $1 ORDER BY p.name LIMIT 100`, [id])).rows
    return {
      ...c, stats: await this.stats(c),
      listings: listings.map((r) => ({ ...r, price_before: r.price_before != null ? Number(r.price_before) : null, price_after: r.price_after != null ? Number(r.price_after) : null })),
    }
  }

  async create(input, actorId) {
    const v = normalise(input)
    if (v.couponId) await this.#assertCoupon(v.couponId)
    const { rows } = await query(
      `INSERT INTO promo_campaigns (name, type, description, starts_at, ends_at, scope, discount, section, coupon_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [v.name, v.type, v.description, v.startsAt, v.endsAt, JSON.stringify(v.scope), v.discount ? JSON.stringify(v.discount) : null, v.section, v.couponId, actorId || null])
    return this.get(rows[0].id)
  }

  async #assertCoupon(id) {
    const c = (await query(`SELECT id FROM coupons WHERE id = $1`, [id])).rows[0]
    if (!c) throw httpError(400, 'That coupon does not exist', 'VALIDATION')
  }

  async update(id, input) {
    const cur = (await query(`SELECT * FROM promo_campaigns WHERE id = $1`, [id])).rows[0]
    if (!cur) throw httpError(404, 'Campaign not found', 'NOT_FOUND')
    if (!['DRAFT', 'SCHEDULED'].includes(cur.status)) throw httpError(409, 'Only draft or scheduled campaigns can be edited', 'NOT_EDITABLE')
    const v = normalise({
      type: cur.type, name: cur.name, description: cur.description, startsAt: cur.starts_at, endsAt: cur.ends_at,
      scope: cur.scope, discount: cur.discount, section: cur.section, couponId: cur.coupon_id, ...input,
    }, { forSchedule: cur.status === 'SCHEDULED' })
    if (v.couponId) await this.#assertCoupon(v.couponId)
    await query(
      `UPDATE promo_campaigns SET name=$2, type=$3, description=$4, starts_at=$5, ends_at=$6, scope=$7, discount=$8, section=$9, coupon_id=$10, updated_at=NOW() WHERE id=$1`,
      [id, v.name, v.type, v.description, v.startsAt, v.endsAt, JSON.stringify(v.scope), v.discount ? JSON.stringify(v.discount) : null, v.section, v.couponId])
    return this.get(id)
  }

  async remove(id) {
    const { rowCount } = await query(`DELETE FROM promo_campaigns WHERE id = $1 AND status IN ('DRAFT', 'CANCELLED')`, [id])
    if (!rowCount) throw httpError(409, 'Only draft or cancelled campaigns can be deleted', 'NOT_DELETABLE')
  }

  async schedule(id) {
    const cur = (await query(`SELECT * FROM promo_campaigns WHERE id = $1`, [id])).rows[0]
    if (!cur) throw httpError(404, 'Campaign not found', 'NOT_FOUND')
    if (cur.status !== 'DRAFT') throw httpError(409, 'Only a draft can be scheduled', 'INVALID_STATE')
    normalise({ type: cur.type, name: cur.name, description: cur.description, startsAt: cur.starts_at, endsAt: cur.ends_at, scope: cur.scope, discount: cur.discount, section: cur.section, couponId: cur.coupon_id }, { forSchedule: true })
    await query(`UPDATE promo_campaigns SET status = 'SCHEDULED', updated_at = NOW() WHERE id = $1`, [id])
    return this.get(id)
  }

  async cancel(id, reason) {
    const { rowCount } = await query(
      `UPDATE promo_campaigns SET status = 'CANCELLED', end_reason = $2, updated_at = NOW() WHERE id = $1 AND status IN ('DRAFT', 'SCHEDULED')`, [id, reason || 'Cancelled before it started'])
    if (!rowCount) throw httpError(409, 'Only a draft or scheduled campaign can be cancelled — end a running one instead', 'INVALID_STATE')
    return this.get(id)
  }

  /** Dry run for the form: what would the discount do to the chosen products right now? */
  async preview(input) {
    const v = normalise({ ...input, name: input.name || 'Preview' })
    if (!v.discount) return { summary: { total: 0, changed: 0, skipped: 0, listings: (await pricing.resolveScope(v.scope)).length, skipReasons: {} }, sample: [], truncated: false }
    const excluded = await this.#busyListings(null)
    return pricing.previewPrice({ scope: { ...v.scope, excludeListingIds: excluded }, params: v.discount })
  }

  async #busyListings(exceptCampaignId) {
    const { rows } = await query(
      `SELECT DISTINCT l.shop_product_id AS id FROM promo_campaign_listings l JOIN promo_campaigns c ON c.id = l.campaign_id
        WHERE c.status = 'ACTIVE' AND ($1::uuid IS NULL OR c.id <> $1)`, [exceptCampaignId])
    return rows.map((r) => r.id)
  }

  // ── lifecycle ───────────────────────────────────────────────────────
  /** DRAFT/SCHEDULED → ACTIVE. The status claim is atomic, so a duplicate trigger is a no-op. */
  async start(id, actorId = null) {
    const before = (await query(`SELECT status FROM promo_campaigns WHERE id = $1`, [id])).rows[0]
    const claim = (await query(
      `UPDATE promo_campaigns SET status = 'ACTIVE', activated_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status IN ('DRAFT', 'SCHEDULED') RETURNING *`, [id])).rows[0]
    if (!claim) {
      const exists = (await query(`SELECT status FROM promo_campaigns WHERE id = $1`, [id])).rows[0]
      if (!exists) throw httpError(404, 'Campaign not found', 'NOT_FOUND')
      throw httpError(409, `This campaign is already ${exists.status.toLowerCase()}`, 'INVALID_STATE')
    }
    try {
      if (claim.ends_at && new Date(claim.ends_at) <= new Date()) throw httpError(409, 'The end time has already passed — move it to the future first', 'WINDOW_PASSED')
      if (claim.type === 'COUPON') {
        await query(`UPDATE promo_campaigns SET listing_count = 0 WHERE id = $1`, [id])
        return this.get(id)
      }
      const busy = await this.#busyListings(id)
      const scope = { ...claim.scope, excludeListingIds: busy }
      let batchId = null
      let touched = []

      if (claim.discount) {
        try {
          const res = await pricing.applyPrice({ scope, params: claim.discount, note: `Campaign: ${claim.name}` }, actorId)
          batchId = res.batchId
          touched = (await query(`SELECT shop_product_id AS id, old_value, new_value FROM price_adjustment_items WHERE batch_id = $1`, [batchId])).rows
        } catch (e) {
          if (e.code !== 'NOTHING_TO_DO') throw e
        }
      }
      // With a discount, only listings whose price really changed join the section
      // (a "Flash Sale" product at its normal price would mislead customers).
      const idsForSection = !claim.section ? []
        : claim.discount ? touched.map((t) => t.id)
        : await pricing.resolveScope(scope)
      const all = new Map(touched.map((t) => [t.id, t]))
      idsForSection.forEach((i) => { if (!all.has(i)) all.set(i, { id: i }) })

      const client = await getClient()
      try {
        await client.query('BEGIN')
        const ids = [...all.keys()]
        if (ids.length) {
          await client.query(
            `INSERT INTO promo_campaign_listings (campaign_id, shop_product_id, price_before, price_after, previous_section, previous_section_ends, previous_position)
             SELECT $1, sp.id, t.old, t.new, sp.merch_section, sp.merch_ends_at, sp.merch_position
               FROM shop_products sp
               JOIN unnest($2::uuid[], $3::numeric[], $4::numeric[]) AS t(id, old, new) ON t.id = sp.id
             ON CONFLICT DO NOTHING`,
            [id, ids, ids.map((i) => all.get(i).old_value ?? null), ids.map((i) => all.get(i).new_value ?? null)])
        }
        await client.query(`UPDATE promo_campaigns SET activation_batch_id = $2, listing_count = $3, updated_at = NOW() WHERE id = $1`, [id, batchId, ids.length])
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        client.release()
      }
      if (claim.section && idsForSection.length) {
        await merch.move(idsForSection, claim.section, { endsAt: claim.ends_at ? new Date(claim.ends_at).toISOString() : undefined })
      }
      return this.get(id)
    } catch (e) {
      // Starting failed: undo whatever was done and put the campaign back.
      const row = (await query(`SELECT activation_batch_id FROM promo_campaigns WHERE id = $1`, [id])).rows[0]
      if (row?.activation_batch_id) await pricing.revert(row.activation_batch_id, actorId).catch(() => {})
      await query(`DELETE FROM promo_campaign_listings WHERE campaign_id = $1`, [id])
      await query(`UPDATE promo_campaigns SET status = $2, activated_at = NULL, activation_batch_id = NULL, listing_count = 0 WHERE id = $1`, [id, before.status])
      throw e
    }
  }

  /** ACTIVE → ENDED: revert the price batch and give listings their old section back. */
  async end(id, reason = 'Ended', actorId = null) {
    const claim = (await query(
      `UPDATE promo_campaigns SET status = 'ENDED', ended_at = NOW(), end_reason = $2, updated_at = NOW() WHERE id = $1 AND status = 'ACTIVE' RETURNING *`, [id, reason])).rows[0]
    if (!claim) {
      const exists = (await query(`SELECT status FROM promo_campaigns WHERE id = $1`, [id])).rows[0]
      if (!exists) throw httpError(404, 'Campaign not found', 'NOT_FOUND')
      throw httpError(409, 'Only a running campaign can be ended', 'INVALID_STATE')
    }
    let revert = { restored: 0, conflicts: 0 }
    if (claim.activation_batch_id) {
      try { revert = await pricing.revert(claim.activation_batch_id, actorId) } catch (e) { if (e.code !== 'ALREADY_REVERTED') throw e }
    }
    if (claim.section) {
      // only listings still sitting in the campaign's section are put back
      await query(
        `UPDATE shop_products sp
            SET merch_section = l.previous_section, merch_starts_at = NULL,
                merch_ends_at = l.previous_section_ends, merch_position = COALESCE(l.previous_position, 0),
                is_featured = COALESCE(l.previous_section = 'FEATURED', FALSE), merch_updated_at = NOW(), updated_at = NOW()
           FROM promo_campaign_listings l
          WHERE l.campaign_id = $1 AND l.shop_product_id = sp.id AND sp.merch_section = $2`, [id, claim.section])
      await query(
        `UPDATE products p SET is_featured = sp.is_featured, updated_at = NOW()
           FROM shop_products sp, promo_campaign_listings l
          WHERE l.campaign_id = $1 AND l.shop_product_id = sp.id AND p.id = sp.product_id`, [id])
    }
    return { ...(await this.get(id)), revert }
  }

  /** Worker tick: start what is due, end what is over. Safe to run concurrently. */
  async tick() {
    const out = { started: 0, ended: 0, failed: 0 }
    const due = (await query(`SELECT id, ends_at FROM promo_campaigns WHERE status = 'SCHEDULED' AND starts_at <= NOW()`)).rows
    for (const c of due) {
      try {
        if (c.ends_at && new Date(c.ends_at) <= new Date()) {
          await query(`UPDATE promo_campaigns SET status = 'ENDED', ended_at = NOW(), end_reason = 'Window passed before it could start', updated_at = NOW() WHERE id = $1 AND status = 'SCHEDULED'`, [c.id])
        } else {
          await this.start(c.id)
          out.started += 1
        }
      } catch { out.failed += 1 }
    }
    const over = (await query(`SELECT id FROM promo_campaigns WHERE status = 'ACTIVE' AND ends_at IS NOT NULL AND ends_at <= NOW()`)).rows
    for (const c of over) {
      try { await this.end(c.id, 'Reached its end time'); out.ended += 1 } catch { out.failed += 1 }
    }
    return out
  }
}
