import { describe, expect, it, vi } from 'vitest'
import { VendorsService } from '../../src/modules/vendors/vendors.service.js'
import { VendorKycService } from '../../src/modules/vendors/vendor-kyc.service.js'
import { VendorStaffService } from '../../src/modules/vendors/vendor-staff.service.js'
import { CatalogueService } from '../../src/modules/catalogue/catalogue.service.js'
import { ProcurementService } from '../../src/modules/procurement/procurement.service.js'
import { WarehouseReceiptsService } from '../../src/modules/warehouse-receipts/warehouse-receipts.service.js'
import { InventoryService } from '../../src/modules/inventory/inventory.service.js'
import { CartQuoteService } from '../../src/modules/cart-quote/cart-quote.service.js'
import { OrdersService } from '../../src/modules/orders/orders.service.js'
import { DeliveriesService } from '../../src/modules/deliveries/deliveries.service.js'
import { SupportService } from '../../src/modules/support/support.service.js'

describe('Phase 11 — Complete 14 E2E Journeys Regression Suite', () => {
  it('Journey 1: Vendor Onboarding', async () => {
    const repoMock = {
      findDuplicate: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'v-1', status: 'PENDING_ONBOARDING' }),
    }
    const svc = new VendorsService(repoMock)
    const vendor = await svc.createVendor('user-1', { business_name: 'Prime Meat Co', email: 'v1@test.com', phone: '1234567890' })
    expect(vendor.status).toBe('PENDING_ONBOARDING')
  })

  it('Journey 2: Vendor KYC Approval', async () => {
    const kycRepoMock = {
      findKycByVendorId: vi.fn().mockResolvedValue({ id: 'kyc-1', vendor_id: 'v-1', status: 'KYC_SUBMITTED' }),
      updateKycStatus: vi.fn().mockResolvedValue({ id: 'kyc-1', status: 'VERIFIED' }),
      updateVendorStatus: vi.fn().mockResolvedValue({ id: 'v-1', status: 'VERIFIED' }),
      logKycReview: vi.fn().mockResolvedValue({}),
      logReview: vi.fn().mockResolvedValue({}),
    }
    const vendorRepoMock = {
      findById: vi.fn().mockResolvedValue({ id: 'v-1', status: 'UNDER_REVIEW' }),
      updateVendorStatus: vi.fn().mockResolvedValue({ id: 'v-1', status: 'VERIFIED' }),
    }
    const svc = new VendorKycService(vendorRepoMock, kycRepoMock)
    const res = await svc.reviewKyc('v-1', 'admin-1', { action: 'APPROVE', notes: 'Approved' })
    expect(res.vendor.status).toBe('VERIFIED')
  })

  it('Journey 3: Vendor Staff Invitation', async () => {
    const repoMock = {
      createInvitation: vi.fn().mockResolvedValue({ id: 'inv-1', email: 'staff@primemeat.com', token: 'token-123' }),
      logAudit: vi.fn().mockResolvedValue({}),
    }
    const vendorRepoMock = { findById: vi.fn().mockResolvedValue({ id: 'v-1' }) }
    const svc = new VendorStaffService(repoMock, vendorRepoMock)
    const inv = await svc.inviteStaff('v-1', 'owner-1', { email: 'staff@primemeat.com', role: 'VENDOR_STAFF' })
    expect(inv.email).toBe('staff@primemeat.com')
  })

  it('Journey 4: Product Proposal Creation', async () => {
    const repoMock = { createProposal: vi.fn().mockResolvedValue({ id: 'prop-1', title: 'Ribeye Steak', status: 'DRAFT' }) }
    const svc = new CatalogueService(repoMock)
    const prop = await svc.createProposal('v-1', { title: 'Ribeye Steak', category_id: 'cat-1' })
    expect(prop.status).toBe('DRAFT')
  })

  it('Journey 5: Product Approval', async () => {
    const repoMock = {
      findProposalById: vi.fn().mockResolvedValue({ id: 'prop-1', vendor_id: 'v-1', status: 'UNDER_REVIEW' }),
      updateProposalStatus: vi.fn().mockResolvedValue({ id: 'prop-1', status: 'APPROVED' }),
      logProposalReview: vi.fn().mockResolvedValue({}),
    }
    const svc = new CatalogueService(repoMock)
    const prop = await svc.reviewProposal('prop-1', 'admin-1', { action: 'APPROVE', comments: 'OK' })
    expect(prop.status).toBe('APPROVED')
  })

  it('Journey 6: Procurement Creation', async () => {
    const repoMock = {
      createProcurementOrder: vi.fn().mockResolvedValue({ id: 'po-1', order_number: 'PO-100', status: 'DRAFT' }),
      addProcurementItem: vi.fn().mockResolvedValue({ id: 'poi-1', quantity_ordered: 100 }),
      logAudit: vi.fn().mockResolvedValue({}),
    }
    const svc = new ProcurementService(repoMock)
    const order = await svc.createProcurement('v-1', 'user-1', { items: [{ product_id: 'p-1', quantity_ordered: 100, unit_cost: 150 }] })
    expect(order.order_number).toBe('PO-100')
  })

  it('Journey 7: Warehouse Receipt', async () => {
    const repoMock = {
      createReceipt: vi.fn().mockResolvedValue({ id: 'wr-1', receipt_number: 'WR-100', status: 'PENDING_RECEIPT' }),
      addReceiptItem: vi.fn().mockResolvedValue({ id: 'wri-1', quantity_received: 100 }),
      logAudit: vi.fn().mockResolvedValue({}),
    }
    const svc = new WarehouseReceiptsService(repoMock)
    const receipt = await svc.createReceipt('user-1', { warehouse_id: 'w-1', items: [{ product_id: 'p-1', quantity_received: 100 }] })
    expect(receipt.receipt_number).toBe('WR-100')
  })

  it('Journey 8: QC Approval', async () => {
    const repoMock = {
      findReceiptById: vi.fn().mockResolvedValue({ id: 'wr-1', status: 'QC_PENDING', items: [{ id: 'wri-1', quantity_received: 100 }] }),
      updateReceiptStatus: vi.fn().mockResolvedValueOnce({ id: 'wr-1', status: 'QC_APPROVED' }).mockResolvedValueOnce({ id: 'wr-1', status: 'RECEIVED' }),
      updateItemQuantities: vi.fn().mockResolvedValue({}),
      createInspection: vi.fn().mockResolvedValue({ id: 'qc-1', result: 'PASS' }),
      logAudit: vi.fn().mockResolvedValue({}),
    }
    const svc = new WarehouseReceiptsService(repoMock)
    const res = await svc.performQcInspection('wr-1', 'inspector-1', { result: 'PASS', item_results: [{ receipt_item_id: 'wri-1', quantity_accepted: 100, quantity_rejected: 0 }] })
    expect(res.receipt.status).toBe('RECEIVED')
  })

  it('Journey 9: Inventory Inbound', async () => {
    const futureExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const repoMock = {
      createLot: vi.fn().mockResolvedValue({ id: 'lot-1', quantity_on_hand: 100 }),
      writeLedgerEntry: vi.fn().mockResolvedValue({ id: 'led-1', movement_type: 'INBOUND' }),
    }
    const svc = new InventoryService(repoMock)
    const res = await svc.registerInbound('user-1', { warehouse_id: 'w-1', product_id: 'p-1', batch_number: 'BATCH-1', expiry_date: futureExpiry, quantity: 100 })
    expect(res.lot.id).toBe('lot-1')
  })

  it('Journey 10: Cart Creation', async () => {
    const repoMock = {
      findProductById: vi.fn().mockResolvedValue({ id: 'p-1', name: 'Steak', price: 250, status: 'ACTIVE' }),
      findOrCreateCart: vi.fn().mockResolvedValue({ id: 'cart-1', customer_id: 'c-1' }),
      addOrUpdateCartItem: vi.fn().mockResolvedValue({}),
      getCartWithItems: vi.fn().mockResolvedValue({ id: 'cart-1', items: [{ product_id: 'p-1', quantity: 2 }] }),
    }
    const svc = new CartQuoteService(repoMock)
    const cart = await svc.addItem('c-1', { product_id: 'p-1', quantity: 2 })
    expect(cart.items).toHaveLength(1)
  })

  it('Journey 11: Checkout Quote', async () => {
    const repoMock = {
      getCartWithItems: vi.fn().mockResolvedValue({ id: 'cart-1', items: [{ product_id: 'p-1', product_name: 'Steak', quantity: 2, unit_price: 250 }] }),
      createQuote: vi.fn().mockResolvedValue({ id: 'q-1', quote_number: 'Q-100', total_payable: 525 }),
    }
    const svc = new CartQuoteService(repoMock)
    const quote = await svc.generateCheckoutQuote('c-1')
    expect(quote.quote_number).toBe('Q-100')
  })

  it('Journey 12: Order Placement', async () => {
    const futureExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString()
    const quoteRepoMock = {
      findQuoteByNumber: vi.fn().mockResolvedValue({ id: 'q-1', customer_id: 'c-1', expires_at: futureExpiry, subtotal: 500, discount_amount: 0, loyalty_redeemed_amount: 0, tax_amount: 25, total_payable: 525, cart_snapshot: { items: [{ product_id: 'p-1', name: 'Steak', quantity: 2, unit_price: 250, subtotal: 500 }] } }),
    }
    const repoMock = {
      createOrder: vi.fn().mockResolvedValue({ id: 'ord-1', order_number: 'ORD-100', status: 'ORDER_PLACED' }),
      addOrderItem: vi.fn().mockResolvedValue({}),
      logStatusTransition: vi.fn().mockResolvedValue({}),
      logAudit: vi.fn().mockResolvedValue({}),
    }
    const svc = new OrdersService(repoMock, quoteRepoMock)
    const order = await svc.createOrderFromQuote('c-1', { quote_number: 'Q-100' })
    expect(order.status).toBe('ORDER_PLACED')
  })

  it('Journey 13: Delivery Completion', async () => {
    const ordersRepoMock = { findOrderById: vi.fn(), updateOrderStatus: vi.fn() }
    const repoMock = {
      findAssignmentById: vi.fn().mockResolvedValue({ id: 'da-1', order_id: 'ord-1', status: 'IN_TRANSIT' }),
      updateAssignmentStatus: vi.fn().mockResolvedValue({ id: 'da-1', status: 'DELIVERED' }),
      logStatusTransition: vi.fn().mockResolvedValue({}),
      logAudit: vi.fn().mockResolvedValue({}),
    }
    const svc = new DeliveriesService(repoMock, ordersRepoMock)
    const res = await svc.transitionDeliveryStatus('da-1', 'rider-1', 'DELIVERED')
    expect(res.status).toBe('DELIVERED')
    expect(ordersRepoMock.updateOrderStatus).toHaveBeenCalledWith('ord-1', 'DELIVERED')
  })

  it('Journey 14: Recall Workflow', async () => {
    const repoMock = {
      createRecall: vi.fn().mockResolvedValue({ id: 'rec-1', recall_number: 'RECALL-100', status: 'DRAFT' }),
      addRecallItem: vi.fn().mockResolvedValue({}),
      recordTraceabilityEvent: vi.fn().mockResolvedValue({}),
    }
    const svc = new SupportService(repoMock)
    const recall = await svc.createRecall('admin-1', { title: 'Packaging issue', reason: 'Defective seal', items: [{ product_id: 'p-1', batch_number: 'B-1' }] })
    expect(recall.recall_number).toBe('RECALL-100')
  })
})
