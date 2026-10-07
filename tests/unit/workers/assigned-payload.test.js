import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../../src/config/database.js', () => ({ query: vi.fn(), getClient: vi.fn() }))
vi.mock('../../../src/config/redis.js', () => ({ redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() } }))
vi.mock('../../../src/config/bullmq.js', () => ({ orderQueue: { add: vi.fn() } }))
vi.mock('../../../src/utils/pushNotification.js', () => ({ sendPush: vi.fn() }))
vi.mock('../../../src/utils/sms.js', () => ({ sendSmsOtp: vi.fn() }))

import { buildAssignedPayload } from '../../../src/workers/processors.js'

const store = { name: 'FreshCuts Kolkata', address: 'Salt Lake', phone: '9000000000', pickup_lat: 22.57, pickup_lng: 88.36 }
const assignment = { id: 'a1', earnings: 30, distance_km: 2 }

function payloadFor(orderOverrides) {
  return buildAssignedPayload({
    order: {
      id: 'o1',
      order_number: 'FC-1',
      payment_method: 'COD',
      items: [],
      delivery_address: { addressLine1: '12 Park St', lat: 22.55, lng: 88.35 },
      customer_name: 'Asha',
      customer_phone: '9000000010',
      ...orderOverrides,
    },
    assignment,
    store,
    estimatedDistanceKm: 2,
    riderEarning: 30,
  })
}

describe('buildAssignedPayload — what the rider sees on a realtime offer', () => {
  it('carries the real order total (orders.total_payable), not ₹0', () => {
    const payload = payloadFor({ total_payable: '380.00', wallet_amount: '0', payment_status: 'PENDING' })
    expect(payload.totalAmount).toBe(380)
  })

  it('asks a COD rider to collect only what the wallet has not already paid', () => {
    const payload = payloadFor({ total_payable: 500, wallet_amount: 200, payment_status: 'PENDING' })
    expect(payload.walletAmount).toBe(200)
    expect(payload.amountDue).toBe(300)
  })

  it('asks for nothing once the order is already PAID', () => {
    const payload = payloadFor({ total_payable: 500, wallet_amount: 500, payment_status: 'PAID' })
    expect(payload.amountDue).toBe(0)
  })

  it('is safe when the order row has no wallet fields', () => {
    const payload = payloadFor({ total_payable: 250 })
    expect(payload.amountDue).toBe(250)
    expect(payload.walletAmount).toBe(0)
  })
})
