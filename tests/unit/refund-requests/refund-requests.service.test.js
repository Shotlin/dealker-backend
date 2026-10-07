import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../../../src/config/database.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }))
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../../src/utils/activityLogger.js', () => ({ logAdminActivity: vi.fn() }))
vi.mock('../../../src/plugins/socketio.plugin.js', () => ({ getSocketIo: vi.fn(() => null) }))
vi.mock('../../../src/plugins/socket-emitter.js', () => ({ getSocketEmitter: vi.fn(() => ({ to: vi.fn() })) }))

const { RefundRequestsService, toCustomerView } = await import(
  '../../../src/modules/refund-requests/refund-requests.service.js'
)

const CUSTOMER = 'cust-1'
const SHOP = 'shop-1'
const items = [
  { id: 'oi1', product_id: 'p1', product_name: 'Eggs', quantity: 1, unit_price: '90', subtotal: '90', product_snapshot: { name: 'Farm Fresh Eggs', price: 90, total: 90 } },
  { id: 'oi2', product_id: 'p2', product_name: 'Chicken', quantity: 1, unit_price: '325', subtotal: '325', product_snapshot: null },
]

function makeRepo(over = {}) {
  const state = { created: null }
  const repo = {
    findOrderForRefund: vi.fn(async () => ({
      id: 'o1', order_number: 'FC-1', customer_id: CUSTOMER, shop_id: SHOP, status: 'DELIVERED',
      payment_status: 'PAID', payment_method: 'COD', total_payable: '415.00',
    })),
    hasBlockingRequest: vi.fn(async () => null),
    findOrderItems: vi.fn(async () => items),
    findPaymentForOrder: vi.fn(async () => null),
    create: vi.fn(async (d) => { state.created = d; return { id: 'rr1', ...d } }),
    findById: vi.fn(async () => ({
      id: 'rr1', order_id: 'o1', order_number: 'FC-1', customer_id: CUSTOMER, shop_id: SHOP,
      status: 'PENDING', scope: 'FULL_ORDER', computed_amount: '415.00', refund_destination: 'WALLET',
      reason: 'spoiled',
    })),
    claimForProcessing: vi.fn(async () => ({
      id: 'rr1', order_id: 'o1', customer_id: CUSTOMER, shop_id: SHOP, scope: 'FULL_ORDER',
      computed_amount: '415.00', refund_destination: 'WALLET', reason: 'spoiled',
    })),
    releaseClaim: vi.fn(async () => {}),
    finalize: vi.fn(async () => ({ id: 'rr1', status: 'APPROVED' })),
    cancelByCustomer: vi.fn(async () => ({ id: 'rr1', status: 'CANCELLED' })),
    ...over,
  }
  return { repo, state }
}

function makeService(over = {}, deps = {}) {
  const { repo, state } = makeRepo(over)
  const creditWallet = vi.fn(async () => ({ balance: 1 }))
  const paymentsRefund = vi.fn(async () => ({ success: true, refundId: 'rfnd_1' }))
  const updateStatus = vi.fn(async () => 'DELIVERED')
  const notifier = { sendNotification: vi.fn(async () => ({})) }
  const io = { to: vi.fn(() => ({ emit: vi.fn() })) }
  const service = new RefundRequestsService({
    repository: repo,
    fastify: { io },
    notifier,
    paymentsService: { refund: paymentsRefund },
    adminOrdersRepo: { updateStatus },
    customersRepo: { creditWallet },
    ...deps,
  })
  return { service, repo, state, creditWallet, paymentsRefund, updateStatus, notifier, io }
}

const asCustomer = { userId: CUSTOMER, role: 'CUSTOMER' }
const asAdmin = (extra = {}) => ({ userId: 'admin-1', role: 'ADMIN', shopId: null, ...extra })

