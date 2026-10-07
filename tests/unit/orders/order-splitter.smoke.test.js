import { describe, it, expect, vi } from 'vitest'

// Avoid touching Postgres while exercising the splitter
vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// This suite predates the purchase-limits feature and exercises none of its
// behavior (that's covered separately) — OrderSplitterService
// default-constructs a real PurchaseLimitsService when no dep is injected,
// which would otherwise issue extra, unmocked `client.query()` calls at the
// start of every createOrders() and shift every test's sequential
// `client.query.mockResolvedValueOnce` setup by one. Stubbing it to always
// report "no failures" keeps this file scoped to what it actually tests.
vi.mock('../../../src/modules/purchase-limits/purchase-limits.service.js', () => ({
  PurchaseLimitsService: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn().mockResolvedValue({ ok: true }),
    evaluateCheckout: vi.fn().mockResolvedValue([]),
  })),
}))

import { OrderSplitterService } from '../../../src/modules/orders/order-splitter.service.js'

// ═══════════════════════════════════════════════════════════
// Smoke tests — pure split + fee math + transactional create
// (full Property tests live in tasks 6.3 / 6.4 / 6.5)
// ═══════════════════════════════════════════════════════════

const SHOP_A = '11111111-1111-1111-1111-111111111111'
const SHOP_B = '22222222-2222-2222-2222-222222222222'
const PROD_1 = '33333333-3333-3333-3333-333333333333'
const PROD_2 = '44444444-4444-4444-4444-444444444444'
const SP_1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SP_2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const USER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

function makeOrdersRepoMock() {
  return {
    create: vi.fn(),
    generateOrderNumber: vi.fn(),
  }
}

function makeShopProductsRepoMock() {
  return {
    findByIdForUpdate: vi.fn(),
    applyStockChange: vi.fn(),
  }
}

function makeClientMock() {
  return { query: vi.fn(), release: vi.fn() }
}

describe('OrderSplitterService construction', () => {
  it('requires both repositories', () => {
    expect(() => new OrderSplitterService({})).toThrow()
    expect(
      () =>
        new OrderSplitterService({
          ordersRepository: makeOrdersRepoMock(),
        })
    ).toThrow()
  })

  it('uses default fee values when none provided', () => {
    const svc = new OrderSplitterService({
      ordersRepository: makeOrdersRepoMock(),
      shopProductsRepository: makeShopProductsRepoMock(),
    })
    expect(svc.deliveryFee).toBe(25)
    expect(svc.platformFee).toBe(5)
    expect(svc.freeDeliveryThreshold).toBe(499)
  })
})

describe('OrderSplitterService.splitCart (Property 6 sanity)', () => {
  const svc = new OrderSplitterService({
    ordersRepository: makeOrdersRepoMock(),
    shopProductsRepository: makeShopProductsRepoMock(),
  })

  it('groups items by shopId and produces one entry per shop', () => {
    const items = [
      { productId: PROD_1, shopId: SHOP_A, quantity: 2 },
      { productId: PROD_2, shopId: SHOP_B, quantity: 1 },
      { productId: PROD_1, shopId: SHOP_A, quantity: 3 },
    ]
    const groups = svc.splitCart(items)
    expect(groups.size).toBe(2)
    expect(groups.get(SHOP_A)).toHaveLength(2)
    expect(groups.get(SHOP_B)).toHaveLength(1)
  })

  it('returns an empty map for an empty cart', () => {
    expect(svc.splitCart([]).size).toBe(0)
    expect(svc.splitCart(null).size).toBe(0)
  })

  it('skips items missing shopId', () => {
    const items = [
      { productId: PROD_1, shopId: null, quantity: 1 },
      { productId: PROD_2, shopId: SHOP_A, quantity: 2 },
    ]
    const groups = svc.splitCart(items)
    expect(groups.size).toBe(1)
    expect(groups.has(SHOP_A)).toBe(true)
  })
})

