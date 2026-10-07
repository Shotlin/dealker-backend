/**
 * Shipping provider interface — the ONE normalized contract every carrier
 * adapter implements (spec §20). Adapters must never leak provider-specific
 * shapes into the marketplace; statuses map through mapStatus().
 *
 * Contract:
 *   checkServiceability(ctx) → { serviceable, etaDays, charge|null }
 *   getRates(ctx)            → Array<{ courier, charge, etaDays }>
 *   createShipment(order)    → { providerOrderId, providerShipmentId, awb, courier, labelUrl }
 *   schedulePickup(shipment) → { ok, pickupToken? }
 *   cancelShipment(shipment) → { ok }
 *   trackShipment(shipment)  → { status, providerStatus, events[], estimatedDelivery }
 *   mapStatus(providerStatus) → internal SHIPMENTS status vocabulary
 *
 * @module modules/shipping/providers/provider-interface
 */

export const INTERNAL_SHIPMENT_STATUSES = Object.freeze([
  'CREATED', 'ASSIGNING', 'ASSIGNED', 'PICKUP_SCHEDULED', 'PICKED_UP',
  'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'FAILED', 'RTO',
])

export class ProviderNotConfiguredError extends Error {
  constructor(provider) {
    super(`Shipping provider ${provider} is not configured`)
    this.code = 'PROVIDER_NOT_CONFIGURED'
    this.provider = provider
  }
}

export class ProviderNotImplementedError extends Error {
  constructor(provider, method) {
    super(`Shipping provider ${provider} has not implemented ${method}() yet`)
    this.code = 'PROVIDER_NOT_IMPLEMENTED'
    this.provider = provider
    this.method = method
  }
}

/** Attach the interface methods to an adapter class prototype (guard rail). */
export function implementsInterface(adapterClass) {
  const required = [
    'checkServiceability', 'getRates', 'createShipment', 'cancelShipment',
    'trackShipment', 'mapStatus',
  ]
  for (const method of required) {
    if (typeof adapterClass.prototype[method] !== 'function') {
      throw new Error(`${adapterClass.name} does not implement ${method}()`)
    }
  }
  return adapterClass
}
