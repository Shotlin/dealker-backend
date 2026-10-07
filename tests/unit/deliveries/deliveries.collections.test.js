import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    getRiderDocuments: vi.fn(),
    getCollectionByOrderId: vi.fn(),
    saveCollection: vi.fn(),
    getCollectionsSummary: vi.fn(),
    getCollections: vi.fn(),
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
  // markDelivered fires the cashback evaluation fire-and-forget — give it
  // a resolved promise so the .catch chain has something to attach to.
  service.cashbackService.evaluateAndCredit = vi.fn().mockResolvedValue(undefined)
  return service
}

const IN_TRANSIT_ASSIGNMENT = {
  assignment_id: 'assign-1',
  status: 'IN_TRANSIT',
  order_id: 'order-1',
  total_payable: 380,
  payment_method: 'COD',
}

describe('DeliveryService.saveCollection (Big Phase 14)', () => {
  let repository
  let service

  beforeEach(() => {
    repository = createRepositoryMock()
    service = createService(repository)
  })

  it('rejects collection when the order is not an in-transit assignment', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue(null)

    await expect(
      service.saveCollection('rider-1', 'order-1', {
        cashAmount: 380,
        upiAmount: 0,
        idempotencyKey: 'collection-order-1',
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_NOT_IN_TRANSIT' })
    expect(repository.saveCollection).not.toHaveBeenCalled()
  })

  it('rejects a split that does not match the amount due beyond the ₹2 tolerance', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue(IN_TRANSIT_ASSIGNMENT)

    await expect(
      service.saveCollection('rider-1', 'order-1', {
        cashAmount: 300,
        upiAmount: 0,
        idempotencyKey: 'k1',
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'COLLECTION_AMOUNT_MISMATCH',
    })
    expect(repository.saveCollection).not.toHaveBeenCalled()
  })

  it('accepts a split within the ₹2 tolerance and persists it', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue(IN_TRANSIT_ASSIGNMENT)
    repository.saveCollection.mockResolvedValue({
      row: { order_id: 'order-1', total_collected: 380.5 },
      replayed: false,
    })

    const result = await service.saveCollection('rider-1', 'order-1', {
      cashAmount: 380.5,
      upiAmount: 0,
      idempotencyKey: 'collection-order-1',
    })

    expect(result.replayed).toBe(false)
    // amount_due snapshotted from the order
    expect(repository.saveCollection).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-1',
        riderId: 'rider-1',
        amountDue: 380,
        cashAmount: 380.5,
        upiAmount: 0,
        idempotencyKey: 'collection-order-1',
      })
    )
  })

  it('falls back to a deterministic key derived from the order id', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue(IN_TRANSIT_ASSIGNMENT)
    repository.saveCollection.mockResolvedValue({
      row: { order_id: 'order-1' },
      replayed: false,
    })

    await service.saveCollection('rider-1', 'order-1', {
      cashAmount: 380,
      upiAmount: 0,
      idempotencyKey: undefined,
    })

    expect(repository.saveCollection).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'collection-order-1' })
    )
  })

  it('surfaces a replay for the same idempotency key', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue(IN_TRANSIT_ASSIGNMENT)
    repository.saveCollection.mockResolvedValue({
      row: { order_id: 'order-1', idempotency_key: 'collection-order-1' },
      replayed: true,
    })

    const result = await service.saveCollection('rider-1', 'order-1', {
      cashAmount: 380,
      upiAmount: 0,
      idempotencyKey: 'collection-order-1',
    })

    expect(result.replayed).toBe(true)
  })

  it('rejects negative amounts', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue(IN_TRANSIT_ASSIGNMENT)

    await expect(
      service.saveCollection('rider-1', 'order-1', {
        cashAmount: -5,
        upiAmount: 385,
        idempotencyKey: 'k',
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' })
  })
})

describe('DeliveryService.markDelivered — COD collection block (§14)', () => {
  let repository
  let service

  beforeEach(() => {
    repository = createRepositoryMock()
    service = createService(repository)
  })

  it('blocks COD delivery without a server-confirmed collection', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue(IN_TRANSIT_ASSIGNMENT)
    repository.getCollectionByOrderId.mockResolvedValue(null)

    await expect(
      service.markDelivered('rider-1', 'order-1', '1234', null, false)
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'COD_COLLECTION_REQUIRED',
    })
    expect(repository.markDelivered).not.toHaveBeenCalled()
  })

  it('allows COD delivery once the collection is confirmed', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue(IN_TRANSIT_ASSIGNMENT)
    repository.getCollectionByOrderId.mockResolvedValue({
      order_id: 'order-1',
      total_collected: 380,
    })
    repository.verifyDeliveryOtp.mockResolvedValue(true)
    repository.markDelivered.mockResolvedValue({
      id: 'assign-1',
      status: 'DELIVERED',
    })
    repository.getDeliveryCompletionSummary.mockResolvedValue({})

    const result = await service.markDelivered('rider-1', 'order-1', '1234', null, false)

    expect(result.status).toBe('DELIVERED')
    expect(repository.markDelivered).toHaveBeenCalled()
  })

  it('does not require a collection for prepaid orders', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue({
      ...IN_TRANSIT_ASSIGNMENT,
      payment_method: 'ONLINE',
    })
    repository.verifyDeliveryOtp.mockResolvedValue(true)
    repository.markDelivered.mockResolvedValue({
      id: 'assign-1',
      status: 'DELIVERED',
    })
    repository.getDeliveryCompletionSummary.mockResolvedValue({})

    const result = await service.markDelivered('rider-1', 'order-1', '1234', null, false)

    expect(result.status).toBe('DELIVERED')
    expect(repository.getCollectionByOrderId).not.toHaveBeenCalled()
  })
})