describe('OrderSplitterService.computeFees (Req 5.7)', () => {
  const svc = new OrderSplitterService({
    ordersRepository: makeOrdersRepoMock(),
    shopProductsRepository: makeShopProductsRepoMock(),
  })

  it('charges flat delivery fee below the threshold', () => {
    const fees = svc.computeFees([{ lineTotal: 100 }, { lineTotal: 50 }])
    expect(fees.subtotal).toBe(150)
    expect(fees.deliveryFee).toBe(25)
    expect(fees.platformFee).toBe(5)
    expect(fees.totalAmount).toBe(180)
  })

  it('waives delivery fee at or above the threshold', () => {
    const fees = svc.computeFees([{ lineTotal: 499 }])
    expect(fees.subtotal).toBe(499)
    expect(fees.deliveryFee).toBe(0)
    expect(fees.totalAmount).toBe(504)
  })

  it('applies the threshold per shop subtotal independently', () => {
    // Shop A subtotal = 200 (charges delivery), Shop B subtotal = 600 (free)
    const a = svc.computeFees([{ lineTotal: 200 }])
    const b = svc.computeFees([{ lineTotal: 600 }])
    expect(a.deliveryFee).toBe(25)
    expect(b.deliveryFee).toBe(0)
  })
})

describe('OrderSplitterService.createOrders — happy path', () => {
  it('locks each shop_product, decrements stock, and creates one order per shop', async () => {
    const ordersRepo = makeOrdersRepoMock()
    const shopProductsRepo = makeShopProductsRepoMock()
    const client = makeClientMock()

    // Shop A: 1 line (qty 2 @ 100, lineTotal 200) — charges delivery
    // Shop B: 1 line (qty 1 @ 600, lineTotal 600) — free delivery
    shopProductsRepo.findByIdForUpdate
      .mockResolvedValueOnce({
        id: SP_1,
        shop_id: SHOP_A,
        product_id: PROD_1,
        stock_quantity: 10,
        max_order_qty: 50,
        is_available: true,
      })
      .mockResolvedValueOnce({
        id: SP_2,
        shop_id: SHOP_B,
        product_id: PROD_2,
        stock_quantity: 5,
        max_order_qty: 20,
        is_available: true,
      })

    shopProductsRepo.applyStockChange
      .mockResolvedValueOnce({
        stockProduct: { id: SP_1, stock_quantity: 8, low_stock_threshold: 5 },
      })
      .mockResolvedValueOnce({
        stockProduct: { id: SP_2, stock_quantity: 4, low_stock_threshold: 5 },
      })

    ordersRepo.generateOrderNumber
      .mockResolvedValueOnce('GRO-20251112-001')
      .mockResolvedValueOnce('GRO-20251112-002')

    ordersRepo.create
      .mockResolvedValueOnce({
        id: 'order-a',
        orderNumber: 'GRO-20251112-001',
        shopId: SHOP_A,
        status: 'CONFIRMED',
        totalAmount: 230,
      })
      .mockResolvedValueOnce({
        id: 'order-b',
        orderNumber: 'GRO-20251112-002',
        shopId: SHOP_B,
        status: 'CONFIRMED',
        totalAmount: 605,
      })

    const svc = new OrderSplitterService({
      ordersRepository: ordersRepo,
      shopProductsRepository: shopProductsRepo,
    })

    const groups = svc.splitCart([
      {
        productId: PROD_1,
        shopId: SHOP_A,
        shopProductId: SP_1,
        quantity: 2,
        salePrice: 100,
        price: 100,
        lineTotal: 200,
        name: 'P1',
      },
      {
        productId: PROD_2,
        shopId: SHOP_B,
        shopProductId: SP_2,
        quantity: 1,
        salePrice: 600,
        price: 600,
        lineTotal: 600,
        name: 'P2',
      },
    ])

    const orders = await svc.createOrders({
      client,
      userId: USER_ID,
      groups,
      deliveryAddress: { lat: 1, lng: 1 },
      payment: { method: 'COD', status: 'PENDING' },
    })

    expect(orders).toHaveLength(2)
    // Shop_A charges delivery
    const shopACall = ordersRepo.create.mock.calls.find(
      ([, data]) => data.shopId === SHOP_A
    )
    expect(shopACall[1].deliveryFee).toBe(25)
    expect(shopACall[1].subtotal).toBe(200)
    // Shop_B subtotal hits threshold → free delivery
    const shopBCall = ordersRepo.create.mock.calls.find(
      ([, data]) => data.shopId === SHOP_B
    )
    expect(shopBCall[1].deliveryFee).toBe(0)
    expect(shopBCall[1].subtotal).toBe(600)

    // Stock locked first, then applied
    expect(shopProductsRepo.findByIdForUpdate).toHaveBeenCalledTimes(2)
    expect(shopProductsRepo.applyStockChange).toHaveBeenCalledTimes(2)

    // Stock decremented by exact item quantity (delta is negative)
    const callsA = shopProductsRepo.applyStockChange.mock.calls.find(
      ([, opts]) => opts.shopProductId === SP_1
    )
    expect(callsA[1].delta).toBe(-2) // qty 2

    const callsB = shopProductsRepo.applyStockChange.mock.calls.find(
      ([, opts]) => opts.shopProductId === SP_2
    )
    expect(callsB[1].delta).toBe(-1) // qty 1
  })
})

