import { query, getClient } from '../../config/database.js'
import { VendorSettlementsService } from '../vendor-settlements/vendor-settlements.service.js'
import { ShippingService } from '../shipping/shipping.service.js'
import { payoutBlocks } from './order-payout.service.js'

const err = (statusCode, message, code = 'ORDER_ERROR') => Object.assign(new Error(message), { statusCode, code })
const n = (x) => (x == null ? 0 : Number(x))

// Approximate city centres (lat, lng) used to estimate road distance when exact coordinates are unknown.
const CITY = {
  mumbai: [19.076, 72.878], delhi: [28.614, 77.209], 'new delhi': [28.614, 77.209], bengaluru: [12.972, 77.595], bangalore: [12.972, 77.595],
  hyderabad: [17.385, 78.487], chennai: [13.083, 80.271], kolkata: [22.573, 88.364], pune: [18.52, 73.857], ahmedabad: [23.023, 72.572],
  jaipur: [26.912, 75.787], lucknow: [26.847, 80.947], surat: [21.17, 72.831], kochi: [9.932, 76.267], noida: [28.535, 77.391], indore: [22.72, 75.857],
  gurgaon: [28.459, 77.027], gurugram: [28.459, 77.027], nagpur: [21.146, 79.088], bhopal: [23.26, 77.413], patna: [25.594, 85.138], chandigarh: [30.733, 76.779],
}
function distanceKm(a, b) {
  const A = CITY[String(a || '').toLowerCase().trim()]; const B = CITY[String(b || '').toLowerCase().trim()]
  if (!A || !B) return null
  if (A === B) return 12
  const rad = (d) => (d * Math.PI) / 180
  const h = Math.sin(rad(B[0] - A[0]) / 2) ** 2 + Math.cos(rad(A[0])) * Math.cos(rad(B[0])) * Math.sin(rad(B[1] - A[1]) / 2) ** 2
  return Math.round(6371 * 2 * Math.asin(Math.sqrt(h)) * 1.25) // ×1.25 ≈ road distance
}

const STEP_LABEL = {
  PENDING: 'Order placed', ORDER_PLACED: 'Order placed', CONFIRMED: 'Order confirmed', PACKED: 'Packed by the seller', READY_TO_SHIP: 'Ready to ship',
  SHIPPED: 'Handed to the delivery partner', OUT_FOR_DELIVERY: 'Out for delivery', DELIVERED: 'Delivered to the customer', CANCELLED: 'Order cancelled',
  REFUNDED: 'Refunded', RETURN_REQUESTED: 'Customer asked to return', RETURNED: 'Returned to the seller',
}
const SHIP_LABEL = {
  CREATED: 'Shipment created', ASSIGNING: 'Finding a delivery partner', ASSIGNED: 'Delivery partner assigned', PICKUP_SCHEDULED: 'Pickup scheduled',
  PICKED_UP: 'Picked up from the seller', IN_TRANSIT: 'On the way', OUT_FOR_DELIVERY: 'Out for delivery', DELIVERED: 'Delivered', CANCELLED: 'Shipment cancelled',
  FAILED: 'Delivery attempt failed', RTO: 'Returning to the seller',
}

function plainStatus(order, sellers) {
  if (order.status === 'CANCELLED') return 'This order was cancelled.'
  if (order.status === 'REFUNDED') return 'This order was returned and the money has been refunded.'
  if (order.status === 'DELIVERED') return 'This order has been delivered.'
  const s = sellers.map((x) => x.status)
  if (s.every((x) => x === 'DELIVERED')) return 'All parcels have been delivered.'
  if (s.some((x) => x === 'OUT_FOR_DELIVERY')) return 'A parcel is out for delivery today.'
  if (s.some((x) => x === 'SHIPPED')) return 'Parcels are on the way to the customer.'
  if (s.some((x) => ['PACKED', 'READY_TO_SHIP'].includes(x))) return 'The seller has packed the order and is handing it to the delivery partner.'
  if (order.status === 'PENDING') return order.payment_status === 'PAID' ? 'Waiting for the seller to confirm.' : 'Waiting for the customer’s payment or the seller’s confirmation.'
  return 'The seller is preparing the order.'
}

