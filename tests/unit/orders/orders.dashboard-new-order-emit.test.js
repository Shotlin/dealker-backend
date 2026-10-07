import { beforeEach, describe, expect, it, vi } from 'vitest'

// orders.service.js transitively imports config/database.js + bullmq.js
// (pg Pool / BullMQ Queue construction) — mock both so this unit test needs
// no live DB/Redis, same convention as orders.place-order-wallet.test.js.
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
import { logger as mockLogger } from '../../../src/config/logger.js'

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

/** Mirrors `orders.place-order-wallet.test.js`'s own harness, plus a spy-able `fastify`. */
function makeDeps({ cartLines = [cartLine()], walletBalance = 0 } = {}) {
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
      created_at: new Date('2026-09-27T10:00:00Z'),
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
        createdAt: row.created_at,
      }
    },
  }

  const cartService = { validateCart: vi.fn(async () => ({ valid: true, groupedByShop })) }
  const cartRepository = { clearCart: vi.fn(async () => {}), clearExtras: vi.fn(async () => {}) }
  const addressesRepository = { findByIdAndUser: vi.fn(async () => ({ id: ADDRESS_ID, label: 'Home' })) }
  const shopProductsRepository = { applyStockChange: vi.fn(async () => {}) }
  const couponsService = {
    validate: vi.fn(async () => ({ valid: true, discount: 0, freeDelivery: false, cashbackAmount: 0, couponId: 'coupon-1' })),
    recordUsageForOrder: vi.fn(async () => {}),
  }
  const walletRepository = {
    getOrCreate: vi.fn(async () => ({ id: 'wallet-1', balance: walletBalance })),
    getForUpdate: vi.fn(async () => ({ id: 'wallet-1', balance: walletBalance })),
    debit: vi.fn(async (client, walletId, amount) => ({ wallet: { id: walletId, balance: walletBalance - amount }, transaction: {} })),
  }
  const fastify = { emitDashboardNewOrder: vi.fn() }

  const service = new OrdersService(repository, null, {
    cartService,
    cartRepository,
    addressesRepository,
    shopProductsRepository,
    couponsService,
    walletRepository,
    fastify,
  })

  return { service, fastify }
}

describe('OrdersService.placeOrder — real-time dashboard new-order alert', () => {
  beforeEach(() => {
    mockClient.query.mockClear()
    mockLogger.warn.mockClear()
  })

  it('a COD order emits dashboard:new_order immediately at placement', async () => {
    const { service, fastify } = makeDeps({ walletBalance: 0 })
    const result = await service.placeOrder(CUSTOMER_ID, {
      addressId: ADDRESS_ID, paymentMethod: 'COD', useWallet: false,
    })

    expect(fastify.emitDashboardNewOrder).toHaveBeenCalledTimes(1)
    expect(fastify.emitDashboardNewOrder).toHaveBeenCalledWith({
      id: result.order.id,
      order_number: 'FC-TEST-0001',
      total: 230,
      payment_method: 'COD',
      shop_id: SHOP_ID,
      created_at: new Date('2026-09-27T10:00:00Z'),
    })
  })

  it('an ONLINE order fully covered by wallet (payment_status PAID) also emits immediately', async () => {
    const { service, fastify } = makeDeps({ walletBalance: 500 })
    await service.placeOrder(CUSTOMER_ID, {
      addressId: ADDRESS_ID, paymentMethod: 'ONLINE', useWallet: true,
    })

    expect(fastify.emitDashboardNewOrder).toHaveBeenCalledTimes(1)
    expect(fastify.emitDashboardNewOrder.mock.calls[0][0]).toMatchObject({ payment_method: 'ONLINE', shop_id: SHOP_ID })
  })

  it('a still-outstanding ONLINE order does NOT emit at placement — only once payment is actually confirmed', async () => {
    const { service, fastify } = makeDeps({ walletBalance: 0 })
    await service.placeOrder(CUSTOMER_ID, {
      addressId: ADDRESS_ID, paymentMethod: 'ONLINE', useWallet: false,
    })

    expect(fastify.emitDashboardNewOrder).not.toHaveBeenCalled()
  })

  it('never blocks order placement if the socket emit itself throws', async () => {
    const { service, fastify } = makeDeps({ walletBalance: 0 })
    fastify.emitDashboardNewOrder.mockImplementation(() => {
      throw new Error('socket down')
    })

    const result = await service.placeOrder(CUSTOMER_ID, {
      addressId: ADDRESS_ID, paymentMethod: 'COD', useWallet: false,
    })

    expect(result.order).toBeTruthy()
    expect(mockLogger.warn).toHaveBeenCalled()
  })

  it('no fastify dep at all (e.g. a caller that never wired it) never throws', async () => {
    const groupedByShop = new Map([[SHOP_ID, [cartLine()]]])
    const repository = {
      findByClientOrderRef: vi.fn(async () => []),
      generateCheckoutOrderNumber: vi.fn(async () => 'FC-TEST-0001'),
      createCheckoutOrder: vi.fn(async (client, data) => ({
        id: 'order-x', order_number: 'FC-TEST-0001', shop_id: data.shopId, status: data.status,
        items: data.items, subtotal: data.subtotal, discount_amount: data.discountAmount,
        delivery_fee: data.deliveryFee, platform_fee: data.platformFee, tax_amount: 0,
        total_payable: data.totalPayable, payment_method: data.paymentMethod, payment_status: data.paymentStatus,
        coupon_code: data.couponCode, wallet_amount: data.walletAmount, wallet_debited: data.walletDebited,
        client_order_ref: data.clientOrderRef, delivery_address: data.deliveryAddress,
        delivery_notes: data.deliveryNotes, estimated_delivery: data.estimatedDelivery,
        created_at: new Date(), updated_at: new Date(),
      })),
      logStatusTransition: vi.fn(async () => ({})),
      _formatCheckoutOrder(row) {
        return {
          id: row.id, orderNumber: row.order_number, shopId: row.shop_id, status: row.status,
          totalAmount: Number(row.total_payable || 0), walletAmountUsed: Number(row.wallet_amount || 0),
          walletDebited: !!row.wallet_debited, paymentMethod: row.payment_method, paymentStatus: row.payment_status,
          couponCode: null, clientOrderRef: null, createdAt: row.created_at,
        }
      },
    }
    const service = new OrdersService(repository, null, {
      cartService: { validateCart: vi.fn(async () => ({ valid: true, groupedByShop })) },
      cartRepository: { clearCart: vi.fn(async () => {}), clearExtras: vi.fn(async () => {}) },
      addressesRepository: { findByIdAndUser: vi.fn(async () => ({ id: ADDRESS_ID })) },
      shopProductsRepository: { applyStockChange: vi.fn(async () => {}) },
      couponsService: { validate: vi.fn(async () => ({ valid: true, discount: 0, freeDelivery: false })) },
      walletRepository: { getOrCreate: vi.fn(async () => ({ id: 'w', balance: 0 })) },
      // no `fastify` at all
    })

    const result = await service.placeOrder(CUSTOMER_ID, {
      addressId: ADDRESS_ID, paymentMethod: 'COD', useWallet: false,
    })
    expect(result.order).toBeTruthy()
  })
})
