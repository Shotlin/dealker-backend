// Regression coverage for the migration-106 orders.user_id→customer_id /
// orders.total_amount→total_payable rename drift (CLAUDE.md §5) hitting
// buildSegmentWhere()'s 'inactive_customers', 'high_value' and
// 'store_customers' cases — all three referenced columns that no longer
// exist on `orders`, so sending a bulk notification (or even just
// previewing the segment's live count) to any of these three segments
// threw a real Postgres "column does not exist" error at request time.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMock = vi.hoisted(() => ({ query: vi.fn(), getClient: vi.fn() }))
vi.mock('../../../src/config/database.js', () => databaseMock)

import { AdminNotificationsRepository } from '../../../src/modules/admin/notifications/notifications.repository.js'

const SHOP_ID = 'shop-kol-123'

beforeEach(() => {
  vi.clearAllMocks()
})

describe("AdminNotificationsRepository — 'inactive_customers' targeting", () => {
  it('scopes on orders.customer_id, never the removed orders.user_id', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ count: 3 }] })
    const repo = new AdminNotificationsRepository()

    await repo.getSegmentCount('inactive_customers')

    const [sql] = databaseMock.query.mock.calls[0]
    expect(sql).toContain('customer_id')
    expect(sql).not.toMatch(/\border_?s?\.user_id\b/)
    expect(sql).not.toMatch(/SELECT DISTINCT user_id FROM orders/)
  })
})

describe("AdminNotificationsRepository — 'high_value' targeting", () => {
  it('scopes on orders.customer_id and SUMs total_payable, never user_id/total', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ count: 7 }] })
    const repo = new AdminNotificationsRepository()

    await repo.getSegmentCount('high_value')

    const [sql] = databaseMock.query.mock.calls[0]
    expect(sql).toContain('customer_id')
    expect(sql).toContain('total_payable')
    expect(sql).not.toMatch(/SELECT user_id FROM orders/)
    expect(sql).not.toMatch(/SUM\(total\)/)
  })
})

describe("AdminNotificationsRepository — 'store_customers' targeting", () => {
  it('scopes on orders.customer_id for the given shop, never the removed orders.user_id', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ count: 12 }] })
    const repo = new AdminNotificationsRepository()

    const count = await repo.getSegmentCount('store_customers', SHOP_ID)

    expect(count).toBe(12)
    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).toContain('customer_id')
    expect(sql).toContain('shop_id')
    expect(sql).not.toMatch(/SELECT DISTINCT user_id FROM orders/)
    expect(params).toContain(SHOP_ID)
  })

  it('falls back to the generic customer base-where (no crash) when segmentValue is missing', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ count: 0 }] })
    const repo = new AdminNotificationsRepository()

    await repo.getSegmentCount('store_customers', undefined)

    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).not.toContain('shop_id')
    expect(params).toEqual([])
  })
})

describe('AdminNotificationsRepository — getTargetUsersWithTokens uses the same fixed columns', () => {
  it('inactive_customers target resolution never references orders.user_id', async () => {
    databaseMock.query.mockResolvedValue({
      rows: [{ user_id: 'u1', fcm_token: 'tok1' }],
    })
    const repo = new AdminNotificationsRepository()

    await repo.getTargetUsersWithTokens('inactive_customers')

    const [sql] = databaseMock.query.mock.calls[0]
    expect(sql).toContain('customer_id')
    expect(sql).not.toMatch(/SELECT DISTINCT user_id FROM orders/)
  })

  it('high_value target resolution never references orders.total', async () => {
    databaseMock.query.mockResolvedValue({
      rows: [{ user_id: 'u1', fcm_token: 'tok1' }],
    })
    const repo = new AdminNotificationsRepository()

    await repo.getTargetUsersWithTokens('high_value')

    const [sql] = databaseMock.query.mock.calls[0]
    expect(sql).toContain('total_payable')
    expect(sql).not.toMatch(/SUM\(total\)/)
  })
})
