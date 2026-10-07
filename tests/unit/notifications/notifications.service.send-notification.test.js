// Regression coverage for the optional channelId/sound override added to
// NotificationsService#sendNotification — added so the vendor app's
// "new requirement" push can ring its own Android notification channel
// (with a custom alert sound) instead of every notification type sharing
// the platform's one generic 'bakaloo_notifications' channel/'default'
// sound. Every existing call site that never passes these must keep
// getting sendPush's own unchanged defaults.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const pushMock = vi.hoisted(() => ({ sendPush: vi.fn().mockResolvedValue({ success: true, messageId: 'm1' }) }))
vi.mock('../../../src/utils/pushNotification.js', () => pushMock)

const orderSettingsRepoMock = vi.hoisted(() => ({ getByEventKey: vi.fn() }))
vi.mock('../../../src/modules/order-notification-settings/order-notification-settings.repository.js', () => ({
  OrderNotificationSettingsRepository: vi.fn().mockImplementation(() => orderSettingsRepoMock),
}))

import { NotificationsService } from '../../../src/modules/notifications/notifications.service.js'

function buildRepository({ tokens = [{ token: 'tok-1' }] } = {}) {
  return {
    createNotification: vi.fn().mockResolvedValue({ id: 'notif-1' }),
    getFcmTokens: vi.fn().mockResolvedValue(tokens),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  orderSettingsRepoMock.getByEventKey.mockReset()
})

describe('NotificationsService#sendNotification — channelId/sound passthrough', () => {
  it('forwards an explicit channelId/sound to sendPush', async () => {
    const repository = buildRepository()
    const service = new NotificationsService(repository, { emitNotification: vi.fn() })

    await service.sendNotification('user-1', {
      title: 'New procurement requirement',
      body: 'Respond before the deadline.',
      type: 'procurement',
      channelId: 'procurement_alerts',
      sound: 'new_requirement_alert',
    })

    expect(pushMock.sendPush).toHaveBeenCalledWith(
      'tok-1',
      expect.objectContaining({ channelId: 'procurement_alerts', sound: 'new_requirement_alert' })
    )
  })

  it('omits channelId/sound entirely when the caller does not pass them, so sendPush keeps its own default channel/sound', async () => {
    const repository = buildRepository()
    const service = new NotificationsService(repository, { emitNotification: vi.fn() })

    await service.sendNotification('user-1', { title: 'Order update', body: 'Your order shipped.' })

    const [, options] = pushMock.sendPush.mock.calls[0]
    expect(options).not.toHaveProperty('channelId')
    expect(options).not.toHaveProperty('sound')
  })

  it('never calls sendPush at all when the user has no active FCM token', async () => {
    const repository = buildRepository({ tokens: [] })
    const service = new NotificationsService(repository, { emitNotification: vi.fn() })

    await service.sendNotification('user-1', { title: 'Hi', body: 'msg' })

    expect(pushMock.sendPush).not.toHaveBeenCalled()
  })
})

// Regression coverage for the order-lifecycle settings gate/override
// (migration 144) — every real order-status notification (order placed,
// confirmed, picked up, etc.) funnels through this exact function with
// type:'ORDER_STATUS', so a bug here would silently change what every
// customer sees for every order in production.
describe('NotificationsService#sendNotification — order-lifecycle settings gate/override', () => {
  it('suppresses the ENTIRE send (no in-app row, no push) when the event is turned off', async () => {
    orderSettingsRepoMock.getByEventKey.mockResolvedValue({
      event_key: 'CONFIRMED', title: 'x', message: 'y', notification_enabled: false,
    })
    const repository = buildRepository()
    const service = new NotificationsService(repository, { emitNotification: vi.fn() })

    const result = await service.sendNotification('user-1', {
      title: 'fallback title', body: 'fallback body', type: 'ORDER_STATUS',
      data: { timelineType: 'CONFIRMED', orderNumber: 'FC-1' },
    })

    expect(result).toBeNull()
    expect(repository.createNotification).not.toHaveBeenCalled()
    expect(pushMock.sendPush).not.toHaveBeenCalled()
  })

  it('overrides the caller-supplied title/body with the admin-edited, interpolated template when enabled', async () => {
    orderSettingsRepoMock.getByEventKey.mockResolvedValue({
      event_key: 'CONFIRMED',
      title: 'Custom title',
      message: 'Your order {{orderId}} is confirmed!',
      notification_enabled: true,
    })
    const repository = buildRepository()
    const service = new NotificationsService(repository, { emitNotification: vi.fn() })

    await service.sendNotification('user-1', {
      title: 'hardcoded default title', body: 'hardcoded default body', type: 'ORDER_STATUS',
      data: { timelineType: 'CONFIRMED', orderNumber: 'FC-KOL-1' },
    })

    expect(repository.createNotification).toHaveBeenCalledWith('user-1', expect.objectContaining({
      title: 'Custom title',
      body: 'Your order FC-KOL-1 is confirmed!',
    }))
  })

  it('appends the delivery-OTP suffix for PICKED_UP mechanically, never as part of the editable template', async () => {
    orderSettingsRepoMock.getByEventKey.mockResolvedValue({
      event_key: 'PICKED_UP', title: 'On the way', message: 'Order {{orderId}} is on its way!', notification_enabled: true,
    })
    const repository = buildRepository()
    const service = new NotificationsService(repository, { emitNotification: vi.fn() })

    await service.sendNotification('user-1', {
      title: 'x', body: 'y', type: 'ORDER_STATUS',
      data: { timelineType: 'PICKED_UP', orderNumber: 'FC-1', deliveryOtp: '9911' },
    })

    const [, notif] = repository.createNotification.mock.calls[0]
    expect(notif.body).toContain('is on its way!')
    expect(notif.body).toContain('delivery OTP is 9911')
  })

  it('falls through unchanged (caller-supplied title/body) when no settings row exists for the event', async () => {
    orderSettingsRepoMock.getByEventKey.mockResolvedValue(null)
    const repository = buildRepository()
    const service = new NotificationsService(repository, { emitNotification: vi.fn() })

    await service.sendNotification('user-1', {
      title: 'caller title', body: 'caller body', type: 'ORDER_STATUS',
      data: { timelineType: 'SOME_FUTURE_EVENT' },
    })

    expect(repository.createNotification).toHaveBeenCalledWith('user-1', expect.objectContaining({
      title: 'caller title', body: 'caller body',
    }))
  })

  it('falls through unchanged if the settings lookup itself throws, never breaking the send', async () => {
    orderSettingsRepoMock.getByEventKey.mockRejectedValue(new Error('db down'))
    const repository = buildRepository()
    const service = new NotificationsService(repository, { emitNotification: vi.fn() })

    await service.sendNotification('user-1', {
      title: 'caller title', body: 'caller body', type: 'ORDER_STATUS',
      data: { timelineType: 'CONFIRMED' },
    })

    expect(repository.createNotification).toHaveBeenCalledWith('user-1', expect.objectContaining({
      title: 'caller title', body: 'caller body',
    }))
  })

  it('never even queries order-notification settings for a non-ORDER_STATUS notification', async () => {
    const repository = buildRepository()
    const service = new NotificationsService(repository, { emitNotification: vi.fn() })

    await service.sendNotification('user-1', { title: 'Promo', body: 'Sale!', type: 'general' })

    expect(orderSettingsRepoMock.getByEventKey).not.toHaveBeenCalled()
  })
})
