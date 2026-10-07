import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeliveriesService } from '../../../src/modules/deliveries/deliveries.service.js'

describe('Phase 9 Rider Shift & Delivery Adaptation Unit Tests', () => {
  let repositoryMock
  let ordersRepoMock
  let service

  beforeEach(() => {
    repositoryMock = {
      createRider: vi.fn(),
      findRiderById: vi.fn(),
      findRiderByUserId: vi.fn(),
      updateRiderAvailability: vi.fn(),
      findActiveShift: vi.fn(),
      startShift: vi.fn(),
      updateShiftStatus: vi.fn(),
      createAssignment: vi.fn(),
      findAssignmentById: vi.fn(),
      findActiveAssignmentByOrder: vi.fn(),
      updateAssignmentStatus: vi.fn(),
      logStatusTransition: vi.fn(),
      logAudit: vi.fn(),
      listRiders: vi.fn(),
      listAssignments: vi.fn(),
    }
    ordersRepoMock = {
      findOrderById: vi.fn(),
      updateOrderStatus: vi.fn(),
    }
    service = new DeliveriesService(repositoryMock, ordersRepoMock)
  })

  describe('Rider Profile & Shift Management', () => {
    it('creates rider profile cleanly', async () => {
      repositoryMock.findRiderByUserId.mockResolvedValueOnce(null)
      repositoryMock.createRider.mockResolvedValueOnce({ id: 'rider-1', user_id: 'u-1', vehicle_type: 'BIKE' })

      const rider = await service.createRider({ user_id: 'u-1', vehicle_type: 'BIKE' })

      expect(repositoryMock.createRider).toHaveBeenCalledWith('u-1', 'BIKE', null)
      expect(rider.id).toBe('rider-1')
    })

    it('starts rider shift when active', async () => {
      repositoryMock.findRiderById.mockResolvedValueOnce({ id: 'rider-1', is_active: true })
      repositoryMock.findActiveShift.mockResolvedValueOnce(null)
      repositoryMock.startShift.mockResolvedValueOnce({ id: 'shift-1', status: 'ON_DUTY' })

      const shift = await service.startShift('rider-1')

      expect(repositoryMock.startShift).toHaveBeenCalledWith('rider-1')
      expect(shift.status).toBe('ON_DUTY')
    })

    it('rejects shift start if rider already has an active shift (409 OVERLAPPING_SHIFT_REJECTED)', async () => {
      repositoryMock.findRiderById.mockResolvedValueOnce({ id: 'rider-1', is_active: true })
      repositoryMock.findActiveShift.mockResolvedValueOnce({ id: 'shift-active', status: 'ON_DUTY' })

      await expect(service.startShift('rider-1')).rejects.toThrow('already has an active shift')
    })
  })

  describe('Delivery Assignment & Status Workflow', () => {
    it('assigns delivery to available on-duty rider', async () => {
      ordersRepoMock.findOrderById.mockResolvedValueOnce({ id: 'ord-1', status: 'READY_FOR_DISPATCH' })
      repositoryMock.findRiderById.mockResolvedValueOnce({ id: 'rider-1', is_active: true, is_available: true })
      repositoryMock.findActiveAssignmentByOrder.mockResolvedValueOnce(null)
      repositoryMock.createAssignment.mockResolvedValueOnce({ id: 'da-1', order_id: 'ord-1', rider_id: 'rider-1', status: 'ASSIGNED' })

      const assignment = await service.assignDelivery('admin-1', { order_id: 'ord-1', rider_id: 'rider-1' })

      expect(repositoryMock.createAssignment).toHaveBeenCalledWith('ord-1', 'rider-1', null)
      expect(assignment.id).toBe('da-1')
    })

    it('rejects delivery assignment if rider is unavailable/off-duty (400 UNAVAILABLE_RIDER_REJECTED)', async () => {
      ordersRepoMock.findOrderById.mockResolvedValueOnce({ id: 'ord-1' })
      repositoryMock.findRiderById.mockResolvedValueOnce({ id: 'rider-1', is_active: true, is_available: false })

      await expect(service.assignDelivery('admin-1', { order_id: 'ord-1', rider_id: 'rider-1' })).rejects.toThrow('Rider is unavailable')
    })

    it('transitions delivery status ASSIGNED -> PICKED_UP -> IN_TRANSIT and updates order status', async () => {
      repositoryMock.findAssignmentById.mockResolvedValueOnce({ id: 'da-1', order_id: 'ord-1', status: 'PICKED_UP' })
      repositoryMock.updateAssignmentStatus.mockResolvedValueOnce({ id: 'da-1', status: 'IN_TRANSIT' })

      const updated = await service.transitionDeliveryStatus('da-1', 'rider-1', 'IN_TRANSIT')

      expect(ordersRepoMock.updateOrderStatus).toHaveBeenCalledWith('ord-1', 'OUT_FOR_DELIVERY')
      expect(updated.status).toBe('IN_TRANSIT')
    })

    it('rejects invalid delivery status transition ASSIGNED -> DELIVERED (400 INVALID_DELIVERY_TRANSITION)', async () => {
      repositoryMock.findAssignmentById.mockResolvedValueOnce({ id: 'da-1', status: 'ASSIGNED' })

      await expect(service.transitionDeliveryStatus('da-1', 'rider-1', 'DELIVERED')).rejects.toThrow('Invalid delivery transition')
    })
  })
})
