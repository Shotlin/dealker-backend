import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../../src/config/redis.js', () => ({
  redis: { get: vi.fn(), setex: vi.fn(), del: vi.fn() },
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { DeliveryRepository } from '../../../src/modules/delivery/delivery.repository.js'
import { getClient } from '../../../src/config/database.js'
import { CLAIMED_ASSIGNMENT_STATUSES } from '../../../src/constants/delivery-statuses.js'

/**
 * Repository-level tests for the atomic accept transaction
 * (blueprint Big Phase 7: first-accept-wins + one-active-order).
 *
 * The DB transaction semantics under test:
 * 1. the order row is locked (`SELECT ... FOR UPDATE`) before any
 *    decision;
 * 2. the winning UPDATE is conditional on `status = 'ASSIGNED'`, so a
 *    concurrent loser updates zero rows and receives a conflict;
 * 3. a rider already holding a claimed assignment for ANOTHER order is
 *    rejected inside the same locked transaction.
 */

function createMockClient() {
  return {
    query: vi.fn(),
    release: vi.fn(),
  }
}

const ORDER_ID = 'order-1'
const ASSIGNMENT_ID = 'assign-1'
const RIDER_ID = 'rider-1'

describe('DeliveryRepository.acceptOrder — race and rider-busy semantics', () => {
  let client
  let repository

  beforeEach(() => {
    client = createMockClient()
    getClient.mockResolvedValue(client)
    repository = new DeliveryRepository()
  })

  function queueLockedOrder(orderRow) {
    client.query.mockResolvedValueOnce(undefined) // BEGIN
    client.query.mockResolvedValueOnce({ rows: orderRow ? [orderRow] : [] }) // SELECT ... FOR UPDATE
  }

  it('locks the order FOR UPDATE before any decision', async () => {
    queueLockedOrder({ id: ORDER_ID, status: 'CONFIRMED', rider_id: null })
    client.query.mockResolvedValueOnce({ rows: [] }) // busy check
    client.query.mockResolvedValueOnce({ rows: [{ id: ASSIGNMENT_ID }] }) // winning UPDATE
    client.query.mockResolvedValueOnce({ rows: [] }) // orders.rider_id update
    client.query.mockResolvedValueOnce({ rows: [] }) // status history
    client.query.mockResolvedValueOnce({ rows: [] }) // cancel competing offers
    client.query.mockResolvedValueOnce(undefined) // COMMIT

    await repository.acceptOrder(ASSIGNMENT_ID, ORDER_ID, RIDER_ID)

    const lockCall = client.query.mock.calls.find(
      (call) => call[0].includes('FOR UPDATE')
    )
    expect(lockCall).toBeDefined()
    expect(lockCall[0]).toContain('FROM orders')
    expect(lockCall[1]).toEqual([ORDER_ID])
    // The lock happens before the busy check and the claim UPDATE.
    const lockIndex = client.query.mock.calls.indexOf(lockCall)
    const busyIndex = client.query.mock.calls.findIndex(
      (call) => call[0].includes('rider_id = $1') && call[0].includes('LIMIT 1')
    )
    expect(busyIndex).toBeGreaterThan(lockIndex)
  })

  it('rejects a rider who already holds a claimed assignment for another order', async () => {
    queueLockedOrder({ id: ORDER_ID, status: 'CONFIRMED', rider_id: null })
    client.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // busy check hits
    client.query.mockResolvedValueOnce(undefined) // ROLLBACK

    const result = await repository.acceptOrder(ASSIGNMENT_ID, ORDER_ID, RIDER_ID)

    expect(result).toEqual({
      conflict: true,
      reason: 'RIDER_ALREADY_HAS_ACTIVE_ORDER',
    })
    // Transaction rolled back; the claim UPDATE was never attempted.
    expect(client.query.mock.calls.some((c) => c[0] === 'ROLLBACK')).toBe(true)
    expect(
      client.query.mock.calls.some(
        (c) => c[0].includes("SET status = 'ACCEPTED'")
      )
    ).toBe(false)
    // The busy check excludes THIS assignment/order and tests the
    // authoritative claimed set.
    const busyCall = client.query.mock.calls.find((c) =>
      c[0].includes('AND id <> $2')
    )
    expect(busyCall[0]).toContain('order_id <> $3')
    expect(busyCall[0]).toContain('status = ANY($4::text[])')
    expect(busyCall[1][3]).toEqual(CLAIMED_ASSIGNMENT_STATUSES)
  })

  it('a losing concurrent accept updates zero rows and gets ORDER_NOT_AVAILABLE', async () => {
    // Interleaving: the winner already flipped the row to ACCEPTED (and
    // holds the same order), so the loser's conditional UPDATE matches
    // nothing even though the busy check passes.
    queueLockedOrder({ id: ORDER_ID, status: 'CONFIRMED', rider_id: null })
    client.query.mockResolvedValueOnce({ rows: [] }) // busy check: loser has no other order
    client.query.mockResolvedValueOnce({ rows: [] }) // conditional UPDATE → 0 rows
    client.query.mockResolvedValueOnce(undefined) // ROLLBACK

    const result = await repository.acceptOrder(ASSIGNMENT_ID, ORDER_ID, RIDER_ID)

    expect(result).toEqual({ conflict: true, reason: 'ORDER_NOT_AVAILABLE' })
    expect(client.query.mock.calls.some((c) => c[0] === 'ROLLBACK')).toBe(true)
  })

  it('an accept against an order already claimed by another rider gets ORDER_ALREADY_CLAIMED', async () => {
    queueLockedOrder({ id: ORDER_ID, status: 'CONFIRMED', rider_id: 'rider-other' })
    client.query.mockResolvedValueOnce(undefined) // ROLLBACK

    const result = await repository.acceptOrder(ASSIGNMENT_ID, ORDER_ID, RIDER_ID)

    expect(result).toEqual({ conflict: true, reason: 'ORDER_ALREADY_CLAIMED' })
  })

  it('the winner commits, claims the order and cancels competing offers', async () => {
    queueLockedOrder({ id: ORDER_ID, status: 'CONFIRMED', rider_id: null })
    client.query.mockResolvedValueOnce({ rows: [] }) // busy check: clean
    client.query.mockResolvedValueOnce({
      rows: [{ id: ASSIGNMENT_ID, rider_id: RIDER_ID, status: 'ACCEPTED' }],
    }) // winning UPDATE
    client.query.mockResolvedValueOnce({ rows: [] }) // orders.rider_id update
    client.query.mockResolvedValueOnce({ rows: [] }) // status history
    client.query.mockResolvedValueOnce({
      rows: [{ id: 'assign-loser', rider_id: 'rider-loser' }],
    }) // cancel competing ASSIGNED offers
    client.query.mockResolvedValueOnce(undefined) // COMMIT

    const result = await repository.acceptOrder(ASSIGNMENT_ID, ORDER_ID, RIDER_ID)

    expect(result.conflict).toBe(false)
    expect(result.assignment.status).toBe('ACCEPTED')
    expect(result.cancelledOffers).toEqual([
      { id: 'assign-loser', rider_id: 'rider-loser' },
    ])
    expect(client.query.mock.calls.some((c) => c[0] === 'COMMIT')).toBe(true)

    // Losing offers are cancelled with the explicit reason so the
    // losing clients can receive order:expired events.
    const cancelCall = client.query.mock.calls.find((c) =>
      c[0].includes("SET status = 'CANCELLED'")
    )
    expect(cancelCall[0]).toContain('cancel_reason')
    expect(cancelCall[1]).toEqual([ORDER_ID, ASSIGNMENT_ID])
  })
})
