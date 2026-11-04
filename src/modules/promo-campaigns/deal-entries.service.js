/**
 * Vendor entries for deals. A deal (promo campaign) can be opened to vendors; each vendor puts
 * its own listings in, an admin approves, and CampaignsService.start applies the campaign
 * discount to the approved ones.
 *
 * @module modules/promo-campaigns/deal-entries.service
 */
import { query } from '../../config/database.js'

const httpError = (statusCode, message, code = 'DEAL_ERROR') => Object.assign(new Error(message), { statusCode, code })
const TIER_RANK = { FREE: 0, PAID: 1, PREMIUM: 2, UNLIMITED: 3 }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The vendor's current plan tier (FREE when there is no active, unexpired subscription). */
export async function vendorTier(vendorId) {
  const { rows: [r] } = await query(
    `SELECT p.tier FROM vendor_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
      WHERE s.vendor_id = $1 AND s.status = 'ACTIVE' AND (s.expires_at IS NULL OR s.expires_at > NOW())`, [vendorId])
  return r?.tier ?? 'FREE'
}

const isOpen = (c) => c.open_to_vendors && ['DRAFT', 'SCHEDULED'].includes(c.status)
  && (!c.entry_deadline || new Date(c.entry_deadline) > new Date())
  && (!c.ends_at || new Date(c.ends_at) > new Date())

async function getCampaign(id) {
  const { rows: [c] } = await query(
    `SELECT id, name, type, status, starts_at, ends_at, discount, open_to_vendors, entry_deadline, min_vendor_tier,
            require_approval, max_entries_per_vendor FROM promo_campaigns WHERE id = $1`, [id])
  if (!c) throw httpError(404, 'Deal not found', 'NOT_FOUND')
  return c
}

export class DealEntriesService {
  // ── vendor ──────────────────────────────────────────────────────────────

  /** Deals a vendor can join, with that vendor's own entry counts. */
  async listOpenForVendor(vendorId) {
    const tier = await vendorTier(vendorId)
    const { rows } = await query(
      `SELECT c.id, c.name, c.type, c.status, c.starts_at, c.ends_at, c.discount, c.entry_deadline, c.min_vendor_tier,
              c.require_approval, c.max_entries_per_vendor, c.open_to_vendors,
              COUNT(e.id) FILTER (WHERE e.vendor_id = $1 AND e.status <> 'WITHDRAWN')::int AS my_entries,
              COUNT(e.id) FILTER (WHERE e.vendor_id = $1 AND e.status = 'APPROVED')::int AS my_approved
         FROM promo_campaigns c LEFT JOIN deal_entries e ON e.campaign_id = c.id
        WHERE c.open_to_vendors AND c.status IN ('DRAFT', 'SCHEDULED', 'ACTIVE') AND (c.ends_at IS NULL OR c.ends_at > NOW())
        GROUP BY c.id ORDER BY c.starts_at ASC NULLS LAST, c.created_at DESC`, [vendorId])
    return rows.map((c) => ({ ...c, can_join: isOpen(c) && TIER_RANK[tier] >= TIER_RANK[c.min_vendor_tier], my_tier: tier }))
  }

  async detailForVendor(id, vendorId) {
    const c = await getCampaign(id)
    if (!c.open_to_vendors) throw httpError(404, 'Deal not found', 'NOT_FOUND')
    const tier = await vendorTier(vendorId)
    const { rows: entries } = await query(
      `SELECT e.id, e.shop_product_id, e.status, e.reject_reason, e.price_at_entry, e.created_at, p.name, p.thumbnail_url
         FROM deal_entries e JOIN shop_products sp ON sp.id = e.shop_product_id JOIN products p ON p.id = sp.product_id
        WHERE e.campaign_id = $1 AND e.vendor_id = $2 ORDER BY e.created_at DESC`, [id, vendorId])
    return { ...c, can_join: isOpen(c) && TIER_RANK[tier] >= TIER_RANK[c.min_vendor_tier], my_tier: tier, entries }
  }

