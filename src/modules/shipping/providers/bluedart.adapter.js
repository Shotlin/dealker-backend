/**
 * Blue Dart adapter — direct-carrier shell behind the normalized interface.
 *
 * Blue Dart's shipper API requires a licensed account (api key, licence key,
 * account number). Credentials arrive encrypted via shipping_provider_settings
 * (migration 158). Until an account is configured the adapter reports
 * NOT_CONFIGURED and the shipping rules engine falls back to the national
 * aggregator — a route is never failed because Blue Dart is unavailable
 * (spec §45). Method bodies follow the interface contract; they activate
 * once credential-verified endpoints are wired against a live account.
 *
 * @module modules/shipping/providers/bluedart.adapter
 */

import {
  implementsInterface,
  ProviderNotConfiguredError,
  ProviderNotImplementedError,
} from './provider-interface.js'

const STATUS_MAP = Object.freeze({
  'BOOKED': 'ASSIGNED',
  'PICKED UP': 'PICKED_UP',
  'IN TRANSIT': 'IN_TRANSIT',
  'OUT FOR DELIVERY': 'OUT_FOR_DELIVERY',
  'DELIVERED': 'DELIVERED',
  'SHIPMENT CANCELLED': 'CANCELLED',
  'UNDELIVERED': 'FAILED',
  'RTO': 'RTO',
})

class BlueDartAdapter {
  constructor({ settings = {} } = {}) {
    this.settings = settings
  }

  #requireConfigured() {
    if (!this.settings?.api_key_encrypted) {
      throw new ProviderNotConfiguredError('BLUEDART')
    }
  }

  async checkServiceability() {
    this.#requireConfigured()
    throw new ProviderNotImplementedError('BLUEDART', 'checkServiceability')
  }

  async getRates() {
    this.#requireConfigured()
    throw new ProviderNotImplementedError('BLUEDART', 'getRates')
  }

  async createShipment() {
    this.#requireConfigured()
    throw new ProviderNotImplementedError('BLUEDART', 'createShipment')
  }

  async cancelShipment() {
    this.#requireConfigured()
    throw new ProviderNotImplementedError('BLUEDART', 'cancelShipment')
  }

  async trackShipment() {
    this.#requireConfigured()
    throw new ProviderNotImplementedError('BLUEDART', 'trackShipment')
  }

  mapStatus(providerStatus) {
    if (!providerStatus) return null
    return STATUS_MAP[String(providerStatus).toUpperCase()] || null
  }
}

export default implementsInterface(BlueDartAdapter)
