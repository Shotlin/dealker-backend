// Coverage for the reported bug: sending a campaign notification to a
// "Specific User" (the admin dashboard's per-customer/"dedicated customer"
// send) was push-only — if that customer's device had no active FCM token
// (missing permission, no push key configured, app not opened recently),
// nothing was ever delivered anywhere, not even the customer's own in-app
// Notification tab, and the dashboard still reported the campaign as
// "SENT". This mirrors the guarantee the single-user
// NotificationsService.sendNotification() path already had (orders/wallet/
// abandoned-cart) but campaigns never did.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMock = vi.hoisted(() => ({ query: vi.fn(), getClient: vi.fn() }))
vi.mock('../../../src/config/database.js', () => databaseMock)

const pushMock = vi.hoisted(() => ({ sendPushBatch: vi.fn() }))
vi.mock('../../../src/utils/pushNotification.js', () => pushMock)

const loggerMock = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../../src/config/logger.js', () => loggerMock)

vi.mock('../../../src/utils/activityLogger.js', () => ({ logAdminActivity: vi.fn() }))

import { AdminNotificationsRepository } from '../../../src/modules/admin/notifications/notifications.repository.js'
import { AdminNotificationsService } from '../../../src/modules/admin/notifications/notifications.service.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AdminNotificationsRepository — getSegmentCount no longer requires a push token (positive)', () => {
  it('counts matching users without joining fcm_tokens', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ count: 1 }] })
    const repo = new AdminNotificationsRepository()

    const count = await repo.getSegmentCount('specific_user', '9999999999')

    expect(count).toBe(1)
    const [sql] = databaseMock.query.mock.calls[0]
    expect(sql).not.toContain('fcm_tokens')
  })
})

describe('AdminNotificationsRepository — getTargetUserIds (positive)', () => {
  it('returns every matching user id regardless of push-token presence', async () => {
    databaseMock.query.mockResolvedValue({
      rows: [{ user_id: 'u1' }, { user_id: 'u2' }],
    })
    const repo = new AdminNotificationsRepository()

    const ids = await repo.getTargetUserIds('specific_user', '9999999999')

    expect(ids).toEqual(['u1', 'u2'])
    const [sql] = databaseMock.query.mock.calls[0]
    expect(sql).not.toContain('fcm_tokens')
  })
})

describe('AdminNotificationsRepository — createBulkNotifications (positive/negative)', () => {
  it('bulk-inserts one notifications row per user id', async () => {
    databaseMock.query.mockResolvedValue({ rows: [] })
    const repo = new AdminNotificationsRepository()

    await repo.createBulkNotifications(['u1', 'u2'], {
      title: 'Sale!', body: 'Big discounts today', type: 'CAMPAIGN', data: { campaignId: 'c1' },
    })

    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).toContain('INSERT INTO notifications')
    expect(sql).toContain('unnest')
    expect(params[0]).toEqual(['u1', 'u2'])
    expect(params[1]).toBe('Sale!')
  })

  it('does nothing for an empty user id list (negative)', async () => {
    const repo = new AdminNotificationsRepository()

    await repo.createBulkNotifications([], { title: 'x', body: 'y' })

    expect(databaseMock.query).not.toHaveBeenCalled()
  })
})

