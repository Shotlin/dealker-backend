import { describe, expect, it, vi } from 'vitest'

// OrdersService#getQualityVideos resolves, per order line, the vendor
// quality/cleaning video that actually backed the batch sold to this
// customer — what the invoice QR scan opens. Ownership-scoped exactly like
// getInvoice/listOrders (§7.2 point 10's IDOR fix): always the caller's
// own order via findOrderById's raw customer_id column, never a
// client-supplied id.
import { OrdersService } from '../../../src/modules/orders/orders.service.js'

function makeOrder(overrides = {}) {
  return {
    id: 'order-1',
    customer_id: 'user-1',
    order_number: 'FC-KOL-20260926-0001',
    items: [
      { id: 'oi-1', productId: 'prod-1', name: 'Chicken Breast 500g' },
      { id: 'oi-2', productId: 'prod-2', name: 'Mutton Curry Cut 1kg' },
    ],
    ...overrides,
  }
}

function makeService({ order = makeOrder(), trace = [] } = {}) {
  const repository = { findOrderById: vi.fn(async () => order) }
  const inventoryService = { getQualityTraceForOrderItems: vi.fn(async () => trace) }
  const service = new OrdersService(repository, null, { inventoryService })
  return { service, repository, inventoryService }
}

describe('OrdersService.getQualityVideos', () => {
  // Regression for a real user-reported concern (2026-09-26): two of the
  // same customer's orders drawing from the same real vendor batch
  // legitimately show the identical video — correct, not a leak — but the
  // mobile screen never displayed WHICH order it resolved, so there was no
  // way to visually confirm it wasn't just reusing stale/cached data.
  // `orderNumber` lets the client show this unambiguously.
  it('always returns the real order_number the video was resolved for, so the client can display which order this is', async () => {
    const { service } = makeService({ order: makeOrder({ order_number: 'FC-KOL-20260926-0002' }) })
    const result = await service.getQualityVideos('user-1', 'order-1')
    expect(result.orderNumber).toBe('FC-KOL-20260926-0002')
  })

  it('returns 404 when the order does not exist', async () => {
    const { service } = makeService({ order: null })
    const result = await service.getQualityVideos('user-1', 'missing')
    expect(result).toMatchObject({ success: false, statusCode: 404 })
  })

  it('rejects a caller who does not own the order (IDOR guard)', async () => {
    const { service } = makeService({ order: makeOrder({ customer_id: 'someone-else' }) })
    const result = await service.getQualityVideos('user-1', 'order-1')
    expect(result).toMatchObject({ success: false, statusCode: 403, message: 'Access denied' })
  })

  it('resolves a real video for an item with a traced allocation', async () => {
    const { service, inventoryService } = makeService({
      trace: [
        {
          order_item_id: 'oi-1',
          inventory_lot_id: 'lot-a',
          quantity_allocated: 2,
          video_url: 'https://cdn.example/quality.mp4',
          vendor_name: 'Kolkata Fresh Meats',
          supply_number: 'SUP-20260925-51E8',
        },
      ],
    })

    const result = await service.getQualityVideos('user-1', 'order-1')

    expect(result.success).toBe(true)
    expect(inventoryService.getQualityTraceForOrderItems).toHaveBeenCalledWith(['oi-1', 'oi-2'])
    expect(result.items).toEqual([
      {
        orderItemId: 'oi-1',
        productName: 'Chicken Breast 500g',
        video: {
          url: 'https://cdn.example/quality.mp4',
          vendorName: 'Kolkata Fresh Meats',
          supplyNumber: 'SUP-20260925-51E8',
        },
      },
      { orderItemId: 'oi-2', productName: 'Mutton Curry Cut 1kg', video: null },
    ])
  })

  it('picks the lot with the largest allocated share as the primary video when a sale spans two lots', async () => {
    const { service } = makeService({
      trace: [
        // Old lot supplied only 2 of the 5 sold; new lot supplied 3 — the
        // new lot's video should win as "primary" for this item.
        {
          order_item_id: 'oi-1',
          inventory_lot_id: 'lot-new',
          quantity_allocated: 3,
          video_url: 'https://cdn.example/new-batch.mp4',
          vendor_name: 'New Vendor',
          supply_number: 'SUP-2',
        },
        {
          order_item_id: 'oi-1',
          inventory_lot_id: 'lot-old',
          quantity_allocated: 2,
          video_url: 'https://cdn.example/old-batch.mp4',
          vendor_name: 'Old Vendor',
          supply_number: 'SUP-1',
        },
      ],
    })

    const result = await service.getQualityVideos('user-1', 'order-1')

    const item1 = result.items.find((i) => i.orderItemId === 'oi-1')
    expect(item1.video.url).toBe('https://cdn.example/new-batch.mp4')
    expect(item1.video.supplyNumber).toBe('SUP-2')
  })

  it('shows no video for an item whose trace has no evidence row (video_url null)', async () => {
    const { service } = makeService({
      trace: [
        {
          order_item_id: 'oi-1',
          inventory_lot_id: 'lot-a',
          quantity_allocated: 2,
          video_url: null,
          vendor_name: 'Some Vendor',
          supply_number: 'SUP-3',
        },
      ],
    })

    const result = await service.getQualityVideos('user-1', 'order-1')

    const item1 = result.items.find((i) => i.orderItemId === 'oi-1')
    expect(item1.video).toBeNull()
  })
})