  /** Vendor's listings that could go in (live, approved, in stock, priced) and whether each is already in. */
  async eligibleListings(id, vendorId) {
    const { rows } = await query(
      `SELECT sp.id, p.name, p.thumbnail_url, sp.price, sp.sale_price, sp.stock_quantity, e.status AS entry_status
         FROM shop_products sp
         JOIN shops s ON s.id = sp.shop_id AND s.vendor_id = $2
         JOIN products p ON p.id = sp.product_id
         LEFT JOIN deal_entries e ON e.shop_product_id = sp.id AND e.campaign_id = $1
        WHERE sp.deleted_at IS NULL AND sp.is_available AND sp.approval_status = 'APPROVED' AND sp.listing_status = 'ACTIVE'
          AND sp.sell_b2c = TRUE AND sp.stock_quantity > 0 AND COALESCE(sp.price, 0) > 0
        ORDER BY p.name LIMIT 200`, [id, vendorId])
    return rows
  }

  async apply(id, vendorId, listingIds) {
    const c = await getCampaign(id)
    if (!isOpen(c)) throw httpError(409, 'This deal is not accepting entries', 'NOT_OPEN')
    if (TIER_RANK[await vendorTier(vendorId)] < TIER_RANK[c.min_vendor_tier]) {
      throw httpError(403, `This deal needs the ${c.min_vendor_tier.toLowerCase()} plan or higher`, 'TIER_REQUIRED')
    }
    const ids = [...new Set((Array.isArray(listingIds) ? listingIds : []).filter((i) => UUID.test(i)))]
    if (!ids.length) throw httpError(400, 'Pick at least one product', 'VALIDATION')
    if (ids.length > 100) throw httpError(400, 'Pick at most 100 products at a time', 'VALIDATION')

    const ok = (await this.eligibleListings(id, vendorId)).filter((l) => ids.includes(l.id) && !['PENDING', 'APPROVED'].includes(l.entry_status))
    if (!ok.length) throw httpError(409, 'None of these products can join (already in, or not live and in stock)', 'NOT_ELIGIBLE')

    if (c.max_entries_per_vendor) {
      const { rows: [{ n }] } = await query(`SELECT COUNT(*)::int n FROM deal_entries WHERE campaign_id = $1 AND vendor_id = $2 AND status IN ('PENDING','APPROVED')`, [id, vendorId])
      if (n + ok.length > c.max_entries_per_vendor) throw httpError(409, `You can enter at most ${c.max_entries_per_vendor} products in this deal`, 'LIMIT')
    }
    const status = c.require_approval ? 'PENDING' : 'APPROVED'
    await query(
      `INSERT INTO deal_entries (campaign_id, shop_product_id, vendor_id, status, price_at_entry, decided_at)
       SELECT $1, t.id, $2, $3, t.price, CASE WHEN $3 = 'APPROVED' THEN NOW() END
         FROM unnest($4::uuid[], $5::numeric[]) AS t(id, price)
       ON CONFLICT (campaign_id, shop_product_id)
       DO UPDATE SET status = EXCLUDED.status, price_at_entry = EXCLUDED.price_at_entry, reject_reason = NULL, decided_at = EXCLUDED.decided_at, decided_by = NULL`,
      [id, vendorId, status, ok.map((l) => l.id), ok.map((l) => Number(l.sale_price) > 0 ? l.sale_price : l.price)])
    return { added: ok.length, status }
  }

  async withdraw(id, entryId, vendorId) {
    const c = await getCampaign(id)
    if (c.status === 'ACTIVE') throw httpError(409, 'The deal is already running — entries can no longer be withdrawn', 'LIVE')
    const { rowCount } = await query(
      `UPDATE deal_entries SET status = 'WITHDRAWN', decided_at = NOW() WHERE id = $1 AND campaign_id = $2 AND vendor_id = $3 AND status IN ('PENDING','APPROVED')`,
      [entryId, id, vendorId])
    if (!rowCount) throw httpError(404, 'Entry not found', 'NOT_FOUND')
    return { withdrawn: true }
  }

