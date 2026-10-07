import { describe, expect, it, vi, beforeEach } from 'vitest'

// Regression coverage: getCoveredCustomers() queried `orders WHERE user_id
// = ...`, but migration 106 renamed orders.user_id -> orders.customer_id
// months ago (see CLAUDE.md §5 — the same rename-drift bug class fixed
// ~10 times elsewhere in this codebase). That query threw on every real
// call, so GET /api/v1/admin/coverage-map/:shopId never actually returned
// data. This pins the fix: the right column name, in both the SELECT and
// the WHERE clause, and the hasActiveOrder set built from the right key.

const queryMock = vi.fn()
vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

const { CoverageMapRepository } = await import(
  '../../../src/modules/coverage-map/coverage-map.repository.js'
)

function fakeAllocationRepo(points) {
  return {
    findUsersAffectedByShop: vi.fn(async ({ afterUserId }) => (afterUserId ? [] : points)),
  }
}

describe('CoverageMapRepository.getCoveredCustomers', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('queries orders.customer_id, never orders.user_id, for the active-order lookup', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (sql.includes('FROM users')) return { rows: [{ id: 'u1', name: 'Ananya' }] }
      if (sql.includes('FROM orders')) return { rows: [{ customer_id: 'u1' }] }
      return { rows: [] }
    })
    const repo = new CoverageMapRepository({
      allocationRepository: fakeAllocationRepo([
        { user_id: 'u1', lat: 22.5, lng: 88.3, pincode: '700001' },
      ]),
    })

    const result = await repo.getCoveredCustomers('shop-1')

    const ordersCall = queryMock.mock.calls.find(([sql]) => sql.includes('FROM orders'))
    expect(ordersCall[0]).toContain('customer_id')
    expect(ordersCall[0]).not.toMatch(/\buser_id\b/)
    expect(result).toEqual([
      { userId: 'u1', name: 'Ananya', lat: 22.5, lng: 88.3, pincode: '700001', hasActiveOrder: true },
    ])
  })

  it('flags hasActiveOrder false for a customer absent from the active-orders result', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (sql.includes('FROM users')) return { rows: [{ id: 'u2', name: 'Rohan' }] }
      if (sql.includes('FROM orders')) return { rows: [] }
      return { rows: [] }
    })
    const repo = new CoverageMapRepository({
      allocationRepository: fakeAllocationRepo([
        { user_id: 'u2', lat: 22.6, lng: 88.4, pincode: '700002' },
      ]),
    })

    const [customer] = await repo.getCoveredCustomers('shop-1')
    expect(customer.hasActiveOrder).toBe(false)
  })

  it('skips customers with no lat/lng rather than plotting a null pin', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (sql.includes('FROM users')) return { rows: [] }
      if (sql.includes('FROM orders')) return { rows: [] }
      return { rows: [] }
    })
    const repo = new CoverageMapRepository({
      allocationRepository: fakeAllocationRepo([
        { user_id: 'u3', lat: null, lng: null, pincode: '700003' },
      ]),
    })

    const result = await repo.getCoveredCustomers('shop-1')
    expect(result).toEqual([])
  })
})
