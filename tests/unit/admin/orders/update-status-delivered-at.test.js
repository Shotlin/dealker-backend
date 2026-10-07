import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

import { AdminOrdersRepository } from '../../../../src/modules/admin/orders/orders.repository.js'
import { getClient } from '../../../../src/config/database.js'

const ORDER_ID = '11111111-1111-1111-1111-111111111111'
const ADMIN_ID = '22222222-2222-2222-2222-222222222222'

describe('AdminOrdersRepository.updateStatus — delivered_at', () => {
  let client
  let repo

  beforeEach(() => {
    vi.clearAllMocks()
    client = { query: vi.fn(), release: vi.fn() }
    getClient.mockResolvedValue(client)
    repo = new AdminOrdersRepository()
  })

  it('sets delivered_at when transitioning to DELIVERED — the settlement worker filters on it and previously never found these orders', async () => {
    client.query.mockImplementation((sql) => {
      if (sql.includes('SELECT status FROM orders')) {
        return Promise.resolve({ rows: [{ status: 'OUT_FOR_DELIVERY' }] })
      }
      return Promise.resolve({ rows: [] })
    })

    await repo.updateStatus(ORDER_ID, 'DELIVERED', ADMIN_ID, 'Marked delivered')

    const updateCall = client.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE orders SET status')
    )
    expect(updateCall[0]).toContain('delivered_at = COALESCE(delivered_at, NOW())')
    expect(updateCall[1]).toEqual(['DELIVERED', ORDER_ID])
  })

  it('does not touch delivered_at for non-DELIVERED transitions', async () => {
    client.query.mockImplementation((sql) => {
      if (sql.includes('SELECT status FROM orders')) {
        return Promise.resolve({ rows: [{ status: 'PENDING' }] })
      }
      return Promise.resolve({ rows: [] })
    })

    await repo.updateStatus(ORDER_ID, 'CONFIRMED', ADMIN_ID, null)

    const updateCall = client.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE orders SET status')
    )
    expect(updateCall[0]).not.toContain('delivered_at')
    expect(updateCall[1]).toEqual(['CONFIRMED', ORDER_ID])
  })

  it('does not overwrite an already-set delivered_at (idempotent re-transition)', async () => {
    client.query.mockImplementation((sql) => {
      if (sql.includes('SELECT status FROM orders')) {
        return Promise.resolve({ rows: [{ status: 'DELIVERED' }] })
      }
      return Promise.resolve({ rows: [] })
    })

    await repo.updateStatus(ORDER_ID, 'DELIVERED', ADMIN_ID, null)

    const updateCall = client.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE orders SET status')
    )
    // COALESCE(delivered_at, NOW()) preserves any existing timestamp
    expect(updateCall[0]).toContain('COALESCE(delivered_at, NOW())')
  })
})