  // ── admin ───────────────────────────────────────────────────────────────

  async listForAdmin(id, status = '') {
    await getCampaign(id)
    const params = [id]
    let sql = `SELECT e.id, e.status, e.reject_reason, e.price_at_entry, e.created_at, v.name AS vendor_name, e.vendor_id,
                      p.name AS product_name, p.thumbnail_url, sp.price, sp.sale_price, sp.stock_quantity, sp.id AS listing_id,
                      (SELECT oc.name FROM promo_campaign_listings ol JOIN promo_campaigns oc ON oc.id = ol.campaign_id
                        WHERE ol.shop_product_id = e.shop_product_id AND oc.id <> e.campaign_id AND oc.status = 'ACTIVE' LIMIT 1) AS busy_in
                 FROM deal_entries e
                 JOIN shop_products sp ON sp.id = e.shop_product_id JOIN products p ON p.id = sp.product_id
                 JOIN vendors v ON v.id = e.vendor_id
                WHERE e.campaign_id = $1 AND e.status <> 'WITHDRAWN'`
    if (status) { params.push(status); sql += ` AND e.status = $2` }
    return (await query(`${sql} ORDER BY (e.status = 'PENDING') DESC, e.created_at DESC LIMIT 500`, params)).rows
  }

  async decide(id, entryIds, decision, reason, adminId) {
    const c = await getCampaign(id)
    if (c.status === 'ACTIVE' || c.status === 'ENDED') throw httpError(409, 'The deal already started — entries can no longer be changed', 'LOCKED')
    if (!['APPROVED', 'REJECTED'].includes(decision)) throw httpError(400, 'Decision must be APPROVED or REJECTED', 'VALIDATION')
    const ids = (Array.isArray(entryIds) ? entryIds : []).filter((i) => UUID.test(i))
    if (!ids.length) throw httpError(400, 'Select at least one entry', 'VALIDATION')
    const { rowCount } = await query(
      `UPDATE deal_entries SET status = $3, reject_reason = $4, decided_by = $5, decided_at = NOW()
        WHERE campaign_id = $1 AND id = ANY($2::uuid[]) AND status IN ('PENDING','APPROVED','REJECTED')`,
      [id, ids, decision, decision === 'REJECTED' ? (reason || null) : null, adminId])
    return { updated: rowCount }
  }

  /** Open / close a deal to vendors and set its entry rules. Only before it starts. */
  async setOpen(id, body) {
    const c = await getCampaign(id)
    if (!['DRAFT', 'SCHEDULED'].includes(c.status)) throw httpError(409, 'Only a draft or scheduled deal can change vendor entry settings', 'LOCKED')
    const tier = body.min_vendor_tier && TIER_RANK[body.min_vendor_tier] !== undefined ? body.min_vendor_tier : c.min_vendor_tier
    const max = body.max_entries_per_vendor ? Math.max(1, Math.floor(Number(body.max_entries_per_vendor))) : null
    await query(
      `UPDATE promo_campaigns SET open_to_vendors = $2, entry_deadline = $3, min_vendor_tier = $4, require_approval = $5,
              max_entries_per_vendor = $6, updated_at = NOW() WHERE id = $1`,
      [id, !!body.open_to_vendors, body.entry_deadline ? new Date(body.entry_deadline) : null, tier, body.require_approval !== false, max])
    return { ok: true }
  }

  /** Approved listing ids for a campaign — merged into the scope when the campaign starts. */
  async approvedListingIds(id) {
    const { rows } = await query(
      `SELECT e.shop_product_id FROM deal_entries e JOIN shop_products sp ON sp.id = e.shop_product_id AND sp.deleted_at IS NULL
        WHERE e.campaign_id = $1 AND e.status = 'APPROVED'`, [id])
    return rows.map((r) => r.shop_product_id)
  }
}
