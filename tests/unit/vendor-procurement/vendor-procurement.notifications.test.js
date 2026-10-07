// Regression coverage: ProcurementNotifier.requestPublished must ask for the
// vendor app's own loud 'procurement_alerts' channel/'new_requirement_alert'
// sound (so a closed app still shows a real system push with the vendor's
// alert sound, not the platform's generic notification tone) — and every
// OTHER procurement event must keep using the shared default, matching the
// same alert-vs-plain-toast split the vendor app's own Socket.IO listener
// already applies in-app.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMock = vi.hoisted(() => ({
  query: vi.fn().mockResolvedValue({ rows: [{ user_id: 'user-1' }] }),
}))
vi.mock('../../../src/config/database.js', () => databaseMock)

vi.mock('../../../src/modules/notifications/notifications.repository.js', () => ({
  NotificationsRepository: vi.fn(),
}))

const sendNotificationMock = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'notif-1' }))
vi.mock('../../../src/modules/notifications/notifications.service.js', () => ({
  NotificationsService: vi.fn().mockImplementation(() => ({
    sendNotification: sendNotificationMock,
  })),
}))

import { ProcurementNotifier } from '../../../src/modules/vendor-procurement/vendor-procurement.notifications.js'

// dispatch() runs via setImmediate (fire-and-forget by design) — flush the
// macrotask + any queued microtasks before asserting.
async function flush() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  vi.clearAllMocks()
  databaseMock.query.mockResolvedValue({ rows: [{ user_id: 'user-1' }] })
})

describe('ProcurementNotifier.requestPublished', () => {
  it('requests the procurement_alerts channel and new_requirement_alert sound', async () => {
    const notifier = new ProcurementNotifier({})

    notifier.requestPublished(
      [{ vendor_id: 'v1' }],
      { requestId: 'req-1', requestNumber: 'PRQ-1', shopName: 'FreshCuts — Kolkata', mode: 'FIXED_OFFER' }
    )
    await flush()

    expect(sendNotificationMock).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ channelId: 'procurement_alerts', sound: 'new_requirement_alert' })
    )
  })
})

describe('ProcurementNotifier.requestClosed — must NOT get the loud channel', () => {
  it('sends with no channelId/sound override, keeping the shared default', async () => {
    const notifier = new ProcurementNotifier({})

    notifier.requestClosed([{ vendor_id: 'v1' }], { requestId: 'req-1', requestNumber: 'PRQ-1', status: 'CANCELLED' })
    await flush()

    expect(sendNotificationMock).toHaveBeenCalledTimes(1)
    const [, options] = sendNotificationMock.mock.calls[0]
    expect(options.channelId).toBeUndefined()
    expect(options.sound).toBeUndefined()
  })
})
