/**
 * Shipping Service — rules-based carrier selection, shipment lifecycle and
 * status mapping. A marketplace order NEVER fails because one provider is
 * unavailable: every provider call goes through the fallback chain (§45).
 *
 * @module modules/shipping/shipping.service
 */

import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { encryptSecret, decryptSecret } from '../../utils/encryption.js'
import { ProviderNotConfiguredError } from './providers/provider-interface.js'

const PROVIDERS = ['SHIPROCKET', 'BLUEDART', 'PORTER']

export class ShippingService {
  #adapters = new Map()

  async #adapter(provider) {
    if (this.#adapters.has(provider)) return this.#adapters.get(provider)
    let Adapter
    if (provider === 'SHIPROCKET') {
      Adapter = (await import('./providers/shiprocket.adapter.js')).default
    } else if (provider === 'BLUEDART') {
      Adapter = (await import('./providers/bluedart.adapter.js')).default
    } else if (provider === 'PORTER') {
      Adapter = (await import('./providers/porter.adapter.js')).default
    } else {
      throw new Error(`Unknown provider ${provider}`)
    }
    const settings = await this.getProviderSettings(provider)
    const adapter = new Adapter({ settings })
    this.#adapters.set(provider, adapter)
    return adapter
  }

  // ── Provider settings (encrypted credentials) ─────────────────────────

  async listProviderSettings() {
    const { rows } = await query(
      `SELECT provider, enabled, mode, last_tested_at, last_test_status, last_test_message
         FROM shipping_provider_settings ORDER BY provider`
    )
    // Shiprocket's own settings module remains the credential source for
    // SHIPROCKET; report its configured state here.
    const { rows: sr } = await query(`SELECT api_email FROM shiprocket_settings LIMIT 1`)
    return rows.map((r) =>
      r.provider === 'SHIPROCKET'
        ? { ...r, configured: !!sr[0]?.api_email }
        : { ...r, configured: false }
    )
  }

  async getProviderSettings(provider) {
    const { rows } = await query(
      `SELECT * FROM shipping_provider_settings WHERE provider = $1 LIMIT 1`, [provider]
    )
    const row = rows[0]
    if (!row) return {}
    const settings = { ...row, api_key: row.api_key_encrypted ? decryptSecret(row.api_key_encrypted) : null }
    return settings
  }

  async updateProviderSettings(provider, patch, actorId = null) {
    const sets = ['updated_at = NOW()']
    const params = [provider]
    if (patch.enabled !== undefined) {
      params.push(!!patch.enabled)
      sets.push(`enabled = $${params.length}`)
    }
    if (patch.mode !== undefined) {
      params.push(String(patch.mode) === 'PRODUCTION' ? 'PRODUCTION' : 'TEST')
      sets.push(`mode = $${params.length}`)
    }
    for (const [column, key] of [['api_key_encrypted', 'apiKey'], ['api_secret_encrypted', 'apiSecret'], ['account_number_encrypted', 'accountNumber']]) {
      if (patch[key] !== undefined && patch[key] !== null && patch[key] !== '') {
        params.push(encryptSecret(String(patch[key])))
        sets.push(`${column} = $${params.length}`)
      }
    }
    if (patch.extraConfig !== undefined) {
      params.push(JSON.stringify(patch.extraConfig || {}))
      sets.push(`extra_config = $${params.length}::jsonb`)
    }
    if (actorId) {
      params.push(actorId)
      sets.push(`updated_by = $${params.length}`)
    }
    await query(
      `INSERT INTO shipping_provider_settings (provider) VALUES ($1) ON CONFLICT (provider) DO NOTHING`,
      [provider]
    )
    await query(
      `UPDATE shipping_provider_settings SET ${sets.join(', ')} WHERE provider = $1`,
      params
    )
    this.#adapters.clear()
    return this.getProviderSettings(provider)
  }

  // ── Rules ─────────────────────────────────────────────────────────────

  async listRules() {
    const { rows } = await query(`SELECT * FROM shipping_rules ORDER BY priority ASC`)
    return rows
  }

