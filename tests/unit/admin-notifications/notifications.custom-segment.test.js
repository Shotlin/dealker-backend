// Coverage for the new 'custom_segment' notification targeting case
// (Phase 1 of the customer-segment marketing system) — an admin-defined
// customer_segments row can now be used as a push-notification target,
// reusing the existing buildSegmentWhere()/getSegmentCount()/
// getTargetUsersWithTokens() pipeline rather than a parallel mechanism.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMock = vi.hoisted(() => ({ query: vi.fn(), getClient: vi.fn() }))
vi.mock('../../../src/config/database.js', () => databaseMock)

import { AdminNotificationsRepository } from '../../../src/modules/admin/notifications/notifications.repository.js'

const SEGMENT_ID = 'seg-vip-123'

beforeEach(() => {
  vi.clearAllMocks()
})

describe("AdminNotificationsRepository — 'custom_segment' targeting (positive)", () => {
  it('getSegmentCount() scopes the count query to customer_segment_members for the given segment id', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ count: 5 }] })
    const repo = new AdminNotificationsRepository()

    const count = await repo.getSegmentCount('custom_segment', SEGMENT_ID)

    expect(count).toBe(5)
    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).toContain('customer_segment_members')
    expect(sql).toContain('segment_id')
    expect(params).toContain(SEGMENT_ID)
  })

  it('getTargetUsersWithTokens() scopes the target list to the segment (only members get the push)', async () => {
    databaseMock.query.mockResolvedValue({
      rows: [{ user_id: 'u1', fcm_token: 'tok1' }],
    })
    const repo = new AdminNotificationsRepository()

    const targets = await repo.getTargetUsersWithTokens('custom_segment', SEGMENT_ID)

    expect(targets).toEqual([{ user_id: 'u1', fcm_token: 'tok1' }])
    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).toContain('customer_segment_members')
    expect(params).toContain(SEGMENT_ID)
  })
})

describe("AdminNotificationsRepository — 'custom_segment' targeting (negative)", () => {
  it('falls back to the generic customer base-where (no segment leak) when segmentValue is missing', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ count: 0 }] })
    const repo = new AdminNotificationsRepository()

    await repo.getSegmentCount('custom_segment', undefined)

    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).not.toContain('customer_segment_members')
    expect(params).toEqual([])
  })

  it('existing all_customers targeting is unaffected by the new segment case (regression)', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ count: 10 }] })
    const repo = new AdminNotificationsRepository()

    await repo.getSegmentCount('all_customers', undefined)

    const [sql] = databaseMock.query.mock.calls[0]
    expect(sql).not.toContain('customer_segment_members')
  })
})
