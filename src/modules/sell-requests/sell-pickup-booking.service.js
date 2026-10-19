/**
 * Automatic pickup for a sold phone.
 *
 * Once the buyer (vendor) has paid and the seller chose HOME PICKUP, a Shiprocket *reverse pickup*
 * (customer's home → the vendor's store) is booked without anyone typing an AWB:
 *   - simulation mode (Shiprocket settings → demo): a fake AWB and a stepper, so the whole flow can be tried
 *     without credentials (same switch the order shipments already use);
 *   - live: Shiprocket `orders/create/return` → AWB assignment → pickup request;
 *   - anything else (no credentials, API error): nothing is booked and the vendor can still book a courier by
 *     hand exactly as before. The reason is written to the request timeline.
 * Courier status then arrives through the existing webhook / sync (DELIVERED at the store = received).
 *
 * @module modules/sell-requests/sell-pickup-booking.service
 */
import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { SellError, addEvent, getSettings, tx } from './sell-requests.service.js'
import { notifySellEvent } from './sell-requests.notify.js'

const text = (v, max) => String(v ?? '').trim().slice(0, max)
const SIM_STEPS = ['PICKED_UP', 'IN_TRANSIT']   // the vendor confirms "received" itself

async function shiprocketRow() {
  try {
    const { ShiprocketRepository } = await import('../shiprocket/shiprocket.repository.js')
    const repo = new ShiprocketRepository()
    return { repo, row: await repo.get() }
  } catch (err) {
    logger.warn({ err: err.message }, 'sell auto-pickup: Shiprocket settings unavailable')
    return { repo: null, row: null }
  }
}

/** Split "line1, line2, city, state, 700001" (the way saved addresses are stored) into parts. */
function addressParts(r) {
  const parts = String(r.pickup_address || '').split(',').map((s) => s.trim()).filter(Boolean)
  const pin = r.pickup_pincode
  if (parts.length && parts[parts.length - 1] === pin) parts.pop()
  const state = parts.length >= 3 ? parts[parts.length - 1] : ''
  const city = r.customer_city && r.customer_city !== '—' ? r.customer_city : (parts.length >= 3 ? parts[parts.length - 2] : '')
  return { line: String(r.pickup_address || '').slice(0, 220), city, state, pin }
}

/** node-pg returns DATE columns as local-midnight Date objects. */
function pickupAt(d) {
  if (!d) return null
  const x = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(x.getTime())) return null
  const p = (n) => String(n).padStart(2, '0')
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T09:00:00`
}

async function insertPickup(client, r, f) {
  const { rows: [p] } = await client.query(
    `INSERT INTO sell_pickups (request_id, provider, awb, courier_name, tracking_url, status, scheduled_at, note, is_simulated, auto_booked, provider_shipment_id)
     VALUES ($1,'SHIPROCKET',$2,$3,$4,'PICKUP_SCHEDULED',$5,$6,$7,TRUE,$8)
     ON CONFLICT (request_id) DO NOTHING RETURNING id`,
    [r.id, f.awb, f.courier, f.trackingUrl || null, pickupAt(r.pickup_date), f.note || null, Boolean(f.simulated), f.shipmentId || null])
  if (!p) return false
  await client.query(`INSERT INTO sell_pickup_events (pickup_id, status, note) VALUES ($1,'PICKUP_SCHEDULED',$2)`, [p.id, f.simulated ? 'Pickup booked automatically (demo)' : 'Pickup booked automatically'])
  await client.query(`UPDATE sell_requests SET stage = 'PICKUP_SCHEDULED', updated_at = NOW() WHERE id = $1`, [r.id])
  await addEvent(client, r.id, 'PICKUP_SCHEDULED', 'Pickup scheduled', null, { provider: 'SHIPROCKET', auto: true, simulated: Boolean(f.simulated) })
  return true
}

/**
 * Book the pickup if everything is in place. Safe to call repeatedly (after funding, after the customer picks a slot).
 * Returns 'BOOKED' | 'SKIPPED' | 'FAILED'.
 */
export async function autoBookPickup(requestId) {
  const { rows: [r] } = await query(
    `SELECT r.*, v.name AS vendor_name, v.phone AS vendor_phone FROM sell_requests r LEFT JOIN vendors v ON v.id = r.assigned_vendor_id WHERE r.id = $1 AND r.kind = 'SELL'`, [requestId])
  if (!r || r.fulfilment !== 'PICKUP' || r.stage !== 'PICKUP_REQUESTED' || ['CANCELLED', 'REJECTED', 'COMPLETED'].includes(r.status)) return 'SKIPPED'
  const s = await getSettings()
  if (s.require_vendor_funding && r.vendor_payment_status !== 'HELD') return 'SKIPPED'
  const { rows: [have] } = await query('SELECT 1 FROM sell_pickups WHERE request_id = $1', [requestId])
  if (have) return 'SKIPPED'

  const { repo, row } = await shiprocketRow()
  let booked = false
  try {
    if (row?.simulation_mode) {
      booked = await tx((client) => insertPickup(client, r, { awb: `SIM-${r.code}`, courier: 'Shiprocket Quick (demo)', simulated: true, note: 'Demo pickup' }))
    } else {
      const creds = repo ? await repo.getCredentialsDecrypted() : null
      if (!creds) throw new Error('Shiprocket is not set up')
      const { ShiprocketClient } = await import('../shiprocket/shiprocket.client.js')
      const client = new ShiprocketClient(creds)
      const { rows: [shop] } = await query(
        `SELECT name, address_line1, city, state, pincode FROM shops WHERE vendor_id = $1 AND deleted_at IS NULL AND is_active ORDER BY created_at LIMIT 1`, [r.assigned_vendor_id])
      if (!shop?.pincode) throw new Error('The buyer has no store address')
      const a = addressParts(r)
      if (!a.city || !a.state || !/^\d{6}$/.test(a.pin || '')) throw new Error('The seller address is missing city, state or pincode')
      const created = await client.request('orders/create/return', {
        method: 'POST',
        body: {
          order_id: `${r.code}-R`, order_date: new Date().toISOString().slice(0, 10),
          pickup_customer_name: text(r.customer_name, 60) || 'Seller', pickup_address: a.line, pickup_city: a.city, pickup_state: a.state,
          pickup_country: 'India', pickup_pincode: a.pin, pickup_email: r.customer_email || 'sell@dealker.in', pickup_phone: String(r.customer_phone || '').replace(/\D/g, '').slice(-10), pickup_isd_code: '91',
          shipping_customer_name: text(shop.name || r.vendor_name, 60), shipping_address: text(shop.address_line1, 220) || text(shop.name, 60), shipping_city: shop.city, shipping_country: 'India',
          shipping_pincode: shop.pincode, shipping_state: shop.state || '', shipping_email: 'store@dealker.in', shipping_isd_code: '91', shipping_phone: String(r.vendor_phone || '').replace(/\D/g, '').slice(-10),
          order_items: [{ name: `${r.model_name} ${r.variant}`.slice(0, 80), sku: r.code, units: 1, selling_price: Number(r.final_price), discount: 0, qc_enable: false }],
          payment_method: 'PREPAID', total_discount: '0', sub_total: Number(r.final_price), length: 20, breadth: 12, height: 8, weight: 0.5,
        },
      })
      const shipmentId = created?.shipment_id
      if (!shipmentId) throw new Error('Shiprocket did not return a shipment')
      let awb = null, courier = null
      try {
        const asg = await client.request('courier/assign/awb', { method: 'POST', body: { shipment_id: shipmentId, is_return: 1 } })
        awb = asg?.response?.data?.awb_code || asg?.data?.awb_code || null
        courier = asg?.response?.data?.courier_name || asg?.data?.courier_name || null
        if (awb) await client.request('courier/generate/pickup', { method: 'POST', body: { shipment_id: [shipmentId] } }).catch(() => {})
      } catch (err) { logger.warn({ err: err.message, requestId }, 'sell auto-pickup: AWB assignment pending') }
      booked = await tx((c) => insertPickup(c, r, {
        awb, courier: courier || 'Shiprocket', shipmentId: String(shipmentId), trackingUrl: awb ? `https://shiprocket.co/tracking/${awb}` : null,
        note: awb ? null : 'Waiting for Shiprocket to assign a courier' }))
    }
  } catch (err) {
    logger.error({ err: err?.message, requestId }, 'sell auto-pickup failed — vendor can book manually')
    await tx((c) => addEvent(c, requestId, 'PICKUP_AUTO_FAILED', 'Automatic pickup could not be booked; the buyer will arrange it', null, { reason: text(err?.message, 200) })).catch(() => {})
    return 'FAILED'
  }
  if (booked) notifySellEvent('PICKUP_SCHEDULED', requestId)
  return booked ? 'BOOKED' : 'SKIPPED'
}

