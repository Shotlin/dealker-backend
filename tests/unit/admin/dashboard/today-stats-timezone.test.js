import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../src/config/database.js', () => ({
  query: vi.fn().mockResolvedValue({
    rows: [{ revenue: 0, orders: 0, cod_to_collect: 0, delivered: 0 }],
  }),
}))

vi.mock('../../../../src/config/redis.js', () => ({
  redis: {},
}))

import { DashboardRepository } from '../../../../src/modules/admin/dashboard/dashboard.repository.js'
import { query } from '../../../../src/config/database.js'

describe('DashboardRepository._todayStats — IST calendar day, not DB-session UTC day', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    query.mockResolvedValue({
      rows: [{ revenue: 0, orders: 0, cod_to_collect: 0, delivered: 0 }],
    })
  })

  it('filters by the IST calendar day instead of a raw CURRENT_DATE compare', async () => {
    const repo = new DashboardRepository()
    await repo._todayStats()

    const [sql] = query.mock.calls[0]
    expect(sql).toContain(
      "(created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date"
    )
    // Guard against regressing back to the UTC-day bug this replaces —
    // a bare CURRENT_DATE compare is 5:30 off from IST midnight, which
    // double-counts part of yesterday before 05:30 IST and drops this
    // morning's orders once the UTC day rolls over.
    expect(sql).not.toContain('created_at::date = CURRENT_DATE')
  })
})
