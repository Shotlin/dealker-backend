/**
 * Deals on home sections. A "deal" is an existing promo campaign (Campaigns page):
 * it already schedules a price cut, tracks the listings it touched and reverts at the end.
 * A section (or one tab of a tabbed section) can point at a campaign; while the campaign
 * is ACTIVE its listings fill the section, otherwise the section shows no deal products.
 */
import { query } from '../../config/database.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isCampaignId = (v) => typeof v === 'string' && UUID.test(v)

/**
 * @returns {Promise<{ deal: object|null, productIds: string[] }>} productIds is empty unless the campaign is ACTIVE.
 */
export async function getCampaignDeal(campaignId) {
  if (!isCampaignId(campaignId)) return { deal: null, productIds: [] }
  const { rows: [c] } = await query(
    `SELECT id, name, type, status, starts_at, ends_at, discount, listing_count FROM promo_campaigns WHERE id = $1`,
    [campaignId]
  )
  if (!c) return { deal: null, productIds: [] }
  const deal = {
    id: c.id, name: c.name, type: c.type, status: c.status,
    starts_at: c.starts_at, ends_at: c.ends_at, discount: c.discount, product_count: c.listing_count,
  }
  if (c.status !== 'ACTIVE') return { deal, productIds: [] }
  const { rows } = await query(
    `SELECT sp.product_id
       FROM promo_campaign_listings l
       JOIN shop_products sp ON sp.id = l.shop_product_id AND sp.deleted_at IS NULL
      WHERE l.campaign_id = $1
      GROUP BY sp.product_id
      ORDER BY MAX(l.price_before - l.price_after) DESC NULLS LAST`,
    [campaignId]
  )
  return { deal, productIds: rows.map((r) => r.product_id) }
}