export const orderOverview = {
  async get(orderId) {
    const o = (await query(
      `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, c.created_at AS customer_since
         FROM orders o LEFT JOIN users c ON c.id = o.customer_id WHERE o.id = $1`, [orderId])).rows[0]
    if (!o) throw err(404, 'Order not found', 'NOT_FOUND')

    const sos = (await query(
      `SELECT so.*, v.name AS vendor_name, v.phone AS vendor_phone, v.email AS vendor_email, vp.legal_name, vp.gstin, vp.city AS vendor_city, vp.state AS vendor_state,
              s.name AS shop_name, s.address_line1 AS shop_address, s.city AS shop_city, s.state AS shop_state, s.pincode AS shop_pincode, s.seller_rating
         FROM seller_orders so LEFT JOIN vendors v ON v.id = so.vendor_id LEFT JOIN vendor_profiles vp ON vp.vendor_id = v.id LEFT JOIN shops s ON s.id = so.shop_id
        WHERE so.order_id = $1 ORDER BY so.created_at, so.seller_order_number`, [orderId])).rows
    const soIds = sos.map((x) => x.id)

    const items = soIds.length ? (await query(
      `SELECT oi.id AS item_id, oi.seller_order_id, oi.product_id, oi.product_name, oi.unit_price, oi.quantity, oi.subtotal, p.thumbnail_url, p.condition, p.brand
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.created_at`, [orderId])).rows : []
    const media = soIds.length ? (await query(`SELECT * FROM seller_order_media WHERE seller_order_id = ANY($1) ORDER BY created_at`, [soIds])).rows : []
    const shipments = soIds.length ? (await query(`SELECT * FROM shipments WHERE seller_order_id = ANY($1) ORDER BY created_at DESC`, [soIds])).rows : []
    const shipIds = shipments.map((s) => s.id)
    const events = shipIds.length ? (await query(`SELECT * FROM shipment_events WHERE shipment_id = ANY($1) ORDER BY occurred_at`, [shipIds])).rows : []

    const history = (await query(`SELECT h.*, u.name AS actor FROM order_status_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.order_id = $1 ORDER BY h.changed_at`, [orderId])).rows
    const payment = (await query(`SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`, [orderId])).rows[0] ?? null
    const coupon = o.coupon_code ? (await query(`SELECT code, description, discount_type, discount_value, max_discount, min_order_amount, coupon_type, absorber FROM coupons WHERE code = $1`, [o.coupon_code])).rows[0] ?? null : null
    const cashback = (await query(`SELECT amount, status, credit_trigger, source_type, created_at, credited_at FROM cashback_transactions WHERE order_id = $1 ORDER BY created_at`, [orderId])).rows
    const refunds = (await query(
      `SELECT r.id, r.status, r.scope, r.items, r.source, r.reason, r.computed_amount, r.resolved_amount, r.refund_destination, r.created_at, r.resolved_at, r.refunded_at, r.admin_notes,
              ru.name AS resolved_by_name, (SELECT COALESCE(SUM(-l.amount),0) FROM settlement_ledger l WHERE l.idempotency_key LIKE 'refund:' || r.id || ':%') AS seller_reversal
         FROM refund_requests r LEFT JOIN users ru ON ru.id = r.resolved_by WHERE r.order_id = $1 ORDER BY r.created_at`, [orderId])).rows
    const tickets = (await query(`SELECT id, ticket_number, subject, status, created_at FROM support_tickets WHERE order_id = $1 ORDER BY created_at DESC`, [orderId])).rows
    const cstats = (await query(`SELECT COUNT(*)::int orders, COALESCE(SUM(total_payable) FILTER (WHERE payment_status='PAID'),0) spent FROM orders WHERE customer_id = $1`, [o.customer_id])).rows[0]

    const payouts = await payoutBlocks(sos)
    const addr = o.delivery_address || {}
    const toCity = addr.city
    const sellers = sos.map((so) => {
      const ship = shipments.find((s) => s.seller_order_id === so.id) || null
      const dist = distanceKm(so.shop_city || so.vendor_city, toCity)
      return {
        id: so.id, number: so.seller_order_number, status: so.status, fulfilment: so.fulfilment_status, payout_status: so.payout_status,
        vendor: { id: so.vendor_id, name: so.vendor_name, legal_name: so.legal_name, gstin: so.gstin, phone: so.vendor_phone, email: so.vendor_email, rating: so.seller_rating != null ? Number(so.seller_rating) : null },
        pickup: { shop: so.shop_name, address: [so.shop_address, so.shop_city, so.shop_state, so.shop_pincode].filter(Boolean).join(', '), city: so.shop_city || so.vendor_city },
        items: items.filter((i) => i.seller_order_id === so.id).map((i) => ({ id: i.item_id, name: i.product_name, quantity: Number(i.quantity), unit_price: n(i.unit_price), subtotal: n(i.subtotal), image: i.thumbnail_url, condition: i.condition, brand: i.brand })),
        money: { subtotal: n(so.item_subtotal), shipping: n(so.shipping_charge), commission_percent: n(so.commission_rate), commission: n(so.commission_amount), payable_to_vendor: n(so.payable_to_seller) },
        payout: payouts[so.id],
        invoice: so.invoice_number ? { number: so.invoice_number, url: so.invoice_url } : null,
        media: media.filter((m) => m.seller_order_id === so.id).map((m) => ({ id: m.id, kind: m.kind, url: m.url, caption: m.caption, created_at: m.created_at })),
        can_create_shipment: !ship && ['CONFIRMED', 'PACKED', 'READY_TO_SHIP', 'ORDER_PLACED'].includes(so.status),
        shipment: ship ? {
          id: ship.id, provider_status: ship.provider_status, created_at: ship.created_at, provider: ship.provider, courier: ship.courier_name, awb: ship.awb, tracking_url: ship.tracking_url, status: ship.status, status_label: SHIP_LABEL[ship.status] || ship.status,
          eta: ship.estimated_delivery, cod_amount: n(ship.cod_amount), charge: n(ship.shipping_charge),
          events: events.filter((e) => e.shipment_id === ship.id).map((e) => ({ status: e.status, label: SHIP_LABEL[e.status] || e.status, note: e.note, location: e.event_location, at: e.occurred_at })),
        } : null,
        route: { from_city: so.shop_city || so.vendor_city, from_state: so.shop_state || so.vendor_state, to_city: toCity, to_state: addr.state, distance_km: dist },
        timestamps: { shipped_at: so.shipped_at, delivered_at: so.delivered_at, cancelled_at: so.cancelled_at, estimated_delivery: so.estimated_delivery },
      }
    })

    // Plain-English timeline of everything that happened
    const timeline = []
    for (const h of history) timeline.push({ at: h.changed_at, title: STEP_LABEL[h.to_status] || h.to_status, who: h.actor || (h.to_status === 'PENDING' ? o.customer_name : null), kind: 'order' })
    for (const s of sellers) {
      if (s.shipment) for (const e of s.shipment.events) timeline.push({ at: e.at, title: `${e.label}${s.vendor.name && sellers.length > 1 ? ` — ${s.vendor.name}` : ''}`, detail: [e.note, e.location].filter(Boolean).join(' · '), kind: 'shipment' })
      for (const m of s.media.slice(0, 1)) timeline.push({ at: m.created_at, title: `${s.vendor.name} uploaded packing proof`, kind: 'proof' })
    }
    for (const r of refunds) {
      timeline.push({ at: r.created_at, title: 'Customer requested a return / refund', detail: r.reason, kind: 'problem' })
      if (r.resolved_at) timeline.push({ at: r.resolved_at, title: r.status === 'APPROVED' ? 'Refund approved' : `Refund ${r.status.toLowerCase()}`, detail: r.admin_notes, kind: 'problem' })
    }
    for (const t of tickets) timeline.push({ at: t.created_at, title: `Support chat opened (${t.ticket_number})`, detail: t.subject, kind: 'support' })
    timeline.sort((a, b) => new Date(a.at) - new Date(b.at))

    // Things a non-technical person should notice
    const attention = []
    if (o.status === 'PENDING' && o.payment_status !== 'PAID' && o.payment_method !== 'COD') attention.push('Payment has not been received yet.')
    for (const r of refunds.filter((x) => ['PENDING', 'PROCESSING'].includes(x.status))) attention.push(`The customer asked to return this order (“${r.reason}”). It needs a decision.`)
    for (const t of tickets.filter((x) => !['RESOLVED', 'CLOSED'].includes(x.status))) attention.push(`There is an open support chat with this customer (${t.ticket_number}).`)
    for (const s of sellers) {
      if (s.shipment && ['FAILED', 'RTO'].includes(s.shipment.status)) attention.push(`${s.vendor.name}: delivery problem — ${s.shipment.status_label.toLowerCase()}.`)
      if (s.shipment?.eta && new Date(s.shipment.eta) < new Date() && !['DELIVERED', 'CANCELLED'].includes(s.status)) attention.push(`${s.vendor.name}: the parcel is later than promised.`)
      if (['CONFIRMED', 'ORDER_PLACED'].includes(s.status) && Date.now() - new Date(o.created_at).getTime() > 48 * 3600000) attention.push(`${s.vendor.name} has not packed this order for over 2 days.`)
    }

    const subtotal = n(o.subtotal)
    const delivered = o.status === 'DELIVERED'
    return {
      order: {
        id: o.id, number: o.order_number, status: o.status, placed_at: o.created_at, delivered_at: o.delivered_at, cancelled_reason: o.cancelled_reason,
        summary: plainStatus(o, sellers), payment_method: o.payment_method, payment_status: o.payment_status, delivery_mode: o.delivery_mode,
        is_marketplace: o.is_marketplace, item_count: items.reduce((x, i) => x + Number(i.quantity), 0), vendor_count: sellers.length,
      },
      customer: { id: o.customer_id, name: o.customer_name, phone: o.customer_phone, email: o.customer_email, since: o.customer_since, orders: cstats.orders, total_spent: n(cstats.spent),
        address: { name: addr.name, phone: addr.phone, line1: addr.line1 || addr.address_line1, city: addr.city, state: addr.state, pincode: addr.pincode } },
      payment: {
        method: o.payment_method, status: o.payment_status, gateway: payment ? { id: payment.razorpay_payment_id, method: payment.method, status: payment.status, paid_at: payment.created_at, refund_amount: payment.refund_amount != null ? Number(payment.refund_amount) : null, refund_status: payment.refund_status } : null,
        breakdown: { items: subtotal, delivery: n(o.delivery_fee) || n(o.shipping_charge), discount: n(o.discount_amount), tax_included: n(o.tax_amount), total: n(o.total_payable),
          points_used: Number(o.points_redeemed || 0), points_value: n(o.loyalty_redeemed_amount), wallet_used: n(o.wallet_amount) },
        coupon: o.coupon_code ? { code: o.coupon_code, saved: n(o.coupon_discount_amount) || n(o.discount_amount), details: coupon } : null,
        cashback: cashback.map((c) => ({ amount: n(c.amount), status: c.status, when: c.credit_trigger, source: c.source_type, credited_at: c.credited_at })),
        loyalty_earned_pending: delivered ? Math.floor(n(o.total_payable) * 0.02) : null,
      },
      sellers, timeline, attention,
      problems: { refunds: refunds.map((r) => ({ ...r, computed_amount: n(r.computed_amount), resolved_amount: r.resolved_amount != null ? Number(r.resolved_amount) : null, seller_reversal: n(r.seller_reversal) })), tickets },
    }
  },

  /** Printable invoice (HTML). kind = 'dealker' (whole order) or a seller-order id (vendor invoice). */
  async invoiceHtml(orderId, sellerOrderId) {
    const d = await this.get(orderId)
    const money = (x) => `₹${Number(x).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
    const sel = sellerOrderId ? d.sellers.find((s) => s.id === sellerOrderId) : null
    if (sellerOrderId && !sel) throw err(404, 'Invoice not found', 'NOT_FOUND')
    const lines = (sel ? sel.items : d.sellers.flatMap((s) => s.items))
    const total = sel ? sel.money.subtotal : d.payment.breakdown.total
    const title = sel ? 'Vendor tax invoice' : 'Dealker order invoice'
    const from = sel ? `${sel.vendor.legal_name || sel.vendor.name}<br>GSTIN ${sel.vendor.gstin || '—'}<br>${sel.pickup.address}` : 'Dealker Marketplace<br>Bengaluru, Karnataka'
    const num = sel?.invoice?.number || `DK-${d.order.number}`
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title} ${num}</title><style>
      body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:40px;max-width:820px}h1{font-size:22px;margin:0}table{width:100%;border-collapse:collapse;margin-top:24px}
      th,td{padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:left;font-size:14px}th{background:#f8fafc}.r{text-align:right}.muted{color:#6b7280;font-size:13px}.tot{font-weight:600;font-size:16px}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:24px}@media print{body{margin:16px}}</style></head><body>
      <h1>${title}</h1><p class="muted">Invoice ${num} · Order ${d.order.number} · ${new Date(d.order.placed_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
      <div class="grid"><div><b>Sold by</b><p class="muted">${from}</p></div>
      <div><b>Bill to</b><p class="muted">${d.customer.address.name || d.customer.name}<br>${[d.customer.address.line1, d.customer.address.city, d.customer.address.state, d.customer.address.pincode].filter(Boolean).join(', ')}<br>${d.customer.address.phone || d.customer.phone || ''}</p></div></div>
      <table><tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Amount</th></tr>
      ${lines.map((i) => `<tr><td>${i.name}</td><td class="r">${i.quantity}</td><td class="r">${money(i.unit_price)}</td><td class="r">${money(i.subtotal)}</td></tr>`).join('')}
      ${sel ? '' : `<tr><td colspan="3" class="r">Delivery</td><td class="r">${money(d.payment.breakdown.delivery)}</td></tr><tr><td colspan="3" class="r">Discounts</td><td class="r">−${money(d.payment.breakdown.discount)}</td></tr>`}
      <tr><td colspan="3" class="r tot">Total</td><td class="r tot">${money(total)}</td></tr></table>
      <p class="muted" style="margin-top:32px">Payment: ${d.payment.method === 'COD' ? 'Cash on delivery' : 'Paid online'} (${d.payment.status.toLowerCase()}). This is a computer-generated document.</p></body></html>`
  },
}


