import { query, getClient } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { NotificationsRepository } from '../notifications/notifications.repository.js'
import { sendPush } from '../../utils/pushNotification.js'
import { BULK_FROM, demandTags, matchInventory, modelKey, parseStorage } from './demand.match.js'

const err = (statusCode, message, code = 'B2B_ERROR', extra = {}) => Object.assign(new Error(message), { statusCode, code, ...extra })
const round2 = (n) => Math.round(Number(n) * 100) / 100
const SELLER_ELIGIBLE = ['ACTIVE', 'VERIFIED']
const COND = ['NEW', 'OPEN_BOX', 'REFURBISHED', 'USED_LIKE_NEW', 'USED_GOOD', 'USED_FAIR']
const DISPLAY_PREFS = ['ANY', 'ORIGINAL', 'GRADE_AB']
const FULFILMENT_PREFS = ['ANY', 'PICKUP', 'DELIVERY']
const PAY_METHODS_VENDOR = ['WALLET']
const OPEN_ORDER_STATUSES = ['PENDING_PAYMENT', 'PAID', 'PACKED', 'DISPATCHED', 'DELIVERED', 'DISPUTED']

const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const priceRange = (r) => {
  const lo = r.target_price != null ? Number(r.target_price) : null
  const hi = r.target_price_max != null ? Number(r.target_price_max) : null
  if (lo != null && hi != null && hi !== lo) return `${inr(lo)}–${inr(hi)}`
  return lo != null ? inr(lo) : hi != null ? inr(hi) : null
}

async function event(client, requirementId, orderId, type, actor, note = null) {
  await client.query(
    `INSERT INTO b2b_events (requirement_id, order_id, type, actor_id, actor_label, note) VALUES ($1,$2,$3,$4,$5,$6)`,
    [requirementId, orderId, type, actor?.userId ?? null, actor?.label ?? null, note])
}

/**
 * In-app notification rows are written inside the caller's transaction; the matching push goes
 * out only after it commits (see `commit`). `push: false` keeps a row in-app only.
 */
async function notifyVendors(client, vendorIds, title, body, data = {}, { push = true } = {}) {
  if (!vendorIds.length) return
  await client.query(
    `INSERT INTO notifications (user_id, title, body, type, data)
     SELECT DISTINCT vu.user_id, $2, $3, 'B2B', $4::jsonb FROM vendor_users vu WHERE vu.vendor_id = ANY($1) AND vu.is_active = true AND vu.deleted_at IS NULL`,
    [vendorIds, title, body, JSON.stringify(data)])
  if (push) (client.__push ||= []).push({ vendorIds, title, body, data })
}

async function pushVendors(items) {
  try {
    const repo = new NotificationsRepository()
    for (const { vendorIds, title, body, data } of items) {
      const { rows } = await query(
        `SELECT DISTINCT user_id FROM vendor_users WHERE vendor_id = ANY($1) AND is_active = true AND deleted_at IS NULL`, [vendorIds])
      for (const { user_id } of rows) {
        for (const t of await repo.getFcmTokens(user_id, 'vendor')) await sendPush(t.token, { title, body, data })
      }
    }
  } catch (e) { logger.warn({ err: e }, 'B2B push failed') } // never fail the business action over a push
}

async function commit(client) {
  await client.query('COMMIT')
  const items = client.__push
  client.__push = null
  if (items?.length) setImmediate(() => { pushVendors(items).catch(() => {}) })
}

export async function commissionFor(sellerVendorId, client = { query }) {
  const o = await client.query(`SELECT b2b_commission_percent FROM vendors WHERE id = $1`, [sellerVendorId])
  if (o.rows[0]?.b2b_commission_percent != null) return Number(o.rows[0].b2b_commission_percent)
  const d = await client.query(`SELECT value FROM app_settings WHERE key = 'b2b_commission_percent'`)
  return d.rows[0] ? Number(d.rows[0].value) : 10
}

async function expireStale() {
  await query(`UPDATE b2b_requirements SET status='EXPIRED', updated_at=NOW() WHERE status='OPEN' AND response_deadline < NOW() AND quantity_awarded = 0`)
  await query(`UPDATE b2b_quotes q SET status='EXPIRED', updated_at=NOW() FROM b2b_requirements r WHERE r.id=q.requirement_id AND r.status='EXPIRED' AND q.status='SUBMITTED'`)
}

// ── Money (vendor settlement ledger = the "Dealker wallet") ──────────────────

const ledgerBalance = async (client, vendorId) =>
  Number((await client.query(`SELECT COALESCE(SUM(amount),0) AS b FROM settlement_ledger WHERE vendor_id=$1`, [vendorId])).rows[0].b)

/** Appends one signed entry to a vendor's ledger (idempotent on `key`). Caller holds the settlement advisory lock. */
async function ledgerEntry(client, vendorId, amount, { reasonCode, reason, referenceId, key, actorId = null }) {
  if (key && (await client.query(`SELECT 1 FROM settlement_ledger WHERE idempotency_key=$1`, [key])).rows[0]) return false
  const balance = round2(await ledgerBalance(client, vendorId) + amount)
  await client.query(
    `INSERT INTO settlement_ledger (vendor_id, entry_type, amount, balance_after, reason, actor_id, idempotency_key, reason_code, reference_type, reference_id)
     VALUES ($1,'ADJUSTMENT',$2,$3,$4,$5,$6,$7,'B2B_ORDER',$8)`,
    [vendorId, amount, balance, reason, actorId, key, reasonCode, referenceId ?? null])
  return true
}

const lockSettlement = (client, vendorId) => client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`settlement:${vendorId}`])

/** Posts commission-split settlement entries into the seller's ledger (idempotent). */
async function postSettlement(client, order, qty) {
  const gross = round2(Number(order.unit_price) * qty)
  const comm = round2(gross * Number(order.commission_percent) / 100)
  await lockSettlement(client, order.seller_vendor_id)
  let balance = await ledgerBalance(client, order.seller_vendor_id)
  for (const [type, amount, key] of [['GROSS_SALES', gross, `b2b:${order.id}:GROSS`], ['COMMISSION', -comm, `b2b:${order.id}:COMM`]]) {
    const dupe = await client.query(`SELECT 1 FROM settlement_ledger WHERE idempotency_key=$1`, [key])
    if (dupe.rows[0] || !amount) continue
    balance = round2(balance + amount)
    await client.query(
      `INSERT INTO settlement_ledger (vendor_id, entry_type, amount, balance_after, reason, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6)`,
      [order.seller_vendor_id, type, amount, balance, `B2B order ${order.order_number}`, key])
  }
  return { gross, comm, payable: round2(gross - comm) }
}

/** Gives money back to the buyer — only when they paid from the wallet (admin-recorded offline payments move no ledger money). */
async function refundBuyer(client, order, units, tag) {
  if (!order.payment_id || !order.buyer_vendor_id) return 0
  const p = (await client.query(`SELECT method FROM b2b_payments WHERE id=$1`, [order.payment_id])).rows[0]
  if (p?.method !== 'WALLET') return 0
  const amount = round2(Number(order.unit_price) * units)
  if (!(amount > 0)) return 0
  await lockSettlement(client, order.buyer_vendor_id)
  await ledgerEntry(client, order.buyer_vendor_id, amount, {
    reasonCode: 'B2B_REFUND', reason: `Refund · ${order.order_number}`, referenceId: order.id, key: `b2b:${order.id}:REFUND:${tag}`,
  })
  return amount
}

