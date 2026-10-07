import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../../src/config/bullmq.js', () => ({ orderQueue: { add: vi.fn() } }))
vi.mock('../../../src/utils/pushNotification.js', () => ({ sendPush: vi.fn() }))
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
import { parseOrderQr } from '../../../src/modules/delivery/pickup-qr.js'

const ORDER_ID = '11111111-2222-4333-8444-555555555555'
const RIDER_ID = 'rider-1'
const QR = `FRESHCUTS-ORDER|FC-KOL-20260928-0001|${ORDER_ID}`

function repo(overrides = {}) {
  return {
    getRiderProfile: vi.fn(),
    updateRiderProfile: vi.fn(),
    getAssignmentByOrderAndRider: vi.fn(),
    getOrderAssignmentSnapshot: vi.fn(),
    getOrderForPickupChecklist: vi.fn(),
    recordPickupScan: vi.fn(),
    getPendingPickupScan: vi.fn(),
    consumePickupScan: vi.fn(),
    markPickedUp: vi.fn(),
    markDelivered: vi.fn(),
    getCollectionByOrderId: vi.fn(),
    saveCollection: vi.fn(),
    storeDeliveryOtp: vi.fn(),
    verifyDeliveryOtp: vi.fn(),
    getOtpFailures: vi.fn().mockResolvedValue(0),
    recordOtpFailure: vi.fn(),
    clearOtpFailures: vi.fn(),
    getDeliveryCompletionSummary: vi.fn(),
    getAssignedOrders: vi.fn(),
    getStoreSettings: vi.fn().mockResolvedValue(null),
    getShopInfo: vi.fn(),
    acceptOrder: vi.fn(),
    ...overrides,
  }
}

function svc(repository) {
  const service = new DeliveryService(repository, {})
  service._emitOrderUpdate = vi.fn()
  service._emitOrderExpired = vi.fn()
  service._emitOutForDeliveryEvents = vi.fn()
  service._queueNotification = vi.fn()
  service._queueAutoAssign = vi.fn()
  service.cashbackService.evaluateAndCredit = vi.fn().mockResolvedValue(undefined)
  return service
}

const ORDER_ROW = {
  id: ORDER_ID,
  order_number: 'FC-KOL-20260928-0001',
  customer_name: 'Asha',
  customer_phone: '9000000010',
  delivery_address: { addressLine1: '12 Park St', city: 'Kolkata', lat: 22.55, lng: 88.35 },
  delivery_notes: 'Ring twice',
  delivery_instructions: null,
  items: [
    { name: 'Chicken Breast', quantity: 2, unit: '500 g', thumbnailUrl: 'https://img/x.jpg', price: 250, total: 500 },
  ],
}

describe('parseOrderQr', () => {
  it('parses the FreshCuts invoice QR', () => {
    expect(parseOrderQr(QR)).toEqual({ orderNumber: 'FC-KOL-20260928-0001', orderId: ORDER_ID })
    expect(parseOrderQr(`  ${QR}  `)?.orderId).toBe(ORDER_ID)
  })

  it.each([
    '',
    null,
    'FRESHCUTS-ORDER|only-two',
    `OTHER|FC-1|${ORDER_ID}`,
    'FRESHCUTS-ORDER|FC-1|not-a-uuid',
    `FRESHCUTS-ORDER||${ORDER_ID}`,
    `1.token.sig`,
  ])('rejects %j', (raw) => {
    expect(parseOrderQr(raw)).toBeNull()
  })
})

