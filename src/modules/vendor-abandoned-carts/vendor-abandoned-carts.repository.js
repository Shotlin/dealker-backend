import { query } from '../../config/database.js'

/**
 * Vendor-scoped READ queries over the abandoned-cart tables.
 *
 * Every query joins items → shops and filters on `shops.vendor_id`, so a vendor
 * only ever sees (and totals) the lines that belong to their own shops. Other
 * vendors' lines in the same cart are never selected, counted or summed.
 */

/** Per-episode aggregate of ONE vendor's lines. */
const MINE = `
  SELECT ci.abandoned_cart_id,
         COUNT(*)::int AS item_count,
         COALESCE(SUM(ci.quantity), 0)::int AS quantity,
         COALESCE(SUM(ci.line_total), 0) AS value,
         (array_agg(ci.product_name ORDER BY ci.line_total DESC))[1] AS top_product,
         (array_agg(ci.product_thumbnail_url ORDER BY ci.line_total DESC))[1] AS top_thumbnail
    FROM abandoned_cart_items ci
    JOIN shops s ON s.id = ci.shop_id
   WHERE s.vendor_id = $1
   GROUP BY ci.abandoned_cart_id`

/** Did the order that closed this episode include this vendor? */
const ORDERED_WITH_ME = `EXISTS (SELECT 1 FROM seller_orders so WHERE so.order_id = ac.converted_order_id AND so.vendor_id = $1)`

/** Vendor-facing state of an episode. */
export const STATE_SQL = `
  CASE
    WHEN ac.status = 'OPEN' THEN 'ABANDONED'
    WHEN ac.status = 'CONVERTED' AND ${ORDERED_WITH_ME} THEN 'ORDERED'
    WHEN ac.status = 'RECOVERED' THEN 'BACK_IN_CART'
    ELSE 'CLOSED'
  END`

const channelClause = (channel, params) => {
  if (channel === 'B2B') { params.push('wholesale'); return `AND ac.price_mode = $${params.length}` }
  if (channel === 'B2C') { params.push('retail'); return `AND ac.price_mode = $${params.length}` }
  return ''
}