async function finishRequirementIfDone(client, requirementId) {
  const r = (await client.query(`SELECT quantity_needed, quantity_awarded, status FROM b2b_requirements WHERE id=$1`, [requirementId])).rows[0]
  const o = (await client.query(`SELECT status FROM b2b_orders WHERE requirement_id=$1 AND status NOT IN ('CANCELLED')`, [requirementId])).rows
  if (r.quantity_awarded >= r.quantity_needed && o.length && o.every((x) => ['COMPLETED', 'REFUNDED'].includes(x.status))) {
    await client.query(`UPDATE b2b_requirements SET status='COMPLETED', updated_at=NOW() WHERE id=$1`, [requirementId])
  }
  const pays = (await client.query(`SELECT payment_status FROM b2b_orders WHERE requirement_id=$1 AND payment_id IS NOT NULL`, [requirementId])).rows
  if (pays.length) {
    const all = pays.every((p) => p.payment_status !== 'ESCROW_HELD')
    const some = pays.some((p) => p.payment_status === 'RELEASED')
    await client.query(
      `UPDATE b2b_payments SET status=$2 WHERE requirement_id=$1`,
      [requirementId, all ? (pays.every((p) => p.payment_status === 'REFUNDED') ? 'REFUNDED' : 'RELEASED') : some ? 'PARTIALLY_RELEASED' : 'HELD'])
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

// "iPhone 13" must not borrow the photo of an "iPhone 13 Pro": variant words have to agree both ways.
const VARIANT_SQL = ['pro', 'max', 'plus', 'mini', 'ultra', 'fe', 'lite', 'se']
  .map((w) => `((' ' || r.model_key || ' ') LIKE '% ${w} %') = ((' ' || btrim(regexp_replace(lower(p.name), '[^a-z0-9]+', ' ', 'g')) || ' ') LIKE '% ${w} %')`).join(' AND ')

const REQ_CARD = (extraSelect = '', extraJoin = '') => `
  SELECT r.*, COALESCE(bv.name, 'Dealker') AS buyer_name, th.thumbnail_url, c.name AS category_name,
         (SELECT COUNT(*)::int FROM b2b_quotes q WHERE q.requirement_id = r.id AND q.status <> 'WITHDRAWN') AS quote_count,
         (SELECT MIN(q.unit_price) FROM b2b_quotes q WHERE q.requirement_id = r.id AND q.status NOT IN ('WITHDRAWN','EXPIRED')) AS best_price,
         (SELECT COALESCE(SUM(q.quantity_offered),0)::int FROM b2b_quotes q WHERE q.requirement_id = r.id AND q.status NOT IN ('WITHDRAWN','EXPIRED')) AS quantity_offered_total
         ${extraSelect}
    FROM b2b_requirements r
    LEFT JOIN vendors bv ON bv.id = r.buyer_vendor_id
    LEFT JOIN categories c ON c.id = r.category_id
    LEFT JOIN LATERAL (
      SELECT p.thumbnail_url FROM products p
       WHERE p.deleted_at IS NULL AND p.thumbnail_url IS NOT NULL AND COALESCE(r.model_key, '') <> ''
         AND (' ' || btrim(regexp_replace(lower(p.name), '[^a-z0-9]+', ' ', 'g')) || ' ') LIKE '% ' || r.model_key || ' %'
         AND ${VARIANT_SQL}
       ORDER BY p.created_at DESC LIMIT 1) th ON true
    ${extraJoin}`

const num = (r) => ({
  ...r,
  target_price: r.target_price != null ? Number(r.target_price) : null,
  target_price_max: r.target_price_max != null ? Number(r.target_price_max) : null,
  best_price: r.best_price != null ? Number(r.best_price) : null,
  tags: demandTags(r),
})

/** The vendor's sellable stock — what a requirement is matched against. */
async function inventoryFor(vendorId, client = { query }) {
  const { rows } = await client.query(
    `SELECT sp.id, p.name, p.brand, p.condition, p.battery_health, p.specifications->>'storage' AS storage, p.thumbnail_url,
            sp.stock_quantity AS stock, COALESCE(sp.sale_price, sp.price) AS price, sp.wholesale_price, sp.sell_b2b, sp.min_order_qty
       FROM shop_products sp JOIN products p ON p.id = sp.product_id
      WHERE p.owner_vendor_id = $1 AND sp.deleted_at IS NULL AND p.deleted_at IS NULL
        AND sp.approval_status = 'APPROVED' AND sp.listing_status = 'ACTIVE' AND sp.stock_quantity > 0
      ORDER BY sp.created_at DESC LIMIT 500`, [vendorId])
  return rows.map((l) => ({
    ...l, stock: Number(l.stock), price: Number(l.price), min_order_qty: Number(l.min_order_qty || 1),
    wholesale_price: l.wholesale_price != null ? Number(l.wholesale_price) : null,
    battery_health: l.battery_health != null ? Number(l.battery_health) : null,
  }))
}

const suggestedUnitPrice = (l) => (l.sell_b2b && l.wholesale_price ? l.wholesale_price : l.price)

function offerState(q) {
  if (!q) return null
  if (q.status === 'SELECTED') return 'ACCEPTED'
  if (q.status === 'PARTIALLY_SELECTED') return 'PARTIAL'
  if (q.status === 'SUBMITTED') return q.buyer_viewed_at ? 'VIEWED' : 'PENDING'
  return q.status // NOT_SELECTED | WITHDRAWN | EXPIRED
}

const OFFER_TABS = {
  pending: `q.status = 'SUBMITTED' AND r.status = 'OPEN'`,
  active: `((q.status = 'SUBMITTED' AND r.status = 'OPEN') OR (q.status IN ('SELECTED','PARTIALLY_SELECTED') AND r.status NOT IN ('COMPLETED','CANCELLED')))`,
  closed: `NOT ((q.status = 'SUBMITTED' AND r.status = 'OPEN') OR (q.status IN ('SELECTED','PARTIALLY_SELECTED') AND r.status NOT IN ('COMPLETED','CANCELLED')))`,
}

const OPEN_FOR_ME = `r.status = 'OPEN' AND r.response_deadline > NOW() AND r.buyer_vendor_id IS DISTINCT FROM $1 AND r.quantity_awarded < r.quantity_needed`

export const b2b = {
  COND,
  DISPLAY_PREFS,
  FULFILMENT_PREFS,

  // ── Requirements ─────────────────────────────────────────────────────
  async createRequirement(input, actor) {
    const e = []
    if (!input.productName?.trim()) e.push('Product name is required')
    if (!(Number(input.quantity) > 0)) e.push('Quantity must be at least 1')
    if (!input.responseDeadline || new Date(input.responseDeadline) <= new Date()) e.push('Quote deadline must be in the future')
    const lo = input.targetPrice != null ? Number(input.targetPrice) : null
    const hi = input.targetPriceMax != null ? Number(input.targetPriceMax) : null
    if (lo != null && !(lo >= 0)) e.push('Target price must be 0 or more')
    if (hi != null && !(hi > 0)) e.push('Maximum price must be greater than 0')
    if (lo != null && hi != null && hi < lo) e.push('Maximum price cannot be lower than the target price')
    if (input.minBatteryHealth != null && !(Number(input.minBatteryHealth) >= 1 && Number(input.minBatteryHealth) <= 100)) e.push('Battery health must be between 1 and 100')
    if (input.displayPref && !DISPLAY_PREFS.includes(input.displayPref)) e.push('Invalid display preference')
    if (input.fulfilmentPref && !FULFILMENT_PREFS.includes(input.fulfilmentPref)) e.push('Invalid pickup/delivery preference')
    if (input.requiredBy && new Date(input.requiredBy) < new Date(new Date().toDateString())) e.push('Needed-by date cannot be in the past')
    if (e.length) throw err(400, e.join('. '), 'VALIDATION_ERROR')
    if (actor.vendorId) {
      const v = (await query(`SELECT status FROM vendors WHERE id=$1`, [actor.vendorId])).rows[0]
      if (!v || !SELLER_ELIGIBLE.includes(v.status)) throw err(403, 'Your vendor account must be verified to post requirements', 'VENDOR_NOT_ELIGIBLE')
    }
    const productName = input.productName.trim()
    const storage = input.storage?.trim() ? input.storage.trim().toUpperCase().replace(/\s+/g, '') : parseStorage(productName)
    const key = modelKey(productName, input.brand)
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const n = (await client.query(`SELECT nextval('b2b_requirement_seq') n`)).rows[0].n
      const { rows } = await client.query(
        `INSERT INTO b2b_requirements (requirement_number, buyer_vendor_id, posted_by_type, created_by, title, product_name, brand, category_id, condition_pref,
           quantity_needed, target_price, description, delivery_city, delivery_pincode, response_deadline, required_by,
           model_key, storage, target_price_max, min_battery_health, display_pref, fulfilment_pref, is_urgent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
        [`B2B-${n}`, actor.vendorId ?? null, actor.vendorId && !actor.isAdmin ? 'VENDOR' : actor.isAdmin && !actor.vendorId ? 'ADMIN' : 'VENDOR', actor.userId ?? null,
          input.title?.trim() || `${input.quantity} × ${productName}`, productName, input.brand || null, input.categoryId || null,
          input.conditionPref || 'ANY', Number(input.quantity), lo, input.description || null, input.deliveryCity || null,
          input.deliveryPincode || null, input.responseDeadline, input.requiredBy || null,
          key, storage, hi, input.minBatteryHealth != null ? Number(input.minBatteryHealth) : null, input.displayPref || 'ANY', input.fulfilmentPref || 'ANY', input.isUrgent === true])
      const req = rows[0]
      await event(client, req.id, null, 'POSTED', actor, `${req.quantity_needed} × ${req.product_name}`)

      // Everyone eligible hears about it; vendors holding matching stock get a personal "you can supply this" alert.
      const vendors = (await client.query(`SELECT id FROM vendors WHERE status = ANY($1) AND id IS DISTINCT FROM $2`, [SELLER_ELIGIBLE, actor.vendorId ?? null])).rows.map((v) => v.id)
      const matches = await matchedVendors(client, req, vendors)
      const tags = demandTags(req)
      const range = priceRange(req)
      const data = { requirementId: req.id, kind: 'B2B_REQUIREMENT' }
      const generic = vendors.filter((v) => !matches.has(v))
      await notifyVendors(client, generic, tags.includes('URGENT') ? 'Urgent buying requirement' : 'New buying requirement',
        `${req.quantity_needed} × ${req.product_name}${range ? ` · ${range}` : ''} — send your offer`, data, { push: tags.includes('URGENT') })
      for (const [vendorId, m] of matches) {
        await notifyVendors(client, [vendorId], `Match found: you have ${m.stock} × ${req.product_name}`,
          `A buyer needs ${req.quantity_needed}${range ? ` at ${range}` : ''}. Send your offer now.`, { ...data, match: true, matchStock: m.stock })
      }
      await commit(client)
      return req
    } catch (x) { await client.query('ROLLBACK').catch(() => {}); throw x } finally { client.release() }
  },

  // ── Wholesale shelf: other vendors' B2B listings, bought directly ────────
  /** Browse verified vendors' wholesale listings (never the caller's own). */
  async wholesaleList(vendorId, { search, brand, condition, sort = 'newest', page = 1, limit = 20 } = {}) {
    const params = [vendorId, SELLER_ELIGIBLE]
    const where = [`sp.sell_b2b = TRUE`, `sp.wholesale_price > 0`, `sp.deleted_at IS NULL`, `p.deleted_at IS NULL`, `sp.approval_status = 'APPROVED'`,
      `sp.listing_status = 'ACTIVE'`, `sp.stock_quantity >= GREATEST(sp.min_order_qty, 1)`, `p.owner_vendor_id IS NOT NULL`, `p.owner_vendor_id <> $1`, `v.status = ANY($2)`, `v.is_active = TRUE`]
    const p_ = (x) => { params.push(x); return `$${params.length}` }
    if (search) { const s = p_(`%${String(search).slice(0, 80)}%`); where.push(`(p.name ILIKE ${s} OR p.brand ILIKE ${s})`) }
    // Facets (brands / conditions on offer) are counted before the brand + condition filters, so the pickers keep every option.
    const facetWhere = where.join(' AND '); const facetParams = [...params]
    if (brand) where.push(`lower(p.brand) = lower(${p_(String(brand).slice(0, 60))})`)
    if (condition && COND.includes(condition)) where.push(`p.condition = ${p_(condition)}`)
    const order = { price_low: 'sp.wholesale_price ASC', price_high: 'sp.wholesale_price DESC', stock: 'sp.stock_quantity DESC' }[sort] || 'sp.created_at DESC'
    const lim = Math.min(50, Math.max(1, Number(limit) || 20)); const off = (Math.max(1, Number(page) || 1) - 1) * lim
    const base = `FROM shop_products sp JOIN products p ON p.id = sp.product_id JOIN vendors v ON v.id = p.owner_vendor_id
                  LEFT JOIN vendor_profiles vp ON vp.vendor_id = v.id WHERE ${where.join(' AND ')}`
    const facetBase = `FROM shop_products sp JOIN products p ON p.id = sp.product_id JOIN vendors v ON v.id = p.owner_vendor_id WHERE ${facetWhere}`
    const [{ rows }, { rows: cnt }, { rows: fb }, { rows: fc }] = await Promise.all([
      query(`SELECT sp.id, p.name, p.brand, p.condition, p.thumbnail_url, p.specifications->>'storage' AS storage, p.battery_health,
                    sp.wholesale_price, sp.min_order_qty AS moq, sp.stock_quantity AS stock, sp.b2b_discount_pct, sp.price AS retail_price,
                    v.id AS seller_id, v.name AS seller_name, vp.city AS seller_city, v.avg_rating AS seller_rating
               ${base} ORDER BY ${order} LIMIT ${lim} OFFSET ${off}`, params),
      query(`SELECT COUNT(*)::int AS n ${base}`, params),
      query(`SELECT p.brand AS value, COUNT(*)::int AS n ${facetBase} AND p.brand IS NOT NULL AND p.brand <> '' GROUP BY p.brand ORDER BY n DESC, p.brand LIMIT 40`, facetParams),
      query(`SELECT p.condition AS value, COUNT(*)::int AS n ${facetBase} AND p.condition IS NOT NULL GROUP BY p.condition ORDER BY n DESC`, facetParams),
    ])
    return {
      facets: { brands: fb.map((r) => ({ value: r.value, count: r.n })), conditions: fc.map((r) => ({ value: r.value, count: r.n })) },
      data: rows.map((r) => ({
        id: r.id, name: r.name, brand: r.brand, condition: r.condition, thumbnail_url: r.thumbnail_url, storage: r.storage,
        battery_health: r.battery_health != null ? Number(r.battery_health) : null, wholesale_price: Number(r.wholesale_price),
        retail_price: r.retail_price != null ? Number(r.retail_price) : null, moq: Number(r.moq || 1), stock: Number(r.stock),
        discount_pct: r.b2b_discount_pct != null ? Number(r.b2b_discount_pct) : null,
        seller: { id: r.seller_id, name: r.seller_name, city: r.seller_city || null, rating: r.seller_rating != null ? Number(r.seller_rating) : null },
      })),
      pagination: { page: Number(page) || 1, limit: lim, total: cnt[0].n },
    }
  },

  async wholesaleDetail(vendorId, listingId) {
    const { rows } = await query(
      `SELECT sp.id, p.name, p.brand, p.condition, p.condition_notes, p.description, p.thumbnail_url, p.images, p.specifications, p.warranty_info, p.battery_health,
              sp.wholesale_price, sp.min_order_qty AS moq, sp.stock_quantity AS stock, sp.b2b_discount_pct, sp.b2b_notes, sp.handling_time_days,
              v.id AS seller_id, v.name AS seller_name, vp.city AS seller_city, vp.state AS seller_state, v.avg_rating AS seller_rating, v.review_count AS seller_reviews
         FROM shop_products sp JOIN products p ON p.id = sp.product_id JOIN vendors v ON v.id = p.owner_vendor_id LEFT JOIN vendor_profiles vp ON vp.vendor_id = v.id
        WHERE sp.id = $1 AND sp.sell_b2b = TRUE AND sp.wholesale_price > 0 AND sp.deleted_at IS NULL AND p.deleted_at IS NULL AND sp.approval_status = 'APPROVED'
          AND sp.listing_status = 'ACTIVE' AND p.owner_vendor_id IS NOT NULL AND p.owner_vendor_id <> $2 AND v.status = ANY($3)`, [listingId, vendorId, SELLER_ELIGIBLE])
    const r = rows[0]
    if (!r) throw err(404, 'This listing is not available', 'NOT_FOUND')
    return {
      id: r.id, name: r.name, brand: r.brand, condition: r.condition, condition_notes: r.condition_notes, description: r.description, thumbnail_url: r.thumbnail_url,
      images: Array.isArray(r.images) ? r.images : [], specifications: r.specifications || {}, warranty_info: r.warranty_info, battery_health: r.battery_health != null ? Number(r.battery_health) : null,
      wholesale_price: Number(r.wholesale_price), moq: Number(r.moq || 1), stock: Number(r.stock), discount_pct: r.b2b_discount_pct != null ? Number(r.b2b_discount_pct) : null,
      notes: r.b2b_notes, handling_days: r.handling_time_days,
      seller: { id: r.seller_id, name: r.seller_name, city: r.seller_city, state: r.seller_state, rating: r.seller_rating != null ? Number(r.seller_rating) : null, reviews: Number(r.seller_reviews || 0) },
    }
  },

  /**
   * Buy a wholesale listing at its listed price. Runs the normal demand flow privately (one requirement, one quote at the
   * listed price, awarded at once) so escrow, dispatch, receipt, disputes and commission all work unchanged. The buyer then
   * pays from the Dealker wallet via `/requirements/:id/pay`. Nothing is broadcast to other vendors.
   */
  async wholesaleBuy(listingId, quantity, actor) {
    const qty = Number(quantity)
    if (!Number.isInteger(qty) || qty < 1) throw err(400, 'Enter a whole number of units', 'VALIDATION_ERROR')
    const buyer = (await query(`SELECT status FROM vendors WHERE id=$1`, [actor.vendorId])).rows[0]
    if (!buyer || !SELLER_ELIGIBLE.includes(buyer.status)) throw err(403, 'Your vendor account must be verified to buy', 'VENDOR_NOT_ELIGIBLE')
    const l = await this.wholesaleDetail(actor.vendorId, listingId)
    if (qty < l.moq) throw err(400, `Minimum order is ${l.moq} units`, 'BELOW_MOQ')
    if (qty > l.stock) throw err(409, `Only ${l.stock} units are in stock`, 'OUT_OF_STOCK')
    const client = await getClient()
    let reqId; let quoteId
    try {
      await client.query('BEGIN')
      const n = (await client.query(`SELECT nextval('b2b_requirement_seq') n`)).rows[0].n
      const name = l.name
      const { rows } = await client.query(
        `INSERT INTO b2b_requirements (requirement_number, buyer_vendor_id, posted_by_type, created_by, title, product_name, brand, condition_pref, quantity_needed, target_price,
           description, response_deadline, model_key, storage, display_pref, fulfilment_pref, is_urgent)
         VALUES ($1,$2,'VENDOR',$3,$4,$5,$6,'ANY',$7,$8,$9, NOW() + INTERVAL '1 hour', $10, $11, 'ANY','ANY', FALSE) RETURNING id`,
        [`B2B-${n}`, actor.vendorId, actor.userId ?? null, `${qty} × ${name} (wholesale shelf)`, name, l.brand || null, qty, l.wholesale_price,
          `Bought directly from ${l.seller.name}'s wholesale listing`, modelKey(name, l.brand), parseStorage(name)])
      reqId = rows[0].id
      const q = await client.query(
        `INSERT INTO b2b_quotes (requirement_id, seller_vendor_id, quantity_offered, unit_price, condition, delivery_days, note, photos, listing_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'[]'::jsonb,$8) RETURNING id`,
        [reqId, l.seller.id, qty, l.wholesale_price, l.condition || 'NEW', l.handling_days ?? 3, 'Listed wholesale price', listingId])
      quoteId = q.rows[0].id
      await event(client, reqId, null, 'POSTED', actor, `Wholesale shelf: ${qty} × ${name}`)
      await client.query('COMMIT')
    } catch (x) { await client.query('ROLLBACK').catch(() => {}); throw x } finally { client.release() }
    const orders = await this.award(reqId, [{ quoteId, quantity: qty }], actor)
    const o = orders[0]
    return { requirement_id: reqId, order_id: o.id, order_number: o.order_number, quantity: qty, unit_price: l.wholesale_price, total: Number(o.subtotal), seller: l.seller.name }
  },

  /**
   * Vendor lists. scope: open (others' demand, default) · new (unseen) · matched (I hold the stock) ·
   * mine (I posted) · quoted (my offers; `tab` = active | pending | closed).
   */
  async listForVendor(vendorId, { scope = 'open', tab, page = 1, limit = 20, search } = {}) {
    await expireStale()
    const params = [vendorId]
    const where = []
    const view = `LEFT JOIN b2b_requirement_views v ON v.requirement_id = r.id AND v.vendor_id = $1`
    const myQuote = `LEFT JOIN b2b_quotes q ON q.requirement_id = r.id AND q.seller_vendor_id = $1`
    if (scope === 'mine') where.push(`r.buyer_vendor_id = $1`)
    else if (scope === 'quoted') {
      where.push(`q.id IS NOT NULL`)
      if (OFFER_TABS[tab]) where.push(OFFER_TABS[tab])
    } else {
      where.push(OPEN_FOR_ME, `v.dismissed_at IS NULL`)
      if (scope === 'new') where.push(`v.first_seen_at IS NULL`, `q.id IS NULL`)
    }
    if (search) { params.push(`%${search}%`); where.push(`(r.product_name ILIKE $${params.length} OR r.title ILIKE $${params.length})`) }
    const w = `WHERE ${where.join(' AND ')}`
    const extra = `, (v.first_seen_at IS NOT NULL) AS viewed, v.dismissed_at,
      (SELECT row_to_json(mq) FROM (SELECT id, quantity_offered, unit_price, status, quantity_awarded, buyer_viewed_at, condition, delivery_days, note, updated_at
                                      FROM b2b_quotes WHERE requirement_id = r.id AND seller_vendor_id = $1) mq) AS my_quote,
      (SELECT COALESCE(json_agg(json_build_object('id', o.id, 'order_number', o.order_number, 'status', o.status, 'quantity', o.quantity, 'payment_status', o.payment_status)
                                ORDER BY o.created_at), '[]'::json)
         FROM b2b_orders o WHERE o.requirement_id = r.id AND o.seller_vendor_id = $1 AND o.status <> 'CANCELLED') AS my_orders`
    const base = `${REQ_CARD(extra, `${view} ${myQuote}`)} ${w}`
    const lim = Math.min(50, Number(limit) || 20)
    const pg = Math.max(1, Number(page))
    const mapRow = (r, inv) => {
      const out = num(r)
      out.offer_state = offerState(r.my_quote)
      if (inv) {
        const m = matchInventory(r, inv)
        out.my_match = { level: m.level, stock: m.stock, listing_id: m.listings[0]?.id ?? null }
      }
      // Offers are sealed: other vendors never see competing prices or counts.
      if (r.buyer_vendor_id !== vendorId) { delete out.best_price; delete out.quantity_offered_total; delete out.quote_count }
      return out
    }

    if (scope === 'matched') {
      const inv = await inventoryFor(vendorId)
      const { rows } = await query(`${base} ORDER BY r.created_at DESC LIMIT 300`, params)
      const hits = rows.map((r) => mapRow(r, inv)).filter((r) => r.my_match?.level === 'EXACT' && !r.my_quote)
      return { data: hits.slice((pg - 1) * lim, pg * lim), pagination: { page: pg, limit: lim, total: hits.length } }
    }
    const cnt = await query(`SELECT COUNT(*)::int n FROM b2b_requirements r ${view} ${myQuote} ${w}`, params)
    const { rows } = await query(`${base} ORDER BY ${scope === 'quoted' ? 'q.updated_at' : 'r.created_at'} DESC LIMIT ${lim} OFFSET ${(pg - 1) * lim}`, params)
    const inv = scope === 'mine' ? null : await inventoryFor(vendorId)
    return { data: rows.map((r) => mapRow(r, inv)), pagination: { page: pg, limit: lim, total: cnt.rows[0].n } }
  },

  /** Counts that drive the hub tabs, the home banner and "needs your action". */
  async demandSummary(vendorId) {
    await expireStale()
    const inv = await inventoryFor(vendorId)
    const open = (await query(
      `SELECT r.id, r.product_name, r.brand, r.model_key, r.storage, r.condition_pref, r.min_battery_health, r.is_urgent, r.required_by, r.quantity_needed,
              (v.first_seen_at IS NOT NULL) AS viewed, (q.id IS NOT NULL) AS quoted
         FROM b2b_requirements r
         LEFT JOIN b2b_requirement_views v ON v.requirement_id = r.id AND v.vendor_id = $1
         LEFT JOIN b2b_quotes q ON q.requirement_id = r.id AND q.seller_vendor_id = $1
        WHERE ${OPEN_FOR_ME} AND v.dismissed_at IS NULL ORDER BY r.created_at DESC LIMIT 300`, [vendorId])).rows
    let fresh = 0; let matched = 0; let urgent = 0
    for (const r of open) {
      if (!r.viewed && !r.quoted) fresh++
      if (demandTags(r).includes('URGENT')) urgent++
      if (!r.quoted && matchInventory(r, inv).level === 'EXACT') matched++
    }
    const offers = (await query(
      `SELECT COUNT(*) FILTER (WHERE ${OFFER_TABS.active})::int AS active, COUNT(*) FILTER (WHERE ${OFFER_TABS.pending})::int AS pending,
              COUNT(*) FILTER (WHERE ${OFFER_TABS.closed})::int AS closed,
              COUNT(*) FILTER (WHERE q.status IN ('SELECTED','PARTIALLY_SELECTED') AND r.status NOT IN ('COMPLETED','CANCELLED'))::int AS accepted
         FROM b2b_quotes q JOIN b2b_requirements r ON r.id = q.requirement_id WHERE q.seller_vendor_id = $1`, [vendorId])).rows[0]
    const mine = (await query(
      `SELECT COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open, COUNT(*)::int AS total,
              COALESCE(SUM((SELECT COUNT(*) FROM b2b_quotes q WHERE q.requirement_id = r.id AND q.status = 'SUBMITTED' AND r.status = 'OPEN')), 0)::int AS offers_waiting
         FROM b2b_requirements r WHERE buyer_vendor_id = $1`, [vendorId])).rows[0]
    const orders = (await query(
      `SELECT COUNT(*) FILTER (WHERE buyer_vendor_id = $1 AND status = 'PENDING_PAYMENT')::int AS to_pay,
              COUNT(*) FILTER (WHERE buyer_vendor_id = $1 AND status IN ('DISPATCHED','DELIVERED'))::int AS to_receive,
              COUNT(*) FILTER (WHERE buyer_vendor_id = $1 AND status = ANY($2))::int AS buying_active,
              COUNT(*) FILTER (WHERE seller_vendor_id = $1 AND status IN ('PAID','PACKED'))::int AS to_dispatch,
              COUNT(*) FILTER (WHERE seller_vendor_id = $1 AND status = ANY($2))::int AS selling_active
         FROM b2b_orders`, [vendorId, OPEN_ORDER_STATUSES])).rows[0]
    return { open: open.length, new: fresh, matched, urgent, offers, mine, orders }
  },

  /** Screen "Match Found": which of my listings fit this requirement, what I can supply and what I'd earn. */
  async matchFor(requirementId, vendorId) {
    const r = (await query(`${REQ_CARD()} WHERE r.id = $1`, [requirementId])).rows[0]
    if (!r) throw err(404, 'Requirement not found', 'NOT_FOUND')
    const inv = await inventoryFor(vendorId)
    const m = matchInventory(r, inv)
    const exact = m.listings.filter((l) => l.level === 'EXACT')
    const lead = exact[0] || m.listings[0] || null
    const my = (await query(
      `SELECT id, quantity_offered, unit_price, status, quantity_awarded, condition, delivery_days, note, buyer_viewed_at, listing_id
         FROM b2b_quotes WHERE requirement_id=$1 AND seller_vendor_id=$2`, [requirementId, vendorId])).rows[0] || null
    const remaining = Math.max(0, r.quantity_needed - r.quantity_awarded)
    return {
      level: m.level,
      totalStock: m.stock,
      canSupply: Math.min(m.stock, remaining),
      remaining,
      listings: m.listings.slice(0, 10).map((l) => ({
        id: l.id, name: l.name, brand: l.brand, condition: l.condition, battery_health: l.battery_health, storage: l.storage ?? parseStorage(l.name),
        stock: l.stock, price: l.price, wholesale_price: l.wholesale_price, sell_b2b: l.sell_b2b, min_order_qty: l.min_order_qty,
        thumbnail_url: l.thumbnail_url, level: l.level, reasons: l.reasons, suggested_price: suggestedUnitPrice(l),
      })),
      suggested: lead ? { listingId: lead.id, unitPrice: suggestedUnitPrice(lead), quantity: Math.min(lead.stock, remaining), condition: lead.condition } : null,
      commissionPercent: await commissionFor(vendorId),
      myQuote: my ? { ...my, unit_price: Number(my.unit_price), offer_state: offerState(my) } : null,
    }
  },

  /** "Not interested" — hides the requirement from this vendor's lists (the buyer never sees who passed). */
  async dismiss(requirementId, vendorId) {
    const r = (await query(`SELECT 1 FROM b2b_requirements WHERE id=$1`, [requirementId])).rows[0]
    if (!r) throw err(404, 'Requirement not found', 'NOT_FOUND')
    await query(
      `INSERT INTO b2b_requirement_views (requirement_id, vendor_id, dismissed_at) VALUES ($1,$2,NOW())
       ON CONFLICT (requirement_id, vendor_id) DO UPDATE SET dismissed_at = NOW()`, [requirementId, vendorId])
  },

  async detail(id, viewer) {
    await expireStale()
    const { rows } = await query(`${REQ_CARD()} WHERE r.id = $1`, [id])
    const r = rows[0]
    if (!r) throw err(404, 'Requirement not found', 'NOT_FOUND')
    const isAdmin = viewer.isAdmin
    const isBuyer = !isAdmin && viewer.vendorId && r.buyer_vendor_id === viewer.vendorId
    if (!isAdmin && !isBuyer && !viewer.vendorId) throw err(403, 'Forbidden', 'FORBIDDEN')
    const full = isAdmin || isBuyer
    if (!isAdmin && !isBuyer) {
      await query(
        `INSERT INTO b2b_requirement_views (requirement_id, vendor_id) VALUES ($1,$2)
         ON CONFLICT (requirement_id, vendor_id) DO UPDATE SET last_seen_at = NOW(), views = b2b_requirement_views.views + 1`, [id, viewer.vendorId])
    }
    if (isBuyer) await query(`UPDATE b2b_quotes SET buyer_viewed_at = NOW() WHERE requirement_id = $1 AND buyer_viewed_at IS NULL AND status <> 'WITHDRAWN'`, [id])
    const qrows = (await query(
      `SELECT q.*, v.name AS seller_name, s.seller_rating, s.city AS seller_city,
              (SELECT COUNT(*)::int FROM b2b_orders o WHERE o.seller_vendor_id = q.seller_vendor_id AND o.status = 'COMPLETED') AS seller_completed_orders
         FROM b2b_quotes q JOIN vendors v ON v.id=q.seller_vendor_id
         LEFT JOIN LATERAL (SELECT seller_rating, city FROM shops WHERE vendor_id = v.id ORDER BY created_at LIMIT 1) s ON true
        WHERE q.requirement_id=$1 ${full ? '' : 'AND q.seller_vendor_id=$2'} ORDER BY q.unit_price ASC, q.created_at`, full ? [id] : [id, viewer.vendorId])).rows
    const orows = (await query(
      `SELECT o.*, sv.name AS seller_name, COALESCE(bv.name,'Dealker') AS buyer_name FROM b2b_orders o JOIN vendors sv ON sv.id=o.seller_vendor_id LEFT JOIN vendors bv ON bv.id=o.buyer_vendor_id
        WHERE o.requirement_id=$1 ${full ? '' : 'AND o.seller_vendor_id=$2'} ORDER BY o.created_at`, full ? [id] : [id, viewer.vendorId])).rows
    const events = full ? (await query(`SELECT type, actor_label, note, order_id, created_at FROM b2b_events WHERE requirement_id=$1 ORDER BY created_at`, [id])).rows : []
    const payment = full ? (await query(`SELECT * FROM b2b_payments WHERE requirement_id=$1 ORDER BY created_at DESC LIMIT 1`, [id])).rows[0] ?? null : null
    const out = num(r)
    if (isAdmin) out.views = (await query(`SELECT COALESCE(SUM(views),0)::int v, COUNT(*)::int vendors FROM b2b_requirement_views WHERE requirement_id=$1`, [id])).rows[0]
    if (!full) { delete out.best_price; delete out.quantity_offered_total; delete out.quote_count }
    const toNum = (o) => ({ ...o, unit_price: Number(o.unit_price), subtotal: o.subtotal != null ? Number(o.subtotal) : undefined, commission_amount: o.commission_amount != null ? Number(o.commission_amount) : undefined,
      seller_payable: o.seller_payable != null ? Number(o.seller_payable) : undefined, commission_percent: o.commission_percent != null ? Number(o.commission_percent) : undefined, released_amount: o.released_amount != null ? Number(o.released_amount) : null })
    const mine = viewer.vendorId && !isBuyer && !isAdmin ? qrows.find((q) => q.seller_vendor_id === viewer.vendorId) : null
    return {
      requirement: out, quotes: qrows.map((q) => ({ ...toNum(q), offer_state: offerState(q) })), orders: orows.map(toNum), events,
      payment: payment ? { ...payment, amount: Number(payment.amount) } : null,
      viewer: { isBuyer: Boolean(isBuyer), isAdmin, myQuoteId: mine?.id ?? null },
    }
  },

  async cancelRequirement(id, actor, reason) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const r = (await client.query(`SELECT * FROM b2b_requirements WHERE id=$1 FOR UPDATE`, [id])).rows[0]
      if (!r) throw err(404, 'Requirement not found', 'NOT_FOUND')
      if (!actor.isAdmin && r.buyer_vendor_id !== actor.vendorId) throw err(403, 'Only the buyer can cancel', 'FORBIDDEN')
      if (['COMPLETED', 'CANCELLED'].includes(r.status)) throw err(409, `Requirement is already ${r.status.toLowerCase()}`)
      const paid = await client.query(`SELECT 1 FROM b2b_orders WHERE requirement_id=$1 AND status NOT IN ('PENDING_PAYMENT','CANCELLED') LIMIT 1`, [id])
      if (paid.rows[0]) throw err(409, 'Some orders are already paid — resolve them before cancelling', 'HAS_PAID_ORDERS')
      await client.query(`UPDATE b2b_orders SET status='CANCELLED', updated_at=NOW() WHERE requirement_id=$1 AND status='PENDING_PAYMENT'`, [id])
      await client.query(`UPDATE b2b_quotes SET status='NOT_SELECTED', updated_at=NOW() WHERE requirement_id=$1 AND status IN ('SUBMITTED','SELECTED','PARTIALLY_SELECTED')`, [id])
      await client.query(`UPDATE b2b_requirements SET status='CANCELLED', cancel_reason=$2, updated_at=NOW() WHERE id=$1`, [id, reason || null])
      await event(client, id, null, 'CANCELLED', actor, reason)
      await commit(client)
    } catch (x) { await client.query('ROLLBACK').catch(() => {}); throw x } finally { client.release() }
  },

  // ── Quotes (sellers) ─────────────────────────────────────────────────
  async upsertQuote(requirementId, vendorId, input, actor) {
    const v = (await query(`SELECT status, name FROM vendors WHERE id=$1`, [vendorId])).rows[0]
    if (!v || !SELLER_ELIGIBLE.includes(v.status)) throw err(403, 'Only verified vendors can send quotes', 'VENDOR_NOT_ELIGIBLE')
    const r = (await query(`SELECT * FROM b2b_requirements WHERE id=$1`, [requirementId])).rows[0]
    if (!r) throw err(404, 'Requirement not found', 'NOT_FOUND')
    if (r.buyer_vendor_id === vendorId) throw err(400, 'You cannot quote on your own requirement', 'OWN_REQUIREMENT')
    if (r.status !== 'OPEN' || new Date(r.response_deadline) <= new Date()) throw err(409, 'This requirement is no longer accepting quotes', 'CLOSED')
    const qty = Number(input.quantity); const price = Number(input.unitPrice)
    if (!(qty > 0) || !(price > 0)) throw err(400, 'Quantity and price must be greater than 0', 'VALIDATION_ERROR')
    if (qty > r.quantity_needed - r.quantity_awarded) throw err(400, `You can offer at most ${r.quantity_needed - r.quantity_awarded} units`, 'VALIDATION_ERROR')
    if (input.condition && !COND.includes(input.condition)) throw err(400, 'Invalid condition', 'VALIDATION_ERROR')
    if (input.listingId) {
      const own = await query(`SELECT 1 FROM shop_products sp JOIN products p ON p.id = sp.product_id WHERE sp.id = $1 AND p.owner_vendor_id = $2 AND sp.deleted_at IS NULL`, [input.listingId, vendorId])
      if (!own.rows[0]) throw err(400, 'That listing is not yours', 'VALIDATION_ERROR')
    }
    const cur = (await query(`SELECT * FROM b2b_quotes WHERE requirement_id=$1 AND seller_vendor_id=$2`, [requirementId, vendorId])).rows[0]
    if (cur && cur.quantity_awarded > 0) throw err(409, 'This quote has already been selected and cannot be changed', 'LOCKED')
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `INSERT INTO b2b_quotes (requirement_id, seller_vendor_id, quantity_offered, unit_price, condition, delivery_days, note, photos, listing_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (requirement_id, seller_vendor_id) DO UPDATE SET quantity_offered=EXCLUDED.quantity_offered, unit_price=EXCLUDED.unit_price, condition=EXCLUDED.condition,
           delivery_days=EXCLUDED.delivery_days, note=EXCLUDED.note, photos=EXCLUDED.photos, listing_id=COALESCE(EXCLUDED.listing_id, b2b_quotes.listing_id),
           status='SUBMITTED', buyer_viewed_at = CASE WHEN b2b_quotes.unit_price IS DISTINCT FROM EXCLUDED.unit_price OR b2b_quotes.quantity_offered IS DISTINCT FROM EXCLUDED.quantity_offered THEN NULL ELSE b2b_quotes.buyer_viewed_at END,
           updated_at=NOW() RETURNING *`,
        [requirementId, vendorId, qty, price, input.condition || 'NEW', input.deliveryDays ?? 3, input.note || null, JSON.stringify(input.photos || []), input.listingId || null])
      await client.query(`UPDATE b2b_requirement_views SET dismissed_at = NULL WHERE requirement_id=$1 AND vendor_id=$2`, [requirementId, vendorId])
      await event(client, requirementId, null, cur ? 'QUOTE_UPDATED' : 'QUOTE_SUBMITTED', { ...actor, label: v.name }, `${qty} @ ₹${price}`)
      if (!cur && r.buyer_vendor_id) await notifyVendors(client, [r.buyer_vendor_id], 'New offer received', `${v.name} offers ${qty} × ${r.product_name} at ${inr(price)}/pc`, { requirementId, kind: 'B2B_QUOTE' })
      await commit(client)
      return rows[0]
    } catch (x) { await client.query('ROLLBACK').catch(() => {}); throw x } finally { client.release() }
  },

  async withdrawQuote(quoteId, vendorId, isAdmin = false) {
    const q = (await query(`SELECT * FROM b2b_quotes WHERE id=$1 ${isAdmin ? '' : 'AND seller_vendor_id=$2'}`, isAdmin ? [quoteId] : [quoteId, vendorId])).rows[0]
    if (!q) throw err(404, 'Quote not found', 'NOT_FOUND')
    if (q.quantity_awarded > 0) throw err(409, 'This quote is already selected', 'LOCKED')
    await query(`UPDATE b2b_quotes SET status='WITHDRAWN', updated_at=NOW() WHERE id=$1`, [quoteId])
  },

  // ── Award (buyer picks quantities from several vendors) ──────────────
  async award(requirementId, selections, actor) {
    if (!Array.isArray(selections) || !selections.length) throw err(400, 'Select at least one quote', 'VALIDATION_ERROR')
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const r = (await client.query(`SELECT * FROM b2b_requirements WHERE id=$1 FOR UPDATE`, [requirementId])).rows[0]
      if (!r) throw err(404, 'Requirement not found', 'NOT_FOUND')
      if (!actor.isAdmin && r.buyer_vendor_id !== actor.vendorId) throw err(403, 'Only the buyer can award', 'FORBIDDEN')
      if (r.status !== 'OPEN') throw err(409, 'This requirement is not open for awarding', 'CLOSED')
      const ids = selections.map((s) => s.quoteId)
      if (new Set(ids).size !== ids.length) throw err(400, 'Each seller can be selected only once', 'VALIDATION_ERROR')
      const total = selections.reduce((s, x) => s + Number(x.quantity), 0)
      if (r.quantity_awarded + total > r.quantity_needed) throw err(400, `Only ${r.quantity_needed - r.quantity_awarded} units are still needed`, 'VALIDATION_ERROR')
      const created = []
      for (const sel of selections) {
        const qty = Number(sel.quantity)
        if (!(qty > 0)) throw err(400, 'Quantity must be at least 1', 'VALIDATION_ERROR')
        const q = (await client.query(`SELECT q.*, v.name AS seller_name FROM b2b_quotes q JOIN vendors v ON v.id=q.seller_vendor_id WHERE q.id=$1 AND q.requirement_id=$2 FOR UPDATE`, [sel.quoteId, requirementId])).rows[0]
        if (!q || ['WITHDRAWN', 'EXPIRED', 'NOT_SELECTED'].includes(q.status)) throw err(400, 'A selected quote is no longer available', 'VALIDATION_ERROR')
        if (qty > q.quantity_offered - q.quantity_awarded) throw err(400, `${q.seller_name} only has ${q.quantity_offered - q.quantity_awarded} units left on this quote`, 'VALIDATION_ERROR')
        const pct = await commissionFor(q.seller_vendor_id, client)
        const subtotal = round2(Number(q.unit_price) * qty); const comm = round2(subtotal * pct / 100)
        const on = (await client.query(`SELECT nextval('b2b_order_seq') n`)).rows[0].n
        const o = (await client.query(
          `INSERT INTO b2b_orders (order_number, requirement_id, quote_id, buyer_vendor_id, seller_vendor_id, quantity, unit_price, subtotal, commission_percent, commission_amount, seller_payable)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [`B2BO-${on}`, requirementId, q.id, r.buyer_vendor_id, q.seller_vendor_id, qty, q.unit_price, subtotal, pct, comm, round2(subtotal - comm)])).rows[0]
        const awarded = q.quantity_awarded + qty
        await client.query(`UPDATE b2b_quotes SET quantity_awarded=$2, status=$3, updated_at=NOW() WHERE id=$1`, [q.id, awarded, awarded >= q.quantity_offered ? 'SELECTED' : 'PARTIALLY_SELECTED'])
        await event(client, requirementId, o.id, 'AWARDED', actor, `${qty} × from ${q.seller_name} @ ₹${q.unit_price}`)
        await notifyVendors(client, [q.seller_vendor_id], 'Offer accepted', `${qty} × ${r.product_name} — waiting for the buyer's payment`, { requirementId, orderId: o.id, kind: 'B2B_AWARDED' })
        created.push(o)
      }
      const newAwarded = r.quantity_awarded + total
      const full = newAwarded >= r.quantity_needed
      await client.query(`UPDATE b2b_requirements SET quantity_awarded=$2, status=$3, updated_at=NOW() WHERE id=$1`, [requirementId, newAwarded, full ? 'AWARDED' : 'OPEN'])
      if (full) await client.query(`UPDATE b2b_quotes SET status='NOT_SELECTED', updated_at=NOW() WHERE requirement_id=$1 AND quantity_awarded=0 AND status='SUBMITTED'`, [requirementId])
      await commit(client)
      return created
    } catch (x) { await client.query('ROLLBACK').catch(() => {}); throw x } finally { client.release() }
  },

  // ── Escrow payment ───────────────────────────────────────────────────
  /**
   * Vendors pay from the Dealker wallet (their settlement balance): the money leaves their ledger now and is
   * held in escrow until the buyer confirms receipt. Admins can also record a payment taken outside the app.
   */
  async pay(requirementId, { method, reference = null }, actor) {
    const m = String(method || (actor.isAdmin ? 'ONLINE' : 'WALLET')).toUpperCase()
    if (!actor.isAdmin && !PAY_METHODS_VENDOR.includes(m)) {
      throw err(400, 'Pay from your Dealker wallet. Other payment methods are not available yet.', 'METHOD_UNAVAILABLE')
    }
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const r = (await client.query(`SELECT * FROM b2b_requirements WHERE id=$1 FOR UPDATE`, [requirementId])).rows[0]
      if (!r) throw err(404, 'Requirement not found', 'NOT_FOUND')
      if (!actor.isAdmin && r.buyer_vendor_id !== actor.vendorId) throw err(403, 'Only the buyer can pay', 'FORBIDDEN')
      const orders = (await client.query(`SELECT * FROM b2b_orders WHERE requirement_id=$1 AND status='PENDING_PAYMENT' FOR UPDATE`, [requirementId])).rows
      if (!orders.length) throw err(409, 'Nothing to pay for this requirement', 'NOTHING_TO_PAY')
      const amount = round2(orders.reduce((s, o) => s + Number(o.subtotal), 0))
      if (m === 'WALLET') {
        if (!r.buyer_vendor_id) throw err(400, 'This requirement has no buyer wallet to pay from', 'METHOD_UNAVAILABLE')
        await lockSettlement(client, r.buyer_vendor_id)
        const hold = (await client.query(`SELECT 1 FROM settlement_holds WHERE vendor_id=$1 AND is_active=TRUE LIMIT 1`, [r.buyer_vendor_id])).rows[0]
        if (hold) throw err(409, 'Your wallet is on hold. Contact support.', 'WALLET_HOLD')
        const balance = await ledgerBalance(client, r.buyer_vendor_id)
        if (balance < amount) {
          throw err(402, `Not enough wallet balance — you need ${inr(amount)} and have ${inr(Math.max(0, balance))}.`, 'INSUFFICIENT_WALLET',
            { required: amount, balance: Math.max(0, round2(balance)), shortfall: round2(amount - Math.max(0, balance)) })
        }
      }
      const p = (await client.query(
        `INSERT INTO b2b_payments (requirement_id, payer_vendor_id, amount, method, reference) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [requirementId, r.buyer_vendor_id, amount, m, reference || `PAY-${Date.now()}`])).rows[0]
      if (m === 'WALLET') {
        await ledgerEntry(client, r.buyer_vendor_id, -amount, {
          reasonCode: 'B2B_PURCHASE', reason: `Payment held in escrow · ${r.requirement_number}`, referenceId: p.id, key: `b2bpay:${p.id}`, actorId: actor.userId || null,
        })
      }
      await client.query(`UPDATE b2b_orders SET status='PAID', payment_status='ESCROW_HELD', payment_id=$2, payment_method=$3, paid_at=NOW(), updated_at=NOW() WHERE id = ANY($1)`, [orders.map((o) => o.id), p.id, m])
      if (r.status === 'AWARDED') await client.query(`UPDATE b2b_requirements SET status='IN_FULFILMENT', updated_at=NOW() WHERE id=$1`, [requirementId])
      await event(client, requirementId, null, 'PAID', actor, `${inr(amount)} held in escrow for ${orders.length} order(s)`)
      await notifyVendors(client, orders.map((o) => o.seller_vendor_id), 'Payment received', `Payment for ${r.product_name} is secured in escrow — please pack and dispatch`, { requirementId, kind: 'B2B_PAID' })
      await commit(client)
      return { ...p, amount, orders: orders.map((o) => o.id) }
    } catch (x) { await client.query('ROLLBACK').catch(() => {}); throw x } finally { client.release() }
  },

  // ── Seller fulfilment ────────────────────────────────────────────────
  async sellerUpdate(orderId, vendorId, { status, courierName, awb, trackingUrl, fulfilmentType = 'DELIVERY', pickupAt, pickupNote }, actor) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const o = (await client.query(`SELECT * FROM b2b_orders WHERE id=$1 FOR UPDATE`, [orderId])).rows[0]
      if (!o || (!actor.isAdmin && o.seller_vendor_id !== vendorId)) throw err(404, 'Order not found', 'NOT_FOUND')
      const FLOW = { PACKED: ['PAID'], DISPATCHED: ['PAID', 'PACKED'], DELIVERED: ['DISPATCHED'] }
      if (!FLOW[status]) throw err(400, 'Invalid status', 'VALIDATION_ERROR')
      if (!FLOW[status].includes(o.status)) throw err(409, o.status === 'PENDING_PAYMENT' ? 'The buyer has not paid yet — escrow must be funded before dispatch' : `Cannot move from ${o.status} to ${status}`, 'INVALID_TRANSITION')
      const pickup = status === 'DISPATCHED' && fulfilmentType === 'PICKUP'
      if (status === 'DISPATCHED' && !pickup && !(courierName && awb)) throw err(400, 'Courier name and tracking number (AWB) are required', 'VALIDATION_ERROR')
      if (pickup && !(pickupAt && new Date(pickupAt) > new Date(Date.now() - 3600000))) throw err(400, 'Choose a pickup date and time in the future', 'VALIDATION_ERROR')
      const sets = { PACKED: `packed_at=NOW()`, DISPATCHED: pickup ? `dispatched_at=NOW(), fulfilment_type='PICKUP', pickup_at=$3, pickup_note=$4` : `dispatched_at=NOW(), fulfilment_type='DELIVERY', courier_name=$3, awb=$4, tracking_url=$5`, DELIVERED: `delivered_at=NOW()` }[status]
      const args = status !== 'DISPATCHED' ? [orderId, status] : pickup ? [orderId, status, pickupAt, pickupNote || null] : [orderId, status, courierName, awb, trackingUrl || null]
      await client.query(`UPDATE b2b_orders SET status=$2, ${sets}, updated_at=NOW() WHERE id=$1`, args)
      const note = status === 'DISPATCHED' ? (pickup ? `Pickup scheduled for ${new Date(pickupAt).toISOString()}` : `${courierName} · AWB ${awb}`) : null
      await event(client, o.requirement_id, o.id, status, actor, note)
      if (o.buyer_vendor_id) {
        const msg = status === 'PACKED' ? [`Order packed`, `${o.order_number} is packed and ready`]
          : status === 'DELIVERED' ? [`Order delivered`, `${o.order_number} was marked delivered — please confirm what you received`]
            : pickup ? [`Pickup scheduled`, `${o.order_number}: collect on ${new Date(pickupAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}`]
              : [`Order dispatched`, `${o.order_number} is on the way with ${courierName} (AWB ${awb})`]
        await notifyVendors(client, [o.buyer_vendor_id], msg[0], msg[1], { orderId, kind: 'B2B_SHIPMENT' })
      }
      await commit(client)
    } catch (x) { await client.query('ROLLBACK').catch(() => {}); throw x } finally { client.release() }
  },

  /** Seller (or admin) cannot fulfil a paid order: buyer is refunded and the units go back on the requirement. */
  async cancelPaidOrder(orderId, vendorId, reason, actor) {
    if (!reason?.trim()) throw err(400, 'Please tell the buyer why', 'VALIDATION_ERROR')
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const o = (await client.query(`SELECT * FROM b2b_orders WHERE id=$1 FOR UPDATE`, [orderId])).rows[0]
      if (!o || (!actor.isAdmin && o.seller_vendor_id !== vendorId)) throw err(404, 'Order not found', 'NOT_FOUND')
      if (!['PAID', 'PACKED'].includes(o.status)) throw err(409, o.status === 'PENDING_PAYMENT' ? 'This order is not paid yet' : 'It is too late to cancel — the order has been dispatched', 'INVALID_TRANSITION')
      const r = (await client.query(`SELECT * FROM b2b_requirements WHERE id=$1 FOR UPDATE`, [o.requirement_id])).rows[0]
      const refunded = await refundBuyer(client, o, o.quantity, 'cancel')
      await client.query(`UPDATE b2b_orders SET status='CANCELLED', payment_status='REFUNDED', cancel_reason=$2, released_amount=0, updated_at=NOW() WHERE id=$1`, [orderId, reason.trim()])
      // The seller failed to deliver: the offer is withdrawn unless another order on the same offer is still alive.
      await client.query(
        `UPDATE b2b_quotes SET quantity_awarded = GREATEST(0, quantity_awarded - $2),
                status = CASE WHEN quantity_awarded - $2 > 0 THEN 'PARTIALLY_SELECTED' ELSE 'WITHDRAWN' END, updated_at = NOW() WHERE id = $1`, [o.quote_id, o.quantity])
      const left = Math.max(0, r.quantity_awarded - o.quantity)
      // The units are needed again: reopen for fresh offers, giving sellers at least 48 hours.
      await client.query(
        `UPDATE b2b_requirements SET quantity_awarded=$2, status = CASE WHEN status IN ('AWARDED','IN_FULFILMENT') THEN 'OPEN' ELSE status END,
                response_deadline = GREATEST(response_deadline, NOW() + interval '48 hours'), updated_at=NOW() WHERE id=$1`, [r.id, left])
      await event(client, r.id, o.id, 'ORDER_CANCELLED', actor, reason.trim())
      if (o.buyer_vendor_id) {
        await notifyVendors(client, [o.buyer_vendor_id], 'Order cancelled by seller',
          `${o.order_number} was cancelled${refunded ? ` and ${inr(refunded)} returned to your wallet` : ''}. Pick another offer for the remaining units.`, { orderId, requirementId: r.id, kind: 'B2B_CANCELLED' })
      }
      await finishRequirementIfDone(client, r.id)
      await commit(client)
      return { refunded }
    } catch (x) { await client.query('ROLLBACK').catch(() => {}); throw x } finally { client.release() }
  },

  // ── Buyer receipt → release or dispute ───────────────────────────────
  async receive(orderId, { receivedQuantity, ok = true, note }, actor) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const o = (await client.query(`SELECT * FROM b2b_orders WHERE id=$1 FOR UPDATE`, [orderId])).rows[0]
      if (!o || (!actor.isAdmin && o.buyer_vendor_id !== actor.vendorId)) throw err(404, 'Order not found', 'NOT_FOUND')
      if (!['DISPATCHED', 'DELIVERED'].includes(o.status)) throw err(409, 'This order has not been dispatched yet', 'INVALID_TRANSITION')
      const got = Number(receivedQuantity ?? o.quantity)
      if (got < 0 || got > o.quantity) throw err(400, 'Invalid received quantity', 'VALIDATION_ERROR')
      await client.query(`UPDATE b2b_orders SET received_at=NOW(), received_quantity=$2, receipt_note=$3, updated_at=NOW() WHERE id=$1`, [orderId, got, note || null])
      if (got === o.quantity && ok) {
        const s = await postSettlement(client, o, o.quantity)
        await client.query(`UPDATE b2b_orders SET status='COMPLETED', payment_status='RELEASED', released_at=NOW(), released_amount=$2, updated_at=NOW() WHERE id=$1`, [orderId, s.payable])
        await event(client, o.requirement_id, o.id, 'RECEIVED', actor, 'Buyer confirmed receipt — payment released to seller')
        await notifyVendors(client, [o.seller_vendor_id], 'Payment released', `${inr(s.payable)} for ${o.order_number} was added to your wallet`, { orderId, kind: 'B2B_RELEASED' })
      } else {
        await client.query(`UPDATE b2b_orders SET status='DISPUTED', dispute_status='OPEN', dispute_reason=$2, updated_at=NOW() WHERE id=$1`, [orderId, note || (got < o.quantity ? `Received ${got} of ${o.quantity}` : 'Item not as described')])
        await event(client, o.requirement_id, o.id, 'DISPUTED', actor, note || `Received ${got} of ${o.quantity}`)
        await notifyVendors(client, [o.seller_vendor_id], 'Buyer reported an issue', `${o.order_number}: ${note || `received ${got} of ${o.quantity}`}. Dealker will review and resolve it.`, { orderId, kind: 'B2B_DISPUTE' })
      }
      await finishRequirementIfDone(client, o.requirement_id)
      await commit(client)
    } catch (x) { await client.query('ROLLBACK').catch(() => {}); throw x } finally { client.release() }
  },

  // ── Admin: resolve a dispute ─────────────────────────────────────────
  async resolveDispute(orderId, { decision, releaseQuantity, note }, actor) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const o = (await client.query(`SELECT * FROM b2b_orders WHERE id=$1 FOR UPDATE`, [orderId])).rows[0]
      if (!o) throw err(404, 'Order not found', 'NOT_FOUND')
      if (o.status !== 'DISPUTED') throw err(409, 'This order has no open dispute', 'INVALID_TRANSITION')
      if (decision === 'RELEASE') {
        const s = await postSettlement(client, o, o.quantity)
        await client.query(`UPDATE b2b_orders SET status='COMPLETED', payment_status='RELEASED', released_at=NOW(), released_amount=$2, dispute_status='RESOLVED_RELEASED', dispute_resolution=$3, updated_at=NOW() WHERE id=$1`, [orderId, s.payable, note || null])
      } else if (decision === 'REFUND') {
        await refundBuyer(client, o, o.quantity, 'dispute')
        await client.query(`UPDATE b2b_orders SET status='REFUNDED', payment_status='REFUNDED', released_amount=0, dispute_status='RESOLVED_REFUNDED', dispute_resolution=$2, updated_at=NOW() WHERE id=$1`, [orderId, note || null])
      } else if (decision === 'PARTIAL') {
        const q = Number(releaseQuantity)
        if (!(q > 0 && q < o.quantity)) throw err(400, 'Release quantity must be between 1 and the order quantity', 'VALIDATION_ERROR')
        const s = await postSettlement(client, o, q)
        await refundBuyer(client, o, o.quantity - q, 'dispute')
        await client.query(`UPDATE b2b_orders SET status='COMPLETED', payment_status='RELEASED', released_at=NOW(), released_amount=$2, dispute_status='RESOLVED_PARTIAL', dispute_resolution=$3, updated_at=NOW() WHERE id=$1`, [orderId, s.payable, note || null])
      } else throw err(400, 'Decision must be RELEASE, REFUND or PARTIAL', 'VALIDATION_ERROR')
      await event(client, o.requirement_id, o.id, 'DISPUTE_RESOLVED', actor, `${decision}${note ? ` — ${note}` : ''}`)
      await notifyVendors(client, [o.seller_vendor_id, o.buyer_vendor_id].filter(Boolean), 'Dispute resolved', `${o.order_number}: ${decision.toLowerCase()}`, { orderId, kind: 'B2B_DISPUTE' })
      await finishRequirementIfDone(client, o.requirement_id)
      await commit(client)
    } catch (x) { await client.query('ROLLBACK').catch(() => {}); throw x } finally { client.release() }
  },

  // ── Orders ───────────────────────────────────────────────────────────
  /** `bucket`: active (needs attention / in motion) · done (completed, cancelled, refunded). */
  async listOrders({ vendorId = null, role, status, bucket, sellerId, search, page = 1, limit = 25 } = {}) {
    const where = []; const params = []
    const p = (v) => { params.push(v); return `$${params.length}` }
    if (vendorId) where.push(role === 'selling' ? `o.seller_vendor_id = ${p(vendorId)}` : `o.buyer_vendor_id = ${p(vendorId)}`)
    if (status) where.push(`o.status = ${p(status)}`)
    if (bucket === 'active') where.push(`o.status = ANY(${p(OPEN_ORDER_STATUSES)})`)
    if (bucket === 'done') where.push(`o.status <> ALL(${p(OPEN_ORDER_STATUSES)})`)
    if (sellerId) where.push(`o.seller_vendor_id = ${p(sellerId)}`)
    if (search) { const s = p(`%${search}%`); where.push(`(o.order_number ILIKE ${s} OR r.product_name ILIKE ${s} OR sv.name ILIKE ${s} OR o.awb ILIKE ${s})`) }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const lim = Math.min(100, Number(limit) || 25); const off = (Math.max(1, Number(page)) - 1) * lim
    const base = `FROM b2b_orders o JOIN b2b_requirements r ON r.id=o.requirement_id JOIN vendors sv ON sv.id=o.seller_vendor_id LEFT JOIN vendors bv ON bv.id=o.buyer_vendor_id ${w}`
    const cnt = await query(`SELECT COUNT(*)::int n ${base}`, params)
    const { rows } = await query(
      `SELECT o.*, r.product_name, r.requirement_number, r.storage, r.model_key, sv.name AS seller_name, COALESCE(bv.name,'Dealker') AS buyer_name,
              (SELECT p.thumbnail_url FROM products p WHERE p.deleted_at IS NULL AND p.thumbnail_url IS NOT NULL AND COALESCE(r.model_key,'') <> ''
                  AND (' ' || btrim(regexp_replace(lower(p.name), '[^a-z0-9]+', ' ', 'g')) || ' ') LIKE '% ' || r.model_key || ' %' LIMIT 1) AS thumbnail_url
         ${base} ORDER BY (o.status='DISPUTED') DESC, o.created_at DESC LIMIT ${lim} OFFSET ${off}`, params)
    const n = (x) => (x == null ? x : Number(x))
    return { data: rows.map((o) => ({ ...o, unit_price: n(o.unit_price), subtotal: n(o.subtotal), commission_percent: n(o.commission_percent), commission_amount: n(o.commission_amount), seller_payable: n(o.seller_payable), released_amount: n(o.released_amount) })), pagination: { page: Number(page), limit: lim, total: cnt.rows[0].n } }
  },

  /** Order tracking: the order, its requirement, who the other party is (revealed once paid), payment and event trail. */
  async orderDetail(orderId, viewer) {
    const o = (await query(`SELECT * FROM b2b_orders WHERE id=$1`, [orderId])).rows[0]
    if (!o) throw err(404, 'Order not found', 'NOT_FOUND')
    const isBuyer = viewer.vendorId && o.buyer_vendor_id === viewer.vendorId
    const isSeller = viewer.vendorId && o.seller_vendor_id === viewer.vendorId
    if (!viewer.isAdmin && !isBuyer && !isSeller) throw err(404, 'Order not found', 'NOT_FOUND')
    const r = (await query(`${REQ_CARD()} WHERE r.id=$1`, [o.requirement_id])).rows[0]
    const seller = (await query(
      `SELECT v.id, v.name, v.phone, s.city, s.pincode, s.address_line1 AS address FROM vendors v
         LEFT JOIN LATERAL (SELECT city, pincode, address_line1 FROM shops WHERE vendor_id = v.id ORDER BY created_at LIMIT 1) s ON true WHERE v.id=$1`, [o.seller_vendor_id])).rows[0]
    const buyer = o.buyer_vendor_id ? (await query(`SELECT id, name, phone FROM vendors WHERE id=$1`, [o.buyer_vendor_id])).rows[0] : null
    const paid = !['PENDING_PAYMENT', 'CANCELLED'].includes(o.status)
    const events = (await query(
      `SELECT type, actor_label, note, created_at FROM b2b_events
        WHERE requirement_id=$1 AND (order_id=$2 OR (order_id IS NULL AND type IN ('POSTED','PAID'))) ORDER BY created_at`, [o.requirement_id, orderId])).rows
    const payment = o.payment_id ? (await query(`SELECT amount, method, reference, status, paid_at FROM b2b_payments WHERE id=$1`, [o.payment_id])).rows[0] : null
    const n = (x) => (x == null ? x : Number(x))
    return {
      order: { ...o, unit_price: n(o.unit_price), subtotal: n(o.subtotal), commission_percent: n(o.commission_percent), commission_amount: n(o.commission_amount), seller_payable: n(o.seller_payable), released_amount: n(o.released_amount) },
      requirement: num(r),
      seller: { name: seller?.name, ...(paid && !isSeller ? { phone: seller?.phone, city: seller?.city, pincode: seller?.pincode, address: seller?.address } : { city: seller?.city }) },
      buyer: buyer ? { name: buyer.name, ...(paid && !isBuyer ? { phone: buyer.phone } : {}) } : { name: 'Dealker' },
      payment: payment ? { ...payment, amount: Number(payment.amount) } : null,
      events,
      viewer: { isBuyer: Boolean(isBuyer), isSeller: Boolean(isSeller), isAdmin: Boolean(viewer.isAdmin) },
    }
  },

  /** What the payment screen shows and what `pay` will check — the same ledger sum. */
  async walletFor(vendorId) {
    const balance = await ledgerBalance({ query }, vendorId)
    const hold = (await query(`SELECT 1 FROM settlement_holds WHERE vendor_id=$1 AND is_active=TRUE LIMIT 1`, [vendorId])).rows[0]
    return { balance: Math.max(0, round2(balance)), onHold: Boolean(hold), methods: [{ id: 'WALLET', label: 'Dealker wallet', available: !hold }] }
  },

  // ── Admin overview ───────────────────────────────────────────────────
  async adminRequirements({ status, search, page = 1, limit = 25 } = {}) {
    await expireStale()
    const where = []; const params = []
    const p = (v) => { params.push(v); return `$${params.length}` }
    if (status) where.push(`r.status = ${p(status)}`)
    if (search) { const s = p(`%${search}%`); where.push(`(r.product_name ILIKE ${s} OR r.requirement_number ILIKE ${s} OR r.title ILIKE ${s} OR bv.name ILIKE ${s})`) }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const lim = Math.min(100, Number(limit) || 25); const off = (Math.max(1, Number(page)) - 1) * lim
    const cnt = await query(`SELECT COUNT(*)::int n FROM b2b_requirements r LEFT JOIN vendors bv ON bv.id=r.buyer_vendor_id ${w}`, params)
    const extra = `, (SELECT COALESCE(SUM(subtotal),0) FROM b2b_orders o WHERE o.requirement_id=r.id AND o.status<>'CANCELLED') AS order_value,
      (SELECT COUNT(*)::int FROM b2b_orders o WHERE o.requirement_id=r.id AND o.status IN ('DISPATCHED','DELIVERED','COMPLETED')) AS dispatched_orders,
      (SELECT COUNT(*)::int FROM b2b_orders o WHERE o.requirement_id=r.id AND o.status<>'CANCELLED') AS order_count,
      (SELECT COALESCE(SUM(views),0)::int FROM b2b_requirement_views vw WHERE vw.requirement_id=r.id) AS view_count`
    const { rows } = await query(`${REQ_CARD(extra)} ${w} ORDER BY r.created_at DESC LIMIT ${lim} OFFSET ${off}`, params)
    return { data: rows.map((r) => ({ ...num(r), order_value: Number(r.order_value) })), pagination: { page: Number(page), limit: lim, total: cnt.rows[0].n } }
  },

  async stats() {
    await expireStale()
    const r = (await query(
      `SELECT COUNT(*) FILTER (WHERE status='OPEN')::int AS open_requirements,
              COUNT(*)::int AS total_requirements,
              (SELECT COUNT(*)::int FROM b2b_quotes WHERE status <> 'WITHDRAWN') AS quotes_received,
              (SELECT COUNT(*)::int FROM b2b_orders WHERE status NOT IN ('CANCELLED')) AS orders,
              (SELECT COALESCE(SUM(subtotal),0) FROM b2b_orders WHERE status NOT IN ('CANCELLED','PENDING_PAYMENT')) AS order_value,
              (SELECT COUNT(*)::int FROM b2b_orders WHERE status IN ('DISPATCHED','DELIVERED','COMPLETED')) AS dispatched,
              (SELECT COUNT(*)::int FROM b2b_orders WHERE status='COMPLETED') AS completed,
              (SELECT COUNT(*)::int FROM b2b_orders WHERE status='DISPUTED') AS disputes,
              (SELECT COUNT(*)::int FROM b2b_orders WHERE status='PENDING_PAYMENT') AS awaiting_payment,
              (SELECT COUNT(*)::int FROM b2b_orders WHERE status IN ('PAID','PACKED')) AS awaiting_dispatch,
              (SELECT COALESCE(SUM(subtotal),0) FROM b2b_orders WHERE payment_status='ESCROW_HELD') AS escrow_held,
              (SELECT COALESCE(SUM(released_amount),0) FROM b2b_orders WHERE payment_status='RELEASED') AS released_to_sellers,
              (SELECT COALESCE(SUM(subtotal*commission_percent/100) FILTER (WHERE status='COMPLETED'),0) FROM b2b_orders) AS commission_earned
         FROM b2b_requirements`)).rows[0]
    const n = Number
    return { ...r, order_value: n(r.order_value), escrow_held: n(r.escrow_held), released_to_sellers: n(r.released_to_sellers), commission_earned: round2(r.commission_earned) }
  },

  /** Dashboard: what is really in demand, how well it is served and where buyers are left waiting. */
  async demandInsights({ days = 30 } = {}) {
    await expireStale()
    const d = Math.min(365, Math.max(1, Number(days) || 30))
    const since = `NOW() - ($1 || ' days')::interval`
    const funnel = (await query(
      `SELECT COUNT(*)::int AS posted,
              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM b2b_quotes q WHERE q.requirement_id = r.id AND q.status <> 'WITHDRAWN'))::int AS quoted,
              COUNT(*) FILTER (WHERE r.quantity_awarded > 0)::int AS awarded,
              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM b2b_orders o WHERE o.requirement_id = r.id AND o.payment_id IS NOT NULL))::int AS paid,
              COUNT(*) FILTER (WHERE r.status = 'COMPLETED')::int AS completed,
              COALESCE(SUM(r.quantity_needed), 0)::int AS units_needed, COALESCE(SUM(r.quantity_awarded), 0)::int AS units_awarded,
              COUNT(*) FILTER (WHERE r.is_urgent)::int AS urgent,
              COUNT(*) FILTER (WHERE r.quantity_needed >= ${BULK_FROM})::int AS bulk
         FROM b2b_requirements r WHERE r.created_at >= ${since}`, [d])).rows[0]
    const speed = (await query(
      `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (fq.first_quote - r.created_at)) / 60))::int AS avg_minutes_to_first_offer
         FROM b2b_requirements r JOIN LATERAL (SELECT MIN(created_at) AS first_quote FROM b2b_quotes q WHERE q.requirement_id = r.id) fq ON fq.first_quote IS NOT NULL
        WHERE r.created_at >= ${since}`, [d])).rows[0]
    const reach = (await query(
      `SELECT COUNT(DISTINCT vendor_id)::int AS vendors_viewed, COALESCE(SUM(views),0)::int AS views, COUNT(*) FILTER (WHERE dismissed_at IS NOT NULL)::int AS dismissed
         FROM b2b_requirement_views v JOIN b2b_requirements r ON r.id = v.requirement_id WHERE r.created_at >= ${since}`, [d])).rows[0]
    const top = (await query(
      `WITH rr AS (
         SELECT r.*, COALESCE(NULLIF(r.model_key, ''), lower(r.product_name)) AS mkey
           FROM b2b_requirements r WHERE r.created_at >= ${since} AND r.status <> 'CANCELLED')
       SELECT rr.mkey AS model, MIN(rr.product_name) AS example, MIN(rr.brand) AS brand,
              COUNT(*)::int AS requests, SUM(rr.quantity_needed)::int AS units_needed, SUM(rr.quantity_awarded)::int AS units_awarded,
              ROUND(AVG(rr.target_price))::int AS avg_target,
              (SELECT COUNT(*)::int FROM b2b_quotes q JOIN rr r2 ON r2.id = q.requirement_id WHERE r2.mkey = rr.mkey AND q.status <> 'WITHDRAWN') AS offers,
              (SELECT p.thumbnail_url FROM products p WHERE p.deleted_at IS NULL AND p.thumbnail_url IS NOT NULL AND rr.mkey <> ''
                  AND (' ' || btrim(regexp_replace(lower(p.name), '[^a-z0-9]+', ' ', 'g')) || ' ') LIKE '% ' || rr.mkey || ' %' LIMIT 1) AS thumbnail_url
         FROM rr GROUP BY rr.mkey ORDER BY units_needed DESC, requests DESC LIMIT 10`, [d])).rows
    const waiting = (await query(
      `SELECT r.id, r.requirement_number, r.product_name, r.quantity_needed, r.target_price, r.target_price_max, r.created_at, r.response_deadline, r.status, r.is_urgent,
              COALESCE(bv.name, 'Dealker') AS buyer_name,
              (SELECT COALESCE(SUM(views),0)::int FROM b2b_requirement_views v WHERE v.requirement_id = r.id) AS view_count
         FROM b2b_requirements r LEFT JOIN vendors bv ON bv.id = r.buyer_vendor_id
        WHERE r.created_at >= ${since} AND r.status IN ('OPEN','EXPIRED') AND r.quantity_awarded = 0
          AND NOT EXISTS (SELECT 1 FROM b2b_quotes q WHERE q.requirement_id = r.id AND q.status <> 'WITHDRAWN')
          AND r.created_at < NOW() - interval '2 hours'
        ORDER BY r.is_urgent DESC, r.created_at LIMIT 10`, [d])).rows
    const n = Number
    return {
      days: d,
      funnel: { ...funnel, fill_rate: funnel.units_needed ? round2(funnel.units_awarded / funnel.units_needed) : 0 },
      avgMinutesToFirstOffer: speed.avg_minutes_to_first_offer,
      reach,
      topModels: top.map((t) => ({ ...t, fill_rate: t.units_needed ? round2(t.units_awarded / t.units_needed) : 0, avg_target: t.avg_target != null ? n(t.avg_target) : null })),
      unserved: waiting.map((w) => ({ ...w, target_price: w.target_price != null ? n(w.target_price) : null, target_price_max: w.target_price_max != null ? n(w.target_price_max) : null })),
    }
  },

  async vendorOptions() {
    const { rows } = await query(`SELECT id, name FROM vendors WHERE status IN ('ACTIVE','VERIFIED') ORDER BY name`)
    return rows
  },

  async getSettings() {
    const d = Number((await query(`SELECT value FROM app_settings WHERE key='b2b_commission_percent'`)).rows[0]?.value ?? 10)
    const { rows } = await query(
      `SELECT v.id, v.name, v.b2b_commission_percent AS override,
              (SELECT COUNT(*)::int FROM b2b_orders o WHERE o.seller_vendor_id=v.id AND o.status<>'CANCELLED') AS orders
         FROM vendors v WHERE v.status IN ('ACTIVE','VERIFIED') ORDER BY v.name`)
    return { defaultPercent: d, vendors: rows.map((v) => ({ ...v, override: v.override != null ? Number(v.override) : null })) }
  },
  async setDefaultCommission(pct) {
    if (!(pct >= 0 && pct <= 50)) throw err(400, 'Commission must be between 0 and 50', 'VALIDATION_ERROR')
    await query(`INSERT INTO app_settings (key, value, description) VALUES ('b2b_commission_percent', $1::jsonb, 'Default B2B commission %') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [JSON.stringify(pct)])
  },
  async setVendorCommission(vendorId, pct) {
    if (pct !== null && !(pct >= 0 && pct <= 50)) throw err(400, 'Commission must be between 0 and 50', 'VALIDATION_ERROR')
    await query(`UPDATE vendors SET b2b_commission_percent=$2 WHERE id=$1`, [vendorId, pct])
  },
}

