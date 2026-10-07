/**
 * Pure helpers for Shiprocket Quick deliveries (no I/O) — kept separate so
 * the money/eligibility rules are directly unit-tested.
 */

export const DEFAULT_PACKAGE = { weight: 2, length: 20, breadth: 20, height: 10 }
export const FALLBACK_EMAIL = 'orders@freshcuts.in'
const TERMINAL_ORDER_STATUSES = ['DELIVERED', 'CANCELLED', 'REFUNDED', 'RETURNED']
const LIVE_SHIPMENT_STATUSES = ['CREATED', 'ASSIGNING', 'ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY']

export function isLiveShipment(shipment) {
  return Boolean(shipment) && LIVE_SHIPMENT_STATUSES.includes(shipment.status)
}

/** Prepaid-only rule: returns null when the order can go to Shiprocket, else a human reason. */
export function assessEligibility({ order, shop, shipment }) {
  if (!order) return 'Order not found'
  if (order.payment_method === 'COD') return 'COD orders are not available on Shiprocket — only prepaid orders'
  if (order.payment_status !== 'PAID') return 'Payment is not completed yet — only paid (prepaid) orders can be assigned'
  if (TERMINAL_ORDER_STATUSES.includes(order.status)) return `Order is already ${order.status}`
  // A row without a Shiprocket shipment id never reached Shiprocket — it must stay retryable.
  if (isLiveShipment(shipment) && shipment.sr_shipment_id) return 'Already assigned to Shiprocket'
  if (order.rider_id) return 'Already assigned to one of your own riders'
  const a = order.delivery_address || {}
  if (!a.lat || !a.lng) return 'Delivery address has no map location'
  if (!a.pincode) return 'Delivery address has no pincode'
  if (!shop?.lat || !shop?.lng || !shop?.pincode) return 'Store has no map location or pincode'
  return null
}

/** Order id sent to Shiprocket; a suffix is added on retry because ids can never be reused. */
export function buildSrOrderRef(orderNumber, attempt = 0) {
  return attempt > 0 ? `${orderNumber}-R${attempt}` : String(orderNumber)
}

export function buildQuickOrderPayload({ order, shop, customer, items, pickupLocation, srOrderRef }) {
  const a = order.delivery_address
  const name = String(customer?.name || 'Customer').trim()
  const [first, ...rest] = name.split(/\s+/)
  const address = [a.addressLine1, a.addressLine2, a.landmark].filter(Boolean).join(', ')
  const phone = String(customer?.phone || '').replace(/\D/g, '').slice(-10)
  const orderItems = (items?.length ? items : [{ name: 'Order items', quantity: 1, price: order.total_payable }]).map((i, idx) => ({
    name: String(i.name || 'Item').slice(0, 100),
    sku: String(i.sku || i.product_id || `ITEM-${idx + 1}`).slice(0, 50),
    units: Number(i.quantity) || 1,
    selling_price: Math.round(Number(i.price) || 0),
  }))
  const subTotal = Math.round(Number(order.total_payable) || 0)
  return {
    order_id: srOrderRef,
    order_date: new Date(order.created_at || Date.now()).toISOString().slice(0, 16).replace('T', ' '),
    pickup_location: pickupLocation,
    billing_customer_name: first || 'Customer',
    billing_last_name: rest.join(' '),
    billing_address: address || a.city || 'Address',
    billing_city: a.city || shop.city || '',
    billing_pincode: Number(a.pincode),
    billing_state: a.state || '',
    billing_country: 'India',
    billing_email: customer?.email || FALLBACK_EMAIL,
    billing_phone: Number(phone),
    shipping_is_billing: true,
    latitude: Number(a.lat),
    longitude: Number(a.lng),
    order_items: orderItems,
    payment_method: 'Prepaid',
    sub_total: subTotal,
    ...DEFAULT_PACKAGE,
    shipping_method: 'HL',
  }
}

/** Shiprocket tracking text → our shipment status (null = no change). */
export function mapTrackingStatus(text) {
  const t = String(text || '').toUpperCase()
  if (!t) return null
  if (t.includes('CANCEL')) return 'CANCELLED'
  if (t.includes('UNDELIVERED') || t.includes('RTO')) return null
  if (t.includes('DELIVERED')) return 'DELIVERED'
  if (t.includes('OUT FOR DELIVERY')) return 'OUT_FOR_DELIVERY'
  if (t.includes('PICKED') || t.includes('IN TRANSIT') || t.includes('SHIPPED')) return 'PICKED_UP'
  return null
}

