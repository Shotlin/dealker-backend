import { describe, expect, it } from 'vitest'

import { BillSummaryService } from '../../../src/modules/cart/bill-summary.service.js'

/**
 * Coverage for `_resolveDeliveryEstimateMinutes` (2026-07-04) — fixes the
 * reported bug where selecting "Quick Delivery" never changed the promised
 * delivery time anywhere in the app (it only ever showed the normal
 * delivery_eta_minutes). Admins can now also set a distinct, faster
 * quick_delivery_eta_minutes, and the headline estimate switches to it only
 * once the customer has actually opted in for this request — never just
 * because the surcharge is enabled in config.
 */

function service() {
  return new BillSummaryService({})
}

function config(overrides = {}) {
  return {
    delivery_eta_minutes: 45,
    quick_delivery_eta_minutes: 15,
    quick_delivery_surcharge_enabled: true,
    ...overrides,
  }
}

describe('BillSummaryService._resolveDeliveryEstimateMinutes — Quick Delivery selected (positive)', () => {
  it('switches to the quick ETA when selected and the surcharge is enabled', () => {
    const result = service()._resolveDeliveryEstimateMinutes(config(), true)

    expect(result.deliveryEstimateMinutes).toBe(15)
    expect(result.normalEtaMinutes).toBe(45)
    expect(result.quickEtaMinutes).toBe(15)
  })
})

describe('BillSummaryService._resolveDeliveryEstimateMinutes — normal path unaffected (negative)', () => {
  it('keeps the normal ETA when quickDeliverySelected is false (default, every normal order)', () => {
    const result = service()._resolveDeliveryEstimateMinutes(config(), false)

    expect(result.deliveryEstimateMinutes).toBe(45)
  })

  it('keeps the normal ETA when the surcharge is enabled in config but the customer did not select it', () => {
    const result = service()._resolveDeliveryEstimateMinutes(config({ quick_delivery_surcharge_enabled: true }), false)

    expect(result.deliveryEstimateMinutes).toBe(45)
  })

  it('never switches when the admin has disabled the surcharge, even if the client claims it was selected', () => {
    const result = service()._resolveDeliveryEstimateMinutes(
      config({ quick_delivery_surcharge_enabled: false }),
      true
    )

    expect(result.deliveryEstimateMinutes).toBe(45)
  })

  it('falls back to the normal ETA when quick_delivery_eta_minutes is 0/unset', () => {
    const result = service()._resolveDeliveryEstimateMinutes(
      config({ quick_delivery_eta_minutes: 0 }),
      true
    )

    expect(result.deliveryEstimateMinutes).toBe(45)
  })

  it('falls back to 30 when delivery_eta_minutes itself is missing (matches existing _safeDefault behavior)', () => {
    const result = service()._resolveDeliveryEstimateMinutes({}, false)

    expect(result.normalEtaMinutes).toBe(30)
    expect(result.deliveryEstimateMinutes).toBe(30)
  })
})
