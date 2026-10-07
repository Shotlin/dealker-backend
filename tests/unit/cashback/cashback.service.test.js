// Coverage for CashbackService — the single place that credits/cancels
// cashback regardless of source (coupon / first-time-offer). Uses
// constructor injection (repo + walletService passed directly) so no
// database mocking is needed.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CashbackService } from '../../../src/modules/cashback/cashback.service.js'

const ORDER_ID = 'order-1'
const USER_ID = 'user-1'

function makeRepoMock(overrides = {}) {
  return {
    createPending: vi.fn().mockImplementation((data) => Promise.resolve({ id: 'tx-1', status: 'PENDING', ...data })),
    findPendingByOrderAndTrigger: vi.fn().mockResolvedValue([]),
    findActiveByOrder: vi.fn().mockResolvedValue([]),
    markCredited: vi.fn().mockResolvedValue({ id: 'tx-1', status: 'CREDITED' }),
    markCancelled: vi.fn().mockResolvedValue({ id: 'tx-1', status: 'CANCELLED' }),
    ...overrides,
  }
}

function makeWalletServiceMock(overrides = {}) {
  return {
    addMoney: vi.fn().mockResolvedValue({ success: true, transaction: { id: 'wtx-1' } }),
    deductMoney: vi.fn().mockResolvedValue({ success: true, deducted: 50 }),
    ...overrides,
  }
}

function makeNotificationsServiceMock(overrides = {}) {
  return {
    sendNotification: vi.fn().mockResolvedValue({}),
    ...overrides,
  }
}

describe('CashbackService.createPending (positive/negative)', () => {
  it('creates a PENDING row with the amount rounded to 2dp', async () => {
    const repo = makeRepoMock()
    const service = new CashbackService(repo, makeWalletServiceMock())

    await service.createPending({
      orderId: ORDER_ID,
      userId: USER_ID,
      sourceType: 'FIRST_TIME_OFFER',
      sourceId: 'offer-1',
      amount: 20.005,
      creditTrigger: 'ORDER_DELIVERED',
    })

    expect(repo.createPending).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 20.01 }),
      null
    )
  })

  it('returns null and does not write anything for a zero/negative amount (negative)', async () => {
    const repo = makeRepoMock()
    const service = new CashbackService(repo, makeWalletServiceMock())

    const result = await service.createPending({
      orderId: ORDER_ID,
      userId: USER_ID,
      sourceType: 'COUPON',
      amount: 0,
      creditTrigger: 'ORDER_DELIVERED',
    })

    expect(result).toBeNull()
    expect(repo.createPending).not.toHaveBeenCalled()
  })
})

describe('CashbackService.evaluateAndCredit (positive/negative)', () => {
  let repo, walletService, service

  beforeEach(() => {
    repo = makeRepoMock()
    walletService = makeWalletServiceMock()
    service = new CashbackService(repo, walletService)
  })

  it('credits every PENDING row whose trigger matches and marks it CREDITED (positive)', async () => {
    repo.findPendingByOrderAndTrigger = vi.fn().mockResolvedValue([
      { id: 'tx-1', userId: USER_ID, orderId: ORDER_ID, amount: 20, sourceType: 'FIRST_TIME_OFFER' },
    ])

    const count = await service.evaluateAndCredit(ORDER_ID, 'ORDER_DELIVERED')

    expect(count).toBe(1)
    expect(walletService.addMoney).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ amount: 20, subType: 'CASHBACK', orderId: ORDER_ID })
    )
    expect(repo.markCredited).toHaveBeenCalledWith('tx-1', 'wtx-1')
  })

  it('does nothing when no PENDING row matches the trigger (negative)', async () => {
    repo.findPendingByOrderAndTrigger = vi.fn().mockResolvedValue([])

    const count = await service.evaluateAndCredit(ORDER_ID, 'PAYMENT_SUCCESS')

    expect(count).toBe(0)
    expect(walletService.addMoney).not.toHaveBeenCalled()
  })

  it('does not mark a row CREDITED when the wallet credit fails (negative)', async () => {
    repo.findPendingByOrderAndTrigger = vi.fn().mockResolvedValue([
      { id: 'tx-1', userId: USER_ID, orderId: ORDER_ID, amount: 20, sourceType: 'COUPON' },
    ])
    walletService.addMoney = vi.fn().mockResolvedValue({ success: false, message: 'boom' })

    const count = await service.evaluateAndCredit(ORDER_ID, 'ORDER_DELIVERED')

    expect(count).toBe(0)
    expect(repo.markCredited).not.toHaveBeenCalled()
  })

  it('never throws even if the repository throws (best-effort side effect)', async () => {
    repo.findPendingByOrderAndTrigger = vi.fn().mockRejectedValue(new Error('db down'))

    await expect(service.evaluateAndCredit(ORDER_ID, 'ORDER_DELIVERED')).resolves.toBe(0)
  })
})