/** Demo only: move a simulated pickup forward (picked up → in transit). The vendor confirms "received" itself. */
export async function advanceSimulation(actor, id) {
  const journey = await import('./sell-journey.service.js')
  const { rows: [p] } = await query('SELECT * FROM sell_pickups WHERE request_id = $1', [id])
  if (!p?.is_simulated) throw new SellError('NOT_SIMULATED', 'This pickup is not a demo pickup', 409)
  await journey.getManageJourney(actor, id)   // visibility
  const next = SIM_STEPS.find((st) => SIM_STEPS.indexOf(st) > SIM_STEPS.indexOf(p.status)) || (p.status === 'PICKUP_SCHEDULED' ? 'PICKED_UP' : null)
  if (!next) throw new SellError('INVALID_STATE', 'The demo pickup is already in transit — mark the phone received', 409)
  return journey.setPickupStatus(actor, id, next, { note: 'Demo courier update' })
}

/** The courier reached the store but nobody could take the phone: record it, tell the seller, keep the phone with the courier. */
export async function storeClosed(actor, id, { note } = {}) {
  await tx(async (client) => {
    const { rows: [r] } = await client.query('SELECT * FROM sell_requests WHERE id = $1 AND kind = $2 FOR UPDATE', [id, 'SELL'])
    if (!r || (actor.kind === 'VENDOR' && r.assigned_vendor_id !== actor.vendorId)) throw new SellError('NOT_FOUND', 'Sell request not found', 404)
    if (!['PICKED_UP', 'IN_TRANSIT'].includes(r.stage)) throw new SellError('INVALID_STATE', 'The phone is not on its way to the store right now', 409)
    const { rows: [p] } = await client.query('SELECT id FROM sell_pickups WHERE request_id = $1', [id])
    const why = text(note, 200) || 'Store was closed'
    if (p) await client.query(`INSERT INTO sell_pickup_events (pickup_id, status, note) VALUES ($1,'IN_TRANSIT',$2)`, [p.id, `Delivery attempt failed: ${why}. Will be retried.`])
    await addEvent(client, id, 'STORE_CLOSED', 'Store was closed — delivery will be retried', actor, { note: why })
  })
  notifySellEvent('STORE_CLOSED', id)
  const journey = await import('./sell-journey.service.js')
  return journey.getManageJourney(actor, id)
}
