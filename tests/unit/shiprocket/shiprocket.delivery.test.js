import { describe, it, expect } from 'vitest'
import {
  assessEligibility, buildQuickOrderPayload, buildSrOrderRef, mapTrackingStatus, parseTracking, pickQuickCourier,
} from '../../../src/modules/shiprocket/shiprocket.delivery.js'

const shop = { name: 'Lucknow', city: 'Lucknow', pincode: '226010', lat: 26.8, lng: 80.9 }
const order = {
  id: 'o1', order_number: 'FC-LKO-20260930-0001', status: 'CONFIRMED', payment_method: 'ONLINE', payment_status: 'PAID',
  total_payable: 380, created_at: '2026-09-30T10:00:00Z', rider_id: null,
  delivery_address: { addressLine1: '12 Hazratganj', landmark: 'Near park', city: 'Lucknow', state: 'UP', pincode: '226001', lat: 26.85, lng: 80.94 },
}

describe('assessEligibility (prepaid-only rule)', () => {
  it('accepts a paid online order', () => expect(assessEligibility({ order, shop })).toBeNull())
  it('rejects COD first', () => expect(assessEligibility({ order: { ...order, payment_method: 'COD' }, shop })).toMatch(/COD/))
  it('rejects unpaid orders', () => expect(assessEligibility({ order: { ...order, payment_status: 'PENDING' }, shop })).toMatch(/not completed/))
  it('rejects delivered/cancelled orders', () => expect(assessEligibility({ order: { ...order, status: 'DELIVERED' }, shop })).toMatch(/DELIVERED/))
  it('rejects an already-live shipment but allows retry after failure/cancel', () => {
    expect(assessEligibility({ order, shop, shipment: { status: 'ASSIGNING', sr_shipment_id: 222 } })).toMatch(/Already assigned/)
    // a half-created row (Shiprocket never returned an id) must stay retryable
    expect(assessEligibility({ order, shop, shipment: { status: 'CREATED', sr_shipment_id: null } })).toBeNull()
    expect(assessEligibility({ order, shop, shipment: { status: 'FAILED' } })).toBeNull()
    expect(assessEligibility({ order, shop, shipment: { status: 'CANCELLED' } })).toBeNull()
  })
  it('rejects an order already given to an own rider', () =>
    expect(assessEligibility({ order: { ...order, rider_id: 'r1' }, shop })).toMatch(/own riders/))
  it('needs map coordinates on the address and the store', () => {
    expect(assessEligibility({ order: { ...order, delivery_address: { pincode: '226001' } }, shop })).toMatch(/map location/)
    expect(assessEligibility({ order, shop: { ...shop, lat: null } })).toMatch(/Store/)
  })
})

describe('buildQuickOrderPayload', () => {
  const p = buildQuickOrderPayload({
    order, shop, pickupLocation: 'Lucknow', srOrderRef: buildSrOrderRef(order.order_number),
    customer: { name: 'Ravi Kumar Singh', phone: '+91 98123 45678', email: null },
    items: [{ name: 'Chicken 1kg', quantity: 2, price: 190 }],
  })
  it('is a prepaid hyperlocal order with coordinates', () => {
    expect(p).toMatchObject({ payment_method: 'Prepaid', shipping_method: 'HL', latitude: 26.85, longitude: 80.94, pickup_location: 'Lucknow' })
  })
  it('splits the name, takes the last 10 digits of the phone and falls back on email', () => {
    expect(p.billing_customer_name).toBe('Ravi')
    expect(p.billing_last_name).toBe('Kumar Singh')
    expect(p.billing_phone).toBe(9812345678)
    expect(p.billing_email).toBe('orders@freshcuts.in')
  })
  it('maps items and the total', () => {
    expect(p.order_items[0]).toMatchObject({ name: 'Chicken 1kg', units: 2, selling_price: 190 })
    expect(p.sub_total).toBe(380)
    expect(p.weight).toBeGreaterThan(0)
  })
  it('suffixes the order id on retry', () => expect(buildSrOrderRef('FC-1', 2)).toBe('FC-1-R2'))
})