export async function listEpisodes(vendorId, { channel = 'ALL', state = '', search = '', days = 30, limit = 25, offset = 0 } = {}) {
  const params = [vendorId]
  const where = [`ac.abandoned_at >= NOW() - make_interval(days => ${Math.min(365, Math.max(1, Number(days) || 30))})`]
  const ch = channelClause(channel, params)
  if (ch) where.push(ch.replace(/^AND /, ''))
  if (state) { params.push(state); where.push(`(${STATE_SQL}) = $${params.length}`) }
  if (search) { params.push(`%${search}%`); where.push(`(u.name ILIKE $${params.length} OR mine.top_product ILIKE $${params.length})`) }
  const sql = `FROM abandoned_carts ac
      JOIN (${MINE}) mine ON mine.abandoned_cart_id = ac.id
      JOIN users u ON u.id = ac.user_id
     WHERE ${where.join(' AND ')}`
  const [{ rows }, { rows: cnt }] = await Promise.all([
    query(
      `SELECT ac.id, ac.status, ac.price_mode, ac.abandoned_at, ac.recovered_at, ac.converted_at, u.name AS customer_name,
              mine.item_count, mine.quantity, mine.value, mine.top_product, mine.top_thumbnail,
              (${STATE_SQL}) AS state,
              (SELECT COUNT(*)::int FROM abandoned_cart_vendor_reminders r WHERE r.abandoned_cart_id = ac.id AND r.vendor_id = $1) AS my_reminders,
              (SELECT MAX(r.created_at) FROM abandoned_cart_vendor_reminders r WHERE r.abandoned_cart_id = ac.id AND r.vendor_id = $1) AS last_reminder_at
         ${sql}
        ORDER BY (ac.status = 'OPEN') DESC, ac.abandoned_at DESC
        LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, params),
    query(`SELECT COUNT(*)::int AS n ${sql}`, params),
  ])
  return { rows, total: cnt[0].n }
}

/** One window of KPI numbers; the service calls it twice (now, previous period). */
export async function windowTotals(vendorId, { channel = 'ALL', fromDays, toDays }) {
  const params = [vendorId]
  const ch = channelClause(channel, params)
  const { rows } = await query(
    `SELECT COUNT(*)::int AS carts,
            COALESCE(SUM(mine.value) FILTER (WHERE ac.status = 'OPEN'), 0) AS pending_value,
            COUNT(*) FILTER (WHERE ac.status = 'OPEN')::int AS open_carts,
            COUNT(*) FILTER (WHERE ac.status = 'CONVERTED' AND ${ORDERED_WITH_ME})::int AS ordered,
            COALESCE(SUM(mine.value) FILTER (WHERE ac.status = 'CONVERTED' AND ${ORDERED_WITH_ME}), 0) AS ordered_value,
            COUNT(*) FILTER (WHERE ac.status = 'CONVERTED' AND ${ORDERED_WITH_ME}
              AND EXISTS (SELECT 1 FROM abandoned_cart_vendor_reminders r
                           WHERE r.abandoned_cart_id = ac.id AND r.vendor_id = $1 AND r.created_at <= ac.converted_at))::int AS ordered_after_reminder
       FROM abandoned_carts ac
       JOIN (${MINE}) mine ON mine.abandoned_cart_id = ac.id
      WHERE ac.abandoned_at >= NOW() - make_interval(days => ${Number(fromDays)})
        AND ac.abandoned_at < NOW() - make_interval(days => ${Number(toDays)})
        ${ch}`, params)
  return rows[0]
}

/** The header of one episode, only if the vendor has lines in it. */
export async function findEpisode(vendorId, id) {
  const { rows } = await query(
    `SELECT ac.id, ac.user_id, ac.status, ac.price_mode, ac.abandoned_at, ac.recovered_at, ac.converted_at, ac.converted_order_id,
            u.name AS customer_name, u.notification_preferences,
            (${STATE_SQL}) AS state
       FROM abandoned_carts ac
       JOIN users u ON u.id = ac.user_id
      WHERE ac.id = $2
        AND EXISTS (SELECT 1 FROM abandoned_cart_items ci JOIN shops s ON s.id = ci.shop_id
                     WHERE ci.abandoned_cart_id = ac.id AND s.vendor_id = $1)`, [vendorId, id])
  return rows[0] || null
}

/** This vendor's lines only, with the live stock of each. */
export async function sliceItems(vendorId, id) {
  const { rows } = await query(
    `SELECT ci.product_id, ci.shop_id, ci.product_name, ci.product_thumbnail_url, ci.product_unit,
            ci.quantity, ci.unit_price, ci.list_price, ci.line_total,
            (SELECT sp.stock_quantity FROM shop_products sp
              WHERE sp.shop_id = ci.shop_id AND sp.product_id = ci.product_id AND sp.deleted_at IS NULL LIMIT 1) AS stock
       FROM abandoned_cart_items ci
       JOIN shops s ON s.id = ci.shop_id
      WHERE ci.abandoned_cart_id = $2 AND s.vendor_id = $1
      ORDER BY ci.line_total DESC`, [vendorId, id])
  return rows
}

export async function vendorReminders(vendorId, id) {
  const { rows } = await query(
    `SELECT r.id, r.template_key, r.product_ids, r.created_at, n.title, n.body
       FROM abandoned_cart_vendor_reminders r
       LEFT JOIN notifications n ON n.id = r.notification_id
      WHERE r.abandoned_cart_id = $2 AND r.vendor_id = $1
      ORDER BY r.created_at DESC`, [vendorId, id])
  return rows
}

/** System-level timeline events that are safe to show every vendor (no other vendor's actions). */
export async function publicEvents(id) {
  const { rows } = await query(
    `SELECT event_type, created_at FROM abandoned_cart_events
      WHERE abandoned_cart_id = $1 AND event_type IN ('DETECTED','RECOVERED','CONVERTED','EXPIRED')
      ORDER BY created_at ASC`, [id])
  return rows
}

export async function vendorName(vendorId) {
  const { rows } = await query(`SELECT name FROM vendors WHERE id = $1`, [vendorId])
  return rows[0]?.name || 'the seller'
}

/** Abandoned-cart pushes this customer got in the last 24 h from ANY sender (admin or vendor). */
export async function customerPushesLast24h(userId) {
  const { rows } = await query(
    `SELECT (SELECT COUNT(*) FROM abandoned_cart_notifications acn JOIN abandoned_carts ac ON ac.id = acn.abandoned_cart_id
              WHERE ac.user_id = $1 AND acn.created_at > NOW() - INTERVAL '24 hours')
          + (SELECT COUNT(*) FROM abandoned_cart_vendor_reminders r JOIN abandoned_carts ac ON ac.id = r.abandoned_cart_id
              WHERE ac.user_id = $1 AND r.created_at > NOW() - INTERVAL '24 hours')  AS n`, [userId])
  return Number(rows[0].n)
}