describe('AdminNotificationsService._executeSend — in-app fallback guarantee (the reported bug)', () => {
  it('creates an in-app notification for the target even when they have no push token, and marks the campaign SENT with a clear explanation (positive)', async () => {
    databaseMock.query.mockImplementation((sql) => {
      if (sql.includes('SELECT DISTINCT u.id AS user_id FROM users')) {
        return Promise.resolve({ rows: [{ user_id: 'u-no-token' }] })
      }
      if (sql.includes('INNER JOIN fcm_tokens')) {
        return Promise.resolve({ rows: [] }) // no active token
      }
      if (sql.includes('INSERT INTO notifications')) {
        return Promise.resolve({ rows: [] })
      }
      if (sql.includes('UPDATE notification_campaigns')) {
        return Promise.resolve({ rows: [{ id: 'c1', status: 'SENT', sent_count: 0, failed_count: 0 }] })
      }
      return Promise.resolve({ rows: [] })
    })

    const service = new AdminNotificationsService()
    await service._executeSend('c1', {
      title: 'Hi', body: 'You have a message', segment: 'specific_user', segmentValue: '9999999999',
    })

    // In-app notification was written for the target despite no push token.
    const insertCall = databaseMock.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO notifications'))
    expect(insertCall).toBeDefined()
    expect(insertCall[1][0]).toEqual(['u-no-token'])

    // Push was never attempted (no tokens) but the campaign still reports
    // SENT with an explanation, not a silent/misleading blank success.
    expect(pushMock.sendPushBatch).not.toHaveBeenCalled()
    const statusCall = databaseMock.query.mock.calls.find(([sql]) => sql.includes('UPDATE notification_campaigns'))
    expect(statusCall).toBeDefined()
    const failureSummaryParam = statusCall[1].find((p) => typeof p === 'string' && p.includes('Delivered in-app'))
    expect(failureSummaryParam).toContain('1 user(s)')
  })

  it('still sends push AND creates the in-app row when the target does have an active token (regression, positive)', async () => {
    databaseMock.query.mockImplementation((sql) => {
      if (sql.includes('SELECT DISTINCT u.id AS user_id FROM users')) {
        return Promise.resolve({ rows: [{ user_id: 'u-with-token' }] })
      }
      if (sql.includes('INNER JOIN fcm_tokens')) {
        return Promise.resolve({ rows: [{ user_id: 'u-with-token', fcm_token: 'tok-1' }] })
      }
      return Promise.resolve({ rows: [] })
    })
    pushMock.sendPushBatch.mockResolvedValue({ success: true, sent: 1, failed: 0, invalidTokens: [] })

    const service = new AdminNotificationsService()
    await service._executeSend('c2', {
      title: 'Hi', body: 'msg', segment: 'specific_user', segmentValue: '8888888888',
    })

    expect(pushMock.sendPushBatch).toHaveBeenCalledWith(['tok-1'], expect.objectContaining({ title: 'Hi', body: 'msg' }))
    const insertCall = databaseMock.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO notifications'))
    expect(insertCall[1][0]).toEqual(['u-with-token'])
  })

  it('does nothing (no in-app rows, no push) when the segment genuinely matches nobody (negative)', async () => {
    databaseMock.query.mockResolvedValue({ rows: [] })

    const service = new AdminNotificationsService()
    await service._executeSend('c3', {
      title: 'Hi', body: 'msg', segment: 'specific_user', segmentValue: 'no-such-user',
    })

    const insertCall = databaseMock.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO notifications'))
    expect(insertCall).toBeUndefined()
    expect(pushMock.sendPushBatch).not.toHaveBeenCalled()
  })

  it('a failure while writing in-app notifications does not abort the push send (best-effort, negative)', async () => {
    databaseMock.query.mockImplementation((sql) => {
      if (sql.includes('SELECT DISTINCT u.id AS user_id FROM users')) {
        return Promise.resolve({ rows: [{ user_id: 'u1' }] })
      }
      if (sql.includes('INSERT INTO notifications')) {
        return Promise.reject(new Error('db down'))
      }
      if (sql.includes('INNER JOIN fcm_tokens')) {
        return Promise.resolve({ rows: [{ user_id: 'u1', fcm_token: 'tok-1' }] })
      }
      return Promise.resolve({ rows: [] })
    })
    pushMock.sendPushBatch.mockResolvedValue({ success: true, sent: 1, failed: 0, invalidTokens: [] })

    const service = new AdminNotificationsService()
    await expect(
      service._executeSend('c4', { title: 'Hi', body: 'msg', segment: 'specific_user', segmentValue: '123' })
    ).resolves.not.toThrow()

    expect(pushMock.sendPushBatch).toHaveBeenCalled()
  })
})
