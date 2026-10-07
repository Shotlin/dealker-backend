import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InventoryService } from '../../../src/modules/inventory/inventory.service.js'

describe('Phase 6 Lot Inventory & FEFO Reservation Unit Tests', () => {
  let repositoryMock
  let service

  beforeEach(() => {
    repositoryMock = {
      findLotByBatch: vi.fn(),
      findLotById: vi.fn(),
      createLot: vi.fn(),
      findAvailableLotsFefo: vi.fn(),
      updateLotQuantities: vi.fn(),
      writeLedgerEntry: vi.fn(),
      getLedgerEntries: vi.fn(),
      findReservationsByKey: vi.fn(),
      createReservation: vi.fn(),
      updateReservationStatus: vi.fn(),
      createAdjustment: vi.fn(),
      listLots: vi.fn(),
    }
    service = new InventoryService(repositoryMock)
  })

  describe('Stock Inbound & Lot Creation', () => {
    it('registers inbound stock and writes append-only ledger entry', async () => {
      const futureExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      repositoryMock.createLot.mockResolvedValueOnce({ id: 'lot-1', quantity_on_hand: 100 })
      repositoryMock.writeLedgerEntry.mockResolvedValueOnce({ id: 'led-1', movement_type: 'INBOUND' })

      const res = await service.registerInbound('user-1', {
        warehouse_id: 'w-1',
        product_id: 'p-1',
        batch_number: 'BATCH-001',
        expiry_date: futureExpiry,
        quantity: 100,
      })

      expect(repositoryMock.createLot).toHaveBeenCalledOnce()
      expect(repositoryMock.writeLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({ movement_type: 'INBOUND', quantity_change: 100 })
      )
      expect(res.lot.id).toBe('lot-1')
    })

    it('rejects inbound stock for expired lot with 400 EXPIRED_LOT_REJECTED', async () => {
      const pastExpiry = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0]

      await expect(
        service.registerInbound('user-1', {
          warehouse_id: 'w-1',
          product_id: 'p-1',
          batch_number: 'BATCH-OLD',
          expiry_date: pastExpiry,
          quantity: 100,
        })
      ).rejects.toThrow('Cannot register inbound stock for expired lot')
    })
  })

  describe('FEFO Allocation & Reservation', () => {
    it('allocates stock from earliest expiry lot first (FEFO rule)', async () => {
      repositoryMock.findReservationsByKey.mockResolvedValueOnce([])
      repositoryMock.findAvailableLotsFefo.mockResolvedValueOnce([
        { id: 'lot-earliest', expiry_date: '2026-08-10', quantity_available: 30 },
        { id: 'lot-later', expiry_date: '2026-08-20', quantity_available: 50 },
      ])
      repositoryMock.updateLotQuantities
        .mockResolvedValueOnce({ id: 'lot-earliest', quantity_available: 0 })
        .mockResolvedValueOnce({ id: 'lot-later', quantity_available: 30 })
      repositoryMock.createReservation
        .mockResolvedValueOnce({ id: 'res-1', lot_id: 'lot-earliest', quantity_reserved: 30 })
        .mockResolvedValueOnce({ id: 'res-2', lot_id: 'lot-later', quantity_reserved: 20 })

      const res = await service.reserveFefo('user-1', {
        warehouse_id: 'w-1',
        product_id: 'p-1',
        quantity: 50,
        reservation_key: 'KEY-FEFO-1',
      })

      expect(repositoryMock.createReservation).toHaveBeenCalledTimes(2)
      expect(res.total_reserved).toBe(50)
      expect(res.reservations[0].lot_id).toBe('lot-earliest')
    })

    it('rejects reservation if insufficient available stock (400 INSUFFICIENT_STOCK)', async () => {
      repositoryMock.findReservationsByKey.mockResolvedValueOnce([])
      repositoryMock.findAvailableLotsFefo.mockResolvedValueOnce([
        { id: 'lot-1', quantity_available: 20 },
      ])

      await expect(
        service.reserveFefo('user-1', {
          warehouse_id: 'w-1',
          product_id: 'p-1',
          quantity: 100,
          reservation_key: 'KEY-SHORT',
        })
      ).rejects.toThrow('Insufficient stock available')
    })

    it('rejects duplicate reservation key with 409 DUPLICATE_RESERVATION_KEY', async () => {
      repositoryMock.findReservationsByKey.mockResolvedValueOnce([{ id: 'existing-res' }])

      await expect(
        service.reserveFefo('user-1', {
          warehouse_id: 'w-1',
          product_id: 'p-1',
          quantity: 10,
          reservation_key: 'KEY-DUP',
        })
      ).rejects.toThrow('Reservation key KEY-DUP is already active')
    })
  })

  describe('Reservation Release & Stock Adjustment', () => {
    it('releases reserved stock and updates lot reserved balance', async () => {
      repositoryMock.findReservationsByKey.mockResolvedValueOnce([
        { id: 'res-1', lot_id: 'lot-1', warehouse_id: 'w-1', product_id: 'p-1', quantity_reserved: 20 },
      ])
      repositoryMock.updateLotQuantities.mockResolvedValueOnce({ id: 'lot-1', quantity_available: 50 })

      const res = await service.releaseReservation('user-1', 'KEY-FEFO-1')

      expect(repositoryMock.updateReservationStatus).toHaveBeenCalledWith('res-1', 'RELEASED')
      expect(res.success).toBe(true)
    })

    it('adjusts stock and prevents negative inventory (400 NEGATIVE_STOCK_PREVENTED)', async () => {
      repositoryMock.findLotById.mockResolvedValueOnce({
        id: 'lot-1',
        quantity_on_hand: 10,
        quantity_reserved: 5,
      })

      await expect(
        service.adjustStock('user-1', {
          lot_id: 'lot-1',
          quantity_change: -15,
          reason: 'Damaged packaging',
        })
      ).rejects.toThrow('Stock adjustment cannot result in negative available inventory')
    })
  })
})
