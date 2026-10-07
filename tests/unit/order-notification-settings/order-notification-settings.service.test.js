import { describe, expect, it, vi } from 'vitest'

import { OrderNotificationSettingsService } from '../../../src/modules/order-notification-settings/order-notification-settings.service.js'

function makeRow(overrides = {}) {
  return {
    event_key: 'ORDER_PLACED',
    title: '🛍️ Order placed',
    message: 'Your order {{orderId}} was placed successfully. We will keep you updated here.',
    notification_enabled: true,
    banner_enabled: true,
    image_url: null,
    updated_at: '2026-09-28T00:00:00Z',
    ...overrides,
  }
}

function makeService({ row = makeRow(), rows = [row] } = {}) {
  const repository = {
    listAll: vi.fn(async () => rows),
    getByEventKey: vi.fn(async (key) => rows.find((r) => r.event_key === key) || null),
    update: vi.fn(async (key, data) => ({ ...rows.find((r) => r.event_key === key), ...data })),
  }
  const notificationsService = { sendNotification: vi.fn(async () => ({ id: 'notif-1' })) }
  return { service: new OrderNotificationSettingsService(repository, notificationsService), repository, notificationsService }
}

describe('OrderNotificationSettingsService.update', () => {
  it('rejects an unknown event key', async () => {
    const { service } = makeService()
    await expect(service.update('NOT_A_REAL_EVENT', { title: 'x' })).rejects.toMatchObject({ code: 'UNKNOWN_EVENT_KEY' })
  })

  it('rejects an empty title/message rather than silently saving blank text', async () => {
    const { service } = makeService()
    await expect(service.update('ORDER_PLACED', { title: '   ' })).rejects.toMatchObject({ code: 'INVALID_TITLE' })
    await expect(service.update('ORDER_PLACED', { message: '' })).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })
  })

  it('saves a real edit and returns the camelCase view', async () => {
    const { service, repository } = makeService()
    const view = await service.update('ORDER_PLACED', { title: 'New title', notificationEnabled: false }, 'admin-1')
    expect(repository.update).toHaveBeenCalledWith(
      'ORDER_PLACED',
      { title: 'New title', notification_enabled: false },
      'admin-1'
    )
    expect(view.title).toBe('New title')
    expect(view.notificationEnabled).toBe(false)
  })
})

describe('OrderNotificationSettingsService.getCustomerFlags', () => {
  it('returns a {notification, banner} pair per event — the shape mobile\'s event-flags call expects', async () => {
    const { service } = makeService({
      rows: [
        makeRow({ event_key: 'ORDER_PLACED', notification_enabled: true, banner_enabled: false }),
        makeRow({ event_key: 'CONFIRMED', notification_enabled: false, banner_enabled: true }),
      ],
    })
    const flags = await service.getCustomerFlags()
    expect(flags).toEqual({
      ORDER_PLACED: { notification: true, banner: false },
      CONFIRMED: { notification: false, banner: true },
    })
  })
})

describe('OrderNotificationSettingsService.sendTest', () => {
  it('interpolates the saved template with sample data and sends to the calling admin, type general', async () => {
    const { service, notificationsService } = makeService()
    await service.sendTest('ORDER_PLACED', 'admin-1')
    expect(notificationsService.sendNotification).toHaveBeenCalledWith(
      'admin-1',
      expect.objectContaining({
        title: '🛍️ Order placed',
        body: expect.stringContaining('FC-KOL-20260928-0001'),
        type: 'general',
      })
    )
  })

  it('appends the delivery-OTP suffix for PICKED_UP, mechanically, not as an editable placeholder', async () => {
    const { service, notificationsService } = makeService({
      row: makeRow({ event_key: 'PICKED_UP', title: '🚴 Out for delivery', message: 'Order {{orderId}} is on its way!' }),
    })
    await service.sendTest('PICKED_UP', 'admin-1')
    const [, options] = notificationsService.sendNotification.mock.calls[0]
    expect(options.body).toContain('is on its way!')
    expect(options.body).toContain('delivery OTP is 4821')
  })

  it('sends even when the event is currently disabled — a test must be able to preview an OFF event', async () => {
    const { service, notificationsService } = makeService({
      row: makeRow({ notification_enabled: false }),
    })
    await service.sendTest('ORDER_PLACED', 'admin-1')
    expect(notificationsService.sendNotification).toHaveBeenCalled()
  })

  it('sends a live-edited draft (not yet saved) when the caller passes an override', async () => {
    const { service, notificationsService } = makeService()
    await service.sendTest('ORDER_PLACED', 'admin-1', { title: 'Draft title', message: 'Draft {{orderId}} message' })
    const [, options] = notificationsService.sendNotification.mock.calls[0]
    expect(options.title).toBe('Draft title')
    expect(options.body).toContain('FC-KOL-20260928-0001')
  })

  it('refuses to send an entirely empty template', async () => {
    const { service } = makeService({ row: makeRow({ title: '', message: '' }) })
    await expect(service.sendTest('ORDER_PLACED', 'admin-1')).rejects.toMatchObject({ code: 'EMPTY_TEMPLATE' })
  })
})
