import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../../../src/config/database.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }))
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../../src/plugins/socketio.plugin.js', () => ({ getSocketIo: vi.fn(() => null) }))
vi.mock('../../../src/plugins/socket-emitter.js', () => ({ getSocketEmitter: vi.fn(() => ({ to: vi.fn() })) }))

const ev = await import('../../../src/modules/orders/order-events.js')

function fakeIo() {
  const emit = vi.fn()
  const to = vi.fn(() => ({ emit }))
  return { io: { to }, to, emit }
}

describe('order-events — sequencing & payloads', () => {
  it('nextEventSeq is strictly increasing even inside one millisecond', () => {
    const seqs = Array.from({ length: 500 }, () => ev.nextEventSeq(1_700_000_000_000))
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
  })

  it('builds an order:status payload with eventId + seq and the authoritative status', () => {
    const p = ev.buildOrderStatusPayload({ orderId: 'o1', orderNumber: 'FC-1', status: 'DELIVERED', shopId: 's1' }, 42)
    expect(p).toMatchObject({ orderId: 'o1', status: 'DELIVERED', timelineType: 'DELIVERED', shopId: 's1', seq: 42, eventId: 'order:o1:42' })
  })

  it('targets customer, rider, order room, the shop room and HQ — once each', () => {
    const rooms = ev.orderEventRooms({ orderId: 'o1', customerId: 'c1', riderId: 'r1', shopId: 's1' })
    expect(rooms.sort()).toEqual(['admin:dashboard', 'order:o1', 'shop:s1', 'user:c1', 'user:r1'])
    expect(ev.orderEventRooms({ orderId: 'o1', customerId: 'c1' })).not.toContain('shop:undefined')
  })

  it('publishOrderStatus sends ONE multi-room emit (a customer is in two of the rooms)', () => {
    const { io, to, emit } = fakeIo()
    ev.publishOrderStatus({ id: 'o1', order_number: 'FC-1', customer_id: 'c1', shop_id: 's1' }, 'PACKED', { io })
    expect(to).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(Array.isArray(to.mock.calls[0][0])).toBe(true)
    expect(emit.mock.calls[0][0]).toBe('order:status')
    expect(emit.mock.calls[0][1]).toMatchObject({ orderId: 'o1', status: 'PACKED', shopId: 's1' })
  })

  it('publishOrderStatus never throws when the socket layer blows up', () => {
    const io = { to: () => { throw new Error('redis down') } }
    expect(() => ev.publishOrderStatus({ id: 'o1', customer_id: 'c1' }, 'PACKED', { io })).not.toThrow()
  })

  it('refund payload shows PROCESSING as PENDING and carries the customer-visible amount', () => {
    const { io, emit } = fakeIo()
    ev.publishRefundStatus({
      id: 'r1', order_id: 'o1', order_number: 'FC-1', customer_id: 'c1', shop_id: 's1',
      status: 'PROCESSING', computed_amount: '90.00', resolved_amount: null, refund_destination: 'WALLET',
    }, { io, event: 'REFUND_REQUESTED' })
    expect(emit.mock.calls[0][0]).toBe('refund:status')
    expect(emit.mock.calls[0][1]).toMatchObject({ refundRequestId: 'r1', status: 'PENDING', amount: 90, event: 'REFUND_REQUESTED' })
  })
})
