import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../src/config/database.js', () => ({
  query: vi.fn(),
}))

import { AdminAnalyticsRepository } from '../../../../src/modules/admin/analytics/analytics.repository.js'
import { query } from '../../../../src/config/database.js'

const SHOP_ID = '11111111-1111-1111-1111-111111111111'

describe('AdminAnalyticsRepository — shop scoping (R17)', () => {
  let repo

  beforeEach(() => {
    vi.clearAllMocks()
    query.mockResolvedValue({ rows: [{}] })
    repo = new AdminAnalyticsRepository()
  })

  it('getSalesAnalytics adds no shop filter for an HQ-wide (shopId=null) call', async () => {
    await repo.getSalesAnalytics({})
    const [sql, params] = query.mock.calls[0]
    expect(sql).not.toContain('o.shop_id')
    expect(params).toEqual([])
  })

  it('getSalesAnalytics filters by shop_id when a shop-scoped caller passes one', async () => {
    await repo.getSalesAnalytics({ shopId: SHOP_ID })
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('AND o.shop_id = $1')
    expect(params).toEqual([SHOP_ID])
  })

  it('getFinancialReport filters every query by shop_id when scoped', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ gross_revenue: 0 }] }) // rev
      .mockResolvedValueOnce({ rows: [] }) // byPayment
      .mockResolvedValueOnce({ rows: [{ gross_taxable: 0 }] }) // grossRow
      .mockResolvedValueOnce({ rows: [{ value: '5' }] }) // gstSetting (no shopId filter — global setting)

    await repo.getFinancialReport({ shopId: SHOP_ID })

    const [revSql, revParams] = query.mock.calls[0]
    expect(revSql).toContain('AND o.shop_id = $1')
    expect(revParams).toEqual([SHOP_ID])

    const [grossSql, grossParams] = query.mock.calls[2]
    expect(grossSql).toContain('AND o.shop_id = $1')
    expect(grossParams).toEqual([SHOP_ID])
  })

  it('getDeliveryAnalytics only joins orders (for shop filtering) when shopId is present', async () => {
    query.mockResolvedValue({ rows: [{ total_deliveries: 0 }] })
    await repo.getDeliveryAnalytics({})
    let [sql] = query.mock.calls[0]
    expect(sql).not.toContain('JOIN orders')

    vi.clearAllMocks()
    query.mockResolvedValue({ rows: [{ total_deliveries: 0 }] })
    await repo.getDeliveryAnalytics({ shopId: SHOP_ID })
    ;[sql] = query.mock.calls[0]
    expect(sql).toContain('JOIN orders o ON o.id = da.order_id')
    expect(sql).toContain('AND o.shop_id = $1')
  })

  it('getComparisonStats filters both periods by shop_id when scoped', async () => {
    query.mockResolvedValue({ rows: [{ revenue: 0, orders: 0, customers: 0, aov: 0 }] })
    await repo.getComparisonStats('2026-01-01', '2026-01-07', '2026-01-08', '2026-01-14', SHOP_ID)

    for (const call of query.mock.calls) {
      const [sql, params] = call
      expect(sql).toContain('AND shop_id = $3')
      expect(params[2]).toBe(SHOP_ID)
    }
  })

  it('getGeographicAnalytics adds no shop filter for an HQ-wide call', async () => {
    query.mockResolvedValue({ rows: [] })
    await repo.getGeographicAnalytics({})
    const [sql, params] = query.mock.calls[0]
    expect(sql).not.toContain('o.shop_id')
    expect(params).toEqual([])
  })

  it('getGeographicAnalytics filters by shop_id when scoped', async () => {
    query.mockResolvedValue({ rows: [] })
    await repo.getGeographicAnalytics({ shopId: SHOP_ID })
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('AND o.shop_id = $1')
    expect(params).toEqual([SHOP_ID])
  })

  it('getDeadStockProducts filters by shop_id when scoped', async () => {
    query.mockResolvedValue({ rows: [] })
    await repo.getDeadStockProducts({ limit: 20, shopId: SHOP_ID })
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('AND sp.shop_id = $1')
    expect(params).toEqual([SHOP_ID, 20])
  })

  it('getDeadStockProducts adds no shop filter for an HQ-wide call', async () => {
    query.mockResolvedValue({ rows: [] })
    await repo.getDeadStockProducts({ limit: 20 })
    const [sql, params] = query.mock.calls[0]
    expect(sql).not.toContain('sp.shop_id')
    expect(params).toEqual([20])
  })
})