/** Vendors (of those given) that hold live stock matching the requirement → Map(vendorId → { stock }). */
async function matchedVendors(client, req, vendorIds) {
  const out = new Map()
  const first = (req.model_key || '').split(' ').filter(Boolean).sort((a, b) => b.length - a.length)[0]
  if (!first || !vendorIds.length) return out
  const { rows } = await client.query(
    `SELECT p.owner_vendor_id AS vendor_id, p.name, p.brand, p.condition, p.battery_health, p.specifications->>'storage' AS storage, sp.stock_quantity AS stock
       FROM shop_products sp JOIN products p ON p.id = sp.product_id
      WHERE p.owner_vendor_id = ANY($1) AND sp.deleted_at IS NULL AND p.deleted_at IS NULL
        AND sp.approval_status = 'APPROVED' AND sp.listing_status = 'ACTIVE' AND sp.stock_quantity > 0
        AND lower(p.name) LIKE '%' || $2 || '%'`, [vendorIds, first])
  const byVendor = new Map()
  for (const l of rows) { (byVendor.get(l.vendor_id) || byVendor.set(l.vendor_id, []).get(l.vendor_id)).push({ ...l, stock: Number(l.stock), battery_health: l.battery_health != null ? Number(l.battery_health) : null }) }
  for (const [vendorId, listings] of byVendor) {
    const m = matchInventory(req, listings)
    if (m.level === 'EXACT') out.set(vendorId, { stock: m.stock })
  }
  return out
}
