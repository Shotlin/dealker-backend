/**
 * Porter adapter — local/hyperlocal carrier shell behind the normalized
 * interface. Porter serves eligible LOCAL delivery legs only; it is never
 * the mandatory nationwide provider (spec §5/§20/§49). Until credentials are
 * configured under shipping_provider_settings, the adapter reports
 * NOT_CONFIGURED and the rules engine falls back to the national aggregator.
 *
 * @module modules/shipping/providers/porter.adapter
 */

import {
  implementsInterface,
  ProviderNotConfiguredError,
  ProviderNotImplementedError,
} from './provider-interface.js'

const STATUS_MAP = Object.freeze({
  'ASSIGNED': 'ASSIGNED',
  'PICKED_UP': 'PICKED_UP',
  'ARRIVED': 'IN_TRANSIT',
  'STARTED_FOR_DELIVERY': 'OUT_FOR_DELIVERY',
  'DELIVERED': 'DELIVERED',
  'CANCELLED': 'CANCELLED',
})

class PorterAdapter {
  constructor({ settings = {} } = {}) {
    this.settings = settings
  }

  #requireConfigured() {
    if (!this.settings?.api_key_encrypted) {
      throw new ProviderNotConfiguredError('PORTER')
    }
  }

  async checkServiceability() {
    this.#requireConfigured()
    throw new ProviderNotImplementedError('PORTER', 'checkServiceability')
  }

  async getRates() {
    this.#requireConfigured()
    throw new ProviderNotImplementedError('PORTER', 'getRates')
  }

  async createShipment() {
    this.#requireConfigured()
    throw new ProviderNotImplementedError('PORTER', 'createShipment')
  }

  async cancelShipment() {
    this.#requireConfigured()
    throw new ProviderNotImplementedError('PORTER', 'cancelShipment')
  }

  async trackShipment() {
    this.#requireConfigured()
    throw new ProviderNotImplementedError('PORTER', 'trackShipment')
  }

  mapStatus(providerStatus) {
    if (!providerStatus) return null
    return STATUS_MAP[String(providerStatus).toUpperCase()] || null
  }
}

export default implementsInterface(PorterAdapter)
