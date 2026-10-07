import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * A partial wallet + ONLINE order never debits the wallet at order-creation
 * time (orders.service.js#placeOrder) — it stays a pending `wallet_amount`
 * on the order row until payment is actually confirmed, right here in
 * PaymentsService#_settleWalletIfPending. Both verifyPayment() and the
 * Razorpay webhook call this after marking the order PAID; only one of
 * them may ever actually touch the wallet, however many times either fires.
 */

const mockClient = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() }

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: vi.fn(),
  getClient: vi.fn(async () => mockClient),
  closePool: vi.fn(),
}))
vi.mock('../../../src/config/razorpay.js', () => ({
  razorpay: { orders: { create: vi.fn() } },
  getRazorpayKeyId: () => 'rzp_test_key',
  getRazorpayKeySecret: () => 'secret',
  getRazorpayWebhookSecret: () => undefined,
  getRazorpayMode: () => 'TEST',
  refreshRazorpayClient: vi.fn(),
}))
vi.mock('../../../src/config/env.js', () => ({ env: { RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'secret' } }))
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../../src/config/bullmq.js', () => ({ orderQueue: { add: vi.fn() } }))
vi.mock('../../../src/modules/orders/orders.repository.js', () => ({
  OrdersRepository: vi.fn().mockImplementation(() => ({
    claimWalletDebit: vi.fn(),
  })),
}))
vi.mock('../../../src/modules/payment-settings/payment-settings.service.js', () => ({
  PaymentSettingsService: vi.fn().mockImplementation(() => ({ getConfig: vi.fn() })),
}))
vi.mock('../../../src/modules/cashback/cashback.service.js', () => ({
  CashbackService: vi.fn().mockImplementation(() => ({})),
}))
vi.mock('../../../src/modules/wallet/wallet.service.js', () => ({
  WalletService: vi.fn().mockImplementation(() => ({})),
}))
vi.mock('../../../src/modules/wallet/wallet.repository.js', () => ({
  WalletRepository: vi.fn().mockImplementation(() => ({
    getForUpdate: vi.fn(),
    debit: vi.fn(),
  })),
}))

const { PaymentsService } = await import('../../../src/modules/payments/payments.service.js')

function service() {
  return new PaymentsService({})
}

describe('PaymentsService._settleWalletIfPending', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClient.query.mockClear()
  })

  it('debits the claimed amount once the wallet has enough balance', async () => {
    const svc = service()
    svc.ordersRepo.claimWalletDebit.mockResolvedValue({
      id: 'order-1', customer_id: 'cust-1', wallet_amount: 100, order_number: 'FC-1',
    })
    svc.walletRepo.getForUpdate.mockResolvedValue({ id: 'wallet-1', balance: 250 })
    svc.walletRepo.debit.mockResolvedValue({ wallet: {}, transaction: {} })

    await svc._settleWalletIfPending('order-1')

    expect(svc.ordersRepo.claimWalletDebit).toHaveBeenCalledWith('order-1')
    expect(svc.walletRepo.debit).toHaveBeenCalledWith(
      mockClient, 'wallet-1', 100, expect.stringContaining('FC-1'), 'order-1', { orderId: 'order-1' }
    )
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT')
  })

  it('is a no-op when there is nothing pending — already claimed by a previous confirmation, or wallet was never used', async () => {
    const svc = service()
    svc.ordersRepo.claimWalletDebit.mockResolvedValue(null) // atomic claim lost/nothing to claim

    await svc._settleWalletIfPending('order-1')

    expect(svc.walletRepo.getForUpdate).not.toHaveBeenCalled()
    expect(svc.walletRepo.debit).not.toHaveBeenCalled()
  })

  it('the second of two concurrent confirmations (webhook + client verify) never double-debits', async () => {
    const svc = service()
    svc.ordersRepo.claimWalletDebit
      .mockResolvedValueOnce({ id: 'order-1', customer_id: 'cust-1', wallet_amount: 100, order_number: 'FC-1' })
      .mockResolvedValueOnce(null) // second caller loses the atomic claim
    svc.walletRepo.getForUpdate.mockResolvedValue({ id: 'wallet-1', balance: 250 })
    svc.walletRepo.debit.mockResolvedValue({ wallet: {}, transaction: {} })

    await svc._settleWalletIfPending('order-1')
    await svc._settleWalletIfPending('order-1')

    expect(svc.walletRepo.debit).toHaveBeenCalledTimes(1)
  })

  it('never throws (and never leaves wallet_debited claimed-but-undone) when the balance somehow no longer covers it', async () => {
    const svc = service()
    svc.ordersRepo.claimWalletDebit.mockResolvedValue({
      id: 'order-1', customer_id: 'cust-1', wallet_amount: 100, order_number: 'FC-1',
    })
    svc.walletRepo.getForUpdate.mockResolvedValue({ id: 'wallet-1', balance: 10 })

    await expect(svc._settleWalletIfPending('order-1')).resolves.toBeUndefined()
    expect(svc.walletRepo.debit).not.toHaveBeenCalled()
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK')
  })
})