describe('RefundRequestsService.create (customer)', () => {
  it("never reveals another customer's order — 404", async () => {
    const { service } = makeService()
    await expect(service.create({ orderId: 'o1', itemScope: 'ALL', description: 'x y z' }, { userId: 'someone-else', role: 'CUSTOMER' }))
      .rejects.toMatchObject({ statusCode: 404, code: 'ORDER_NOT_FOUND' })
  })

  it('only DELIVERED orders are refundable', async () => {
    const { service } = makeService({
      findOrderForRefund: vi.fn(async () => ({ id: 'o1', customer_id: CUSTOMER, shop_id: SHOP, status: 'PACKED', total_payable: '10' })),
    })
    await expect(service.create({ orderId: 'o1', itemScope: 'ALL', description: 'bad' }, asCustomer))
      .rejects.toMatchObject({ code: 'ORDER_NOT_REFUNDABLE' })
  })

  it('a second request for the same order is a 409', async () => {
    const { service } = makeService({ hasBlockingRequest: vi.fn(async () => ({ id: 'rr0', status: 'REJECTED' })) })
    await expect(service.create({ orderId: 'o1', itemScope: 'ALL', description: 'bad' }, asCustomer))
      .rejects.toMatchObject({ statusCode: 409, code: 'REFUND_REQUEST_EXISTS' })
  })

  it('a lost race on the partial-unique index is also a 409, not a 500', async () => {
    const { service } = makeService({ create: vi.fn(async () => { throw Object.assign(new Error('dup'), { code: '23505' }) }) })
    await expect(service.create({ orderId: 'o1', itemScope: 'ALL', description: 'bad' }, asCustomer))
      .rejects.toMatchObject({ statusCode: 409 })
  })

  it('ALL = full order, amount is the real order total, shop copied from the order', async () => {
    const { service, state } = makeService()
    await service.create({ orderId: 'o1', itemScope: 'ALL', description: 'spoiled' }, asCustomer)
    expect(state.created).toMatchObject({ scope: 'FULL_ORDER', computedAmount: '415.00', shopId: SHOP, source: 'CUSTOMER', items: null })
  })

  it('SPECIFIC = item-level; amount is summed server-side from the order lines', async () => {
    const { service, state } = makeService()
    await service.create({ orderId: 'o1', itemScope: 'SPECIFIC', productIds: ['p1'], description: 'spoiled' }, asCustomer)
    expect(state.created.scope).toBe('ITEMS')
    expect(state.created.computedAmount).toBe('90.00')
    expect(state.created.items).toEqual([expect.objectContaining({ productId: 'p1', name: 'Farm Fresh Eggs', lineTotal: 90 })])
  })

  it('rejects a product that is not on the order', async () => {
    const { service } = makeService()
    await expect(service.create({ orderId: 'o1', itemScope: 'SPECIFIC', productIds: ['nope'], description: 'x y z' }, asCustomer))
      .rejects.toMatchObject({ code: 'INVALID_REFUND_ITEMS' })
  })

  it('ticking every line collapses to a full-order request', async () => {
    const { service, state } = makeService()
    await service.create({ orderId: 'o1', itemScope: 'SPECIFIC', productIds: ['p1', 'p2'], description: 'x y z' }, asCustomer)
    expect(state.created).toMatchObject({ scope: 'FULL_ORDER', computedAmount: '415.00' })
  })

  it('defaults the destination to the original method only when a gateway payment exists', async () => {
    const online = makeService({ findPaymentForOrder: vi.fn(async () => ({ id: 'pay1', status: 'PAID', razorpay_payment_id: 'pay_x' })) })
    await online.service.create({ orderId: 'o1', itemScope: 'ALL', description: 'x y z' }, asCustomer)
    expect(online.state.created.refundDestination).toBe('RAZORPAY')
    const cod = makeService()
    await cod.service.create({ orderId: 'o1', itemScope: 'ALL', description: 'x y z' }, asCustomer)
    expect(cod.state.created.refundDestination).toBe('WALLET')
  })

  it('publishes refund:status (REFUND_REQUESTED) so the store dashboard updates live', async () => {
    const { service, io } = makeService()
    await service.create({ orderId: 'o1', itemScope: 'ALL', description: 'x y z' }, asCustomer)
    const rooms = io.to.mock.calls[0][0]
    expect(rooms).toEqual(expect.arrayContaining([`shop:${SHOP}`, `user:${CUSTOMER}`, 'admin:dashboard']))
  })

  it("a shop-scoped admin cannot file against another shop's order", async () => {
    const { service } = makeService()
    await expect(service.create({ orderId: 'o1', itemScope: 'ALL', description: 'x y z' }, asAdmin({ shopId: 'other-shop' })))
      .rejects.toMatchObject({ statusCode: 403, code: 'CROSS_SHOP_ACCESS_DENIED' })
  })
})

