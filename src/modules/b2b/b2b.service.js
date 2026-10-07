import { query, getClient } from '../../config/database.js'

const err = (statusCode, message, code = 'B2B_ERROR') => Object.assign(new Error(message), { statusCode, code })
const round2 = (n) => Math.round(Number(n) * 100) / 100
const SELLER_ELIGIBLE = ['ACTIVE', 'VERIFIED']
const COND = ['NEW', 'OPEN_BOX', 'REFURBISHED', 'USED_LIKE_NEW', 'USED_GOOD', 'USED_FAIR']

async function event(client, requirementId, orderId, type, actor, note = null) {
  await client.query(
    `INSERT INTO b2b_events (requirement_id, order_id, type, actor_id, actor_label, note) VALUES ($1,$2,$3,$4,$5,$6)`,
    [requirementId, orderId, type, actor?.userId ?? null, actor?.label ?? null, note])
}

async function notifyVendors(client, vendorIds, title, body, data = {}) {
  if (!vendorIds.length) return
  await client.query(
    `INSERT INTO notifications (user_id, title, body, type, data)
     SELECT DISTINCT vu.user_id, $2, $3, 'B2B', $4::jsonb FROM vendor_users vu WHERE vu.vendor_id = ANY($1) AND vu.is_active = true AND vu.deleted_at IS NULL`,
    [vendorIds, title, body, JSON.stringify(data)])
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

/** Posts commission-split settlement entries into the vendor ledger (idempotent). */
async function postSettlement(client, order, qty) {
  const gross = round2(Number(order.unit_price) * qty)
  const comm = round2(gross * Number(order.commission_percent) / 100)
  const bal = (await client.query(`SELECT COALESCE(SUM(amount),0) b FROM settlement_ledger WHERE vendor_id=$1`, [order.seller_vendor_id])).rows[0].b
  let balance = Number(bal)
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

const REQ_CARD = `
  SELECT r.*, COALESCE(bv.name, 'Dealker') AS buyer_name,
         (SELECT COUNT(*)::int FROM b2b_quotes q WHERE q.requirement_id = r.id AND q.status <> 'WITHDRAWN') AS quote_count,
         (SELECT MIN(q.unit_price) FROM b2b_quotes q WHERE q.requirement_id = r.id AND q.status NOT IN ('WITHDRAWN','EXPIRED')) AS best_price,
         (SELECT COALESCE(SUM(q.quantity_offered),0)::int FROM b2b_quotes q WHERE q.requirement_id = r.id AND q.status NOT IN ('WITHDRAWN','EXPIRED')) AS quantity_offered_total,
         c.name AS category_name
    FROM b2b_requirements r
    LEFT JOIN vendors bv ON bv.id = r.buyer_vendor_id
    LEFT JOIN categories c ON c.id = r.category_id`

const num = (r) => ({ ...r, target_price: r.target_price != null ? Number(r.target_price) : null, best_price: r.best_price != null ? Number(r.best_price) : null })

export const b2b = {
  COND,

  // ── Requirements ─────────────────────────────────────────────────────
  async createRequirement(input, actor) {
    const e = []
    if (!input.productName?.trim()) e.push('Product name is required')
    if (!(Number(input.quantity) > 0)) e.push('Quantity must be at least 1')
    if (!input.responseDeadline || new Date(input.responseDeadline) <= new Date()) e.push('Quote deadline must be in the future')
    if (e.length) throw err(400, e.join('. '), 'VALIDATION_ERROR')
    if (actor.vendorId) {
      const v = (await query(`SELECT status FROM vendors WHERE id=$1`, [actor.vendorId])).rows[0]
      if (!v || !SELLER_ELIGIBLE.includes(v.status)) throw err(403, 'Your vendor account must be verified to post requirements', 'VENDOR_NOT_ELIGIBLE')
    }
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const n = (await client.query(`SELECT nextval('b2b_requirement_seq') n`)).rows[0].n
      const { rows } = await client.query(
        `INSERT INTO b2b_requirements (requirement_number, buyer_vendor_id, posted_by_type, created_by, title, product_name, brand, category_id, condition_pref,
           quantity_needed, target_price, description, delivery_city, delivery_pincode, response_deadline, required_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [`B2B-${n}`, actor.vendorId ?? null, actor.vendorId && !actor.isAdmin ? 'VENDOR' : actor.isAdmin && !actor.vendorId ? 'ADMIN' : 'VENDOR', actor.userId ?? null,
          input.title?.trim() || `${input.quantity} × ${input.productName.trim()}`, input.productName.trim(), input.brand || null, input.categoryId || null,
          input.conditionPref || 'ANY', Number(input.quantity), input.targetPrice ?? null, input.description || null, input.deliveryCity || null,
          input.deliveryPincode || null, input.responseDeadline, input.requiredBy || null])
      await event(client, rows[0].id, null, 'POSTED', actor, `${rows[0].quantity_needed} × ${rows[0].product_name}`)
      const vendors = (await client.query(`SELECT id FROM vendors WHERE status = ANY($1) AND id IS DISTINCT FROM $2`, [SELLER_ELIGIBLE, actor.vendorId ?? null])).rows.map((v) => v.id)
      await notifyVendors(client, vendors, 'New buying requirement', `${rows[0].quantity_needed} × ${rows[0].product_name} — send your quote`, { requirementId: rows[0].id, kind: 'B2B_REQUIREMENT' })
      await client.query('COMMIT')
      return rows[0]
    } catch (x) { await client.query('ROLLBACK').catch(() => {}); throw x } finally { client.release() }
  },

  /** Vendor lists: open (others' requirements to quote on), mine (I posted), quoted (I quoted). */
  async listForVendor(vendorId, { scope = 'open', page = 1, limit = 20, search } = {}) {
    await expireStale()
    const params = [vendorId]
    const where = []
    if (scope === 'mine') where.push(`r.buyer_vendor_id = $1`)
    else if (scope === 'quoted') where.push(`EXISTS (SELECT 1 FROM b2b_quotes q WHERE q.requirement_id=r.id AND q.seller_vendor_id=$1)`)
    else where.push(`r.status = 'OPEN' AND r.response_deadline > NOW() AND r.buyer_vendor_id IS DISTINCT FROM $1 AND r.quantity_awarded < r.quantity_needed`)
    if (search) { params.push(`%${search}%`); where.push(`(r.product_name ILIKE $${params.length} OR r.title ILIKE $${params.length})`) }
    const lim = Math.min(50, Number(limit) || 20); const off = (Math.max(1, Number(page)) - 1) * lim
    const w = `WHERE ${where.join(' AND ')}`
    const cnt = await query(`SELECT COUNT(*)::int n FROM b2b_requirements r ${w}`, params)
    const { rows } = await query(
      `${REQ_CARD.replace('FROM b2b_requirements r', `, (SELECT row_to_json(mq) FROM (SELECT id, quantity_offered, unit_price, status, quantity_awarded FROM b2b_quotes WHERE requirement_id = r.id AND seller_vendor_id = $1) mq) AS my_quote\n    FROM b2b_requirements r`)} ${w} ORDER BY r.created_at DESC LIMIT ${lim} OFFSET ${off}`, params)
    // Quotes are sealed: other vendors never see counts of competing prices.
    const data = rows.map((r) => {
      const out = num(r)
      if (r.buyer_vendor_id !== vendorId) { delete out.best_price; delete out.quantity_offered_total; delete out.quote_count }
      return out
    })
    return { data, pagination: { page: Number(page), limit: lim, total: cnt.rows[0].n } }
  },

  async detail(id, viewer) {
    await expireStale()
    const { rows } = await query(`${REQ_CARD} WHERE r.id = $1`, [id])
    const r = rows[0]
    if (!r) throw err(404, 'Requirement not found', 'NOT_FOUND')
    const isAdmin = viewer.isAdmin
    const isBuyer = !isAdmin && viewer.vendorId && r.buyer_vendor_id === viewer.vendorId
    if (!isAdmin && !isBuyer && !viewer.vendorId) throw err(403, 'Forbidden', 'FORBIDDEN')
    const full = isAdmin || isBuyer
    const qrows = (await query(
      `SELECT q.*, v.name AS seller_name, s.seller_rating FROM b2b_quotes q JOIN vendors v ON v.id=q.seller_vendor_id
         LEFT JOIN LATERAL (SELECT seller_rating FROM shops WHERE vendor_id = v.id ORDER BY created_at LIMIT 1) s ON true
        WHERE q.requirement_id=$1 ${full ? '' : 'AND q.seller_vendor_id=$2'} ORDER BY q.unit_price ASC, q.created_at`, full ? [id] : [id, viewer.vendorId])).rows
    const orows = (await query(
      `SELECT o.*, sv.name AS seller_name, COALESCE(bv.name,'Dealker') AS buyer_name FROM b2b_orders o JOIN vendors sv ON sv.id=o.seller_vendor_id LEFT JOIN vendors bv ON bv.id=o.buyer_vendor_id
        WHERE o.requirement_id=$1 ${full ? '' : 'AND o.seller_vendor_id=$2'} ORDER BY o.created_at`, full ? [id] : [id, viewer.vendorId])).rows
    const events = full ? (await query(`SELECT type, actor_label, note, order_id, created_at FROM b2b_events WHERE requirement_id=$1 ORDER BY created_at`, [id])).rows : []
    const payment = full ? (await query(`SELECT * FROM b2b_payments WHERE requirement_id=$1 ORDER BY created_at DESC LIMIT 1`, [id])).rows[0] ?? null : null
    const out = num(r)
    if (!full) { delete out.best_price; delete out.quantity_offered_total; delete out.quote_count }
    const toNum = (o) => ({ ...o, unit_price: Number(o.unit_price), subtotal: o.subtotal != null ? Number(o.subtotal) : undefined, commission_amount: o.commission_amount != null ? Number(o.commission_amount) : undefined,
      seller_payable: o.seller_payable != null ? Number(o.seller_payable) : undefined, commission_percent: o.commission_percent != null ? Number(o.commission_percent) : undefined, released_amount: o.released_amount != null ? Number(o.released_amount) : null })
    return { requirement: out, quotes: qrows.map(toNum), orders: orows.map(toNum), events, payment: payment ? { ...payment, amount: Number(payment.amount) } : null, viewer: { isBuyer: Boolean(isBuyer), isAdmin } }
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
      await client.query('COMMIT')
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
    if (qty > r.quantity_needed) throw err(400, `You can offer at most ${r.quantity_needed} units`, 'VALIDATION_ERROR')
    if (input.condition && !COND.includes(input.condition)) throw err(400, 'Invalid condition', 'VALIDATION_ERROR')
    const cur = (await query(`SELECT * FROM b2b_quotes WHERE requirement_id=$1 AND seller_vendor_id=$2`, [requirementId, vendorId])).rows[0]
    if (cur && cur.quantity_awarded > 0) throw err(409, 'This quote has already been selected and cannot be changed', 'LOCKED')
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `INSERT INTO b2b_quotes (requirement_id, seller_vendor_id, quantity_offered, unit_price, condition, delivery_days, note, photos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (requirement_id, seller_vendor_id) DO UPDATE SET quantity_offered=EXCLUDED.quantity_offered, unit_price=EXCLUDED.unit_price, condition=EXCLUDED.condition,
           delivery_days=EXCLUDED.delivery_days, note=EXCLUDED.note, photos=EXCLUDED.photos, status='SUBMITTED', updated_at=NOW() RETURNING *`,
        [requirementId, vendorId, qty, price, input.condition || 'NEW', input.deliveryDays ?? 3, input.note || null, JSON.stringify(input.photos || [])])
      await event(client, requirementId, null, cur ? 'QUOTE_UPDATED' : 'QUOTE_SUBMITTED', { ...actor, label: v.name }, `${qty} @ ₹${price}`)
      if (!cur && r.buyer_vendor_id) await notifyVendors(client, [r.buyer_vendor_id], 'New quote received', `${v.name} offers ${qty} × ${r.product_name} at ₹${price}`, { requirementId, kind: 'B2B_QUOTE' })
      await client.query('COMMIT')
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
        await notifyVendors(client, [q.seller_vendor_id], 'Your quote was selected', `${qty} × ${r.product_name} — payment pending from buyer`, { requirementId, orderId: o.id, kind: 'B2B_AWARDED' })
        created.push(o)
      }
      const newAwarded = r.quantity_awarded + total
      const full = newAwarded >= r.quantity_needed
      await client.query(`UPDATE b2b_requirements SET quantity_awarded=$2, status=$3, updated_at=NOW() WHERE id=$1`, [requirementId, newAwarded, full ? 'AWARDED' : 'OPEN'])
      if (full) await client.query(`UPDATE b2b_quotes SET status='NOT_SELECTED', updated_at=NOW() WHERE requirement_id=$1 AND quantity_awarded=0 AND status='SUBMITTED'`, [requirementId])
      await client.query('COMMIT')
      return created
    } catch (x) { await client.query('ROLLBACK').catch(() => {}); throw x } finally { client.release() }
  },

  // ── Escrow payment ───────────────────────────────────────────────────
  async pay(requirementId, { method = 'ONLINE', reference = null }, actor) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const r = (await client.query(`SELECT * FROM b2b_requirements WHERE id=$1 FOR UPDATE`, [requirementId])).rows[0]
      if (!r) throw err(404, 'Requirement not found', 'NOT_FOUND')
      if (!actor.isAdmin && r.buyer_vendor_id !== actor.vendorId) throw err(403, 'Only the buyer can pay', 'FORBIDDEN')
      const orders = (await client.query(`SELECT * FROM b2b_orders WHERE requirement_id=$1 AND status='PENDING_PAYMENT' FOR UPDATE`, [requirementId])).rows
      if (!orders.length) throw err(409, 'Nothing to pay for this requirement', 'NOTHING_TO_PAY')
      const amount = round2(orders.reduce((s, o) => s + Number(o.subtotal), 0))
      const p = (await client.query(
        `INSERT INTO b2b_payments (requirement_id, payer_vendor_id, amount, method, reference) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [requirementId, r.buyer_vendor_id, amount, method, reference || `PAY-${Date.now()}`])).rows[0]
      await client.query(`UPDATE b2b_orders SET status='PAID', payment_status='ESCROW_HELD', payment_id=$2, paid_at=NOW(), updated_at=NOW() WHERE id = ANY($1)`, [orders.map((o) => o.id), p.id])
      if (r.status === 'AWARDED') await client.query(`UPDATE b2b_requirements SET status='IN_FULFILMENT', updated_at=NOW() WHERE id=$1`, [requirementId])
      await event(client, requirementId, null, 'PAID', actor, `₹${amount} held in escrow for ${orders.length} order(s)`)
      await notifyVendors(client, orders.map((o) => o.seller_vendor_id), 'Payment received in escrow', `Payment for ${r.product_name} is secured — please dispatch`, { requirementId, kind: 'B2B_PAID' })
      await client.query('COMMIT')
      return p
    } catch (x) { await client.query('ROLLBACK').catch(() => {}); throw x } finally { client.release() }
  },

  // ── Seller fulfilment ────────────────────────────────────────────────
  async sellerUpdate(orderId, vendorId, { status, courierName, awb, trackingUrl }, actor) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const o = (await client.query(`SELECT * FROM b2b_orders WHERE id=$1 FOR UPDATE`, [orderId])).rows[0]
      if (!o || (!actor.isAdmin && o.seller_vendor_id !== vendorId)) throw err(404, 'Order not found', 'NOT_FOUND')
      const FLOW = { PACKED: ['PAID'], DISPATCHED: ['PAID', 'PACKED'], DELIVERED: ['DISPATCHED'] }
      if (!FLOW[status]) throw err(400, 'Invalid status', 'VALIDATION_ERROR')
      if (!FLOW[status].includes(o.status)) throw err(409, o.status === 'PENDING_PAYMENT' ? 'The buyer has not paid yet — escrow must be funded before dispatch' : `Cannot move from ${o.status} to ${status}`, 'INVALID_TRANSITION')
      if (status === 'DISPATCHED' && !(courierName && awb)) throw err(400, 'Courier name and tracking number (AWB) are required', 'VALIDATION_ERROR')
      const sets = { PACKED: `packed_at=NOW()`, DISPATCHED: `dispatched_at=NOW(), courier_name=$3, awb=$4, tracking_url=$5`, DELIVERED: `delivered_at=NOW()` }[status]
      const args = status === 'DISPATCHED' ? [orderId, status, courierName, awb, trackingUrl || null] : [orderId, status]
      await client.query(`UPDATE b2b_orders SET status=$2, ${sets}, updated_at=NOW() WHERE id=$1`, args)
      await event(client, o.requirement_id, o.id, status, actor, status === 'DISPATCHED' ? `${courierName} · AWB ${awb}` : null)
      if (['DISPATCHED', 'DELIVERED'].includes(status) && o.buyer_vendor_id)
        await notifyVendors(client, [o.buyer_vendor_id], `Order ${status.toLowerCase()}`, `${o.order_number} is ${status.toLowerCase()}`, { orderId, kind: 'B2B_SHIPMENT' })
      await client.query('COMMIT')
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
        await notifyVendors(client, [o.seller_vendor_id], 'Payment released', `₹${s.payable} for ${o.order_number} added to your balance`, { orderId, kind: 'B2B_RELEASED' })
      } else {
        await client.query(`UPDATE b2b_orders SET status='DISPUTED', dispute_status='OPEN', dispute_reason=$2, updated_at=NOW() WHERE id=$1`, [orderId, note || (got < o.quantity ? `Received ${got} of ${o.quantity}` : 'Item not as described')])
        await event(client, o.requirement_id, o.id, 'DISPUTED', actor, note || `Received ${got} of ${o.quantity}`)
      }
      await finishRequirementIfDone(client, o.requirement_id)
      await client.query('COMMIT')
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
        await client.query(`UPDATE b2b_orders SET status='REFUNDED', payment_status='REFUNDED', released_amount=0, dispute_status='RESOLVED_REFUNDED', dispute_resolution=$2, updated_at=NOW() WHERE id=$1`, [orderId, note || null])
      } else if (decision === 'PARTIAL') {
        const q = Number(releaseQuantity)
        if (!(q > 0 && q < o.quantity)) throw err(400, 'Release quantity must be between 1 and the order quantity', 'VALIDATION_ERROR')
        const s = await postSettlement(client, o, q)
        await client.query(`UPDATE b2b_orders SET status='COMPLETED', payment_status='RELEASED', released_at=NOW(), released_amount=$2, dispute_status='RESOLVED_PARTIAL', dispute_resolution=$3, updated_at=NOW() WHERE id=$1`, [orderId, s.payable, note || null])
      } else throw err(400, 'Decision must be RELEASE, REFUND or PARTIAL', 'VALIDATION_ERROR')
      await event(client, o.requirement_id, o.id, 'DISPUTE_RESOLVED', actor, `${decision}${note ? ` — ${note}` : ''}`)
      await notifyVendors(client, [o.seller_vendor_id, o.buyer_vendor_id].filter(Boolean), 'Dispute resolved', `${o.order_number}: ${decision.toLowerCase()}`, { orderId, kind: 'B2B_DISPUTE' })
      await finishRequirementIfDone(client, o.requirement_id)
      await client.query('COMMIT')
    } catch (x) { await client.query('ROLLBACK').catch(() => {}); throw x } finally { client.release() }
  },

  // ── Orders listing ───────────────────────────────────────────────────
  async listOrders({ vendorId = null, role, status, sellerId, search, page = 1, limit = 25 } = {}) {
    const where = []; const params = []
    const p = (v) => { params.push(v); return `$${params.length}` }
    if (vendorId) where.push(role === 'selling' ? `o.seller_vendor_id = ${p(vendorId)}` : `o.buyer_vendor_id = ${p(vendorId)}`)
    if (status) where.push(`o.status = ${p(status)}`)
    if (sellerId) where.push(`o.seller_vendor_id = ${p(sellerId)}`)
    if (search) { const s = p(`%${search}%`); where.push(`(o.order_number ILIKE ${s} OR r.product_name ILIKE ${s} OR sv.name ILIKE ${s} OR o.awb ILIKE ${s})`) }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const lim = Math.min(100, Number(limit) || 25); const off = (Math.max(1, Number(page)) - 1) * lim
    const base = `FROM b2b_orders o JOIN b2b_requirements r ON r.id=o.requirement_id JOIN vendors sv ON sv.id=o.seller_vendor_id LEFT JOIN vendors bv ON bv.id=o.buyer_vendor_id ${w}`
    const cnt = await query(`SELECT COUNT(*)::int n ${base}`, params)
    const { rows } = await query(
      `SELECT o.*, r.product_name, r.requirement_number, sv.name AS seller_name, COALESCE(bv.name,'Dealker') AS buyer_name ${base} ORDER BY (o.status='DISPUTED') DESC, o.created_at DESC LIMIT ${lim} OFFSET ${off}`, params)
    const n = (x) => (x == null ? x : Number(x))
    return { data: rows.map((o) => ({ ...o, unit_price: n(o.unit_price), subtotal: n(o.subtotal), commission_percent: n(o.commission_percent), commission_amount: n(o.commission_amount), seller_payable: n(o.seller_payable), released_amount: n(o.released_amount) })), pagination: { page: Number(page), limit: lim, total: cnt.rows[0].n } }
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
    const { rows } = await query(
      `${REQ_CARD.replace('SELECT r.*,', `SELECT r.*, (SELECT COALESCE(SUM(subtotal),0) FROM b2b_orders o WHERE o.requirement_id=r.id AND o.status<>'CANCELLED') AS order_value, (SELECT COUNT(*)::int FROM b2b_orders o WHERE o.requirement_id=r.id AND o.status IN ('DISPATCHED','DELIVERED','COMPLETED')) AS dispatched_orders, (SELECT COUNT(*)::int FROM b2b_orders o WHERE o.requirement_id=r.id AND o.status<>'CANCELLED') AS order_count,`)} ${w} ORDER BY r.created_at DESC LIMIT ${lim} OFFSET ${off}`, params)
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
