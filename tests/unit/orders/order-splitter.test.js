import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external collaborators BEFORE importing the SUT ─────────────
vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  cacheDeletePattern: vi.fn(),
}))

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../../src/config/redis.js', () => ({
  redis: {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
  },
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

// ═══════════════════════════════════════════════════════════════════════
// Test fixtures
// ═══════════════════════════════════════════════════════════════════════

const SHOP_A = '11111111-1111-1111-1111-111111111111'
const SHOP_B = '22222222-2222-2222-2222-222222222222'
const SHOP_C = '33333333-3333-3333-3333-333333333333'
const PROD_1 = '44444444-4444-4444-4444-444444444411'
const PROD_2 = '55555555-5555-5555-5555-555555555522'
const PROD_3 = '66666666-6666-6666-6666-666666666633'
const SP_A1 = 'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SP_B1 = 'bbbbbbb1-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const SP_B2 = 'bbbbbbb2-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const SP_C1 = 'ccccccc1-cccc-cccc-cccc-cccccccccccc'
const USER_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'

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

function makeSvc({ ordersRepo, shopProductsRepo, fees } = {}) {
  return new OrderSplitterService({
    ordersRepository: ordersRepo || makeOrdersRepoMock(),
    shopProductsRepository: shopProductsRepo || makeShopProductsRepoMock(),
    fees,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════
// 1.  splitCart — additional edge cases beyond the smoke test
// ═══════════════════════════════════════════════════════════════════════

describe('OrderSplitterService.splitCart — edge cases', () => {
  it('keeps lines for the same product but different shops as separate group entries', () => {
    const svc = makeSvc()
    const groups = svc.splitCart([
      { productId: PROD_1, shopId: SHOP_A, quantity: 1 },
      { productId: PROD_1, shopId: SHOP_B, quantity: 2 },
    ])

    expect(groups.size).toBe(2)
    expect(groups.get(SHOP_A)).toHaveLength(1)
    expect(groups.get(SHOP_B)).toHaveLength(1)
    expect(groups.get(SHOP_A)[0].productId).toBe(PROD_1)
    expect(groups.get(SHOP_B)[0].productId).toBe(PROD_1)
  })

  it('preserves item insertion order within each shop bucket', () => {
    const svc = makeSvc()
    const a1 = { productId: PROD_1, shopId: SHOP_A, quantity: 1, lineTotal: 10 }
    const a2 = { productId: PROD_2, shopId: SHOP_A, quantity: 2, lineTotal: 20 }
    const a3 = { productId: PROD_3, shopId: SHOP_A, quantity: 3, lineTotal: 30 }

    const groups = svc.splitCart([a1, a2, a3])
    expect(groups.get(SHOP_A)).toEqual([a1, a2, a3])
  })

  it('produces the same Map regardless of input ordering (numeric keys are not reordered)', () => {
    const itemsX = [
      { productId: PROD_1, shopId: SHOP_B, quantity: 1 },
      { productId: PROD_2, shopId: SHOP_A, quantity: 2 },
      { productId: PROD_3, shopId: SHOP_C, quantity: 3 },
    ]
    const itemsY = [...itemsX].reverse()

    const gx = makeSvc().splitCart(itemsX)
    const gy = makeSvc().splitCart(itemsY)

    expect(gx.size).toBe(3)
    expect(gy.size).toBe(3)
    // Same set of shop keys regardless of input order
    expect([...gx.keys()].sort()).toEqual([...gy.keys()].sort())
    // Each shop's bucket has the same items (set-equal)
    for (const shop of gx.keys()) {
      expect(gx.get(shop)).toEqual(
        expect.arrayContaining(gy.get(shop))
      )
      expect(gy.get(shop)).toEqual(
        expect.arrayContaining(gx.get(shop))
      )
    }
  })

  it('keeps items missing productId in the group (createOrders is responsible for catching them later)', () => {
    const svc = makeSvc()
    const groups = svc.splitCart([
      { shopId: SHOP_A, quantity: 1 }, // no productId
      { productId: PROD_1, shopId: SHOP_A, quantity: 2 },
    ])
    // Items without productId are NOT filtered here; only items without
    // shopId are dropped (they cannot be grouped).
    expect(groups.get(SHOP_A)).toHaveLength(2)
  })

  it('treats undefined/missing shopId items as un-groupable (drops them)', () => {
    const svc = makeSvc()
    const groups = svc.splitCart([
      { productId: PROD_1, quantity: 1 }, // no shopId field at all
      { productId: PROD_2, shopId: undefined, quantity: 1 },
      { productId: PROD_3, shopId: SHOP_A, quantity: 1 },
    ])
    expect(groups.size).toBe(1)
    expect(groups.has(SHOP_A)).toBe(true)
    expect(groups.get(SHOP_A)).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 2.  computeFees — Property tests for invariants (Req 5.7)
// ═══════════════════════════════════════════════════════════════════════

describe('OrderSplitterService.computeFees — invariants', () => {
  it('subtotal equals sum(lineTotal) rounded to 2 decimals', () => {
    const svc = makeSvc()

    // Floating-point sum that needs rounding: 0.1 + 0.2 + 0.3 = 0.6 in math
    // but 0.6000000000000001 in JS without rounding.
    const fees = svc.computeFees([
      { lineTotal: 0.1 },
      { lineTotal: 0.2 },
      { lineTotal: 0.3 },
    ])
    expect(fees.subtotal).toBe(0.6)

    // Three-decimal entries get rounded to 2 (cumulative effect)
    const fees2 = svc.computeFees([
      { lineTotal: 19.999 },
      { lineTotal: 0.001 },
    ])
    expect(fees2.subtotal).toBe(20)
  })

  it('coerces missing lineTotal to 0', () => {
    // The splitter uses `Number(item.lineTotal ?? 0)`, so undefined is treated
    // as 0. Non-numeric strings would propagate NaN — that case is upstream
    // input that the cart service guarantees is numeric (`_formatLine`).
    const svc = makeSvc()
    const fees = svc.computeFees([
      { lineTotal: 100 },
      {}, // missing
    ])
    expect(fees.subtotal).toBe(100)
  })

  it('deliveryFee=0 iff subtotal >= threshold (and equals deliveryFee otherwise)', () => {
    const svc = makeSvc({ fees: { freeDeliveryThreshold: 499, deliveryFee: 25 } })

    // Just below threshold → charge
    const below = svc.computeFees([{ lineTotal: 498.99 }])
    expect(below.subtotal).toBe(498.99)
    expect(below.deliveryFee).toBe(25)

    // Exactly at threshold → free (>= rule)
    const at = svc.computeFees([{ lineTotal: 499 }])
    expect(at.subtotal).toBe(499)
    expect(at.deliveryFee).toBe(0)

    // Above threshold → free
    const above = svc.computeFees([{ lineTotal: 1000 }])
    expect(above.deliveryFee).toBe(0)

    // Empty cart → 0 subtotal, charge applies (0 < 499)
    const empty = svc.computeFees([])
    expect(empty.subtotal).toBe(0)
    expect(empty.deliveryFee).toBe(25)
  })

  it('totalAmount equals subtotal + deliveryFee + platformFee for a sample of cases', () => {
    const svc = makeSvc({
      fees: { deliveryFee: 25, platformFee: 5, freeDeliveryThreshold: 499 },
    })

    const samples = [
      [{ lineTotal: 100 }],
      [{ lineTotal: 500 }],
      [{ lineTotal: 99.99 }, { lineTotal: 0.01 }],
      [{ lineTotal: 250.5 }, { lineTotal: 250.5 }], // 501 → free delivery
      [{ lineTotal: 1 }],
    ]

    for (const items of samples) {
      const fees = svc.computeFees(items)
      const expected = Number(
        (fees.subtotal + fees.deliveryFee + fees.platformFee).toFixed(2)
      )
      expect(fees.totalAmount).toBe(expected)
      expect(fees.platformFee).toBe(5)
    }
  })

  it('honours custom fee configuration', () => {
    const svc = makeSvc({
      fees: { deliveryFee: 40, platformFee: 10, freeDeliveryThreshold: 999 },
    })
    const fees = svc.computeFees([{ lineTotal: 200 }])
    expect(fees.deliveryFee).toBe(40)
    expect(fees.platformFee).toBe(10)
    expect(fees.totalAmount).toBe(250)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 3.  createOrders — guard rails
// ═══════════════════════════════════════════════════════════════════════

describe('OrderSplitterService.createOrders — guards', () => {
  it('throws when no client is provided', async () => {
    const svc = makeSvc()
    const groups = svc.splitCart([
      { productId: PROD_1, shopId: SHOP_A, shopProductId: SP_A1, quantity: 1 },
    ])

    await expect(
      svc.createOrders({
        client: null,
        userId: USER_ID,
        groups,
        deliveryAddress: {},
        payment: { method: 'COD' },
      })
    ).rejects.toThrow(/createOrders requires an open pg client/)
  })

  it('throws EMPTY_CART when groups is null or empty', async () => {
    const svc = makeSvc()
    const client = makeClientMock()

    await expect(
      svc.createOrders({
        client,
        userId: USER_ID,
        groups: null,
        deliveryAddress: {},
        payment: { method: 'COD' },
      })
    ).rejects.toMatchObject({ code: 'EMPTY_CART' })

    await expect(
      svc.createOrders({
        client,
        userId: USER_ID,
        groups: new Map(),
        deliveryAddress: {},
        payment: { method: 'COD' },
      })
    ).rejects.toMatchObject({ code: 'EMPTY_CART' })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 4.  createOrders — happy path: stock locking + N orders
// ═══════════════════════════════════════════════════════════════════════

describe('OrderSplitterService.createOrders — happy path', () => {
  it('calls findByIdForUpdate then applyStockChange for each item, in lock-then-apply order, stamping the newly-created order id onto the ledger', async () => {
    const ordersRepo = makeOrdersRepoMock()
    const shopProductsRepo = makeShopProductsRepoMock()

    shopProductsRepo.findByIdForUpdate
      .mockResolvedValueOnce({
        id: SP_A1,
        shop_id: SHOP_A,
        product_id: PROD_1,
        stock_quantity: 10,
        max_order_qty: 50,
        is_available: true,
      })
      .mockResolvedValueOnce({
        id: SP_B1,
        shop_id: SHOP_B,
        product_id: PROD_2,
        stock_quantity: 8,
        max_order_qty: 50,
        is_available: true,
      })
      .mockResolvedValueOnce({
        id: SP_B2,
        shop_id: SHOP_B,
        product_id: PROD_3,
        stock_quantity: 4,
        max_order_qty: 50,
        is_available: true,
      })

    shopProductsRepo.applyStockChange
      .mockResolvedValueOnce({ stockProduct: { id: SP_A1, stock_quantity: 8, low_stock_threshold: 5 } })
      .mockResolvedValueOnce({ stockProduct: { id: SP_B1, stock_quantity: 7, low_stock_threshold: 5 } })
      .mockResolvedValueOnce({ stockProduct: { id: SP_B2, stock_quantity: 1, low_stock_threshold: 5 } })

    ordersRepo.generateOrderNumber
      .mockResolvedValueOnce('GRO-20251112-001')
      .mockResolvedValueOnce('GRO-20251112-002')

    ordersRepo.create
      .mockResolvedValueOnce({ id: 'order-a', shopId: SHOP_A })
      .mockResolvedValueOnce({ id: 'order-b', shopId: SHOP_B })

    const svc = makeSvc({ ordersRepo, shopProductsRepo })
    const client = makeClientMock()

    const groups = svc.splitCart([
      {
        productId: PROD_1,
        shopId: SHOP_A,
        shopProductId: SP_A1,
        quantity: 2,
        salePrice: 100,
        price: 100,
        lineTotal: 200,
        name: 'P1',
      },
      {
        productId: PROD_2,
        shopId: SHOP_B,
        shopProductId: SP_B1,
        quantity: 1,
        salePrice: 600,
        price: 600,
        lineTotal: 600,
        name: 'P2',
      },
      {
        productId: PROD_3,
        shopId: SHOP_B,
        shopProductId: SP_B2,
        quantity: 3,
        salePrice: 50,
        price: 50,
        lineTotal: 150,
        name: 'P3',
      },
    ])

    const orders = await svc.createOrders({
      client,
      userId: USER_ID,
      groups,
      deliveryAddress: { lat: 1, lng: 1 },
      payment: { method: 'COD', status: 'PENDING' },
    })

    // N shops in → N orders out
    expect(orders).toHaveLength(2)

    // findByIdForUpdate called once per item
    expect(shopProductsRepo.findByIdForUpdate).toHaveBeenCalledTimes(3)
    // applyStockChange called once per item
    expect(shopProductsRepo.applyStockChange).toHaveBeenCalledTimes(3)

    // Lock occurs strictly BEFORE apply for the same shop_product_id.
    // Within a shop the splitter verifies all items first, then creates the
    // order (so its id exists), then applies all stock changes — so the
    // last lock precedes the first apply globally as well.
    const lockOrders = shopProductsRepo.findByIdForUpdate.mock.invocationCallOrder
    const applyOrders = shopProductsRepo.applyStockChange.mock.invocationCallOrder
    expect(applyOrders[0]).toBeGreaterThan(lockOrders[0])

    // The stock decrement is a signed negative delta through the
    // centralized ORDER_DEDUCTION ledger path, stamped with the real
    // order id created for that shop (order-a for SHOP_A's line).
    expect(shopProductsRepo.applyStockChange).toHaveBeenNthCalledWith(1, client, {
      shopProductId: SP_A1,
      delta: -2,
      type: 'ORDER_DEDUCTION',
      source: 'ORDER',
      orderId: 'order-a',
      actor: null,
    })
  })

  it('returns array length = N shops', async () => {
    const ordersRepo = makeOrdersRepoMock()
    const shopProductsRepo = makeShopProductsRepoMock()

    // Three shops, one item each
    shopProductsRepo.findByIdForUpdate.mockImplementation(async (_c, id, shopId) => ({
      id,
      shop_id: shopId,
      product_id: 'p',
      stock_quantity: 100,
      max_order_qty: 50,
      is_available: true,
    }))
    shopProductsRepo.applyStockChange.mockResolvedValue({ stockProduct: { id: 'x', low_stock_threshold: 5 } })
    ordersRepo.generateOrderNumber.mockImplementation(async () => `GRO-${Math.random()}`)
    ordersRepo.create.mockImplementation(async (_c, data) => ({
      id: `order-${data.shopId}`,
      shopId: data.shopId,
    }))

    const svc = makeSvc({ ordersRepo, shopProductsRepo })
    const groups = svc.splitCart([
      { productId: PROD_1, shopId: SHOP_A, shopProductId: SP_A1, quantity: 1, lineTotal: 10 },
      { productId: PROD_2, shopId: SHOP_B, shopProductId: SP_B1, quantity: 1, lineTotal: 10 },
      { productId: PROD_3, shopId: SHOP_C, shopProductId: SP_C1, quantity: 1, lineTotal: 10 },
    ])

    const orders = await svc.createOrders({
      client: makeClientMock(),
      userId: USER_ID,
      groups,
      deliveryAddress: {},
      payment: { method: 'COD' },
    })

    expect(orders).toHaveLength(3)
    expect(orders.map((o) => o.shopId).sort()).toEqual(
      [SHOP_A, SHOP_B, SHOP_C].sort()
    )
  })

  it('order numbers are unique per shop (generateOrderNumber called once per shop)', async () => {
    const ordersRepo = makeOrdersRepoMock()
    const shopProductsRepo = makeShopProductsRepoMock()

    shopProductsRepo.findByIdForUpdate.mockImplementation(async (_c, id, shopId) => ({
      id,
      shop_id: shopId,
      product_id: 'p',
      stock_quantity: 100,
      max_order_qty: 50,
      is_available: true,
    }))
    shopProductsRepo.applyStockChange.mockResolvedValue({ stockProduct: { id: 'x', low_stock_threshold: 5 } })

    let counter = 0
    ordersRepo.generateOrderNumber.mockImplementation(async () => {
      counter += 1
      return `GRO-20251112-${String(counter).padStart(3, '0')}`
    })
    ordersRepo.create.mockImplementation(async (_c, data) => ({
      id: `order-${data.shopId}`,
      orderNumber: data.orderNumber,
      shopId: data.shopId,
    }))

    const svc = makeSvc({ ordersRepo, shopProductsRepo })
    const groups = svc.splitCart([
      { productId: PROD_1, shopId: SHOP_A, shopProductId: SP_A1, quantity: 1, lineTotal: 10 },
      { productId: PROD_2, shopId: SHOP_A, shopProductId: SP_A1, quantity: 1, lineTotal: 10 },
      { productId: PROD_2, shopId: SHOP_B, shopProductId: SP_B1, quantity: 1, lineTotal: 10 },
      { productId: PROD_3, shopId: SHOP_C, shopProductId: SP_C1, quantity: 1, lineTotal: 10 },
    ])

    const orders = await svc.createOrders({
      client: makeClientMock(),
      userId: USER_ID,
      groups,
      deliveryAddress: {},
      payment: { method: 'COD' },
    })

    // Three shops → exactly three calls (NOT one per item)
    expect(ordersRepo.generateOrderNumber).toHaveBeenCalledTimes(3)
    expect(orders).toHaveLength(3)

    // Each order has a distinct order number
    const numbers = orders.map((o) => o.orderNumber)
    expect(new Set(numbers).size).toBe(numbers.length)
  })

  it('passes the correct fee breakdown to ordersRepo.create per shop', async () => {
    const ordersRepo = makeOrdersRepoMock()
    const shopProductsRepo = makeShopProductsRepoMock()

    shopProductsRepo.findByIdForUpdate.mockImplementation(async (_c, id, shopId) => ({
      id,
      shop_id: shopId,
      product_id: 'p',
      stock_quantity: 100,
      max_order_qty: 50,
      is_available: true,
    }))
    shopProductsRepo.applyStockChange.mockResolvedValue({ stockProduct: { id: 'x', low_stock_threshold: 5 } })
    ordersRepo.generateOrderNumber.mockImplementation(async () => 'GRO-X')
    ordersRepo.create.mockImplementation(async (_c, data) => ({
      id: `order-${data.shopId}`,
      ...data,
    }))

    const svc = makeSvc({
      ordersRepo,
      shopProductsRepo,
      fees: { deliveryFee: 25, platformFee: 5, freeDeliveryThreshold: 499 },
    })

    const groups = svc.splitCart([
      // SHOP_A subtotal = 100 → charges delivery
      { productId: PROD_1, shopId: SHOP_A, shopProductId: SP_A1, quantity: 1, lineTotal: 100, salePrice: 100, name: 'P1' },
      // SHOP_B subtotal = 600 → free delivery
      { productId: PROD_2, shopId: SHOP_B, shopProductId: SP_B1, quantity: 1, lineTotal: 600, salePrice: 600, name: 'P2' },
    ])

    await svc.createOrders({
      client: makeClientMock(),
      userId: USER_ID,
      groups,
      deliveryAddress: {},
      payment: { method: 'COD' },
    })

    const calls = ordersRepo.create.mock.calls.map(([, data]) => data)
    const a = calls.find((c) => c.shopId === SHOP_A)
    const b = calls.find((c) => c.shopId === SHOP_B)

    expect(a.subtotal).toBe(100)
    expect(a.deliveryFee).toBe(25)
    expect(a.platformFee).toBe(5)
    expect(a.totalAmount).toBe(130)

    expect(b.subtotal).toBe(600)
    expect(b.deliveryFee).toBe(0) // free
    expect(b.platformFee).toBe(5)
    expect(b.totalAmount).toBe(605)
  })

  it('selects PENDING status for non-COD payments and CONFIRMED for COD', async () => {
    const ordersRepo = makeOrdersRepoMock()
    const shopProductsRepo = makeShopProductsRepoMock()

    shopProductsRepo.findByIdForUpdate.mockResolvedValue({
      id: SP_A1,
      shop_id: SHOP_A,
      product_id: PROD_1,
      stock_quantity: 10,
      max_order_qty: 50,
      is_available: true,
    })
    shopProductsRepo.applyStockChange.mockResolvedValue({ stockProduct: { id: SP_A1, low_stock_threshold: 5 } })
    ordersRepo.generateOrderNumber.mockResolvedValue('GRO-X')
    ordersRepo.create.mockImplementation(async (_c, data) => data)

    const svc = makeSvc({ ordersRepo, shopProductsRepo })
    const groups = svc.splitCart([
      { productId: PROD_1, shopId: SHOP_A, shopProductId: SP_A1, quantity: 1, lineTotal: 100, salePrice: 100, name: 'P1' },
    ])

    // COD → CONFIRMED
    await svc.createOrders({
      client: makeClientMock(),
      userId: USER_ID,
      groups,
      deliveryAddress: {},
      payment: { method: 'COD' },
    })
    expect(ordersRepo.create.mock.calls[0][1].status).toBe('CONFIRMED')

    // Reset & try ONLINE
    ordersRepo.create.mockClear()
    shopProductsRepo.findByIdForUpdate.mockResolvedValue({
      id: SP_A1,
      shop_id: SHOP_A,
      product_id: PROD_1,
      stock_quantity: 10,
      max_order_qty: 50,
      is_available: true,
    })
    await svc.createOrders({
      client: makeClientMock(),
      userId: USER_ID,
      groups,
      deliveryAddress: {},
      payment: { method: 'UPI', status: 'PENDING' },
    })
    expect(ordersRepo.create.mock.calls[0][1].status).toBe('PENDING')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 5.  createOrders — failure paths (Req 5.9 — atomicity-before-writes)
// ═══════════════════════════════════════════════════════════════════════

describe('OrderSplitterService.createOrders — failure aggregation (Req 5.9)', () => {
  it('throws CHECKOUT_PARTIAL_FAIL with ALL failure reasons before any writes', async () => {
    const ordersRepo = makeOrdersRepoMock()
    const shopProductsRepo = makeShopProductsRepoMock()

    // Three items in the FIRST iterated shop, all violating different rules
    // → splitter must collect all three failures before throwing, and must
    //   NOT have called applyStockChange or ordersRepo.create.
    shopProductsRepo.findByIdForUpdate
      .mockResolvedValueOnce(null) // SHOP_PRODUCT_UNAVAILABLE
      .mockResolvedValueOnce({
        id: SP_A1,
        shop_id: SHOP_A,
        max_order_qty: 5,
        stock_quantity: 100,
        is_available: true,
      }) // qty 10 > 5 → MAX_QTY_EXCEEDED
      .mockResolvedValueOnce({
        id: SP_A1,
        shop_id: SHOP_A,
        max_order_qty: 50,
        stock_quantity: 1,
        is_available: true,
      }) // qty 4 > stock 1 → INSUFFICIENT_STOCK

    const svc = makeSvc({ ordersRepo, shopProductsRepo })
    const groups = svc.splitCart([
      { productId: PROD_1, shopId: SHOP_A, shopProductId: SP_A1, quantity: 1, lineTotal: 10 },
      { productId: PROD_2, shopId: SHOP_A, shopProductId: SP_A1, quantity: 10, lineTotal: 100 },
      { productId: PROD_3, shopId: SHOP_A, shopProductId: SP_A1, quantity: 4, lineTotal: 40 },
    ])

    let thrown
    try {
      await svc.createOrders({
        client: makeClientMock(),
        userId: USER_ID,
        groups,
        deliveryAddress: {},
        payment: { method: 'COD' },
      })
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeDefined()
    expect(thrown.code).toBe('CHECKOUT_PARTIAL_FAIL')

    // All three failures collected
    expect(thrown.failures).toHaveLength(3)
    const codes = thrown.failures.map((f) => f.code).sort()
    expect(codes).toEqual(
      ['INSUFFICIENT_STOCK', 'MAX_QTY_EXCEEDED', 'SHOP_PRODUCT_UNAVAILABLE'].sort()
    )

    // Every failure has the expected shape
    for (const f of thrown.failures) {
      expect(f).toEqual(
        expect.objectContaining({
          productId: expect.any(String),
          shopId: SHOP_A,
          reason: expect.any(String),
          code: expect.any(String),
        })
      )
    }

    // Critical: no writes happened (Req 5.9 atomicity-before-writes)
    expect(shopProductsRepo.applyStockChange).not.toHaveBeenCalled()
    expect(ordersRepo.create).not.toHaveBeenCalled()
    expect(ordersRepo.generateOrderNumber).not.toHaveBeenCalled()
  })

  it('aborts the entire checkout when the FIRST shop fails (no writes against any later shop)', async () => {
    const ordersRepo = makeOrdersRepoMock()
    const shopProductsRepo = makeShopProductsRepoMock()

    // First shop (SHOP_A) → fails with INSUFFICIENT_STOCK
    // Second shop (SHOP_B) → would be valid; must NOT be touched after
    //                        the throw because the splitter aborts.
    shopProductsRepo.findByIdForUpdate.mockResolvedValueOnce({
      id: SP_A1,
      shop_id: SHOP_A,
      max_order_qty: 50,
      stock_quantity: 0,
      is_available: true,
    })

    const svc = makeSvc({ ordersRepo, shopProductsRepo })
    const groups = svc.splitCart([
      { productId: PROD_1, shopId: SHOP_A, shopProductId: SP_A1, quantity: 1, lineTotal: 10 },
      { productId: PROD_2, shopId: SHOP_B, shopProductId: SP_B1, quantity: 1, lineTotal: 10 },
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
        expect.objectContaining({ shopId: SHOP_A, code: 'INSUFFICIENT_STOCK' }),
      ]),
    })

    // SHOP_A locked once; SHOP_B never touched (sorted iteration: A < B,
    // so we abort on A before reaching B).
    expect(shopProductsRepo.findByIdForUpdate).toHaveBeenCalledTimes(1)
    expect(shopProductsRepo.findByIdForUpdate).toHaveBeenCalledWith(
      expect.anything(),
      SP_A1,
      SHOP_A
    )
    expect(shopProductsRepo.applyStockChange).not.toHaveBeenCalled()
    expect(ordersRepo.create).not.toHaveBeenCalled()
  })

  it('propagates the error when applyStockChange throws (e.g. STOCK_NEGATIVE_FORBIDDEN from a concurrent sale) — the caller rolls back the whole transaction, order insert included', async () => {
    const ordersRepo = makeOrdersRepoMock()
    const shopProductsRepo = makeShopProductsRepoMock()

    shopProductsRepo.findByIdForUpdate.mockResolvedValueOnce({
      id: SP_A1,
      shop_id: SHOP_A,
      product_id: PROD_1,
      stock_quantity: 10,
      max_order_qty: 50,
      is_available: true,
    })
    ordersRepo.generateOrderNumber.mockResolvedValueOnce('GRO-X')
    ordersRepo.create.mockResolvedValueOnce({ id: 'order-a', shopId: SHOP_A })

    const stockErr = new Error('Resulting stock_quantity cannot be negative')
    stockErr.code = 'STOCK_NEGATIVE_FORBIDDEN'
    shopProductsRepo.applyStockChange.mockRejectedValueOnce(stockErr)

    const svc = makeSvc({ ordersRepo, shopProductsRepo })
    const groups = svc.splitCart([
      { productId: PROD_1, shopId: SHOP_A, shopProductId: SP_A1, quantity: 2, lineTotal: 20 },
    ])

    await expect(
      svc.createOrders({
        client: makeClientMock(),
        userId: USER_ID,
        groups,
        deliveryAddress: {},
        payment: { method: 'COD' },
      })
    ).rejects.toMatchObject({ code: 'STOCK_NEGATIVE_FORBIDDEN' })

    // The order row WAS inserted before the stock-change call that then
    // threw — safe because createOrders() never owns BEGIN/COMMIT itself;
    // the caller's transaction (mocked here) rolls back the order insert
    // along with everything else on any thrown error.
    expect(ordersRepo.create).toHaveBeenCalledTimes(1)
  })
})
