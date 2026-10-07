import { describe, expect, it, vi } from 'vitest'

// `orders.service.js` transitively imports config/database.js + bullmq.js
// (pg Pool / BullMQ Queue construction) — mock both so this unit test needs
// no live DB/Redis. Same setup as orders.payment-gate.spec.js.
vi.mock('../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: vi.fn(),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

vi.mock('../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn() },
  orderQueue: { add: vi.fn() },
  smsQueue: { add: vi.fn() },
  themeQueue: { add: vi.fn() },
  allocationQueue: { add: vi.fn() },
  settlementQueue: { add: vi.fn() },
  payoutQueue: { add: vi.fn() },
  stockNotificationsQueue: { add: vi.fn() },
  scheduledOrdersQueue: { add: vi.fn() },
  reportPrecomputeQueue: { add: vi.fn() },
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { OrdersRepository } from '../../src/modules/orders/orders.repository.js'
import { OrdersService } from '../../src/modules/orders/orders.service.js'

/**
 * Coverage for the two new placeOrder() gates added in Phase 2 of the
 * delivery-scheduling feature (2026-07-04):
 *   - _checkStoreOpenForAsap(): blocks ASAP ordering while the store is
 *     closed, server-side backstop for the mobile UI's own steering.
 *   - _resolveMaxScheduledAhead(): the calendar's real generated horizon,
 *     replacing the old hardcoded "7 days ahead" cap.
 * Both are extracted private methods (matching this file's existing
 * _checkPaymentMethodAllowed convention) so they're testable in isolation
 * without exercising the rest of placeOrder()'s heavy cart/transaction flow.
 */

function makeService({ storeIsOpen = true, maxGeneratedDate = null } = {}) {
  const storeStatusService = { isOpen: vi.fn(async () => ({ isOpen: storeIsOpen, source: 'DEFAULT', reason: null })) }
  const deliveryCalendarService = { getMaxGeneratedDate: vi.fn(async () => maxGeneratedDate) }
  const service = new OrdersService(new OrdersRepository(), null, {
    storeStatusService,
    deliveryCalendarService,
  })
  return { service, storeStatusService, deliveryCalendarService }
}

describe('OrdersService._checkStoreOpenForAsap (positive)', () => {
  it('returns null (proceed) when the store is open', async () => {
    const { service } = makeService({ storeIsOpen: true })
    const result = await service._checkStoreOpenForAsap()
    expect(result).toBeNull()
  })
})

describe('OrdersService._checkStoreOpenForAsap (negative — the server-side backstop)', () => {
  it('blocks with STORE_CLOSED_ASAP_UNAVAILABLE when the store is closed', async () => {
    const { service } = makeService({ storeIsOpen: false })
    const result = await service._checkStoreOpenForAsap()
    expect(result).toEqual(
      expect.objectContaining({ success: false, code: 'STORE_CLOSED_ASAP_UNAVAILABLE' })
    )
  })
})

describe('OrdersService._resolveMaxScheduledAhead (positive)', () => {
  it('uses the calendar\'s actual generated horizon when available (genuinely extends beyond 7 days)', async () => {
    const { service } = makeService({ maxGeneratedDate: '2026-08-15' })
    const now = new Date('2026-07-04T10:00:00.000Z')

    const maxAhead = await service._resolveMaxScheduledAhead(now)

    expect(maxAhead.toISOString().slice(0, 10)).toBe('2026-08-15')
    // Genuinely beyond the old 7-day cap — proves the horizon really extended.
    const oldSevenDayCap = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    expect(maxAhead.getTime()).toBeGreaterThan(oldSevenDayCap.getTime())
  })

  it('accepts a JS Date object from the repository the same as a string', async () => {
    const { service } = makeService({ maxGeneratedDate: new Date('2026-08-15T00:00:00.000Z') })
    const now = new Date('2026-07-04T10:00:00.000Z')

    const maxAhead = await service._resolveMaxScheduledAhead(now)

    expect(maxAhead.toISOString().slice(0, 10)).toBe('2026-08-15')
  })
})

describe('OrdersService._resolveMaxScheduledAhead (negative — fail-safe)', () => {
  it('falls back to the old 7-day cap when the calendar has never been generated', async () => {
    const { service } = makeService({ maxGeneratedDate: null })
    const now = new Date('2026-07-04T10:00:00.000Z')

    const maxAhead = await service._resolveMaxScheduledAhead(now)

    const expected = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    expect(maxAhead.getTime()).toBe(expected.getTime())
  })
})
