import { describe, expect, it, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({ query: vi.fn(async () => ({ rows: [] })) }))
vi.mock('../../../src/config/database.js', () => db)
vi.mock('../../../src/config/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../../../src/utils/activityLogger.js', () => ({ logAdminActivity: vi.fn() }))
vi.mock('../../../src/plugins/socketio.plugin.js', () => ({ getSocketIo: vi.fn(() => null) }))
vi.mock('../../../src/plugins/socket-emitter.js', () => ({ getSocketEmitter: vi.fn(() => ({ to: vi.fn() })) }))

const { ReturnJourneyService, pickupStatusFromShipping } = await import('../../../src/modules/refund-requests/return-journey.service.js')
const { RefundRequestsService, toCustomerView } = await import('../../../src/modules/refund-requests/refund-requests.service.js')

beforeEach(() => { db.query.mockReset(); db.query.mockImplementation(async () => ({ rows: [] })) })

describe('pickupStatusFromShipping', () => {
  it('maps courier vocabulary to return-pickup states (delivered to warehouse = received)', () => {
    expect(pickupStatusFromShipping('PICKUP_SCHEDULED')).toBe('PICKUP_SCHEDULED')
    expect(pickupStatusFromShipping('OUT_FOR_DELIVERY')).toBe('IN_TRANSIT')
    expect(pickupStatusFromShipping('DELIVERED')).toBe('RECEIVED')
    expect(pickupStatusFromShipping('RTO')).toBe('FAILED')
    expect(pickupStatusFromShipping('SOMETHING_ELSE')).toBeNull()
  })
})