const TRACK_STATUSES = ['PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RTO', 'CANCELLED']
const settlements = new VendorSettlementsService()
const shipping = new ShippingService()

/** Re-derive the parent order's status from its parcels and record the change. */
async function rollUpParent(client, orderId, actorId) {
  const o = (await client.query(`SELECT status, payment_method FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0]
  const parts = (await client.query(`SELECT status FROM seller_orders WHERE order_id = $1 AND status <> 'CANCELLED'`, [orderId])).rows.map((r) => r.status)
  if (!parts.length || ['CANCELLED', 'REFUNDED'].includes(o.status)) return
  let next = o.status
  if (parts.every((x) => x === 'DELIVERED')) next = 'DELIVERED'
  else if (parts.some((x) => ['SHIPPED', 'OUT_FOR_DELIVERY'].includes(x)) && o.status !== 'DELIVERED') next = 'OUT_FOR_DELIVERY'
  if (next === o.status) return
  await client.query(
    `UPDATE orders SET status = $2, updated_at = NOW(),
            delivered_at = CASE WHEN $2 = 'DELIVERED' THEN NOW() ELSE delivered_at END,
            payment_status = CASE WHEN $2 = 'DELIVERED' AND payment_method = 'COD' THEN 'PAID' ELSE payment_status END WHERE id = $1`, [orderId, next])
  await client.query(`INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note) VALUES ($1,$2,$3,$4,'Updated from shipment tracking')`, [orderId, o.status, next, actorId])
}

export const shipmentTracking = {
  async addEvent(shipmentId, { status, note, location }, actorId) {
    if (!TRACK_STATUSES.includes(status)) throw err(400, 'Unknown tracking status', 'VALIDATION_ERROR')
    const client = await getClient()
    let soId = null; let delivered = false
    try {
      await client.query('BEGIN')
      const sh = (await client.query(`SELECT * FROM shipments WHERE id = $1 FOR UPDATE`, [shipmentId])).rows[0]
      if (!sh) throw err(404, 'Shipment not found', 'NOT_FOUND')
      if (['DELIVERED', 'CANCELLED'].includes(sh.status)) throw err(409, `This shipment is already ${sh.status.toLowerCase()}`, 'INVALID_TRANSITION')
      soId = sh.seller_order_id
      await client.query(`INSERT INTO shipment_events (shipment_id, status, provider_status, note, event_location, occurred_at) VALUES ($1,$2,$2,$3,$4,NOW())`, [shipmentId, status, note || null, location || null])
      await client.query(`UPDATE shipments SET status = $2::text, provider_status = $2::text, updated_at = NOW() WHERE id = $1`, [shipmentId, status])
      const so = (await client.query(`SELECT id, order_id, status FROM seller_orders WHERE id = $1 FOR UPDATE`, [soId])).rows[0]
      const map = { PICKED_UP: 'SHIPPED', IN_TRANSIT: 'SHIPPED', OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY', DELIVERED: 'DELIVERED' }
      if (map[status] && !['DELIVERED', 'CANCELLED', 'RETURNED'].includes(so.status)) {
        const next = map[status]
        await client.query(
          `UPDATE seller_orders SET status = $2, fulfilment_status = $3, updated_at = NOW(),
                  shipped_at = CASE WHEN shipped_at IS NULL AND $2 IN ('SHIPPED','OUT_FOR_DELIVERY','DELIVERED') THEN NOW() ELSE shipped_at END,
                  delivered_at = CASE WHEN $2 = 'DELIVERED' THEN NOW() ELSE delivered_at END WHERE id = $1`,
          [soId, next, next === 'DELIVERED' ? 'DELIVERED' : 'DISPATCHED'])
        delivered = next === 'DELIVERED'
        await rollUpParent(client, so.order_id, actorId)
      }
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    if (delivered) await settlements.postSellerOrderEntries(soId).catch(() => {})
    const so = (await query(`SELECT order_id FROM seller_orders WHERE id = $1`, [soId])).rows[0]
    return orderOverview.get(so.order_id)
  },

  async createManual(sellerOrderId, { provider = 'SELF', courierName, awb, trackingUrl, eta }, actorId) {
    if (!courierName?.trim()) throw err(400, 'Courier name is required', 'VALIDATION_ERROR')
    if (provider !== 'SELF' && !awb?.trim()) throw err(400, 'Tracking number (AWB) is required', 'VALIDATION_ERROR')
    const client = await getClient()
    let orderId
    try {
      await client.query('BEGIN')
      const so = (await client.query(`SELECT * FROM seller_orders WHERE id = $1 FOR UPDATE`, [sellerOrderId])).rows[0]
      if (!so) throw err(404, 'Parcel not found', 'NOT_FOUND')
      orderId = so.order_id
      if (!['ORDER_PLACED', 'CONFIRMED', 'PACKED', 'READY_TO_SHIP'].includes(so.status)) throw err(409, 'A shipment can only be created before the parcel is on its way', 'INVALID_TRANSITION')
      const dupe = await client.query(`SELECT 1 FROM shipments WHERE seller_order_id = $1 AND status NOT IN ('CANCELLED','FAILED')`, [sellerOrderId])
      if (dupe.rows[0]) throw err(409, 'This parcel already has a shipment', 'DUPLICATE')
      const ord = (await client.query(`SELECT payment_method, total_payable FROM orders WHERE id = $1`, [orderId])).rows[0]
      const sh = (await client.query(
        `INSERT INTO shipments (seller_order_id, provider, provider_order_id, awb, courier_name, shipping_charge, cod_amount, status, provider_status, estimated_delivery, tracking_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'PICKUP_SCHEDULED','PICKUP_SCHEDULED',$8,$9) RETURNING id`,
        [sellerOrderId, provider, `MAN-${Date.now()}`, awb?.trim() || null, courierName.trim(), so.shipping_charge ?? 0, ord.payment_method === 'COD' ? ord.total_payable : 0,
          eta || null, trackingUrl || null])).rows[0]
      await client.query(`INSERT INTO shipment_events (shipment_id, status, provider_status, note, event_location) VALUES ($1,'CREATED','CREATED','Shipment booked by Dealker team',NULL), ($1,'PICKUP_SCHEDULED','PICKUP_SCHEDULED',$2,NULL)`, [sh.id, `Pickup scheduled with ${courierName.trim()}`])
      await client.query(`UPDATE seller_orders SET shipment_id = $2, shipping_provider = $3, status = CASE WHEN status IN ('ORDER_PLACED','CONFIRMED') THEN 'PACKED' ELSE status END, fulfilment_status = CASE WHEN status IN ('ORDER_PLACED','CONFIRMED') THEN 'PACKED' ELSE fulfilment_status END, updated_at = NOW() WHERE id = $1`, [sellerOrderId, sh.id, provider])
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    return orderOverview.get(orderId)
  },

  async refresh(shipmentId) {
    const before = (await query(`SELECT s.status, s.provider, s.seller_order_id, (SELECT COUNT(*)::int FROM shipment_events e WHERE e.shipment_id = s.id) n FROM shipments s WHERE s.id = $1`, [shipmentId])).rows[0]
    if (!before) throw err(404, 'Shipment not found', 'NOT_FOUND')
    let connected = true
    try { await shipping.trackShipment(shipmentId) } catch (e) { connected = false; if (!e.code) throw e }
    const after = (await query(`SELECT s.status, (SELECT COUNT(*)::int FROM shipment_events e WHERE e.shipment_id = s.id) n FROM shipments s WHERE s.id = $1`, [shipmentId])).rows[0]
    const changed = after.status !== before.status || after.n !== before.n
    const so = (await query(`SELECT order_id FROM seller_orders WHERE id = $1`, [before.seller_order_id])).rows[0]
    const message = changed ? 'Tracking updated from the courier.'
      : before.provider === 'SELF' ? 'This parcel is delivered by the seller themselves, so there is nothing to refresh. Add an update manually instead.'
      : connected ? 'Checked with the courier — no new updates yet.' : 'The courier connection isn’t set up yet, so status can’t refresh automatically. Add an update manually instead.'
    return { overview: await orderOverview.get(so.order_id), changed, message }
  },
}
