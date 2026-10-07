import { describe, expect, it, vi } from 'vitest'

/**
 * Regression coverage for the real "Item / pc / ₹0" bug reported live on
 * the mobile Order Details screen for a genuine placed order.
 *
 * `order_items` rows carry the real relational columns written by
 * `createCheckoutOrder` (`product_name`, `unit_price`, `subtotal`) — not
 * `name`/`price`/`total`/`unit`/`thumbnailUrl`, the shape mobile's
 * `OrderItemModel.fromJson` (and `invoiceGenerator.js`) actually reads.
 * `findOrderById`/`listOrders` used to hand back those raw rows verbatim,
 * so every field mobile expected fell through to its fallback default
 * ('Item', 'pc', ₹0) even though the real product name/price/unit were
 * sitting right there in `product_snapshot` (the exact camelCase item
 * object captured at checkout time).
 *
 * Also covers the sibling bug on the same screen: `orders.total_payable`
 * (the real column, migration 106) was never mirrored under any key
 * mobile's `total`/`totalAmount`/`total_amount` reader accepts, so
 * "Total Paid" always showed ₹0 for every order fetched through this path.
 */
vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
}))

const { query: pooledQuery } = await import('../../../src/config/database.js')
const { OrdersRepository } = await import('../../../src/modules/orders/orders.repository.js')

const orderRow = {
  id: 'order-1',
  order_number: 'FC-KOL-20260924-0001',
  status: 'ORDER_PLACED',
  total_payable: '380.00',
  wallet_amount: '0.00',
}

const itemRowWithSnapshot = {
  id: 'item-1',
  order_id: 'order-1',
  product_id: 'prod-1',
  product_name: 'Chicken Breast Boneless (500 g)',
  quantity: 1,
  unit_price: '350.00',
  subtotal: '350.00',
  shop_product_id: 'sp-1',
  product_snapshot: {
    productId: 'prod-1',
    shopProductId: 'sp-1',
    name: 'Chicken Breast Boneless (500 g)',
    price: 350,
    quantity: 1,
    unit: '500 g',
    total: 350,
    thumbnailUrl: 'https://cdn.example.com/chicken.jpg',
  },
}

const itemRowWithDiscountSnapshot = {
  id: 'item-3',
  order_id: 'order-1',
  product_id: 'prod-3',
  product_name: 'Chicken Breast (Boneless)',
  quantity: 1,
  unit_price: '260.00',
  subtotal: '260.00',
  shop_product_id: 'sp-3',
  product_snapshot: {
    productId: 'prod-3',
    shopProductId: 'sp-3',
    name: 'Chicken Breast (Boneless)',
    price: 260,
    quantity: 1,
    unit: '500 g',
    total: 260,
    thumbnailUrl: 'https://cdn.example.com/chicken2.jpg',
    brand: 'Fresh Cuts',
    originalPrice: 320,
    discountPercent: 18,
  },
}

const itemRowWithoutSnapshot = {
  id: 'item-2',
  order_id: 'order-1',
  product_id: 'prod-2',
  product_name: 'Mutton Curry Cut',
  quantity: 2,
  unit_price: '250.00',
  subtotal: '500.00',
  shop_product_id: 'sp-2',
  product_snapshot: {},
}