describe('customer view with pickup + QC', () => {
  const row = { id: 'rr1', order_id: 'o1', scope: 'FULL_ORDER', reason: 'x', status: 'PROCESSING', computed_amount: '10499', created_at: 't0', return_approved_at: 't1' }
  it('walks Requested → Approved → Picked up → Received → QC and waits for the price answer', () => {
    const v = toCustomerView(row, {
      pickup: { status: 'RECEIVED', scheduled_at: 't1', picked_up_at: 't2', received_at: 't3' },
      qc: { price_status: 'PROPOSED', inspected_at: 't4', original_price: 10499, revised_price: 9999 },
    })
    expect(v.timeline.map((t) => t.key)).toEqual(['REQUESTED', 'RETURN_APPROVED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'RECEIVED', 'QC_DONE', 'PRICE_CONFIRMATION'])
    expect(v.timeline.at(-1).current).toBe(true)
    expect(v.qc.revised_price).toBe(9999)
  })
  it('an approved return without pickup still shows Approved then Refunded', () => {
    const v = toCustomerView({ ...row, status: 'APPROVED', return_approved_at: null, resolved_at: 't9' })
    expect(v.timeline.map((t) => t.key)).toEqual(['REQUESTED', 'APPROVED', 'REFUNDED'])
  })
})

describe('return window', () => {
  const svc = new ReturnJourneyService()
  it('allows a return inside the window and blocks one after it', async () => {
    db.query.mockImplementation(async () => ({ rows: [{ window_days: 7, free_pickup: true, policy_points: [] }] }))
    await expect(svc.assertInsideWindow({ delivered_at: new Date(Date.now() - 3 * 86400000) })).resolves.toBeUndefined()
    await expect(svc.assertInsideWindow({ delivered_at: new Date(Date.now() - 9 * 86400000) })).rejects.toMatchObject({ code: 'RETURN_WINDOW_CLOSED', statusCode: 409 })
  })
  it('does not block an order that has no delivery date', async () => {
    await expect(svc.assertInsideWindow({ delivered_at: null })).resolves.toBeUndefined()
  })
})

describe('QC price revision', () => {
  const svc = new ReturnJourneyService()
  const open = { id: 'rr1', status: 'PENDING', customer_id: 'c1', order_id: 'o1', order_number: 'M-1', computed_amount: '10499' }
  it('refuses a revised price above the original', async () => {
    db.query.mockImplementation(async (sql) => ({ rows: /FROM refund_requests r JOIN orders/.test(sql) ? [open] : [] }))
    await expect(svc.saveQc('rr1', { checks: [{ label: 'Screen', status: 'OK' }], revisedPrice: 12000 }, { userId: 'a1' })).rejects.toMatchObject({ code: 'INVALID_REVISED_PRICE' })
  })
  it('refuses an unknown check result', async () => {
    db.query.mockImplementation(async (sql) => ({ rows: /FROM refund_requests r JOIN orders/.test(sql) ? [open] : [] }))
    await expect(svc.saveQc('rr1', { checks: [{ label: 'Screen', status: 'GOOD' }] }, { userId: 'a1' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
  it('approval waits while the customer has not answered, and uses the accepted price afterwards', async () => {
    db.query.mockImplementation(async () => ({ rows: [{ price_status: 'PROPOSED', revised_price: '9999' }] }))
    await expect(svc.approvalAmount('rr1')).rejects.toMatchObject({ code: 'QC_PRICE_PENDING' })
    db.query.mockImplementation(async () => ({ rows: [{ price_status: 'ACCEPTED', revised_price: '9999' }] }))
    expect(await svc.approvalAmount('rr1')).toBe(9999)
    db.query.mockImplementation(async () => ({ rows: [{ price_status: 'NONE', revised_price: null }] }))
    expect(await svc.approvalAmount('rr1')).toBeNull()
    db.query.mockImplementation(async () => ({ rows: [] }))
    expect(await svc.approvalAmount('rr1')).toBeNull()
  })
})

describe('RefundRequestsService.approve with a QC price', () => {
  const pending = { id: 'rr1', order_id: 'o1', order_number: 'M-1', customer_id: 'c1', shop_id: null, status: 'PENDING', scope: 'FULL_ORDER', computed_amount: '10499.00', refund_destination: 'WALLET', reason: 'x' }
  function build(journey) {
    const repo = {
      findById: vi.fn(async () => pending),
      findOrderForRefund: vi.fn(async () => ({ id: 'o1', order_number: 'M-1', status: 'DELIVERED', payment_status: 'PAID' })),
      findPaymentForOrder: vi.fn(async () => null),
      claimForProcessing: vi.fn(async () => ({ ...pending, status: 'PROCESSING' })),
      releaseClaim: vi.fn(), finalize: vi.fn(async () => ({ ...pending, status: 'APPROVED' })),
    }
    const creditWallet = vi.fn(async () => ({}))
    const service = new RefundRequestsService({
      repository: repo, journey, fastify: { io: null }, notifier: null,
      adminOrdersRepo: { updateStatus: vi.fn() }, customersRepo: { creditWallet },
    })
    return { service, repo, creditWallet }
  }
  it('refunds the price the customer accepted, not the original', async () => {
    const { service, creditWallet, repo } = build({ approvalAmount: vi.fn(async () => 9999) })
    await service.approve('rr1', { userId: 'a1', role: 'ADMIN' })
    expect(creditWallet).toHaveBeenCalledWith('c1', 9999, expect.any(String))
    expect(repo.finalize).toHaveBeenCalledWith('rr1', expect.objectContaining({ resolvedAmount: 9999 }))
  })
  it('does not claim or move money while the price is unanswered', async () => {
    const err = Object.assign(new Error('wait'), { code: 'QC_PRICE_PENDING', statusCode: 409 })
    const { service, creditWallet, repo } = build({ approvalAmount: vi.fn(async () => { throw err }) })
    await expect(service.approve('rr1', { userId: 'a1', role: 'ADMIN' })).rejects.toMatchObject({ code: 'QC_PRICE_PENDING' })
    expect(repo.claimForProcessing).not.toHaveBeenCalled()
    expect(creditWallet).not.toHaveBeenCalled()
  })
})
