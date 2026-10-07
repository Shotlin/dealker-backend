import { query } from '../../config/database.js'
import { announceOrderStatusById } from '../orders/order-events.js'
import { logger } from '../../config/logger.js'
import { ShiprocketRepository } from './shiprocket.repository.js'
import { ShiprocketClient } from './shiprocket.client.js'
import {
  assessEligibility, buildQuickOrderPayload, buildSrOrderRef, isLiveShipment,
  mapTrackingStatus, parseTracking, pickQuickCourier,
  haversineKm, simulatedRate, nextSimulationStep, resolvePickupLocation,
} from './shiprocket.delivery.js'
import { emit } from '../../utils/audit-log.js'

function fail(message, statusCode = 400) {
  const err = new Error(message)
  err.statusCode = statusCode
  return err
}

/** Shiprocket Quick deliveries for individual orders (prepaid only, manual assign). */
export class ShiprocketOrdersService {
  constructor(repository = new ShiprocketRepository(), clientFactory = (c) => new ShiprocketClient(c)) {
    this.repository = repository
    this.clientFactory = clientFactory
    this.clients = new Map()
  }

  async #client() {
    const creds = await this.repository.getCredentialsDecrypted()
    if (!creds) throw fail('Shiprocket credentials are not saved yet')
    const key = `${creds.email}:${creds.password.length}`
    if (!this.clients.has(key)) this.clients = new Map([[key, this.clientFactory(creds)]])
    return { client: this.clients.get(key), creds }
  }

  async #simulated() {
    try {
      return Boolean((await this.repository.get())?.simulation_mode)
    } catch {
      return false
    }
  }

  async #load(orderId) {
    const { rows } = await query(
      `SELECT o.id, o.order_number, o.status, o.shop_id, o.rider_id, o.payment_method, o.payment_status,
              o.total_payable, o.delivery_address, o.created_at,
              u.name AS customer_name, u.phone AS customer_phone, u.email AS customer_email
       FROM orders o LEFT JOIN users u ON u.id = o.customer_id WHERE o.id = $1`,
      [orderId]
    )
    const order = rows[0]
    if (!order) throw fail('Order not found', 404)
    if (typeof order.delivery_address === 'string') order.delivery_address = JSON.parse(order.delivery_address)
    const { rows: shopRows } = await query('SELECT id, name, city, pincode, lat, lng FROM shops WHERE id = $1', [order.shop_id])
    const { rows: shipRows } = await query('SELECT * FROM shiprocket_shipments WHERE order_id = $1', [orderId])
    const { rows: itemRows } = await query(
      'SELECT product_id, product_name AS name, unit_price AS price, quantity FROM order_items WHERE order_id = $1',
      [orderId]
    )
    return {
      order,
      shop: shopRows[0] ? { ...shopRows[0], lat: Number(shopRows[0].lat), lng: Number(shopRows[0].lng) } : null,
      shipment: shipRows[0] || null,
      items: itemRows,
    }
  }

  assertShop(order, requestShopId) {
    if (requestShopId && order.shop_id !== requestShopId) throw fail('This order belongs to another shop', 403)
  }

  /** Read-only: is the order eligible, is Quick available, and at what price. */
  async check(orderId, requestShopId) {
    const { order, shop, shipment } = await this.#load(orderId)
    this.assertShop(order, requestShopId)
    const reason = assessEligibility({ order, shop, shipment })
    if (reason) return { eligible: false, reason, available: false, rate: null, shipment }
    if (await this.#simulated()) {
      const a = order.delivery_address
      const km = haversineKm(shop.lat, shop.lng, a.lat, a.lng)
      return { eligible: true, reason: null, available: true, rate: simulatedRate(km), courierName: 'Shiprocket Quick (demo)', simulated: true, shipment }
    }
    const { client } = await this.#client()
    const a = order.delivery_address
    try {
      const list = await client.checkQuick({
        pickupPostcode: shop.pincode, deliveryPostcode: a.pincode,
        fromLat: shop.lat, fromLng: shop.lng, toLat: a.lat, toLng: a.lng,
      })
      const quick = pickQuickCourier(list)
      return quick
        ? { eligible: true, reason: null, available: true, rate: quick.rate, courierName: quick.courierName, shipment }
        : { eligible: true, reason: 'Shiprocket Quick is not available for this address', available: false, rate: null, shipment }
    } catch (err) {
      return { eligible: true, reason: err.message, available: false, rate: null, shipment }
    }
  }

  /** Creates the Shiprocket order and requests a rider. */
  async assign(orderId, adminId, requestShopId) {
    const { order, shop, shipment, items } = await this.#load(orderId)
    this.assertShop(order, requestShopId)
    const reason = assessEligibility({ order, shop, shipment })
    if (reason) throw fail(reason, 409)
    if (await this.#simulated()) {
      const stamp = Date.now()
      const row = await this.#upsert(orderId, {
        sr_order_ref: `SIM-${order.order_number}`, sr_order_id: stamp, sr_shipment_id: stamp + 1,
        status: 'ASSIGNING', last_error: null, created_by: adminId, is_simulated: true,
      })
      const withLabel = await this.#update(orderId, { sr_status: 'Finding a rider (demo)' })
      emit('shiprocket_order_assigned_simulated', { actor_user_id: adminId, target_type: 'orders', target_id: orderId })
      return withLabel || row
    }
    const { client, creds } = await this.#client()
    // Shiprocket only accepts a pickup NAME that exists in the account — resolve it from the real list.
    const pickups = await client.listPickupLocations().catch(() => null)
    const pickupLocation = pickups ? resolvePickupLocation(pickups, creds.pickupLocation, shop.pincode) : creds.pickupLocation
    if (!pickupLocation) {
      const names = (pickups || []).map((p) => `"${p.pickup_location}"`).join(', ')
      throw fail(
        pickups?.length
          ? `No Shiprocket pickup address matches "${creds.pickupLocation || ''}" or pincode ${shop.pincode}. Your Shiprocket pickup addresses: ${names}. Save the exact name on the Shiprocket settings page.`
          : 'Your Shiprocket account has no pickup address. Add one in Shiprocket → Settings → Pickup Addresses.',
        422
      )
    }

    // Only bump the id suffix if the previous attempt really created an order at Shiprocket.
    const attempt = shipment?.sr_order_id ? Number(String(shipment.sr_order_ref).split('-R')[1] || 0) + 1 : Number(String(shipment?.sr_order_ref || '').split('-R')[1] || 0)
    const srOrderRef = buildSrOrderRef(order.order_number, attempt)
    const payload = buildQuickOrderPayload({
      order, shop, items, pickupLocation, srOrderRef,
      customer: { name: order.customer_name, phone: order.customer_phone, email: order.customer_email },
    })

    let created
    try {
      created = await client.createQuickOrder(payload)
    } catch (err) {
      await this.#saveFailure(orderId, srOrderRef, err.message, adminId)
      throw fail(`Shiprocket rejected the order: ${err.message}`, 422)
    }
    if (!created?.order_id || !created?.shipment_id) {
      const detail = String(created?.message || JSON.stringify(created) || 'empty response').slice(0, 300)
      await this.#saveFailure(orderId, srOrderRef, `Shiprocket did not return an order id: ${detail}`, adminId)
      logger.warn({ orderId, response: created }, 'Shiprocket create returned no order/shipment id')
      throw fail(`Shiprocket did not create the order: ${detail}`, 422)
    }
    const row = await this.#upsert(orderId, {
      sr_order_ref: srOrderRef, sr_order_id: created.order_id, sr_shipment_id: created.shipment_id,
      status: 'CREATED', last_error: null, created_by: adminId,
    })
    try {
      await client.assignAwb(created.shipment_id)
      await this.#update(orderId, { status: 'ASSIGNING' })
    } catch (err) {
      await this.#update(orderId, { last_error: `Rider assignment failed: ${err.message}` })
      throw fail(`Order created in Shiprocket but rider assignment failed: ${err.message}. Press Assign again to retry.`, 422)
    }
    emit('shiprocket_order_assigned', {
      actor_user_id: adminId, target_type: 'orders', target_id: orderId,
      after: { srOrderRef, srOrderId: created.order_id },
    })
    return { ...row, status: 'ASSIGNING' }
  }

  /** Re-reads Shiprocket tracking, stores it, and moves our order status forward. */
  async refresh(orderId) {
    const { rows } = await query('SELECT * FROM shiprocket_shipments WHERE order_id = $1', [orderId])
    const sh = rows[0]
    if (!sh || !isLiveShipment(sh) || !sh.sr_shipment_id || sh.is_simulated) return sh || null
    const { client } = await this.#client()
    let info
    try {
      info = parseTracking(await client.trackShipment(sh.sr_shipment_id))
    } catch (err) {
      logger.warn({ err: err.message, orderId }, 'Shiprocket tracking failed')
      return sh
    }
    const mapped = mapTrackingStatus(info.statusText)
    const next = mapped || (info.awb && sh.status === 'ASSIGNING' ? 'ASSIGNED' : sh.status)
    const updated = await this.#update(orderId, {
      status: next, sr_status: info.statusText, awb_code: info.awb || sh.awb_code,
      courier_name: info.courierName || sh.courier_name,
      agent_name: info.agentName || sh.agent_name, agent_phone: info.agentPhone || sh.agent_phone,
      tracking_url: info.trackingUrl || sh.tracking_url,
    })
    if (next !== sh.status) await this.#syncOrderStatus(orderId, next)
    return updated
  }

  async syncActive() {
    const { rows } = await query(
      `SELECT order_id FROM shiprocket_shipments
       WHERE status IN ('ASSIGNING','ASSIGNED','PICKED_UP','OUT_FOR_DELIVERY') AND is_simulated = FALSE LIMIT 100`
    )
    for (const r of rows) {
      try { await this.refresh(r.order_id) } catch (err) { logger.warn({ err: err.message }, 'Shiprocket sync failed') }
    }
    return rows.length
  }

  async cancel(orderId, adminId, requestShopId) {
    const { order, shipment } = await this.#load(orderId)
    this.assertShop(order, requestShopId)
    if (!isLiveShipment(shipment)) throw fail('No active Shiprocket delivery for this order', 409)
    if (['PICKED_UP', 'OUT_FOR_DELIVERY'].includes(shipment.status)) throw fail('The rider already picked this up — it cannot be cancelled', 409)
    if (!shipment.is_simulated) {
      const { client } = await this.#client()
      try {
        await client.cancelOrders([Number(shipment.sr_order_id)])
      } catch (err) {
        throw fail(`Shiprocket could not cancel: ${err.message}`, 422)
      }
    }
    const row = await this.#update(orderId, { status: 'CANCELLED' })
    emit('shiprocket_order_cancelled', { actor_user_id: adminId, target_type: 'orders', target_id: orderId })
    return row
  }

  /** Demo only: move a simulated shipment one step forward (rider assigned → picked up → out → delivered). */
  async advanceSimulation(orderId, adminId, requestShopId) {
    const { order, shipment } = await this.#load(orderId)
    this.assertShop(order, requestShopId)
    if (!shipment?.is_simulated) throw fail('This order is not a demo (simulated) shipment', 409)
    if (!isLiveShipment(shipment)) throw fail('The demo delivery is already finished', 409)
    const step = nextSimulationStep(shipment.status, order.order_number)
    if (!step) throw fail('The demo delivery is already finished', 409)
    const updated = await this.#update(orderId, step)
    await this.#syncOrderStatus(orderId, step.status)
    emit('shiprocket_simulation_advanced', { actor_user_id: adminId, target_type: 'orders', target_id: orderId, after: { status: step.status } })
    return updated
  }

  async get(orderId) {
    const { rows } = await query('SELECT * FROM shiprocket_shipments WHERE order_id = $1', [orderId])
    return rows[0] || null
  }

  async #syncOrderStatus(orderId, status) {
    const target = status === 'DELIVERED' ? 'DELIVERED' : status === 'OUT_FOR_DELIVERY' || status === 'PICKED_UP' ? 'OUT_FOR_DELIVERY' : null
    if (!target) return
    const { rows } = await query(
      `UPDATE orders SET status = $2, delivered_at = CASE WHEN $2 = 'DELIVERED' THEN NOW() ELSE delivered_at END, updated_at = NOW()
       WHERE id = $1 AND status NOT IN ('DELIVERED','CANCELLED','REFUNDED','RETURNED') AND status <> $2
       RETURNING id`,
      [orderId, target]
    )
    if (rows[0]) {
      await query(
        `INSERT INTO order_status_history (order_id, to_status, note) VALUES ($1, $2, 'Updated by Shiprocket Quick')`,
        [orderId, target]
      )
      // Same customer notification + realtime event every other status
      // writer produces — previously a Shiprocket-driven DELIVERED reached
      // neither the customer's app nor the dashboard until a manual refresh.
      await announceOrderStatusById(orderId, target)
    }
  }

  async #upsert(orderId, f) {
    const { rows } = await query(
      `INSERT INTO shiprocket_shipments (order_id, sr_order_ref, sr_order_id, sr_shipment_id, status, last_error, created_by, is_simulated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (order_id) DO UPDATE SET sr_order_ref = EXCLUDED.sr_order_ref, sr_order_id = EXCLUDED.sr_order_id,
         sr_shipment_id = EXCLUDED.sr_shipment_id, status = EXCLUDED.status, last_error = EXCLUDED.last_error,
         is_simulated = EXCLUDED.is_simulated,
         awb_code = NULL, agent_name = NULL, agent_phone = NULL, tracking_url = NULL, sr_status = NULL,
         updated_at = NOW()
       RETURNING *`,
      [orderId, f.sr_order_ref, f.sr_order_id, f.sr_shipment_id, f.status, f.last_error, f.created_by, Boolean(f.is_simulated)]
    )
    return rows[0]
  }

  async #saveFailure(orderId, srOrderRef, message, adminId) {
    await query(
      `INSERT INTO shiprocket_shipments (order_id, sr_order_ref, status, last_error, created_by)
       VALUES ($1,$2,'FAILED',$3,$4)
       ON CONFLICT (order_id) DO UPDATE SET status = 'FAILED', last_error = EXCLUDED.last_error, sr_order_ref = EXCLUDED.sr_order_ref, updated_at = NOW()`,
      [orderId, srOrderRef, message, adminId]
    )
  }

  async #update(orderId, fields) {
    const keys = Object.keys(fields)
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ')
    const { rows } = await query(
      `UPDATE shiprocket_shipments SET ${sets}, updated_at = NOW() WHERE order_id = $1 RETURNING *`,
      [orderId, ...keys.map((k) => fields[k])]
    )
    return rows[0]
  }
}