  async upsertRule(rule) {
    if (rule.id) {
      const sets = []
      const params = []
      for (const key of ['name', 'priority', 'is_active', 'pickup_pincode_prefix', 'delivery_pincode_prefix', 'max_weight_grams', 'cod_allowed', 'preferred_provider', 'fallback_provider']) {
        if (rule[key] !== undefined) {
          params.push(rule[key])
          sets.push(`${key} = $${params.length}`)
        }
      }
      if (sets.length) {
        params.push(rule.id)
        await query(`UPDATE shipping_rules SET ${sets.join(', ')} WHERE id = $${params.length}`, params)
      }
    } else {
      await query(
        `INSERT INTO shipping_rules (name, priority, pickup_pincode_prefix, delivery_pincode_prefix, max_weight_grams, cod_allowed, preferred_provider, fallback_provider)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [rule.name, rule.priority || 100, rule.pickup_pincode_prefix || null, rule.delivery_pincode_prefix || null,
         rule.max_weight_grams || null, rule.cod_allowed ?? null, rule.preferred_provider || null, rule.fallback_provider || null]
      )
    }
    return this.listRules()
  }

  /** Highest-priority active rule matching the context (NULL = wildcard). */
  async selectProvider(ctx) {
    const { rows } = await query(`SELECT * FROM shipping_rules WHERE is_active = TRUE ORDER BY priority ASC`)
    for (const rule of rows) {
      if (rule.pickup_pincode_prefix && !String(ctx.pickupPincode || '').startsWith(rule.pickup_pincode_prefix)) continue
      if (rule.delivery_pincode_prefix && !String(ctx.deliveryPincode || '').startsWith(rule.delivery_pincode_prefix)) continue
      if (rule.max_weight_grams != null && Number(ctx.weightGrams || 0) > rule.max_weight_grams) continue
      if (rule.cod_allowed != null && !!ctx.cod !== !!rule.cod_allowed) continue
      return { preferred: rule.preferred_provider || 'SHIPROCKET', fallback: rule.fallback_provider || 'BLUEDART' }
    }
    return { preferred: 'SHIPROCKET', fallback: 'BLUEDART' }
  }

  // ── Serviceability & rates ────────────────────────────────────────────

  /**
   * Check every enabled provider, never throwing for an unavailable one.
   * Returns per-provider results plus the recommended provider.
   */
  async checkServiceability(ctx) {
    const routing = await this.selectProvider(ctx)
    const results = []
    for (const provider of PROVIDERS) {
      const settings = await this.getProviderSettings(provider)
      if (!settings.enabled && provider !== 'SHIPROCKET') continue
      try {
        const adapter = await this.#adapter(provider)
        const res = await adapter.checkServiceability(ctx)
        results.push({ provider, ...res })
      } catch (err) {
        if (err instanceof ProviderNotConfiguredError || err.code === 'PROVIDER_NOT_IMPLEMENTED') {
          results.push({ provider, serviceable: false, unavailableReason: err.code })
        } else {
          logger.warn({ err, provider }, 'Serviceability check failed for provider')
          results.push({ provider, serviceable: false, unavailableReason: 'PROVIDER_ERROR' })
        }
      }
    }
    const serviceable = results.filter((r) => r.serviceable)
    const preferredResult = serviceable.find((r) => r.provider === routing.preferred)
    return {
      routing,
      results,
      recommended: preferredResult?.provider || serviceable[0]?.provider || null,
    }
  }

  // ── Shipment lifecycle ────────────────────────────────────────────────

  /** Public health probe used by the admin "test provider" endpoint. */
  async testProvider(provider, ctx = {}) {
    const adapter = await this.#adapter(provider)
    return adapter.checkServiceability(ctx)
  }

  async createShipmentForSellerOrder(sellerOrderId, actorId = null) {
    const { rows: soRows } = await query(
      `SELECT so.*, o.delivery_address, o.payment_method, o.payment_status
         FROM seller_orders so JOIN orders o ON o.id = so.order_id
        WHERE so.id = $1 LIMIT 1`,
      [sellerOrderId]
    )
    const sellerOrder = soRows[0]
    if (!sellerOrder) {
      const err = new Error('Seller order not found')
      err.code = 'NOT_FOUND'
      throw err
    }
    const { rows: items } = await query(
      `SELECT * FROM order_items WHERE seller_order_id = $1`, [sellerOrderId]
    )
    const { rows: shopRows } = await query(
      `SELECT * FROM shops WHERE id = $1`, [sellerOrder.shop_id]
    )
    const shop = shopRows[0] || {}
    const weightGrams = Number(sellerOrder.weight_grams || items.reduce((s, i) => s + 500 * Number(i.quantity || 1), 500))
    const codAmount = sellerOrder.payment_method === 'COD' && sellerOrder.payment_status !== 'PAID'
      ? Number(sellerOrder.payable_to_seller || 0) + Number(sellerOrder.shipping_charge || 0)
      : 0

    const routing = await this.selectProvider({
      pickupPincode: shop.pincode,
      deliveryPincode: sellerOrder.delivery_address?.pincode,
      weightGrams,
      cod: codAmount > 0,
    })

    const ctx = {
      pickupPincode: shop.pincode,
      deliveryPincode: sellerOrder.delivery_address?.pincode,
      cod: codAmount,
      weightGrams,
    }

    let lastError = null
    for (const provider of [routing.preferred, routing.fallback, 'SHIPROCKET']) {
      if (!provider) continue
      try {
        const adapter = await this.#adapter(provider)
        const created = await adapter.createShipment({
          sellerOrder: { ...sellerOrder, weight_grams: weightGrams },
          items,
          codAmount,
          pickup: { pincode: shop.pincode, name: shop.name, address: shop.address_line1 },
          delivery: {
            pincode: sellerOrder.delivery_address?.pincode,
            name: sellerOrder.delivery_address?.name,
            address: sellerOrder.delivery_address?.address_line1 || sellerOrder.delivery_address?.address,
            city: sellerOrder.delivery_address?.city,
            state: sellerOrder.delivery_address?.state,
            phone: sellerOrder.delivery_address?.phone,
          },
        })
        const { rows: shipment } = await query(
          `INSERT INTO shipments
             (seller_order_id, provider, provider_order_id, provider_shipment_id, awb, courier_name,
              pickup_location, shipping_charge, cod_amount, status, label_url, tracking_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, 'ASSIGNED', $9, $10)
           ON CONFLICT (seller_order_id) DO UPDATE SET
             provider = EXCLUDED.provider, provider_order_id = EXCLUDED.provider_order_id,
             provider_shipment_id = EXCLUDED.provider_shipment_id, awb = EXCLUDED.awb,
             courier_name = EXCLUDED.courier_name, status = 'ASSIGNED', updated_at = NOW()
           RETURNING *`,
          [sellerOrderId, provider, created.providerOrderId, created.providerShipmentId,
           created.awb, created.courier, shop.name, codAmount, created.labelUrl,
           created.awb ? `https://track.shiprocket.co/${created.awb}` : null]
        )
        await query(
          `UPDATE seller_orders SET shipping_provider = $2, shipment_id = $3, updated_at = NOW() WHERE id = $1`,
          [sellerOrderId, provider, shipment[0].id]
        )
        await this.#appendEvent(shipment[0].id, 'ASSIGNED', null, `Shipment created via ${provider}`)
        return shipment[0]
      } catch (err) {
        lastError = err
        logger.warn({ err, provider, sellerOrderId }, 'Provider shipment creation failed — trying fallback')
      }
    }
    throw lastError || new Error('No shipping provider could create this shipment')
  }

  async trackShipment(shipmentId) {
    const { rows } = await query(`SELECT * FROM shipments WHERE id = $1 LIMIT 1`, [shipmentId])
    const shipment = rows[0]
    if (!shipment) {
      const err = new Error('Shipment not found')
      err.code = 'NOT_FOUND'
      throw err
    }
    if (!shipment.awb || shipment.provider === 'SELF') return shipment
    try {
      const adapter = await this.#adapter(shipment.provider)
      const tracked = await adapter.trackShipment(shipment)
      for (const event of tracked.events || []) {
        await this.#appendEvent(shipment.id, event.status || 'PROVIDER_UPDATE', event.providerStatus, event.note, event.eventLocation, event.occurredAt)
      }
      if (tracked.status && tracked.status !== shipment.status) {
        await query(`UPDATE shipments SET status = $2, provider_status = $3, estimated_delivery = COALESCE($4, estimated_delivery), updated_at = NOW() WHERE id = $1`, [shipment.id, tracked.status, tracked.providerStatus, tracked.estimatedDelivery])
        // Map external status into seller-order fulfilment — never blindly.
        if (tracked.status === 'DELIVERED') {
          await query(`UPDATE seller_orders SET status = 'DELIVERED', delivered_at = NOW(), fulfilment_status = 'DELIVERED', updated_at = NOW() WHERE id = $1 AND status NOT IN ('DELIVERED', 'CLOSED', 'CANCELLED')`, [shipment.seller_order_id])
        } else if (tracked.status === 'IN_TRANSIT' || tracked.status === 'OUT_FOR_DELIVERY') {
          await query(`UPDATE seller_orders SET status = 'OUT_FOR_DELIVERY', updated_at = NOW() WHERE id = $1 AND status IN ('SHIPPED', 'READY_TO_SHIP')`, [shipment.seller_order_id])
        }
      }
      return { ...shipment, status: tracked.status || shipment.status, events: tracked.events }
    } catch (err) {
      if (err.code === 'PROVIDER_NOT_CONFIGURED' || err.code === 'PROVIDER_NOT_IMPLEMENTED') return shipment
      throw err
    }
  }

  async cancelShipment(shipmentId, actorId = null) {
    const { rows } = await query(`SELECT * FROM shipments WHERE id = $1 LIMIT 1 FOR UPDATE`, [shipmentId])
    const shipment = rows[0]
    if (!shipment) {
      const err = new Error('Shipment not found')
      err.code = 'NOT_FOUND'
      throw err
    }
    try {
      const adapter = await this.#adapter(shipment.provider)
      await adapter.cancelShipment(shipment)
    } catch (err) {
      if (!(err.code === 'PROVIDER_NOT_CONFIGURED' || err.code === 'PROVIDER_NOT_IMPLEMENTED')) throw err
    }
    await query(`UPDATE shipments SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1`, [shipmentId])
    await this.#appendEvent(shipmentId, 'CANCELLED', null, `Cancelled by ${actorId || 'system'}`)
    return { success: true }
  }

  /** Webhook entry point — signature verification happens per provider. */
  async handleWebhook(provider, payload) {
    // Shiprocket posts { awb, current_status, ... } shaped payloads; locate
    // the shipment by AWB or provider shipment id — never by raw trust.
    const awb = payload?.awb || payload?.awb_code || payload?.data?.awb
    const providerShipmentId = payload?.shipment_id ? String(payload.shipment_id) : null
    const { rows } = await query(
      `SELECT * FROM shipments
        WHERE (awb = $1 AND $1 IS NOT NULL) OR (provider_shipment_id = $2 AND $2 IS NOT NULL)
        LIMIT 1`,
      [awb || null, providerShipmentId]
    )
    const shipment = rows[0]
    if (!shipment) return { matched: false }
    const adapter = await this.#adapter(provider)
    const mapped = adapter.mapStatus(payload.current_status || payload.status)
    await this.#appendEvent(shipment.id, mapped || 'PROVIDER_UPDATE', payload.current_status || payload.status, payload.remark || payload.comment || null, payload.location || null)
    if (mapped && mapped !== shipment.status) {
      await query(`UPDATE shipments SET status = $2, provider_status = $3, updated_at = NOW() WHERE id = $1`, [shipment.id, mapped, payload.current_status || payload.status])
      if (mapped === 'DELIVERED') {
        await query(`UPDATE seller_orders SET status = 'DELIVERED', delivered_at = NOW(), fulfilment_status = 'DELIVERED', updated_at = NOW() WHERE id = $1 AND status NOT IN ('DELIVERED','CLOSED','CANCELLED')`, [shipment.seller_order_id])
      }
    }
    return { matched: true, status: mapped }
  }

  async #appendEvent(shipmentId, status, providerStatus, note, location = null, occurredAt = null) {
    await query(
      `INSERT INTO shipment_events (shipment_id, status, provider_status, note, event_location, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [shipmentId, status, providerStatus, note, location, occurredAt || new Date()]
    )
  }

  async listShipments({ status = '', provider = '', page = 1, limit = 20 } = {}) {
    const params = []
    const where = []
    if (status) { params.push(status); where.push(`sh.status = $${params.length}`) }
    if (provider) { params.push(provider); where.push(`sh.provider = $${params.length}`) }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const offset = (Math.max(1, page) - 1) * limit
    const { rows } = await query(
      `SELECT sh.*, so.seller_order_number, so.vendor_id, o.order_number AS parent_order_number
         FROM shipments sh
         JOIN seller_orders so ON so.id = sh.seller_order_id
         JOIN orders o ON o.id = so.order_id
         ${whereSql}
        ORDER BY sh.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )
    const { rows: count } = await query(
      `SELECT COUNT(*) AS total FROM shipments sh ${whereSql}`, params
    )
    return { data: rows, pagination: { page: Number(page), limit, total: Number(count[0]?.total || 0) } }
  }
}