describe('OrderSplitterService.createOrders — rejection paths (Req 5.9, 12.7)', () => {
  it('throws CHECKOUT_PARTIAL_FAIL when a shop_product is gone', async () => {
    const ordersRepo = makeOrdersRepoMock()
    const shopProductsRepo = makeShopProductsRepoMock()
    shopProductsRepo.findByIdForUpdate.mockResolvedValueOnce(null)

    const svc = new OrderSplitterService({
      ordersRepository: ordersRepo,
      shopProductsRepository: shopProductsRepo,
    })
    const groups = svc.splitCart([
      {
        productId: PROD_1,
        shopId: SHOP_A,
        shopProductId: SP_1,
        quantity: 1,
        salePrice: 50,
        lineTotal: 50,
      },
    ])

    await expect(
      svc.createOrders({
        client: makeClientMock(),
        userId: USER_ID,
        groups,
        deliveryAddress: {},
        payment: { method: 'COD' },
      })
    ).rejects.toMatchObject({
      code: 'CHECKOUT_PARTIAL_FAIL',
      failures: expect.arrayContaining([
        expect.objectContaining({ productId: PROD_1, shopId: SHOP_A }),
      ]),
    })

    // Must NOT have called create on rejection (Req 5.9)
    expect(ordersRepo.create).not.toHaveBeenCalled()
    expect(shopProductsRepo.applyStockChange).not.toHaveBeenCalled()
  })

  it('throws when stock is insufficient (Req 5.5)', async () => {
    const shopProductsRepo = makeShopProductsRepoMock()
    shopProductsRepo.findByIdForUpdate.mockResolvedValueOnce({
      id: SP_1,
      shop_id: SHOP_A,
      product_id: PROD_1,
      stock_quantity: 1,
      max_order_qty: 50,
      is_available: true,
    })

    const svc = new OrderSplitterService({
      ordersRepository: makeOrdersRepoMock(),
      shopProductsRepository: shopProductsRepo,
    })

    const groups = svc.splitCart([
      {
        productId: PROD_1,
        shopId: SHOP_A,
        shopProductId: SP_1,
        quantity: 5,
        salePrice: 100,
        lineTotal: 500,
      },
    ])

    await expect(
      svc.createOrders({
        client: makeClientMock(),
        userId: USER_ID,
        groups,
        deliveryAddress: {},
        payment: { method: 'COD' },
      })
    ).rejects.toMatchObject({
      code: 'CHECKOUT_PARTIAL_FAIL',
      failures: expect.arrayContaining([
        expect.objectContaining({ code: 'INSUFFICIENT_STOCK' }),
      ]),
    })
  })

  it('throws when quantity exceeds max_order_qty (Req 12.7)', async () => {
    const shopProductsRepo = makeShopProductsRepoMock()
    shopProductsRepo.findByIdForUpdate.mockResolvedValueOnce({
      id: SP_1,
      shop_id: SHOP_A,
      product_id: PROD_1,
      stock_quantity: 100,
      max_order_qty: 5, // newly lowered
      is_available: true,
    })

    const svc = new OrderSplitterService({
      ordersRepository: makeOrdersRepoMock(),
      shopProductsRepository: shopProductsRepo,
    })

    const groups = svc.splitCart([
      {
        productId: PROD_1,
        shopId: SHOP_A,
        shopProductId: SP_1,
        quantity: 10,
        salePrice: 50,
        lineTotal: 500,
      },
    ])

    await expect(
      svc.createOrders({
        client: makeClientMock(),
        userId: USER_ID,
        groups,
        deliveryAddress: {},
        payment: { method: 'COD' },
      })
    ).rejects.toMatchObject({
      code: 'CHECKOUT_PARTIAL_FAIL',
      failures: expect.arrayContaining([
        expect.objectContaining({ code: 'MAX_QTY_EXCEEDED', max: 5 }),
      ]),
    })
  })
})