describe('DeliveryService.verifyPickupScan', () => {
  let repository
  let service
  beforeEach(() => {
    repository = repo()
    service = svc(repository)
    repository.getOrderForPickupChecklist.mockResolvedValue(ORDER_ROW)
  })

  it('rejects a code that is not a FreshCuts order QR', async () => {
    await expect(service.verifyPickupScan(RIDER_ID, { qr: '1.abc.def' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'INVALID_QR' })
    expect(repository.recordPickupScan).not.toHaveBeenCalled()
  })

  it('rejects an order this rider never had (WRONG_RIDER)', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue(null)
    repository.getOrderAssignmentSnapshot.mockResolvedValue({ id: ORDER_ID, assignment_status: null })
    await expect(service.verifyPickupScan(RIDER_ID, { qr: QR }))
      .rejects.toMatchObject({ statusCode: 403, code: 'WRONG_RIDER' })
    expect(repository.recordPickupScan).not.toHaveBeenCalled()
  })

  it('404s for an unknown order', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue(null)
    repository.getOrderAssignmentSnapshot.mockResolvedValue(null)
    await expect(service.verifyPickupScan(RIDER_ID, { qr: QR }))
      .rejects.toMatchObject({ statusCode: 404, code: 'ORDER_NOT_FOUND' })
  })

  it('refuses an order that is still only an offer (not accepted)', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue({ status: 'ASSIGNED' })
    await expect(service.verifyPickupScan(RIDER_ID, { qr: QR }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ORDER_NOT_ACCEPTED' })
  })

  it('refuses an order already picked up', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue({ status: 'IN_TRANSIT' })
    await expect(service.verifyPickupScan(RIDER_ID, { qr: QR }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_PICKED_UP' })
  })

  it('rejects a code whose order number does not match the order id', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue({ status: 'ACCEPTED' })
    repository.getOrderForPickupChecklist.mockResolvedValue({ ...ORDER_ROW, order_number: 'FC-OTHER-1' })
    await expect(service.verifyPickupScan(RIDER_ID, { qr: QR }))
      .rejects.toMatchObject({ statusCode: 400, code: 'INVALID_QR' })
    expect(repository.recordPickupScan).not.toHaveBeenCalled()
  })

  it('records the scan and returns a price-free checklist for the accepted rider', async () => {
    repository.getAssignmentByOrderAndRider.mockResolvedValue({ status: 'ACCEPTED' })
    const checklist = await service.verifyPickupScan(RIDER_ID, { qr: QR })

    expect(repository.recordPickupScan).toHaveBeenCalledWith(ORDER_ID, RIDER_ID)
    expect(checklist).toMatchObject({
      orderId: ORDER_ID,
      orderNumber: 'FC-KOL-20260928-0001',
      customerName: 'Asha',
      customerPhone: '9000000010',
      lat: 22.55,
      lng: 88.35,
      deliveryNotes: 'Ring twice',
    })
    expect(checklist.items).toEqual([
      { name: 'Chicken Breast', quantity: 2, unit: '500 g', image: 'https://img/x.jpg', variant: null },
    ])
    // No money fields may leak into the checklist.
    expect(JSON.stringify(checklist)).not.toMatch(/price|total|subtotal|amount/i)
  })
})

describe('DeliveryService.getPendingChecklist', () => {
  it('404s NO_PENDING_CHECKLIST when nothing was scanned', async () => {
    const repository = repo()
    repository.getAssignmentByOrderAndRider.mockResolvedValue({ status: 'ACCEPTED' })
    repository.getPendingPickupScan.mockResolvedValue(null)
    await expect(svc(repository).getPendingChecklist(RIDER_ID, ORDER_ID))
      .rejects.toMatchObject({ statusCode: 404, code: 'NO_PENDING_CHECKLIST' })
  })

  it('returns the checklist for a verified, unconsumed scan', async () => {
    const repository = repo()
    repository.getAssignmentByOrderAndRider.mockResolvedValue({ status: 'ACCEPTED' })
    repository.getPendingPickupScan.mockResolvedValue({ order_id: ORDER_ID })
    repository.getOrderForPickupChecklist.mockResolvedValue(ORDER_ROW)
    const checklist = await svc(repository).getPendingChecklist(RIDER_ID, ORDER_ID)
    expect(checklist.orderId).toBe(ORDER_ID)
  })

  it('does not resurrect the checklist once the order is picked up', async () => {
    const repository = repo()
    repository.getAssignmentByOrderAndRider.mockResolvedValue({ status: 'IN_TRANSIT' })
    await expect(svc(repository).getPendingChecklist(RIDER_ID, ORDER_ID))
      .rejects.toMatchObject({ code: 'NO_PENDING_CHECKLIST' })
  })
})

describe('markPickedUp consumes the scan', () => {
  it('stamps the scan consumed after a successful pickup', async () => {
    const repository = repo()
    repository.getAssignmentByOrderAndRider.mockResolvedValue({
      assignment_id: 'a1', status: 'ACCEPTED', customer_id: 'c1', order_number: 'FC-1',
    })
    repository.markPickedUp.mockResolvedValue({ id: 'a1', status: 'IN_TRANSIT' })
    await svc(repository).markPickedUp(RIDER_ID, ORDER_ID)
    expect(repository.consumePickupScan).toHaveBeenCalledWith(ORDER_ID)
  })
})

