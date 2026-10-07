import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../src/config/database.js', () => ({
  query: vi.fn(),
}))

import { AdminAnalyticsRepository } from '../../../../src/modules/admin/analytics/analytics.repository.js'
import { query } from '../../../../src/config/database.js'

function mockFinancialReportQueries({ orderCount, gstAmount, taxableAmount, gstRateValue }) {
  query
    .mockResolvedValueOnce({
      rows: [{ gross_revenue: 1000, total_discounts: 0, delivery_fees: 50, net_revenue: 1000, order_count: orderCount }],
    }) // rev summary
    .mockResolvedValueOnce({ rows: [] }) // byPayment
    .mockResolvedValueOnce({ rows: [{ gst_amount: gstAmount, taxable_amount: taxableAmount }] }) // taxRow
    .mockResolvedValueOnce({ rows: [gstRateValue === undefined ? undefined : { gst_rate: gstRateValue }] }) // gstConfig
}

describe('AdminAnalyticsRepository.getFinancialReport — GST breakdown (real charged tax)', () => {
  let repo

  beforeEach(() => {
    vi.clearAllMocks()
    repo = new AdminAnalyticsRepository()
  })

  it('sums the real orders.tax_amount charged in the period, alongside the configured rate for display', async () => {
    mockFinancialReportQueries({ orderCount: 10, gstAmount: 50, taxableAmount: 1000, gstRateValue: '18' })

    const result = await repo.getFinancialReport({})

    expect(result.gstBreakdown).toEqual([
      { gst_rate: 18, taxable_amount: 1000, gst_amount: 50 },
    ])
  })

  it('reports gst_rate 0 when fee_settings has no GLOBAL row (defensive default)', async () => {
    mockFinancialReportQueries({ orderCount: 10, gstAmount: 0, taxableAmount: 1000, gstRateValue: undefined })

    const result = await repo.getFinancialReport({})

    expect(result.gstBreakdown).toEqual([
      { gst_rate: 0, taxable_amount: 1000, gst_amount: 0 },
    ])
  })

  it('returns an empty breakdown when there are no orders in the period', async () => {
    mockFinancialReportQueries({ orderCount: 0, gstAmount: 0, taxableAmount: 0, gstRateValue: '18' })

    const result = await repo.getFinancialReport({})

    expect(result.gstBreakdown).toEqual([])
  })

  it('rounds gst_amount/taxable_amount to 2 decimal places', async () => {
    mockFinancialReportQueries({ orderCount: 3, gstAmount: 15.2549, taxableAmount: 84.7451, gstRateValue: '18' })

    const result = await repo.getFinancialReport({})

    expect(result.gstBreakdown).toEqual([
      { gst_rate: 18, taxable_amount: 84.75, gst_amount: 15.25 },
    ])
  })
})
