import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WarehouseReceiptsService } from '../../../src/modules/warehouse-receipts/warehouse-receipts.service.js'

describe('Phase 5A Warehouse Receipt & Quality Control Unit Tests', () => {
  let repositoryMock
  let service

  beforeEach(() => {
    repositoryMock = {
      createReceipt: vi.fn(),
      addReceiptItem: vi.fn(),
      findReceiptById: vi.fn(),
      updateReceiptStatus: vi.fn(),
      updateItemQuantities: vi.fn(),
      createInspection: vi.fn(),
      addInspectionResult: vi.fn(),
      logAudit: vi.fn(),
      listReceipts: vi.fn(),
    }
    service = new WarehouseReceiptsService(repositoryMock)
  })

  describe('Warehouse Receipts Lifecycle & State Machine', () => {
    it('creates warehouse receipt with items cleanly', async () => {
      repositoryMock.createReceipt.mockResolvedValueOnce({ id: 'wr-1', receipt_number: 'WR-101', status: 'PENDING_RECEIPT' })
      repositoryMock.addReceiptItem.mockResolvedValueOnce({ id: 'ri-1', product_id: 'prod-1', quantity_received: 100 })

      const res = await service.createReceipt('user-1', {
        warehouse_id: 'w-1',
        items: [{ product_id: 'prod-1', quantity_received: 100 }],
      })

      expect(repositoryMock.createReceipt).toHaveBeenCalledWith('w-1', null, expect.stringMatching(/^WR-/), 'user-1', null)
      expect(res.id).toBe('wr-1')
    })

    it('starts receiving PENDING_RECEIPT -> RECEIVING', async () => {
      repositoryMock.findReceiptById.mockResolvedValueOnce({ id: 'wr-1', warehouse_id: 'w-1', status: 'PENDING_RECEIPT' })
      repositoryMock.updateReceiptStatus.mockResolvedValueOnce({ id: 'wr-1', status: 'RECEIVING' })

      const updated = await service.startReceiving('wr-1', 'w-1', 'user-1')
      expect(updated.status).toBe('RECEIVING')
    })

    it('rejects receiving if warehouse does not match (403 CROSS_WAREHOUSE_ACCESS_DENIED)', async () => {
      repositoryMock.findReceiptById.mockResolvedValueOnce({ id: 'wr-1', warehouse_id: 'w-other', status: 'PENDING_RECEIPT' })

      await expect(service.startReceiving('wr-1', 'w-1', 'user-1')).rejects.toThrow('Forbidden')
    })

    it('rejects invalid state transition PENDING_RECEIPT -> QC_APPROVED with 400 INVALID_STATE_TRANSITION', () => {
      expect(() => service.validateStateTransition('PENDING_RECEIPT', 'QC_APPROVED')).toThrow('Invalid state transition')
    })
  })

  describe('Quality Control Inspection', () => {
    it('approves QC inspection and transitions status to RECEIVED', async () => {
      repositoryMock.findReceiptById.mockResolvedValueOnce({
        id: 'wr-1',
        status: 'QC_PENDING',
        items: [{ id: 'ri-1', quantity_received: 100 }],
      })
      repositoryMock.updateReceiptStatus
        .mockResolvedValueOnce({ id: 'wr-1', status: 'QC_APPROVED' })
        .mockResolvedValueOnce({ id: 'wr-1', status: 'RECEIVED' })
      repositoryMock.createInspection.mockResolvedValueOnce({ id: 'qc-1', result: 'PASS' })

      const res = await service.performQcInspection('wr-1', 'inspector-1', {
        result: 'PASS',
        item_results: [{ receipt_item_id: 'ri-1', quantity_accepted: 100, quantity_rejected: 0 }],
      })

      expect(repositoryMock.updateItemQuantities).toHaveBeenCalledWith('ri-1', 100, 0)
      expect(res.receipt.status).toBe('RECEIVED')
    })

    it('rejects QC inspection and transitions status to RETURNED', async () => {
      repositoryMock.findReceiptById.mockResolvedValueOnce({
        id: 'wr-1',
        status: 'QC_PENDING',
        items: [{ id: 'ri-1', quantity_received: 100 }],
      })
      repositoryMock.updateReceiptStatus
        .mockResolvedValueOnce({ id: 'wr-1', status: 'QC_REJECTED' })
        .mockResolvedValueOnce({ id: 'wr-1', status: 'RETURNED' })
      repositoryMock.createInspection.mockResolvedValueOnce({ id: 'qc-1', result: 'FAIL' })

      const res = await service.performQcInspection('wr-1', 'inspector-1', {
        result: 'FAIL',
        item_results: [{ receipt_item_id: 'ri-1', quantity_accepted: 0, quantity_rejected: 100 }],
      })

      expect(res.receipt.status).toBe('RETURNED')
    })

    it('rejects inspection if accepted + rejected exceeds received quantity (400 EXCEEDS_RECEIVED_QUANTITY)', async () => {
      repositoryMock.findReceiptById.mockResolvedValueOnce({
        id: 'wr-1',
        status: 'QC_PENDING',
        items: [{ id: 'ri-1', quantity_received: 50 }],
      })

      await expect(
        service.performQcInspection('wr-1', 'inspector-1', {
          result: 'PASS',
          item_results: [{ receipt_item_id: 'ri-1', quantity_accepted: 40, quantity_rejected: 20 }],
        })
      ).rejects.toThrow('exceeds received quantity')
    })
  })
})
