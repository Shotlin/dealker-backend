// Regression: a customer campaign ("All Customers", "Specific User" …) was
// also delivered to the vendor app, because vendor demo accounts are plain
// `users` rows and both apps register tokens against the same user with no
// notion of which app a token belongs to. Tokens are now labelled per app and
// every send is filtered to the right one.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMock = vi.hoisted(() => ({ query: vi.fn(), getClient: vi.fn() }))
vi.mock('../../../src/config/database.js', () => databaseMock)
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
const pushMock = vi.hoisted(() => ({ sendPush: vi.fn().mockResolvedValue({ success: true }), sendPushBatch: vi.fn() }))
vi.mock('../../../src/utils/pushNotification.js', () => pushMock)
vi.mock('../../../src/utils/activityLogger.js', () => ({ logAdminActivity: vi.fn() }))

import { NotificationsRepository } from '../../../src/modules/notifications/notifications.repository.js'
import { NotificationsService } from '../../../src/modules/notifications/notifications.service.js'
import {
  AdminNotificationsRepository,
  appForSegment,
} from '../../../src/modules/admin/notifications/notifications.repository.js'
import { AdminNotificationsService } from '../../../src/modules/admin/notifications/notifications.service.js'

beforeEach(() => {
  vi.clearAllMocks()
  databaseMock.query.mockResolvedValue({ rows: [] })
})

describe('token registration is per app', () => {
  it('stores the app and only deactivates the same user\'s tokens of that SAME app', async () => {
    await new NotificationsRepository().registerToken('u1', 'tok-vendor', 'android', 'vendor')

    const [insertSql, insertParams] = databaseMock.query.mock.calls[0]
    expect(insertSql).toContain('app = EXCLUDED.app')
    expect(insertParams).toEqual(['u1', 'tok-vendor', 'android', 'vendor'])

    const [deactSql, deactParams] = databaseMock.query.mock.calls[1]
    expect(deactSql).toMatch(/app = \$3/)
    expect(deactParams).toEqual(['u1', 'tok-vendor', 'vendor'])
  })

  it('defaults to the customer app when the client sends no app', async () => {
    await new NotificationsRepository().registerToken('u1', 'tok', 'android')
    expect(databaseMock.query.mock.calls[0][1][3]).toBe('customer')
  })

  it('getFcmTokens only returns the requested app\'s tokens (customer by default)', async () => {
    const repo = new NotificationsRepository()
    await repo.getFcmTokens('u1')
    expect(databaseMock.query.mock.calls[0][1]).toEqual(['u1', 'customer'])
    await repo.getFcmTokens('u1', 'vendor')
    expect(databaseMock.query.mock.calls[1][1]).toEqual(['u1', 'vendor'])
  })
})

describe('sendNotification pushes only to the intended app', () => {
  const build = (tokens) => {
    const repository = {
      createNotification: vi.fn().mockResolvedValue({ id: 'n1' }),
      getFcmTokens: vi.fn().mockResolvedValue(tokens),
    }
    return { repository, service: new NotificationsService(repository, {}) }
  }

  it('defaults to the customer app', async () => {
    const { repository, service } = build([{ token: 't1' }])
    await service.sendNotification('u1', { title: 'a', body: 'b' })
    expect(repository.getFcmTokens).toHaveBeenCalledWith('u1', 'customer')
  })

  it('a vendor notification asks for the vendor app\'s tokens', async () => {
    const { repository, service } = build([{ token: 't1' }])
    await service.sendNotification('u1', { title: 'a', body: 'b', app: 'vendor' })
    expect(repository.getFcmTokens).toHaveBeenCalledWith('u1', 'vendor')
  })
})

describe('campaign segments target the right app', () => {
  it('maps vendor segments to the vendor app and everything else to the customer app', () => {
    expect(appForSegment('all_vendors')).toBe('vendor')
    expect(appForSegment('specific_vendor')).toBe('vendor')
    for (const s of ['all_customers', 'specific_user', 'high_value', 'custom_segment', 'store_customers']) {
      expect(appForSegment(s)).toBe('customer')
    }
  })

  it('"All Customers" only joins customer-app tokens', async () => {
    await new AdminNotificationsRepository().getTargetUsersWithTokens('all_customers')
    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).toMatch(/ft\.app = \$1/)
    expect(params).toEqual(['customer'])
  })

  it('"All Vendors" only joins vendor-app tokens and selects users from vendor_users', async () => {
    await new AdminNotificationsRepository().getTargetUsersWithTokens('all_vendors')
    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).toContain('vendor_users')
    expect(sql).toMatch(/ft\.app = \$1/)
    expect(params).toEqual(['vendor'])
  })

  it('"Specific Vendor" binds the value and the app in the right positions', async () => {
    await new AdminNotificationsRepository().getTargetUsersWithTokens('specific_vendor', '9800000001')
    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(params).toEqual(['9800000001', 'vendor'])
    expect(sql).toMatch(/ft\.app = \$2/)
  })

  it('"Specific Vendor" with no value matches nobody instead of every vendor', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ count: 0 }] })
    await new AdminNotificationsRepository().getSegmentCount('specific_vendor')
    expect(databaseMock.query.mock.calls[0][0]).toContain('FALSE')
  })
})

describe('vendor campaigns are push-only', () => {
  it('does not write in-app rows for a vendor segment', async () => {
    databaseMock.query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT DISTINCT u.id AS user_id')) return { rows: [{ user_id: 'u1' }] }
      return { rows: [] }
    })
    pushMock.sendPushBatch.mockResolvedValue({ success: true, sent: 0, failed: 0 })

    await new AdminNotificationsService()._executeSend('c1', { title: 't', body: 'b', segment: 'all_vendors' })

    const wroteInApp = databaseMock.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO notifications'))
    expect(wroteInApp).toBe(false)
  })
})
