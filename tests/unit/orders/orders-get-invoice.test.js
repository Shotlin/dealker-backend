import { describe, expect, it, vi } from 'vitest'

// Regression test: `findById` returns the camelCase shape from
// OrdersRepository._format() (userId, paymentStatus), not raw snake_case
// columns. getInvoice used to compare against order.user_id/payment_status,
// which are always undefined on that shape — every invoice request failed
// with "Access denied" regardless of who owned the order or whether it was
// paid. These tests pin the fix to the actual camelCase fields.
vi.mock('pdfkit', () => ({
  default: class FakePDFDocument {
    constructor() {
      this._handlers = {}
    }
    on(event, handler) {
      this._handlers[event] = handler
      if (event === 'end') {
        // Fire synchronously enough for the promise in generateInvoicePDF
        // to resolve once `end()` is called below.
      }
      return this
    }
    fontSize() { return this }
    font() { return this }
    text() { return this }
    moveDown() { return this }
    moveTo() { return this }
    lineTo() { return this }
    stroke() { return this }
    rect() { return this }
    fillAndStroke() { return this }
    fillColor() { return this }
    strokeColor() { return this }
    addPage() { return this }
    registerFont() { return this }
    image() { return this }
    widthOfString() { return 10 }
    heightOfString() { return 10 }
    get page() { return { width: 595, height: 842 } }
    get y() { return 0 }
    set y(_v) {}
    end() {
      this._handlers.data?.(Buffer.from('%PDF-fake'))
      this._handlers.end?.()
    }
  },
}))

const { OrdersService } = await import('../../../src/modules/orders/orders.service.js')

function makeOrder(overrides = {}) {
  return {
    id: 'order-1',
    orderNumber: 'BKLOO-20260705-003',
    userId: 'user-1',
    status: 'DELIVERED',
    items: [{ name: 'Onion', quantity: 1, price: 13, total: 13 }],
    paymentMethod: 'COD',
    paymentStatus: 'PAID',
    deliveryAddress: { label: 'Home', addressLine1: 'P. R. Thakur Sarani', city: 'Chikanpara', pincode: '743287' },
    subtotal: 13,
    discountAmount: 0,
    deliveryFee: 39,
    taxAmount: 0,
    totalAmount: 61.36,
    createdAt: '2026-07-05T20:13:00.000Z',
    ...overrides,
  }
}

function makeRepository(overrides = {}) {
  return {
    findById: vi.fn(async () => makeOrder()),
    getStatusHistory: vi.fn(async () => []),
    ...overrides,
  }
}

describe('OrdersService.getInvoice', () => {
  it('succeeds for the order owner on a paid order', async () => {
    const repository = makeRepository()
    const service = new OrdersService(repository)

    const result = await service.getInvoice('user-1', 'order-1')

    expect(result.success).toBe(true)
    expect(result.orderNumber).toBe('BKLOO-20260705-003')
    expect(Buffer.isBuffer(result.buffer)).toBe(true)
  })

  it('rejects a different user with 403 Access denied (not a false positive from undefined fields)', async () => {
    const repository = makeRepository({ findById: vi.fn(async () => makeOrder({ userId: 'someone-else' })) })
    const service = new OrdersService(repository)

    const result = await service.getInvoice('user-1', 'order-1')

    expect(result).toMatchObject({ success: false, statusCode: 403, message: 'Access denied' })
  })

  it('rejects an unpaid order with 400 even for the actual owner', async () => {
    const repository = makeRepository({ findById: vi.fn(async () => makeOrder({ paymentStatus: 'PENDING' })) })
    const service = new OrdersService(repository)

    const result = await service.getInvoice('user-1', 'order-1')

    expect(result).toMatchObject({
      success: false,
      statusCode: 400,
      message: 'Invoice available only for paid orders',
    })
  })

  it('returns 404 when the order does not exist', async () => {
    const repository = makeRepository({ findById: vi.fn(async () => null) })
    const service = new OrdersService(repository)

    const result = await service.getInvoice('user-1', 'missing-order')

    expect(result).toMatchObject({ success: false, statusCode: 404, message: 'Order not found' })
  })
})