describe('RefundRequestsService.approve', () => {
  it('cross-shop approval is refused before anything happens', async () => {
    const { service, repo, creditWallet } = makeService()
    await expect(service.approve('rr1', asAdmin({ shopId: 'other-shop' }))).rejects.toMatchObject({ statusCode: 403 })
    expect(repo.claimForProcessing).not.toHaveBeenCalled()
    expect(creditWallet).not.toHaveBeenCalled()
  })

  it('a lost claim race moves NO money', async () => {
    const { service, creditWallet, paymentsRefund } = makeService({ claimForProcessing: vi.fn(async () => null) })
    await expect(service.approve('rr1', asAdmin())).rejects.toMatchObject({ statusCode: 409 })
    expect(creditWallet).not.toHaveBeenCalled()
    expect(paymentsRefund).not.toHaveBeenCalled()
  })

  it('an unpaid order is refused BEFORE the claim (state untouched)', async () => {
    const { service, repo } = makeService({
      findOrderForRefund: vi.fn(async () => ({ id: 'o1', order_number: 'FC-1', customer_id: CUSTOMER, shop_id: SHOP, status: 'DELIVERED', payment_status: 'PENDING', total_payable: '415' })),
    })
    await expect(service.approve('rr1', asAdmin())).rejects.toMatchObject({ code: 'ORDER_NOT_PAID' })
    expect(repo.claimForProcessing).not.toHaveBeenCalled()
  })

  it('Razorpay destination without an online payment is refused pre-claim', async () => {
    const { service, repo } = makeService()
    await expect(service.approve('rr1', asAdmin({ refundTo: 'RAZORPAY' }))).rejects.toMatchObject({ code: 'NO_GATEWAY_PAYMENT' })
    expect(repo.claimForProcessing).not.toHaveBeenCalled()
  })

  it('full-order wallet refund: credits once, finalizes, flips the order to REFUNDED, notifies', async () => {
    const { service, creditWallet, repo, updateStatus, notifier, io } = makeService()
    await service.approve('rr1', asAdmin({ adminNotes: 'ok' }))
    expect(creditWallet).toHaveBeenCalledTimes(1)
    expect(creditWallet.mock.calls[0][1]).toBe(415)
    expect(repo.finalize).toHaveBeenCalledWith('rr1', expect.objectContaining({ status: 'APPROVED', resolvedAmount: 415 }))
    expect(updateStatus).toHaveBeenCalledWith('o1', 'REFUNDED', 'admin-1', expect.any(String))
    expect(notifier.sendNotification).toHaveBeenCalledTimes(1)
    // order:status (REFUNDED) + refund:status both published
    const events = io.to.mock.results.map((r) => r.value.emit)
    expect(events.length).toBeGreaterThanOrEqual(2)
  })

  it('item-level refund leaves the order DELIVERED', async () => {
    const { service, updateStatus } = makeService({
      claimForProcessing: vi.fn(async () => ({ id: 'rr1', order_id: 'o1', customer_id: CUSTOMER, shop_id: SHOP, scope: 'ITEMS', computed_amount: '90.00', refund_destination: 'WALLET', reason: 'x' })),
    })
    await service.approve('rr1', asAdmin())
    expect(updateStatus).not.toHaveBeenCalled()
  })

  it('a gateway failure releases the claim back to PENDING and finalizes nothing', async () => {
    const { service, repo } = makeService(
      { findPaymentForOrder: vi.fn(async () => ({ id: 'pay1', status: 'PAID', razorpay_payment_id: 'pay_x' })),
        claimForProcessing: vi.fn(async () => ({ id: 'rr1', order_id: 'o1', customer_id: CUSTOMER, shop_id: SHOP, scope: 'FULL_ORDER', computed_amount: '415.00', refund_destination: 'RAZORPAY', reason: 'x' })) },
      { paymentsService: { refund: vi.fn(async () => ({ success: false, message: 'Razorpay down' })) } }
    )
    await expect(service.approve('rr1', asAdmin({ refundTo: 'RAZORPAY' }))).rejects.toMatchObject({ code: 'GATEWAY_REFUND_FAILED' })
    expect(repo.releaseClaim).toHaveBeenCalledWith('rr1', 'Razorpay down')
    expect(repo.finalize).not.toHaveBeenCalled()
  })

  it('partial Razorpay refunds do not flip the order inside PaymentsService', async () => {
    const paymentsRefund = vi.fn(async () => ({ success: true, refundId: 'rfnd_9' }))
    const { service } = makeService(
      { findPaymentForOrder: vi.fn(async () => ({ id: 'pay1', status: 'PAID', razorpay_payment_id: 'pay_x' })),
        claimForProcessing: vi.fn(async () => ({ id: 'rr1', order_id: 'o1', customer_id: CUSTOMER, shop_id: SHOP, scope: 'ITEMS', computed_amount: '90.00', refund_destination: 'RAZORPAY', reason: 'x' })) },
      { paymentsService: { refund: paymentsRefund } }
    )
    await service.approve('rr1', asAdmin({ refundTo: 'RAZORPAY' }))
    expect(paymentsRefund).toHaveBeenCalledWith('pay1', expect.objectContaining({ amount: 90, markOrderRefunded: false }))
  })

  it('only PENDING requests can be approved', async () => {
    const { service } = makeService({ findById: vi.fn(async () => ({ id: 'rr1', shop_id: SHOP, status: 'APPROVED' })) })
    await expect(service.approve('rr1', asAdmin())).rejects.toMatchObject({ code: 'REFUND_NOT_PENDING' })
  })
})

