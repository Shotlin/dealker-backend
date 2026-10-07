import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProcurementService } from '../../../src/modules/procurement/procurement.service.js'

describe('Phase 4A Procurement, Batch & Media Evidence Unit Tests', () => {
  let repositoryMock
  let service

  beforeEach(() => {
    repositoryMock = {
      createProcurementOrder: vi.fn(),
      addProcurementItem: vi.fn(),
      findOrderById: vi.fn(),
      updateOrderStatus: vi.fn(),
      findItemById: vi.fn(),
      updateItemQuantityReceived: vi.fn(),
      findDuplicateBatchNumber: vi.fn(),
      createBatch: vi.fn(),
      addMedia: vi.fn(),
      getMedia: vi.fn(),
      logAudit: vi.fn(),
      listOrders: vi.fn(),
    }
    service = new ProcurementService(repositoryMock)
  })

  describe('Procurement Lifecycle & State Machine', () => {
    it('creates procurement order with items and total cost', async () => {
      repositoryMock.createProcurementOrder.mockResolvedValueOnce({ id: 'po-1', order_number: 'PO-101', status: 'DRAFT' })
      repositoryMock.addProcurementItem.mockResolvedValueOnce({ id: 'item-1', product_id: 'prod-1', quantity_ordered: 100, unit_cost: 50 })

      const res = await service.createProcurement('v-1', 'user-1', {
        notes: 'Initial order',
        items: [{ product_id: 'prod-1', quantity_ordered: 100, unit_cost: 50 }],
      })

      expect(repositoryMock.createProcurementOrder).toHaveBeenCalledWith('v-1', expect.stringMatching(/^PO-/), 'Initial order', 5000)
      expect(res.id).toBe('po-1')
    })

    it('allows valid transition DRAFT -> SUBMITTED', async () => {
      repositoryMock.findOrderById.mockResolvedValueOnce({ id: 'po-1', vendor_id: 'v-1', status: 'DRAFT' })
      repositoryMock.updateOrderStatus.mockResolvedValueOnce({ id: 'po-1', status: 'SUBMITTED' })

      const updated = await service.submitProcurement('po-1', 'v-1', 'user-1')
      expect(updated.status).toBe('SUBMITTED')
    })

    it('approves order SUBMITTED -> APPROVED', async () => {
      repositoryMock.findOrderById.mockResolvedValueOnce({ id: 'po-1', status: 'SUBMITTED' })
      repositoryMock.updateOrderStatus.mockResolvedValueOnce({ id: 'po-1', status: 'APPROVED' })

      const updated = await service.approveProcurement('po-1', 'user-1')
      expect(updated.status).toBe('APPROVED')
    })

    it('rejects invalid state transition DRAFT -> CLOSED with 400 INVALID_STATE_TRANSITION', () => {
      expect(() => service.validateStateTransition('DRAFT', 'CLOSED')).toThrow('Invalid state transition')
    })
  })

  describe('Goods Receipt & Batching', () => {
    it('records partial receipt and updates status to PARTIALLY_RECEIVED', async () => {
      repositoryMock.findOrderById
        .mockResolvedValueOnce({ id: 'po-1', vendor_id: 'v-1', status: 'APPROVED' })
        .mockResolvedValueOnce({
          id: 'po-1',
          vendor_id: 'v-1',
          status: 'APPROVED',
          items: [{ id: 'item-1', quantity_ordered: 100, quantity_received: 50 }],
        })
      repositoryMock.findItemById.mockResolvedValueOnce({ id: 'item-1', quantity_ordered: 100, quantity_received: 0 })
      repositoryMock.findDuplicateBatchNumber.mockResolvedValueOnce(null)
      repositoryMock.createBatch.mockResolvedValueOnce({ id: 'b-1', batch_number: 'BATCH-001', quantity: 50 })
      repositoryMock.updateOrderStatus.mockResolvedValueOnce({ id: 'po-1', status: 'PARTIALLY_RECEIVED' })

      const res = await service.recordGoodsReceipt('po-1', 'v-1', 'user-1', {
        receipts: [{ item_id: 'item-1', quantity_received: 50, batch_number: 'BATCH-001' }],
      })

      expect(repositoryMock.createBatch).toHaveBeenCalledWith(
        expect.objectContaining({ batch_number: 'BATCH-001', quantity: 50 })
      )
      expect(res.order.status).toBe('PARTIALLY_RECEIVED')
    })

    it('rejects receipt exceeding ordered quantity with 400 EXCEEDS_ORDERED_QUANTITY', async () => {
      repositoryMock.findOrderById.mockResolvedValueOnce({ id: 'po-1', vendor_id: 'v-1', status: 'APPROVED' })
      repositoryMock.findItemById.mockResolvedValueOnce({ id: 'item-1', quantity_ordered: 100, quantity_received: 80 })

      await expect(
        service.recordGoodsReceipt('po-1', 'v-1', 'user-1', {
          receipts: [{ item_id: 'item-1', quantity_received: 50, batch_number: 'BATCH-002' }],
        })
      ).rejects.toThrow('exceeds ordered quantity')
    })

    it('throws 409 DUPLICATE_BATCH_NUMBER on duplicate batch number', async () => {
      repositoryMock.findOrderById.mockResolvedValueOnce({ id: 'po-1', vendor_id: 'v-1', status: 'APPROVED' })
      repositoryMock.findItemById.mockResolvedValueOnce({ id: 'item-1', quantity_ordered: 100, quantity_received: 0 })
      repositoryMock.findDuplicateBatchNumber.mockResolvedValueOnce({ id: 'b-existing' })

      await expect(
        service.recordGoodsReceipt('po-1', 'v-1', 'user-1', {
          receipts: [{ item_id: 'item-1', quantity_received: 50, batch_number: 'BATCH-DUP' }],
        })
      ).rejects.toThrow('Batch number BATCH-DUP already exists')
    })
  })

  describe('Media Evidence', () => {
    it('adds procurement media evidence metadata cleanly', async () => {
      repositoryMock.findOrderById.mockResolvedValueOnce({ id: 'po-1', vendor_id: 'v-1', status: 'APPROVED' })
      repositoryMock.addMedia.mockResolvedValueOnce({ id: 'm-1', media_type: 'INVOICE', file_key: 'keys/inv.pdf' })

      const media = await service.addMedia('po-1', 'v-1', 'user-1', { media_type: 'INVOICE', file_key: 'keys/inv.pdf' })

      expect(repositoryMock.addMedia).toHaveBeenCalledOnce()
      expect(media.media_type).toBe('INVOICE')
    })

    it('rejects evidence addition if order status is CLOSED with 400 ORDER_CLOSED_LOCKED', async () => {
      repositoryMock.findOrderById.mockResolvedValueOnce({ id: 'po-1', vendor_id: 'v-1', status: 'CLOSED' })

      await expect(
        service.addMedia('po-1', 'v-1', 'user-1', { media_type: 'INVOICE', file_key: 'keys/inv.pdf' })
      ).rejects.toThrow('Procurement evidence cannot be added or modified after order is CLOSED')
    })
  })
})
