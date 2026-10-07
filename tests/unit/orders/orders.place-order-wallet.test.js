import { beforeEach, describe, expect, it, vi } from 'vitest'

// orders.service.js transitively imports config/database.js + bullmq.js
// (pg Pool / BullMQ Queue construction) — mock both so this unit test needs
// no live DB/Redis, same convention as orders.payment-gate.spec.js.
vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: vi.fn(),
  getClient: vi.fn(async () => mockClient),
  closePool: vi.fn(),
}))

vi.mock('../../../src/config/bullmq.js', () => ({
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

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const mockClient = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() }

import { OrdersService } from '../../../src/modules/orders/orders.service.js'

const CUSTOMER_ID = 'cust-1'
const ADDRESS_ID = 'addr-1'
const SHOP_ID = 'shop-1'

function cartLine(overrides = {}) {
  return {
    productId: 'prod-1',
    shopProductId: 'sp-1',
    categoryId: 'cat-1',
    name: 'Chicken Breast',
    effectivePrice: 200,
    quantity: 1,
    unit: 'g',
    lineTotal: 200,
    thumbnailUrl: null,
    ...overrides,
  }
}

function makeDeps({ cartLines = [cartLine()], walletBalance = 0, couponResult = null } = {}) {
  const groupedByShop = new Map([[SHOP_ID, cartLines]])

  const repository = {
    findByClientOrderRef: vi.fn(async () => []),
    generateCheckoutOrderNumber: vi.fn(async () => 'FC-TEST-0001'),
    createCheckoutOrder: vi.fn(async (client, data) => ({
      id: `order-${Math.random().toString(36).slice(2, 8)}`,
      order_number: 'FC-TEST-0001',
      customer_id: CUSTOMER_ID,
      shop_id: data.shopId,
      status: data.status,
      items: data.items,
      subtotal: data.subtotal,
      discount_amount: data.discountAmount,
      delivery_fee: data.deliveryFee,
      platform_fee: data.platformFee,
      tax_amount: 0,
      total_payable: data.totalPayable,
      payment_method: data.paymentMethod,
      payment_status: data.paymentStatus,
      coupon_code: data.couponCode,
      wallet_amount: data.walletAmount,
      wallet_debited: data.walletDebited,
      client_order_ref: data.clientOrderRef,
      delivery_address: data.deliveryAddress,
      delivery_notes: data.deliveryNotes,
      estimated_delivery: data.estimatedDelivery,
      created_at: new Date(),
      updated_at: new Date(),
    })),
    logStatusTransition: vi.fn(async () => ({})),
    _formatCheckoutOrder(row) {
      return {
        id: row.id,
        orderNumber: row.order_number,
        shopId: row.shop_id,
        status: row.status,
        subtotal: Number(row.subtotal || 0),
        discountAmount: Number(row.discount_amount || 0),
        deliveryFee: Number(row.delivery_fee || 0),
        platformFee: Number(row.platform_fee || 0),
        totalAmount: Number(row.total_payable || 0),
        walletAmountUsed: Number(row.wallet_amount || 0),
        walletDebited: !!row.wallet_debited,
        paymentMethod: row.payment_method,
        paymentStatus: row.payment_status,
        couponCode: row.coupon_code || null,
        clientOrderRef: row.client_order_ref || null,
      }
    },
  }

  const cartService = { validateCart: vi.fn(async () => ({ valid: true, groupedByShop })) }
  const cartRepository = { clearCart: vi.fn(async () => {}), clearExtras: vi.fn(async () => {}) }
  const addressesRepository = { findByIdAndUser: vi.fn(async () => ({ id: ADDRESS_ID, label: 'Home' })) }
  const shopProductsRepository = {
    applyStockChange: vi.fn(async () => {}),
    restoreStockForCancelledOrder: vi.fn(async () => ({ restoredCount: 0, failedItems: [] })),
  }
  const couponsService = {
    validate: vi.fn(async () => couponResult ?? { valid: true, discount: 0, freeDelivery: false, cashbackAmount: 0, couponId: 'coupon-1' }),
    recordUsageForOrder: vi.fn(async () => {}),
  }
  const walletRepository = {
    getOrCreate: vi.fn(async () => ({ id: 'wallet-1', balance: walletBalance })),
    getForUpdate: vi.fn(async () => ({ id: 'wallet-1', balance: walletBalance })),
    debit: vi.fn(async (client, walletId, amount) => ({ wallet: { id: walletId, balance: walletBalance - amount }, transaction: {} })),
  }

  const service = new OrdersService(repository, null, {
    cartService,
    cartRepository,
    addressesRepository,
    shopProductsRepository,
    couponsService,
    walletRepository,
    // No paymentSettingsService — _checkPaymentMethodAllowed short-circuits
    // to null (allowed), matching how it behaves when unconfigured today.
  })

  return { service, repository, cartRepository, couponsService, walletRepository, shopProductsRepository }
}

describe('OrdersService.placeOrder — wallet + coupon', () => {
  beforeEach(() => {
    mockClient.query.mockClear()
  })

  it('wallet OFF → normal total, no wallet touched', async () => {
    const { service, walletRepository } = makeDeps({ walletBalance: 500 })
    const result = await service.placeOrder(CUSTOMER_ID, {
      addressId: ADDRESS_ID, paymentMethod: 'COD', useWallet: false,
    })
    expect(result.order.totalAmount).toBe(230) // 200 + 25 delivery + 5 platform
    expect(result.order.walletAmountUsed).toBe(0)
    expect(walletRepository.getOrCreate).not.toHaveBeenCalled()
    expect(walletRepository.debit).not.toHaveBeenCalled()
  })

  it('COD + wallet ON with partial balance → payable reduces by exactly the balance used', async () => {
    const { service, walletRepository } = makeDeps({ walletBalance: 100 })
    const result = await service.placeOrder(CUSTOMER_ID, {
      addressId: ADDRESS_ID, paymentMethod: 'COD', useWallet: true,
    })
    // payable before wallet = 230; wallet has 100 → walletApplied = min(100,230) = 100
    expect(result.order.walletAmountUsed).toBe(100)
    expect(result.order.totalAmount).toBe(130)
    expect(result.order.paymentStatus).toBe('PENDING')
    expect(walletRepository.debit).toHaveBeenCalledWith(
      mockClient, 'wallet-1', 100, expect.any(String), expect.any(String), expect.objectContaining({ orderId: expect.any(String) })
    )
  })

  it('COD + wallet ON with balance greater than order → remaining becomes ₹0 and order is marked PAID', async () => {
    const { service, walletRepository, cartRepository } = makeDeps({ walletBalance: 500 })
    const result = await service.placeOrder(CUSTOMER_ID, {
      addressId: ADDRESS_ID, paymentMethod: 'COD', useWallet: true,
    })
    expect(result.order.walletAmountUsed).toBe(230) // never more than the bill, even with ₹500 available
    expect(result.order.totalAmount).toBe(0)
    expect(result.order.paymentStatus).toBe('PAID')
    expect(walletRepository.debit).toHaveBeenCalledWith(
      mockClient, 'wallet-1', 230, expect.any(String), expect.any(String), expect.any(Object)
    )
    expect(cartRepository.clearCart).toHaveBeenCalled()
  })

  it('wallet OFF again after being toggled on restores the original (unreduced) total', async () => {
    const { service } = makeDeps({ walletBalance: 500 })
    const withWallet = await service.placeOrder(CUSTOMER_ID, {
      addressId: ADDRESS_ID, paymentMethod: 'COD', useWallet: true, clientOrderRef: 'attempt-1',
    })
    const withoutWallet = await service.placeOrder(CUSTOMER_ID, {
      addressId: ADDRESS_ID, paymentMethod: 'COD', useWallet: false, clientOrderRef: 'attempt-2',
    })
    expect(withWallet.order.totalAmount).toBe(0)
    expect(withoutWallet.order.totalAmount).toBe(230)
  })

  it('ONLINE + wallet ON with partial balance defers the debit — nothing taken at order-creation time', async () => {
    const { service, walletRepository } = makeDeps({ walletBalance: 100 })
    const result = await service.placeOrder(CUSTOMER_ID, {
      addressId: ADDRESS_ID, paymentMethod: 'ONLINE', useWallet: true,
    })
    expect(result.order.walletAmountUsed).toBe(100)
    expect(result.order.totalAmount).toBe(130)
    expect(result.order.walletDebited).toBe(false)
    expect(result.order.paymentStatus).toBe('PENDING')
    expect(walletRepository.debit).not.toHaveBeenCalled()
  })

  it('ONLINE + wallet ON fully covering the total debits immediately and skips Razorpay (PAID at creation)', async () => {
    const { service, walletRepository } = makeDeps({ walletBalance: 1000 })
    const result = await service.placeOrder(CUSTOMER_ID, {
      addressId: ADDRESS_ID, paymentMethod: 'ONLINE', useWallet: true,
    })
    expect(result.order.totalAmount).toBe(0)
    expect(result.order.paymentStatus).toBe('PAID')
    expect(result.order.walletDebited).toBe(true)
    expect(walletRepository.debit).toHaveBeenCalledTimes(1)
  })

  it('ONLINE without wallet leaves the full total untouched and never reads the wallet', async () => {
    const { service, walletRepository } = makeDeps({ walletBalance: 500 })
    const result = await service.placeOrder(CUSTOMER_ID, {
      addressId: ADDRESS_ID, paymentMethod: 'ONLINE', useWallet: false,
    })
    expect(result.order.totalAmount).toBe(230)
    expect(walletRepository.getOrCreate).not.toHaveBeenCalled()
  })

  it('coupon + wallet together — discount applies first, then wallet reduces the post-discount remainder', async () => {
    const { service, couponsService, walletRepository } = makeDeps({
      walletBalance: 100,
      couponResult: { valid: true, discount: 50, freeDelivery: false, cashbackAmount: 0, couponId: 'coupon-1' },
    })
    const result = await service.placeOrder(CUSTOMER_ID, {
      addressId: ADDRESS_ID, paymentMethod: 'COD', useWallet: true, couponCode: '20FLAT',
    })
    // subtotal 200 - discount 50 + delivery 25 + platform 5 = 180; wallet 100 → payable 80
    expect(result.order.discountAmount).toBe(50)
    expect(result.order.walletAmountUsed).toBe(100)
    expect(result.order.totalAmount).toBe(80)
    expect(couponsService.validate).toHaveBeenCalledWith(CUSTOMER_ID, '20FLAT', 200, expect.any(Array))
    expect(couponsService.recordUsageForOrder).toHaveBeenCalled()
    expect(walletRepository.debit).toHaveBeenCalledWith(
      mockClient, 'wallet-1', 100, expect.any(String), expect.any(String), expect.any(Object)
    )
  })

  it('rejects an invalid coupon with the backend message instead of silently ignoring it', async () => {
    const { service } = makeDeps({
      couponResult: { valid: false, message: 'This coupon has expired.', code: 'COUPON_EXPIRED' },
    })
    await expect(
      service.placeOrder(CUSTOMER_ID, { addressId: ADDRESS_ID, paymentMethod: 'COD', couponCode: 'DEAD10' })
    ).rejects.toThrow('This coupon has expired.')
  })

  it('double tap with the same clientOrderRef returns the existing order instead of creating a duplicate', async () => {
    const { service, repository } = makeDeps({ walletBalance: 0 })
    const first = await service.placeOrder(CUSTOMER_ID, {
      addressId: ADDRESS_ID, paymentMethod: 'COD', clientOrderRef: 'same-attempt',
    })
    // Simulate the ref now existing (as it would in a real DB after the first call committed).
    repository.findByClientOrderRef.mockResolvedValueOnce([first.order])

    const second = await service.placeOrder(CUSTOMER_ID, {
      addressId: ADDRESS_ID, paymentMethod: 'COD', clientOrderRef: 'same-attempt',
    })

    expect(second.order.id).toBe(first.order.id)
    expect(repository.createCheckoutOrder).toHaveBeenCalledTimes(1) // not called again for the replay
  })
})
