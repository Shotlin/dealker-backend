import { describe, expect, it, vi, beforeEach } from 'vitest'

// Regression coverage: GET /api/v1/admin/orders had no shop-scope
// resolution at all — the dashboard's branch selector (X-Shop-Id header,
// already sent on every request by apiClient.ts) was silently ignored
// server-side, so every HQ admin saw every order from every branch
// regardless of which one was selected.

const queryMock = vi.fn(async () => ({ rows: [{ count: '0' }] }))
vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

const { AdminOrdersRepository } = await import(
  '../../../src/modules/admin/orders/orders.repository.js'
)

describe('AdminOrdersRepository.findAll — shop scope', () => {
  beforeEach(() => {
    queryMock.mockClear()
    queryMock.mockImplementation(async (sql) => {
      // First call is the COUNT query, second is the SELECT — both just
      // need a benign shape here; the assertions below inspect the SQL
      // text and params actually sent, not the (irrelevant) return value.
      if (sql.includes('COUNT(*)')) return { rows: [{ count: '0' }] }
      return { rows: [] }
    })
  })

  it('filters by o.shop_id when a concrete shopId is given (a shop selected, or a shop-staff JWT)', async () => {
    const repo = new AdminOrdersRepository()
    await repo.findAll({ offset: 0, limit: 20, shopId: 'shop-kolkata' })

    const calls = queryMock.mock.calls
    for (const [sql, params] of calls) {
      expect(sql).toContain('AND o.shop_id = $')
      expect(params).toContain('shop-kolkata')
    }
  })

  it('does not filter by shop_id at all for "All Shops" (shopId null/undefined)', async () => {
    const repo = new AdminOrdersRepository()
    await repo.findAll({ offset: 0, limit: 20, shopId: null })

    const calls = queryMock.mock.calls
    for (const [sql] of calls) {
      expect(sql).not.toContain('o.shop_id = $')
    }
  })

  it('combines the shop filter with other filters (status) without cross-contaminating param indices', async () => {
    const repo = new AdminOrdersRepository()
    await repo.findAll({ offset: 0, limit: 20, shopId: 'shop-delhi', status: 'CONFIRMED' })

    const [selectSql, selectParams] = queryMock.mock.calls[queryMock.mock.calls.length - 1]
    expect(selectSql).toContain('AND o.shop_id = $1')
    expect(selectSql).toContain('AND o.status = $2')
    expect(selectParams[0]).toBe('shop-delhi')
    expect(selectParams[1]).toBe('CONFIRMED')
  })

  it('the COUNT query is scoped identically to the SELECT — a branch\'s pagination total can never leak other branches\' rows', async () => {
    // `params` is a single array the repository mutates in place (it pushes
    // limit/offset onto the SAME array after the COUNT query already ran)
    // — vitest's mock.calls holds a reference, not a snapshot, so this
    // test must capture the params synchronously as the COUNT query fires
    // rather than reading them back afterward.
    let countParamsAtCallTime = null
    let countSqlSeen = null
    queryMock.mockImplementation(async (sql, params) => {
      if (sql.includes('COUNT(*)') && countSqlSeen === null) {
        countSqlSeen = sql
        countParamsAtCallTime = [...params]
      }
      return { rows: [{ count: '0' }] }
    })

    const repo = new AdminOrdersRepository()
    await repo.findAll({ offset: 0, limit: 20, shopId: 'shop-local' })

    expect(countSqlSeen).toContain('SELECT COUNT(*)')
    expect(countSqlSeen).toContain('AND o.shop_id = $1')
    expect(countParamsAtCallTime).toEqual(['shop-local'])
  })
})
