/**
 * AdminOrdersService#findById — quality_evidence wiring
 *
 * The dashboard's Order Detail drawer has always had a "Vendor Cutting
 * Evidence" slot (a <video> element) but it stayed permanently null since
 * the 2026-09-23 Orders rebuild deleted the old fake `CuttingEvidencePlayer`
 * and correctly refused to fabricate a replacement — at that time there was
 * genuinely no real backend data model for it. §7.5 (2026-09-25) built one
 * (order_item → inventory_lot allocation → procurement receipt → supply
 * order → vendor → quality video), already used by the customer app's QR
 * scan flow, but nothing wired the admin dashboard to it. This closes that
 * gap: `findById` now resolves the same real per-item video trace.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  getClient: vi.fn(),
}))
vi.mock('../../../src/config/bullmq.js', () => ({
  notificationQueue: { add: vi.fn() },
  orderQueue: { add: vi.fn() },
}))
vi.mock('../../../src/utils/activityLogger.js', () => ({ logAdminActivity: vi.fn() }))
vi.mock('../../../src/utils/invoiceGenerator.js', () => ({
  generateInvoicePDF: vi.fn(async () => Buffer.from('pdf')),
  generatePackingSlipPDF: vi.fn(async () => Buffer.from('pdf')),
}))

const inventoryServiceMock = vi.hoisted(() => ({
  getQualityTraceForOrderItems: vi.fn(async () => []),
}))
vi.mock('../../../src/modules/inventory/inventory.repository.js', () => ({
  InventoryRepository: vi.fn(),
}))
vi.mock('../../../src/modules/inventory/inventory.service.js', () => ({
  InventoryService: vi.fn(() => inventoryServiceMock),
}))

import { AdminOrdersService } from '../../../src/modules/admin/orders/orders.service.js'

const ORDER_ID = 'order-1'
const SHOP_A = 'shop-a-uuid'

function makeService({ items = [], trace = [] } = {}) {
  const order = { id: ORDER_ID, shop_id: SHOP_A, status: 'CONFIRMED', order_number: 'FC-A-0001', customer_id: 'cust-1' }
  const repository = {
    findById: vi.fn(async () => order),
    getOrderItems: vi.fn(async () => items),
    getOrderTimeline: vi.fn(async () => []),
    getOrderPayment: vi.fn(async () => null),
    getOrderDelivery: vi.fn(async () => null),
    getSettlementHistory: vi.fn(async () => []),
  }
  inventoryServiceMock.getQualityTraceForOrderItems.mockResolvedValue(trace)
  const service = new AdminOrdersService(repository, null)
  return { service, repository }
}

beforeEach(() => vi.clearAllMocks())

describe('AdminOrdersService.findById — quality_evidence (Vendor Cutting Evidence)', () => {
  it('never calls the inventory trace at all when the order has no items', async () => {
    const { service } = makeService({ items: [] })

    const result = await service.findById(ORDER_ID)

    expect(result.quality_evidence).toEqual([])
    expect(inventoryServiceMock.getQualityTraceForOrderItems).not.toHaveBeenCalled()
  })

  it('returns an honest empty array — never a fabricated video — when no item resolves one', async () => {
    const { service } = makeService({
      items: [{ id: 'oi-1', product_name: 'Chicken Breast Boneless (1 kg)' }],
      trace: [],
    })

    const result = await service.findById(ORDER_ID)

    expect(result.quality_evidence).toEqual([])
  })

  it('surfaces the real vendor video for an item with a resolved quality trace', async () => {
    const { service, repository } = makeService({
      items: [{ id: 'oi-1', product_name: 'Chicken Breast Boneless (1 kg)' }],
      trace: [
        {
          order_item_id: 'oi-1',
          quantity_allocated: '1.00',
          video_url: 'https://cdn.example/vid.mp4',
          vendor_name: 'Kolkata Fresh Chicken Co.',
          supply_number: 'SUP-20260926-7544',
        },
      ],
    })

    const result = await service.findById(ORDER_ID)

    expect(repository.getOrderItems).toHaveBeenCalledWith(ORDER_ID)
    expect(inventoryServiceMock.getQualityTraceForOrderItems).toHaveBeenCalledWith(['oi-1'])
    expect(result.quality_evidence).toEqual([
      {
        orderItemId: 'oi-1',
        productName: 'Chicken Breast Boneless (1 kg)',
        videoUrl: 'https://cdn.example/vid.mp4',
        vendorName: 'Kolkata Fresh Chicken Co.',
        supplyNumber: 'SUP-20260926-7544',
      },
    ])
  })

  it('picks the largest-share lot per item (first row wins — trace is pre-sorted DESC) when a sale spans two lots', async () => {
    const { service } = makeService({
      items: [{ id: 'oi-1', product_name: 'Whole Chicken' }],
      trace: [
        // Already ordered quantity_allocated DESC, exactly as
        // findQualityTraceForOrderItems returns it — the primary lot is
        // simply "first row seen per order_item_id."
        {
          order_item_id: 'oi-1',
          quantity_allocated: '3.00',
          video_url: 'https://cdn.example/primary.mp4',
          vendor_name: 'Primary Vendor',
          supply_number: 'SUP-PRIMARY',
        },
        {
          order_item_id: 'oi-1',
          quantity_allocated: '1.00',
          video_url: 'https://cdn.example/secondary.mp4',
          vendor_name: 'Secondary Vendor',
          supply_number: 'SUP-SECONDARY',
        },
      ],
    })

    const result = await service.findById(ORDER_ID)

    expect(result.quality_evidence).toHaveLength(1)
    expect(result.quality_evidence[0].vendorName).toBe('Primary Vendor')
  })

  it('skips an item whose matched trace row has no video at all', async () => {
    const { service } = makeService({
      items: [{ id: 'oi-1', product_name: 'Manually Stocked Item' }],
      trace: [{ order_item_id: 'oi-1', quantity_allocated: '1.00', video_url: null, vendor_name: null, supply_number: null }],
    })

    const result = await service.findById(ORDER_ID)

    expect(result.quality_evidence).toEqual([])
  })
})
