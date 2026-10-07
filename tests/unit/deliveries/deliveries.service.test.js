import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external dependencies BEFORE importing service ─
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../../src/config/bullmq.js', () => ({
  orderQueue: { add: vi.fn() },
}))

vi.mock('../../../src/utils/pushNotification.js', () => ({
  sendPush: vi.fn(),
}))

vi.mock('../../../src/modules/uploads/uploads.service.js', () => ({
  UploadsService: class {
    uploadImage = vi.fn()
  },
}))

vi.mock('../../../src/modules/cashback/cashback.service.js', () => ({
  CashbackService: class {
    evaluateAndCredit = vi.fn()
  },
}))

import { DeliveryService } from '../../../src/modules/delivery/delivery.service.js'

function createRepositoryMock() {
  return {
    getRiderProfile: vi.fn(),
    toggleOnline: vi.fn(),
    getAssignmentByOrderAndRider: vi.fn(),
    getOrderAssignmentSnapshot: vi.fn(),
    acceptOrder: vi.fn(),
    rejectOrder: vi.fn(),
    markPickedUp: vi.fn(),
    markDelivered: vi.fn(),
    verifyDeliveryOtp: vi.fn(),
    storeDeliveryOtp: vi.fn(),
    saveProofPhoto: vi.fn(),
    getAssignedOrders: vi.fn(),
    getStoreSettings: vi.fn(),
    getDeliveryStats: vi.fn(),
    getDeliveryEarnings: vi.fn(),
    getDeliveryPayouts: vi.fn(),
    getDeliveryCompletionSummary: vi.fn(),
    updateLocation: vi.fn(),
    getDeliveryHistory: vi.fn(),
  }
}

function createService(repository) {
  const service = new DeliveryService(repository, {})
  service._emitOrderUpdate = vi.fn()
  service._emitOrderExpired = vi.fn()
  service._queueNotification = vi.fn()
  service._queueAutoAssign = vi.fn()
  service._runAutoAssignFallback = vi.fn()
  service._queueBacklogAssignScan = vi.fn()
  return service
}

describe('DeliveryService toggleOnline eligibility gates', () => {
  let repository
  let service

  beforeEach(() => {
    repository = createRepositoryMock()
    service = createService(repository)
  })

  it('rejects with RIDER_NOT_FOUND when the profile is missing', async () => {
    repository.getRiderProfile.mockResolvedValue(null)

    await expect(service.toggleOnline('rider-1', true)).rejects.toMatchObject({
      statusCode: 404,
      code: 'RIDER_NOT_FOUND',
    })
    expect(repository.toggleOnline).not.toHaveBeenCalled()
  })

  it('rejects with RIDER_NOT_APPROVED when the profile is unapproved', async () => {
    repository.getRiderProfile.mockResolvedValue({
      user_id: 'rider-1',
      is_approved: false,
      is_active: true,
    })

    await expect(service.toggleOnline('rider-1', true)).rejects.toMatchObject({
      statusCode: 403,
      code: 'RIDER_NOT_APPROVED',
    })
    expect(repository.toggleOnline).not.toHaveBeenCalled()
  })

  it('rejects with RIDER_SUSPENDED when a suspended rider tries to go online', async () => {
    repository.getRiderProfile.mockResolvedValue({
      user_id: 'rider-1',
      is_approved: true,
      is_active: false,
    })

    await expect(service.toggleOnline('rider-1', true)).rejects.toMatchObject({
      statusCode: 403,
      code: 'RIDER_SUSPENDED',
    })
    expect(repository.toggleOnline).not.toHaveBeenCalled()
    expect(service._queueBacklogAssignScan).not.toHaveBeenCalled()
  })

  it('still allows a suspended rider to go offline (harmless direction)', async () => {
    repository.getRiderProfile.mockResolvedValue({
      user_id: 'rider-1',
      is_approved: true,
      is_active: false,
    })
    repository.toggleOnline.mockResolvedValue({ user_id: 'rider-1', is_online: false })

    await expect(service.toggleOnline('rider-1', false)).resolves.toMatchObject({
      is_online: false,
    })
    expect(repository.toggleOnline).toHaveBeenCalledWith('rider-1', false)
  })

  it('lets an approved active rider go online and queues a backlog scan', async () => {
    repository.getRiderProfile.mockResolvedValue({
      user_id: 'rider-1',
      is_approved: true,
      is_active: true,
    })
    repository.toggleOnline.mockResolvedValue({ user_id: 'rider-1', is_online: true })

    await expect(service.toggleOnline('rider-1', true)).resolves.toMatchObject({
      is_online: true,
    })
    expect(repository.toggleOnline).toHaveBeenCalledWith('rider-1', true)
    expect(service._queueBacklogAssignScan).toHaveBeenCalledWith('RIDER_WENT_ONLINE')
  })
})

describe('DeliveryService.acceptOrder — rider-busy conflict mapping', () => {
  let repository
  let service

  beforeEach(() => {
    repository = createRepositoryMock()
    service = createService(repository)
  })

  it('maps RIDER_ALREADY_HAS_ACTIVE_ORDER to a typed 409 with rider-facing copy', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue({
      assignment_id: 'assign-1',
      status: 'ASSIGNED',
    })
    repository.acceptOrder.mockResolvedValue({
      conflict: true,
      reason: 'RIDER_ALREADY_HAS_ACTIVE_ORDER',
    })

    await expect(service.acceptOrder('rider-1', 'order-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'RIDER_ALREADY_HAS_ACTIVE_ORDER',
      message: 'You already have an active delivery. Complete it first',
    })
  })

  it('emits order:expired to every losing rider after a winning accept', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue({
      assignment_id: 'assign-winner',
      status: 'ASSIGNED',
      order_number: 'ORD-1',
      order_status: 'CONFIRMED',
      customer_id: 'customer-1',
    })
    repository.acceptOrder.mockResolvedValue({
      conflict: false,
      assignment: { id: 'assign-winner', status: 'ACCEPTED' },
      cancelledOffers: [
        { id: 'assign-loser-1', rider_id: 'rider-loser-1' },
        { id: 'assign-loser-2', rider_id: 'rider-loser-2' },
      ],
    })
    repository.storeDeliveryOtp.mockResolvedValue(undefined)

    await service.acceptOrder('rider-1', 'order-1')

    expect(service._emitOrderExpired).toHaveBeenCalledTimes(2)
    expect(service._emitOrderExpired).toHaveBeenCalledWith('order-1', 'rider-loser-1', {
      orderId: 'order-1',
      assignmentId: 'assign-loser-1',
      status: 'EXPIRED',
      message: 'Accepted by another rider',
    })
    expect(service._emitOrderExpired).toHaveBeenCalledWith('order-1', 'rider-loser-2', {
      orderId: 'order-1',
      assignmentId: 'assign-loser-2',
      status: 'EXPIRED',
      message: 'Accepted by another rider',
    })
  })
})
