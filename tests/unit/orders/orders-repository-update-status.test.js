import { describe, expect, it, vi, beforeEach } from 'vitest'

// Capture every query issued so we can assert on the exact SQL/params
// `updateStatus` builds — this is a regression test for a real production
// bug: passing `status: undefined` (several payment-flow callers do this
// on purpose, to mean "don't touch status") used to still include
// `status = $1` in the UPDATE, and node-postgres binds `undefined` params
// as SQL NULL — silently nulling the order's status on every online
// checkout.
const queryMock = vi.fn(async () => ({ rows: [{ id: 'order-1', status: 'PENDING' }] }))
vi.mock('../../../src/config/database.js', () => ({
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
}))

const { OrdersRepository } = await import('../../../src/modules/orders/orders.repository.js')

beforeEach(() => {
  queryMock.mockClear()
})

describe('OrdersRepository.updateStatus', () => {
  it('does not touch the status column when status is undefined', async () => {
    const repo = new OrdersRepository()
    await repo.updateStatus('order-1', undefined, { paymentStatus: 'FAILED' })

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).not.toMatch(/(?<!_)status = \$/)
    expect(sql).toMatch(/payment_status = \$/)
    expect(params).not.toContain(undefined)
  })

  it('writes payment_expires_at when provided, without touching status', async () => {
    const repo = new OrdersRepository()
    const expiresAt = new Date('2026-01-01T00:00:00Z')
    await repo.updateStatus('order-1', undefined, { paymentExpiresAt: expiresAt })

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).not.toMatch(/(?<!_)status = \$/)
    expect(sql).toMatch(/payment_expires_at = \$/)
    expect(params).toContain(expiresAt)
  })

  it('still sets status when the caller actually provides one', async () => {
    const repo = new OrdersRepository()
    await repo.updateStatus('order-1', 'CONFIRMED', { paymentStatus: 'PAID' })

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/status = \$1/)
    expect(params[0]).toBe('CONFIRMED')
  })
})