describe('delivery OTP privacy', () => {
  it('never returns the OTP from acceptOrder', async () => {
    const repository = repo()
    repository.getAssignmentByOrderAndRider.mockResolvedValue({
      assignment_id: 'a1', status: 'ASSIGNED', customer_id: 'c1', order_number: 'FC-1', order_status: 'CONFIRMED',
    })
    repository.acceptOrder.mockResolvedValue({
      conflict: false,
      assignment: { id: 'a1', status: 'ACCEPTED', delivery_otp: '1234' },
      cancelledOffers: [],
    })
    const result = await svc(repository).acceptOrder(RIDER_ID, ORDER_ID)
    expect(result).not.toHaveProperty('deliveryOtp')
    expect(result).not.toHaveProperty('delivery_otp')
    expect(repository.storeDeliveryOtp).toHaveBeenCalledWith(ORDER_ID, expect.stringMatching(/^\d{4}$/))
  })

  it('never returns the OTP from resendOtp', async () => {
    const repository = repo()
    repository.getAssignmentByOrderAndRider.mockResolvedValue({
      assignment_id: 'a1', status: 'IN_TRANSIT', customer_id: 'c1', order_number: 'FC-1', order_status: 'OUT_FOR_DELIVERY',
    })
    const result = await svc(repository).resendOtp(RIDER_ID, ORDER_ID)
    expect(result).not.toHaveProperty('deliveryOtp')
    expect(repository.clearOtpFailures).toHaveBeenCalledWith(ORDER_ID)
  })

  it('strips the OTP column from the rider order list', async () => {
    const repository = repo()
    repository.getAssignedOrders.mockResolvedValue([
      {
        order_id: ORDER_ID, assignment_id: 'a1', assignment_status: 'ACCEPTED', order_number: 'FC-1',
        delivery_otp: '4321', total_payable: 300, payment_method: 'COD', delivery_address: {},
      },
    ])
    const [order] = await svc(repository).getAssignedOrders(RIDER_ID)
    expect(order).not.toHaveProperty('delivery_otp')
    expect(order).not.toHaveProperty('deliveryOtp')
    expect(JSON.stringify(order)).not.toContain('4321')
  })

  it('locks OTP guessing after too many wrong attempts', async () => {
    const repository = repo()
    repository.getAssignmentByOrderAndRider.mockResolvedValue({
      assignment_id: 'a1', status: 'IN_TRANSIT', payment_method: 'ONLINE', payment_status: 'PAID', total_payable: 100,
    })
    repository.getOtpFailures.mockResolvedValue(5)
    await expect(svc(repository).markDelivered(RIDER_ID, ORDER_ID, '0000'))
      .rejects.toMatchObject({ statusCode: 429, code: 'OTP_ATTEMPTS_EXCEEDED' })
    expect(repository.verifyDeliveryOtp).not.toHaveBeenCalled()
  })

  it('counts a wrong OTP and does not deliver', async () => {
    const repository = repo()
    repository.getAssignmentByOrderAndRider.mockResolvedValue({
      assignment_id: 'a1', status: 'IN_TRANSIT', payment_method: 'ONLINE', payment_status: 'PAID', total_payable: 100,
    })
    repository.verifyDeliveryOtp.mockResolvedValue(false)
    await expect(svc(repository).markDelivered(RIDER_ID, ORDER_ID, '0000'))
      .rejects.toMatchObject({ code: 'INVALID_OTP' })
    expect(repository.recordOtpFailure).toHaveBeenCalledWith(ORDER_ID)
    expect(repository.markDelivered).not.toHaveBeenCalled()
  })
})

