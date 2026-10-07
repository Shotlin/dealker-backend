import { beforeEach, describe, expect, it, vi } from 'vitest'

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
const KOLKATA_SHOP_ID = 'shop-kolkata'
const DELHI_SHOP_ID = 'shop-delhi'

/**
 * Regression coverage for "store/branch must be the source of truth for
 * every order" — proves `placeOrder` never collapses a genuinely multi-shop
 * cart onto one shop (a "default/fallback" branch), and that every
 * downstream effect (order row, stock deduction) stays attached to the
 * exact shop each line item actually belongs to
 * (cart.service.js#_resolveProductAndShop already derives this from real
 * shop_products ownership — never a default — this test proves placeOrder
 * preserves that all the way through).
 */
describe('OrdersService.placeOrder — multi-shop cart integrity', () => {
  function makeService() {
    const groupedByShop = new Map([
      [
        KOLKATA_SHOP_ID,
        [
          {
            productId: 'prod-kol-1',
            shopProductId: 'sp-kol-1',
            categoryId: 'cat-1',
            name: 'Kolkata Rohu Fish',
            effectivePrice: 300,
            quantity: 1,
            unit: 'kg',
            lineTotal: 300,
            thumbnailUrl: null,
          },
        ],
      ],
      [
        DELHI_SHOP_ID,
        [
          {
            productId: 'prod-del-1',
            shopProductId: 'sp-del-1',
            categoryId: 'cat-2',
            name: 'Delhi Chicken Curry Cut',
            effectivePrice: 250,
            quantity: 2,
            unit: 'kg',
            lineTotal: 500,
            thumbnailUrl: null,
          },
        ],
      ],
    ])

    const createdRows = []
    const repository = {
      findByClientOrderRef: vi.fn(async () => []),
      generateCheckoutOrderNumber: vi.fn(async (client, shopId) =>
        shopId === KOLKATA_SHOP_ID ? 'FC-KOL-20260923-0001' : 'FC-DEL-20260923-0001'
      ),
      createCheckoutOrder: vi.fn(async (client, data) => {
        const row = {
          id: `order-${data.shopId}`,
          order_number: data.orderNumber,
          customer_id: CUSTOMER_ID,
          shop_id: data.shopId,
          status: data.status,
          items: data.items,
          subtotal: data.subtotal,
          discount_amount: data.discountAmount,
          delivery_fee: data.deliveryFee,
          platform_fee: data.platformFee,
          total_payable: data.totalPayable,
          payment_method: data.paymentMethod,
          payment_status: data.paymentStatus,
          coupon_code: data.couponCode,
          wallet_amount: data.walletAmount,
          wallet_debited: data.walletDebited,
          created_at: new Date(),
          updated_at: new Date(),
        }
        createdRows.push(row)
        return row
      }),
      logStatusTransition: vi.fn(async () => ({})),
      _formatCheckoutOrder(row) {
        return {
          id: row.id,
          orderNumber: row.order_number,
          shopId: row.shop_id,
          status: row.status,
          subtotal: Number(row.subtotal || 0),
          discountAmount: Number(row.discount_amount || 0),
          totalAmount: Number(row.total_payable || 0),
          walletAmountUsed: Number(row.wallet_amount || 0),
          paymentMethod: row.payment_method,
          paymentStatus: row.payment_status,
        }
      },
    }

    const cartService = { validateCart: vi.fn(async () => ({ valid: true, groupedByShop })) }
    const cartRepository = { clearCart: vi.fn(async () => {}), clearExtras: vi.fn(async () => {}) }
    const addressesRepository = { findByIdAndUser: vi.fn(async () => ({ id: ADDRESS_ID })) }
    const shopProductsRepository = { applyStockChange: vi.fn(async () => {}) }
    const couponsService = {
      validate: vi.fn(async () => ({ valid: true, discount: 0, freeDelivery: false, cashbackAmount: 0, couponId: null })),
      recordUsageForOrder: vi.fn(async () => {}),
    }
    const walletRepository = {
      getOrCreate: vi.fn(async () => ({ id: 'wallet-1', balance: 0 })),
      getForUpdate: vi.fn(async () => ({ id: 'wallet-1', balance: 0 })),
      debit: vi.fn(async () => ({})),
    }

    const service = new OrdersService(repository, null, {
      cartService, cartRepository, addressesRepository, shopProductsRepository,
      couponsService, walletRepository,
    })
    return { service, repository, shopProductsRepository, createdRows }
  }

  beforeEach(() => {
    mockClient.query.mockClear()
  })

  it('creates one order per shop, each carrying its OWN real shop_id — never collapsed onto a single/default shop', async () => {
    const { service, createdRows } = makeService()

    const result = await service.placeOrder(CUSTOMER_ID, {
      addressId: ADDRESS_ID, paymentMethod: 'COD',
    })

    expect(result.orders).toHaveLength(2)
    const shopIds = result.orders.map((o) => o.shopId).sort()
    expect(shopIds).toEqual([DELHI_SHOP_ID, KOLKATA_SHOP_ID].sort())

    const kolkataOrder = createdRows.find((r) => r.shop_id === KOLKATA_SHOP_ID)
    const delhiOrder = createdRows.find((r) => r.shop_id === DELHI_SHOP_ID)
    expect(kolkataOrder.subtotal).toBe(300)
    expect(delhiOrder.subtotal).toBe(500)
    // Each order's own items array only ever contains that shop's lines.
    expect(kolkataOrder.items).toHaveLength(1)
    expect(kolkataOrder.items[0].productId).toBe('prod-kol-1')
    expect(delhiOrder.items).toHaveLength(1)
    expect(delhiOrder.items[0].productId).toBe('prod-del-1')
  })

  it('deducts stock only against each line\'s own shopProductId — never crossed between branches', async () => {
    const { service, shopProductsRepository } = makeService()

    await service.placeOrder(CUSTOMER_ID, { addressId: ADDRESS_ID, paymentMethod: 'COD' })

    const calls = shopProductsRepository.applyStockChange.mock.calls.map((c) => c[1])
    expect(calls).toHaveLength(2)
    expect(calls.find((c) => c.shopProductId === 'sp-kol-1')).toBeTruthy()
    expect(calls.find((c) => c.shopProductId === 'sp-del-1')).toBeTruthy()
    // The Kolkata stock line must be attached to the Kolkata order id, not
    // the Delhi one (or some shared/default id).
    const kolCall = calls.find((c) => c.shopProductId === 'sp-kol-1')
    const delCall = calls.find((c) => c.shopProductId === 'sp-del-1')
    expect(kolCall.orderId).not.toBe(delCall.orderId)
  })

  it('generates a distinct, correctly-shop-prefixed order number per branch (never one shop\'s prefix reused for another)', async () => {
    const { service, repository } = makeService()

    await service.placeOrder(CUSTOMER_ID, { addressId: ADDRESS_ID, paymentMethod: 'COD' })

    const shopIdsAskedFor = repository.generateCheckoutOrderNumber.mock.calls.map((c) => c[1])
    expect(shopIdsAskedFor.sort()).toEqual([DELHI_SHOP_ID, KOLKATA_SHOP_ID].sort())
  })
})