describe('tracking', () => {
  it('maps statuses', () => {
    expect(mapTrackingStatus('Delivered')).toBe('DELIVERED')
    expect(mapTrackingStatus('OUT FOR DELIVERY')).toBe('OUT_FOR_DELIVERY')
    expect(mapTrackingStatus('Picked Up')).toBe('PICKED_UP')
    expect(mapTrackingStatus('Undelivered')).toBeNull()
    expect(mapTrackingStatus('Canceled')).toBe('CANCELLED')
    expect(mapTrackingStatus('')).toBeNull()
  })
  it('parses rider details in object and string form', () => {
    const base = (agent) => ({ tracking_data: { shipment_track: [{ awb_code: 'A1', current_status: 'Picked Up', courier_name: 'Shiprocket Quick', courier_agent_details: agent }] } })
    expect(parseTracking(base({ name: 'Amit', phone: '999' }))).toMatchObject({ agentName: 'Amit', agentPhone: '999', awb: 'A1' })
    expect(parseTracking(base('Amit'))).toMatchObject({ agentName: 'Amit', agentPhone: null })
    expect(parseTracking({}).statusText).toBeNull()
  })
  it('picks the Quick courier and its rate', () => {
    expect(pickQuickCourier([{ courier_name: 'Other', rates: '10' }, { courier_name: 'Shiprocket Quick', rates: '345.3' }])).toMatchObject({ courierName: 'Shiprocket Quick', rate: 345.3 })
    expect(pickQuickCourier([])).toBeNull()
  })
})

import { haversineKm, simulatedRate, nextSimulationStep } from '../../../src/modules/shiprocket/shiprocket.delivery.js'

describe('simulation helpers', () => {
  it('haversine + demo rate are sane', () => {
    const km = haversineKm(26.8537, 81.0117, 26.85, 80.94)
    expect(km).toBeGreaterThan(5)
    expect(km).toBeLessThan(10)
    expect(simulatedRate(km)).toBe(Math.round(40 + 6 * km))
    expect(simulatedRate(NaN)).toBe(40)
  })
  it('walks the full demo lifecycle in order and then stops', () => {
    const seen = []
    let cur = 'ASSIGNING'
    for (let i = 0; i < 6; i++) {
      const step = nextSimulationStep(cur, 'FC-STR-20260930-0007')
      if (!step) break
      seen.push(step.status)
      cur = step.status
    }
    expect(seen).toEqual(['ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED'])
    expect(nextSimulationStep('DELIVERED')).toBeNull()
    expect(nextSimulationStep('CANCELLED')).toBeNull()
  })
  it('the first step attaches a demo rider, awb and courier', () => {
    expect(nextSimulationStep('ASSIGNING', 'FC-STR-20260930-0007')).toMatchObject({
      status: 'ASSIGNED', agent_name: 'Demo Rider', agent_phone: '9000000000', awb_code: 'SIM09300007',
    })
  })
})

import { resolvePickupLocation } from '../../../src/modules/shiprocket/shiprocket.delivery.js'

describe('resolvePickupLocation', () => {
  const work = { pickup_location: 'work', pin_code: '226010' }
  const other = { pickup_location: 'Kolkata Hub', pin_code: '700001' }
  it('the exact real-world case: setting "Lucknow" but the account only has "work" at 226010', () => {
    expect(resolvePickupLocation([work], 'Lucknow', '226010')).toBe('work')
  })
  it('prefers the configured name (case-insensitive)', () => {
    expect(resolvePickupLocation([work, other], ' KOLKATA hub ', '226010')).toBe('Kolkata Hub')
  })
  it('falls back to the store pincode when several exist and the name does not match', () => {
    expect(resolvePickupLocation([work, other], 'nope', '226010')).toBe('work')
  })
  it('returns null when it cannot decide safely', () => {
    expect(resolvePickupLocation([work, other], 'nope', '999999')).toBeNull()
    expect(resolvePickupLocation([], 'x', '226010')).toBeNull()
  })
})