describe('CashbackService.evaluateAndCredit — cashback-credited push/in-app notification', () => {
  // Previously nothing notified the customer when cashback actually landed
  // in their wallet, regardless of source (coupon / milestone / payment
  // offer / first-time offer) — this is the "wallet, cashback any activity"
  // gap reported by the user.
  it('sends a WALLET-type notification to the customer after a successful credit (positive)', async () => {
    const repo = makeRepoMock({
      findPendingByOrderAndTrigger: vi.fn().mockResolvedValue([
        { id: 'tx-1', userId: USER_ID, orderId: ORDER_ID, amount: 50, sourceType: 'PAYMENT_OFFER' },
      ]),
    })
    const walletService = makeWalletServiceMock()
    const notificationsService = makeNotificationsServiceMock()
    const service = new CashbackService(repo, walletService, notificationsService)

    await service.evaluateAndCredit(ORDER_ID, 'ORDER_DELIVERED')
    await new Promise((resolve) => setImmediate(resolve)) // let the fire-and-forget notify settle

    expect(notificationsService.sendNotification).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        type: 'WALLET',
        data: expect.objectContaining({ type: 'WALLET', orderId: ORDER_ID, amount: 50 }),
      })
    )
  })

  it('does not notify when the wallet credit fails (negative)', async () => {
    const repo = makeRepoMock({
      findPendingByOrderAndTrigger: vi.fn().mockResolvedValue([
        { id: 'tx-1', userId: USER_ID, orderId: ORDER_ID, amount: 50, sourceType: 'COUPON' },
      ]),
    })
    const walletService = makeWalletServiceMock({ addMoney: vi.fn().mockResolvedValue({ success: false }) })
    const notificationsService = makeNotificationsServiceMock()
    const service = new CashbackService(repo, walletService, notificationsService)

    await service.evaluateAndCredit(ORDER_ID, 'ORDER_DELIVERED')
    await new Promise((resolve) => setImmediate(resolve))

    expect(notificationsService.sendNotification).not.toHaveBeenCalled()
  })

  it('does not let a notification failure affect the credit result (best-effort)', async () => {
    const repo = makeRepoMock({
      findPendingByOrderAndTrigger: vi.fn().mockResolvedValue([
        { id: 'tx-1', userId: USER_ID, orderId: ORDER_ID, amount: 50, sourceType: 'CART_MILESTONE' },
      ]),
    })
    const walletService = makeWalletServiceMock()
    const notificationsService = makeNotificationsServiceMock({
      sendNotification: vi.fn().mockRejectedValue(new Error('fcm down')),
    })
    const service = new CashbackService(repo, walletService, notificationsService)

    const count = await service.evaluateAndCredit(ORDER_ID, 'ORDER_DELIVERED')

    expect(count).toBe(1)
    expect(repo.markCredited).toHaveBeenCalledWith('tx-1', 'wtx-1')
  })
})

describe('CashbackService.cancelForOrder (positive/negative)', () => {
  let repo, walletService, service

  beforeEach(() => {
    repo = makeRepoMock()
    walletService = makeWalletServiceMock()
    service = new CashbackService(repo, walletService)
  })

  it('cancels a PENDING row without touching the wallet (positive)', async () => {
    repo.findActiveByOrder = vi.fn().mockResolvedValue([
      { id: 'tx-1', userId: USER_ID, orderId: ORDER_ID, amount: 20, status: 'PENDING' },
    ])

    const count = await service.cancelForOrder(ORDER_ID)

    expect(count).toBe(1)
    expect(walletService.deductMoney).not.toHaveBeenCalled()
    expect(repo.markCancelled).toHaveBeenCalledWith('tx-1')
  })

  it('claws back a CREDITED row from the wallet before cancelling it (positive)', async () => {
    repo.findActiveByOrder = vi.fn().mockResolvedValue([
      { id: 'tx-1', userId: USER_ID, orderId: ORDER_ID, amount: 50, status: 'CREDITED' },
    ])

    const count = await service.cancelForOrder(ORDER_ID)

    expect(count).toBe(1)
    expect(walletService.deductMoney).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ amount: 50, subType: 'CASHBACK', orderId: ORDER_ID })
    )
    expect(repo.markCancelled).toHaveBeenCalledWith('tx-1')
  })

  it('does nothing for an order with no active cashback rows (negative)', async () => {
    repo.findActiveByOrder = vi.fn().mockResolvedValue([])

    const count = await service.cancelForOrder(ORDER_ID)

    expect(count).toBe(0)
    expect(repo.markCancelled).not.toHaveBeenCalled()
  })
})
