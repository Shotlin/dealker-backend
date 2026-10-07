/**
 * Shiprocket adapter — reuses the existing, credential-managed Shiprocket
 * client (src/modules/shiprocket/shiprocket.client.js: AES-256-GCM encrypted
 * settings, in-process token cache, 401 re-login). Only the documented
 * apiv2.shiprocket.in/v1/external paths the client already talks to are used.
 *
 * @module modules/shipping/providers/shiprocket.adapter
 */

import { implementsInterface } from './provider-interface.js'

const STATUS_MAP = Object.freeze({
  // Shiprocket statuses → internal vocabulary
  'NEW': 'CREATED',
  'PICKUP SCHEDULED': 'PICKUP_SCHEDULED',
  'PICKED UP': 'PICKED_UP',
  'IN TRANSIT': 'IN_TRANSIT',
  'OUT FOR DELIVERY': 'OUT_FOR_DELIVERY',
  'DELIVERED': 'DELIVERED',
  'CANCELED': 'CANCELLED',
  'CANCELLED': 'CANCELLED',
  'UNDELIVERED': 'FAILED',
  'RTO INITIATED': 'RTO',
  'RTO DELIVERED': 'RTO',
  'LOST': 'FAILED',
})

class ShiprocketAdapter {
  constructor({ settings = {}, clientFactory = null } = {}) {
    this.settings = settings
    // The existing module owns credentials + token lifecycle.
    this.clientFactory = clientFactory
    this.client = null
  }

  async #getClient() {
    if (this.client) return this.client
    const { ShiprocketClient } = await import('../../shiprocket/shiprocket.client.js')
    this.client = this.clientFactory ? this.clientFactory() : new ShiprocketClient()
    return this.client
  }

  async checkServiceability({ pickupPincode, deliveryPincode, cod = 0, weightGrams = 500 } = {}) {
    if (!pickupPincode || !deliveryPincode) return { serviceable: false }
    const client = await this.#getClient()
    try {
      // checkQuick hits the courier serviceability + hyperlocal quick endpoint.
      const res = await client.checkQuick({
        pickupPostcode: String(pickupPincode),
        deliveryPostcode: String(deliveryPincode),
        cod: cod > 0 ? 1 : 0,
      })
      const available = Array.isArray(res?.data?.available_courier_companies)
        ? res.data.available_courier_companies
        : (Array.isArray(res?.available_courier_companies) ? res.available_courier_companies : [])
      const etas = available.map((c) => Number(c.estimated_delivery_days)).filter(Number.isFinite)
      return {
        serviceable: available.length > 0,
        etaDays: etas.length ? Math.min(...etas) : null,
        couriers: available.map((c) => ({
          courier: c.courier_name,
          charge: Number(c.rate || c.freight_charge || 0),
          etaDays: Number(c.estimated_delivery_days || 0) || null,
        })),
      }
    } catch {
      return { serviceable: false }
    }
  }

  async getRates(ctx) {
    const res = await this.checkServiceability(ctx)
    return res.couriers || []
  }

  /**
   * order = { sellerOrder, shipment, pickup: {pincode, name, address}, delivery: {pincode, name, address, phone}, items, codAmount }
   */
  async createShipment(order) {
    const client = await this.#getClient()
    const body = {
      order_id: order.sellerOrder.seller_order_number,
      order_date: new Date().toISOString().slice(0, 10),
      pickup_location: order.pickup?.name || 'Primary',
      billing_customer_name: order.delivery?.name || 'Customer',
      billing_last_name: '',
      billing_address: order.delivery?.address || '',
      billing_city: order.delivery?.city || '',
      billing_pincode: String(order.delivery?.pincode || ''),
      billing_state: order.delivery?.state || '',
      billing_country: 'India',
      billing_email: order.delivery?.email || '',
      billing_phone: String(order.delivery?.phone || ''),
      shipping_is_billing: true,
      order_items: (order.items || []).map((item) => ({
        name: item.product_name || item.name || 'Item',
        sku: item.sku || item.seller_sku || String(item.product_id || ''),
        units: Number(item.quantity || 1),
        selling_price: Number(item.unit_price || 0),
      })),
      payment_method: order.codAmount > 0 ? 'COD' : 'Prepaid',
      sub_total: Number(order.sellerOrder.item_subtotal || 0),
      length: Number(order.sellerOrder.package_length_cm || 10),
      breadth: Number(order.sellerOrder.package_width_cm || 10),
      height: Number(order.sellerOrder.package_height_cm || 5),
      weight: Number(order.sellerOrder.weight_grams || 500) / 1000,
    }
    // Documented v1/external endpoints — created through the shared client.
    const created = await client.request('orders/create/adhoc', { method: 'POST', body })
    let awb = null
    let courier = null
    try {
      const assignment = await client.request('courier/assign/awb', {
        method: 'POST',
        body: { shipment_id: created?.shipment_id },
      })
      awb = assignment?.response?.data?.awb_code || assignment?.data?.awb_code || null
      courier = assignment?.response?.data?.courier_name || assignment?.data?.courier_name || null
    } catch {
      // AWB assignment can lag creation; the poller picks it up later.
    }
    return {
      providerOrderId: String(created?.order_id || ''),
      providerShipmentId: String(created?.shipment_id || ''),
      awb,
      courier,
      labelUrl: created?.label_url || null,
    }
  }

  async cancelShipment(shipment) {
    const client = await this.#getClient()
    await client.request('orders/cancel/shipment/awbs', {
      method: 'POST',
      body: { awbs: [shipment.awb] },
    })
    return { ok: true }
  }

  async trackShipment(shipment) {
    const client = await this.#getClient()
    const res = await client.request(`courier/track/awb/${shipment.awb}`, { method: 'GET' })
    const data = res?.tracking_data || res?.data?.tracking_data || {}
    const track = Array.isArray(data?.shipment_track) ? data.shipment_track[0] : {}
    const activities = Array.isArray(data?.shipment_track_activities)
      ? data.shipment_track_activities
      : []
    return {
      status: this.mapStatus(track?.current_status),
      providerStatus: track?.current_status || null,
      estimatedDelivery: track?.edd ? new Date(track.edd) : null,
      events: activities.map((a) => ({
        status: this.mapStatus(a?.activity),
        providerStatus: a?.activity || null,
        note: a?.activity || null,
        eventLocation: a?.location || null,
        occurredAt: a?.date ? new Date(a.date) : null,
      })),
    }
  }

  mapStatus(providerStatus) {
    if (!providerStatus) return null
    return STATUS_MAP[String(providerStatus).toUpperCase()] || null
  }
}

export default implementsInterface(ShiprocketAdapter)
