import { describe, expect, it, vi, beforeEach } from 'vitest'

// Regression coverage: GET /api/v1/admin/riders/live-locations returned
// every online rider platform-wide with no way to scope it to one shop —
// the Coverage Map needs only the riders currently delivering for the
// shop it's showing, not every rider in the fleet. Also confirms the
// query now selects rp.location_updated_at (needed to gray out a stale
// pin) and that the existing no-shopId callers (DeliveryPage's fleet
// view) are unaffected.

const queryMock = vi.fn(async () => ({ rows: [] }))
vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

const { AdminRidersRepository } = await import(
  '../../../src/modules/admin/riders/riders.repository.js'
)

describe('AdminRidersRepository.getLiveLocations', () => {
  beforeEach(() => {
    queryMock.mockClear()
    queryMock.mockImplementation(async () => ({ rows: [] }))
  })

  it('with no shopId, keeps the old LEFT JOIN (every online rider, assignment optional) and no params', async () => {
    const repo = new AdminRidersRepository()
    await repo.getLiveLocations()

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toContain('LEFT JOIN delivery_assignments da')
    expect(sql).not.toContain('JOIN orders o')
    expect(params).toEqual([])
  })

  it('with a shopId, INNER JOINs through orders and filters on o.shop_id = $1', async () => {
    const repo = new AdminRidersRepository()
    await repo.getLiveLocations('shop-kolkata')

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toContain('JOIN delivery_assignments da')
    expect(sql).not.toContain('LEFT JOIN delivery_assignments da')
    expect(sql).toContain('JOIN orders o ON o.id = da.order_id AND o.shop_id = $1')
    expect(params).toEqual(['shop-kolkata'])
  })

  it('always selects rp.location_updated_at so the frontend can judge staleness', async () => {
    const repo = new AdminRidersRepository()
    await repo.getLiveLocations()
    const [sql] = queryMock.mock.calls[0]
    expect(sql).toContain('rp.location_updated_at')
  })
})