describe('OrdersRepository.findOrderById item + total formatting', () => {
  it('prefers product_snapshot (checkout-time camelCase shape) for name/price/unit/total/thumbnailUrl', async () => {
    pooledQuery.mockReset()
    pooledQuery
      .mockResolvedValueOnce({ rows: [orderRow] })
      .mockResolvedValueOnce({ rows: [itemRowWithSnapshot] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const repo = new OrdersRepository()
    const order = await repo.findOrderById('order-1')

    expect(order.items).toHaveLength(1)
    expect(order.items[0]).toMatchObject({
      productId: 'prod-1',
      name: 'Chicken Breast Boneless (500 g)',
      price: 350,
      quantity: 1,
      unit: '500 g',
      total: 350,
      thumbnailUrl: 'https://cdn.example.com/chicken.jpg',
    })
  })

  it('surfaces brand/originalPrice/discountPercent when the checkout snapshot has them (the MRP strikethrough + % OFF badge on the Order Details screen)', async () => {
    pooledQuery.mockReset()
    pooledQuery
      .mockResolvedValueOnce({ rows: [orderRow] })
      .mockResolvedValueOnce({ rows: [itemRowWithDiscountSnapshot] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const repo = new OrdersRepository()
    const order = await repo.findOrderById('order-1')

    expect(order.items[0]).toMatchObject({
      brand: 'Fresh Cuts',
      originalPrice: 320,
      discountPercent: 18,
    })
  })

  it('never fabricates a discount for an item snapshot that genuinely has none (older order, or a product with no sale price)', async () => {
    pooledQuery.mockReset()
    pooledQuery
      .mockResolvedValueOnce({ rows: [orderRow] })
      .mockResolvedValueOnce({ rows: [itemRowWithSnapshot] }) // no brand/originalPrice/discountPercent in its snapshot
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const repo = new OrdersRepository()
    const order = await repo.findOrderById('order-1')

    expect(order.items[0].brand).toBeNull()
    expect(order.items[0].originalPrice).toBeNull()
    expect(order.items[0].discountPercent).toBe(0)
  })

  it('falls back to the relational columns when product_snapshot is empty (rows written before the snapshot existed), never the generic placeholder', async () => {
    pooledQuery.mockReset()
    pooledQuery
      .mockResolvedValueOnce({ rows: [orderRow] })
      .mockResolvedValueOnce({ rows: [itemRowWithoutSnapshot] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const repo = new OrdersRepository()
    const order = await repo.findOrderById('order-1')

    expect(order.items[0]).toMatchObject({
      name: 'Mutton Curry Cut',
      price: 250,
      quantity: 2,
      total: 500,
    })
    expect(order.items[0].name).not.toBe('Item')
  })

  it('mirrors total_payable/wallet_amount under the camelCase keys mobile actually reads, without dropping the raw columns other callers use', async () => {
    pooledQuery.mockReset()
    pooledQuery
      .mockResolvedValueOnce({ rows: [orderRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const repo = new OrdersRepository()
    const order = await repo.findOrderById('order-1')

    expect(order.totalAmount).toBe(380)
    expect(order.walletAmountUsed).toBe(0)
    // Raw snake_case columns must still be present — transitionOrderStatus,
    // createFulfilmentTask, and getInvoice's ownership check all read them.
    expect(order.total_payable).toBe('380.00')
    expect(order.status).toBe('ORDER_PLACED')
  })
})

describe('OrdersRepository.listOrders', () => {
  it('scopes strictly to the given customerId and batch-formats items/totals for every returned order', async () => {
    pooledQuery.mockReset()
    pooledQuery
      .mockResolvedValueOnce({ rows: [orderRow] })
      .mockResolvedValueOnce({ rows: [itemRowWithSnapshot] })

    const repo = new OrdersRepository()
    const orders = await repo.listOrders('cust-1', null, null)

    expect(orders).toHaveLength(1)
    expect(orders[0].totalAmount).toBe(380)
    expect(orders[0].items[0].name).toBe('Chicken Breast Boneless (500 g)')

    const [listSql, listParams] = pooledQuery.mock.calls[0]
    expect(listSql).toContain('customer_id = $1')
    expect(listParams).toEqual(['cust-1'])
  })

  it('returns [] and never fetches item rows when the scoped customer has no orders (no unscoped ANY($1) query with an empty array)', async () => {
    pooledQuery.mockReset()
    pooledQuery.mockResolvedValueOnce({ rows: [] })

    const repo = new OrdersRepository()
    const orders = await repo.listOrders('cust-1', null, null)

    expect(orders).toEqual([])
    expect(pooledQuery).toHaveBeenCalledTimes(1)
  })
})