describe('reject / cancel', () => {
  it('reject finalizes REJECTED, notifies the customer, moves no money', async () => {
    const { service, repo, notifier, creditWallet } = makeService()
    await service.reject('rr1', asAdmin({ adminNotes: 'Not eligible' }))
    expect(repo.finalize).toHaveBeenCalledWith('rr1', expect.objectContaining({ status: 'REJECTED', adminNotes: 'Not eligible' }))
    expect(notifier.sendNotification).toHaveBeenCalledTimes(1)
    expect(creditWallet).not.toHaveBeenCalled()
  })

  it("a customer cannot cancel someone else's request", async () => {
    const { service } = makeService({
      cancelByCustomer: vi.fn(async () => null),
      findById: vi.fn(async () => ({ id: 'rr1', customer_id: 'other', status: 'PENDING' })),
    })
    await expect(service.cancel('rr1', asCustomer)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('cancelling a non-pending request explains why', async () => {
    const { service } = makeService({
      cancelByCustomer: vi.fn(async () => null),
      findById: vi.fn(async () => ({ id: 'rr1', customer_id: CUSTOMER, status: 'APPROVED' })),
    })
    await expect(service.cancel('rr1', asCustomer)).rejects.toMatchObject({ statusCode: 409, code: 'REFUND_NOT_CANCELLABLE' })
  })
})

describe('toCustomerView — the exact shape the mobile app parses', () => {
  const row = { id: 'rr1', order_id: 'o1', order_number: 'FC-1', scope: 'ITEMS', reason: 'spoiled', status: 'PROCESSING', computed_amount: '90.00', resolved_amount: null, refund_destination: 'WALLET', admin_notes: null, created_at: 'now', updated_at: 'now' }
  it('maps scope/status/amount and hides the transient PROCESSING state', () => {
    expect(toCustomerView(row)).toMatchObject({ item_scope: 'SPECIFIC', description: 'spoiled', status: 'PENDING', refund_amount: 90, refund_to: null })
  })
  it('exposes refund_to only once approved', () => {
    expect(toCustomerView({ ...row, status: 'APPROVED', resolved_amount: '90.00' })).toMatchObject({ status: 'APPROVED', refund_to: 'wallet', refund_amount: 90 })
    expect(toCustomerView({ ...row, status: 'APPROVED', refund_destination: 'RAZORPAY' }).refund_to).toBe('original')
  })
  it('null in, null out', () => { expect(toCustomerView(null)).toBeNull() })
})