/** Pulls the latest track entry + rider details out of Shiprocket's tracking response. */
export function parseTracking(data) {
  const track = data?.tracking_data?.shipment_track?.[0] || null
  const acts = data?.tracking_data?.shipment_track_activities || []
  const statusText = track?.current_status || acts[0]?.['sr-status-label'] || acts[0]?.activity || null
  let agentName = null
  let agentPhone = null
  const agent = track?.courier_agent_details
  if (agent && typeof agent === 'object') {
    agentName = agent.name || agent.agent_name || null
    agentPhone = agent.phone || agent.mobile || agent.contact || null
  } else if (typeof agent === 'string' && agent.trim()) {
    agentName = agent.trim()
  }
  return {
    statusText,
    awb: track?.awb_code || null,
    courierName: track?.courier_name || null,
    agentName,
    agentPhone,
    trackingUrl: data?.tracking_data?.track_url || null,
  }
}

/** Picks the "Shiprocket Quick" entry (or any hyperlocal courier) out of a serviceability list. */
export function pickQuickCourier(list) {
  const q = (list || []).find((c) => /quick/i.test(c.courier_name || '')) || (list || [])[0] || null
  if (!q) return null
  const rate = Number(q.rates ?? q.rate ?? q.freight_charge)
  return { courierName: q.courier_name || 'Shiprocket Quick', courierId: q.courier_company_id ?? null, rate: Number.isFinite(rate) ? rate : null }
}

// ── Simulation (demo) mode helpers — never touch the network ─────────────────

export function haversineKm(lat1, lng1, lat2, lng2) {
  const rad = (d) => (Number(d) * Math.PI) / 180
  const dLat = rad(lat2 - lat1)
  const dLng = rad(lng2 - lng1)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(h))
}

/** A believable demo price: ₹40 base + ₹6/km, rounded. */
export function simulatedRate(km) {
  const d = Number.isFinite(km) ? km : 0
  return Math.round(40 + 6 * d)
}

const SIM_NEXT = {
  CREATED: 'ASSIGNED',
  ASSIGNING: 'ASSIGNED',
  ASSIGNED: 'PICKED_UP',
  PICKED_UP: 'OUT_FOR_DELIVERY',
  OUT_FOR_DELIVERY: 'DELIVERED',
}
const SIM_LABEL = {
  ASSIGNED: 'Rider assigned (demo)',
  PICKED_UP: 'Picked up (demo)',
  OUT_FOR_DELIVERY: 'Out for delivery (demo)',
  DELIVERED: 'Delivered (demo)',
}

/** The next demo status + the fields to store, or null when the shipment is already finished. */
export function nextSimulationStep(current, orderNumber = 'ORDER') {
  const status = SIM_NEXT[current]
  if (!status) return null
  const fields = { status, sr_status: SIM_LABEL[status] }
  if (status === 'ASSIGNED') {
    fields.awb_code = `SIM${String(orderNumber).replace(/\D/g, '').slice(-8) || '0001'}`
    fields.courier_name = 'Shiprocket Quick (demo)'
    fields.agent_name = 'Demo Rider'
    fields.agent_phone = '9000000000'
  }
  return fields
}

/**
 * Picks the Shiprocket pickup-location NAME to send. Shiprocket only accepts a name that
 * exists in the account, so: the configured name (case-insensitive) → else the address whose
 * pincode equals the store's → else the only address there is → else null.
 */
export function resolvePickupLocation(list, configured, shopPincode) {
  const items = (list || []).filter((p) => p?.pickup_location)
  const want = String(configured || '').trim().toLowerCase()
  if (want) {
    const hit = items.find((p) => String(p.pickup_location).trim().toLowerCase() === want)
    if (hit) return hit.pickup_location
  }
  const byPin = items.filter((p) => shopPincode && String(p.pin_code) === String(shopPincode))
  if (byPin.length === 1) return byPin[0].pickup_location
  if (items.length === 1) return items[0].pickup_location
  return null
}
