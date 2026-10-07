import { describe, expect, it, vi } from 'vitest'

// `orders.service.js` transitively imports config/database.js + bullmq.js
// (pg Pool / BullMQ Queue construction) — mock both so this unit test needs
// no live DB/Redis.
vi.mock('../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: vi.fn(),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

vi.mock('../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn() },
  orderQueue: { add: vi.fn() },
  smsQueue: { add: vi.fn() },
  themeQueue: { add: vi.fn() },
  allocationQueue: { add: vi.fn() },
  settlementQueue: { add: vi.fn() },
  payoutQueue: { add: vi.fn() },
  stockNotificationsQueue: { add: vi.fn() },
  scheduledOrdersQueue: { add: vi.fn() },
  reportPrecomputeQueue: { add: vi.fn() },
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { OrdersRepository } from '../../src/modules/orders/orders.repository.js'
import { OrdersService } from '../../src/modules/orders/orders.service.js'

const USER_ID = '11111111-1111-1111-1111-111111111111'
const ADDRESS_ID = '22222222-2222-2222-2222-222222222222'

function makeService({ config, totalPayable = 250 }) {
  const paymentSettingsService = { getConfig: vi.fn(async () => config) }
  const billSummaryService = { getBillSummary: vi.fn(async () => ({ totalPayable })) }
  // `OrdersRepository`'s own constructor does not touch the DB — safe to
  // instantiate directly rather than stub every method.
  const service = new OrdersService(new OrdersRepository(), null, {
    paymentSettingsService,
    billSummaryService,
  })
  return { service, billSummaryService }
}

const ALL_ENABLED = {
  codEnabled: true,
  razorpayEnabled: true,
  walletEnabled: true,
  codMinOrderAmount: 99,
  codMaxOrderAmount: 2000,
}

describe('OrdersService._checkPaymentMethodAllowed', () => {
  it('allows COD when enabled and the bill is within min/max', async () => {
    const { service } = makeService({ config: ALL_ENABLED, totalPayable: 250 })
    const result = await service._checkPaymentMethodAllowed(USER_ID, ADDRESS_ID, 'COD')
    expect(result).toBeNull()
  })

  it('rejects COD when the admin has disabled it', async () => {
    const { service } = makeService({
      config: { ...ALL_ENABLED, codEnabled: false },
    })
    const result = await service._checkPaymentMethodAllowed(USER_ID, ADDRESS_ID, 'COD')
    expect(result).toEqual(
      expect.objectContaining({ success: false, code: 'COD_DISABLED' })
    )
  })

  it('rejects COD when the bill is below the configured minimum', async () => {
    const { service, billSummaryService } = makeService({
      config: { ...ALL_ENABLED, codMinOrderAmount: 200 },
      totalPayable: 150,
    })
    const result = await service._checkPaymentMethodAllowed(USER_ID, ADDRESS_ID, 'COD')
    expect(result).toEqual(
      expect.objectContaining({ success: false, code: 'COD_BELOW_MIN' })
    )
    expect(result.message).toContain('200')
    expect(billSummaryService.getBillSummary).toHaveBeenCalledWith(USER_ID, ADDRESS_ID)
  })

  it('rejects COD when the bill is above the configured maximum', async () => {
    const { service } = makeService({
      config: { ...ALL_ENABLED, codMaxOrderAmount: 500 },
      totalPayable: 900,
    })
    const result = await service._checkPaymentMethodAllowed(USER_ID, ADDRESS_ID, 'COD')
    expect(result).toEqual(
      expect.objectContaining({ success: false, code: 'COD_ABOVE_MAX' })
    )
  })

  it('rejects ONLINE when Razorpay is disabled', async () => {
    const { service } = makeService({
      config: { ...ALL_ENABLED, razorpayEnabled: false },
    })
    const result = await service._checkPaymentMethodAllowed(USER_ID, ADDRESS_ID, 'ONLINE')
    expect(result).toEqual(
      expect.objectContaining({ success: false, code: 'RAZORPAY_DISABLED' })
    )
  })

  it('rejects WALLET when wallet payments are disabled', async () => {
    const { service } = makeService({
      config: { ...ALL_ENABLED, walletEnabled: false },
    })
    const result = await service._checkPaymentMethodAllowed(USER_ID, ADDRESS_ID, 'WALLET')
    expect(result).toEqual(
      expect.objectContaining({ success: false, code: 'WALLET_DISABLED' })
    )
  })

  it('does not need the bill total for ONLINE/WALLET checks', async () => {
    const { service, billSummaryService } = makeService({ config: ALL_ENABLED })
    await service._checkPaymentMethodAllowed(USER_ID, ADDRESS_ID, 'ONLINE')
    await service._checkPaymentMethodAllowed(USER_ID, ADDRESS_ID, 'WALLET')
    expect(billSummaryService.getBillSummary).not.toHaveBeenCalled()
  })
})