describe('COD amount due (wallet-aware)', () => {
  const base = { assignment_id: 'a1', status: 'IN_TRANSIT', payment_method: 'COD', total_payable: 500 }

  it('collects only total minus the wallet slice already debited', async () => {
    const repository = repo()
    repository.getAssignmentByOrderAndRider.mockResolvedValue({ ...base, wallet_amount: 200, payment_status: 'PENDING' })
    repository.saveCollection.mockResolvedValue({ row: { id: 'c1' }, replayed: false })
    await svc(repository).saveCollection(RIDER_ID, ORDER_ID, { cashAmount: 300, upiAmount: 0 })
    expect(repository.saveCollection).toHaveBeenCalledWith(expect.objectContaining({ amountDue: 300, cashAmount: 300 }))
  })

  it('rejects the full total when part was already paid from the wallet', async () => {
    const repository = repo()
    repository.getAssignmentByOrderAndRider.mockResolvedValue({ ...base, wallet_amount: 200, payment_status: 'PENDING' })
    await expect(svc(repository).saveCollection(RIDER_ID, ORDER_ID, { cashAmount: 500, upiAmount: 0 }))
      .rejects.toMatchObject({ code: 'COLLECTION_AMOUNT_MISMATCH' })
  })

  it('refuses a collection when nothing is due (wallet covered it)', async () => {
    const repository = repo()
    repository.getAssignmentByOrderAndRider.mockResolvedValue({ ...base, wallet_amount: 500, payment_status: 'PAID' })
    await expect(svc(repository).saveCollection(RIDER_ID, ORDER_ID, { cashAmount: 0, upiAmount: 0 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'COLLECTION_NOT_REQUIRED' })
  })

  it('lets a fully wallet-paid COD order be delivered without a collection', async () => {
    const repository = repo()
    repository.getAssignmentByOrderAndRider.mockResolvedValue({ ...base, wallet_amount: 500, payment_status: 'PAID' })
    repository.getCollectionByOrderId.mockResolvedValue(null)
    repository.verifyDeliveryOtp.mockResolvedValue(true)
    repository.markDelivered.mockResolvedValue({ id: 'a1', status: 'DELIVERED', completionSummary: {} })
    await expect(svc(repository).markDelivered(RIDER_ID, ORDER_ID, '1234')).resolves.toBeTruthy()
  })

  it('still blocks delivery of a COD order with money due and no collection', async () => {
    const repository = repo()
    repository.getAssignmentByOrderAndRider.mockResolvedValue({ ...base, wallet_amount: 0, payment_status: 'PENDING' })
    repository.getCollectionByOrderId.mockResolvedValue(null)
    await expect(svc(repository).markDelivered(RIDER_ID, ORDER_ID, '1234'))
      .rejects.toMatchObject({ code: 'COD_COLLECTION_REQUIRED' })
  })

  it('exposes amountDue on the rider order list', async () => {
    const repository = repo()
    repository.getAssignedOrders.mockResolvedValue([
      {
        order_id: ORDER_ID, assignment_id: 'a1', assignment_status: 'ACCEPTED', order_number: 'FC-1',
        total_payable: 500, wallet_amount: 200, payment_status: 'PENDING', payment_method: 'COD', delivery_address: {},
      },
    ])
    const [order] = await svc(repository).getAssignedOrders(RIDER_ID)
    expect(order.amountDue).toBe(300)
    expect(order.walletAmount).toBe(200)
  })
})

describe('DeliveryService.updateRiderProfile', () => {
  let repository
  let service
  beforeEach(() => {
    repository = repo()
    service = svc(repository)
    repository.getRiderProfile.mockResolvedValue({ user_id: RIDER_ID })
    repository.updateRiderProfile.mockResolvedValue({ user_id: RIDER_ID, name: 'Ravi' })
  })

  it('normalises and saves only the supplied fields', async () => {
    await service.updateRiderProfile(RIDER_ID, {
      name: '  Ravi ', vehicleNumber: 'wb 01 ab 1234', bankIfsc: 'sbin0001234', bankAccountNumber: '123456789012',
    })
    expect(repository.updateRiderProfile).toHaveBeenCalledWith(RIDER_ID, {
      name: 'Ravi', vehicleNumber: 'WB 01 AB 1234', bankIfsc: 'SBIN0001234', bankAccountNumber: '123456789012',
    })
  })

  it('rejects a malformed IFSC and a non-numeric account number', async () => {
    await expect(service.updateRiderProfile(RIDER_ID, { bankIfsc: 'BAD' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(service.updateRiderProfile(RIDER_ID, { bankAccountNumber: '12ab' })).rejects.toMatchObject({ statusCode: 400 })
    expect(repository.updateRiderProfile).not.toHaveBeenCalled()
  })

  it('refuses to blank a field with an empty string', async () => {
    await expect(service.updateRiderProfile(RIDER_ID, { name: '   ' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('404s when the caller has no rider profile', async () => {
    repository.getRiderProfile.mockResolvedValue(null)
    await expect(service.updateRiderProfile(RIDER_ID, { name: 'X' })).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('DeliveryService.uploadDocument', () => {
  it('rejects a document type the database would refuse', async () => {
    await expect(svc(repo()).uploadDocument({ riderId: RIDER_ID, fileStream: {}, docType: 'selfie' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'INVALID_DOCUMENT_TYPE' })
  })
})
