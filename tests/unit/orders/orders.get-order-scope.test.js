import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { OrdersService } from '../../../src/modules/orders/orders.service.js'

const OWNER = 'user-owner'
const ORDER = { id: 'o1', customer_id: OWNER, shop_id: 'shop-1', status: 'OUT_FOR_DELIVERY' }

function makeService(repositoryOverrides = {}) {
  const repository = {
    findOrderById: vi.fn().mockResolvedValue(ORDER),
    getActiveDeliveryOtp: vi.fn().mockResolvedValue('4821'),
    getActiveOrder: vi.fn().mockResolvedValue({ id: 'o1', status: 'OUT_FOR_DELIVERY' }),
    ...repositoryOverrides,
  }
  return { service: new OrdersService(repository, {}), repository }
}

describe('OrdersService.getOrderById — read scope', () => {
  let service
  beforeEach(() => {
    ;({ service } = makeService())
  })

  it('returns the order to its owner, with the delivery OTP while out for delivery', async () => {
    const order = await service.getOrderById('o1', { userId: OWNER })
    expect(order.id).toBe('o1')
    expect(order.deliveryOtp).toBe('4821')
  })

  it('does not attach an OTP before the rider is on the way', async () => {
    const { service: s } = makeService({ findOrderById: vi.fn().mockResolvedValue({ ...ORDER, status: 'PACKED' }) })
    const order = await s.getOrderById('o1', { userId: OWNER })
    expect(order.deliveryOtp).toBeUndefined()
  })

  it('404s another customer (no existence leak)', async () => {
    await expect(service.getOrderById('o1', { userId: 'someone-else' }))
      .rejects.toMatchObject({ statusCode: 404, code: 'ORDER_NOT_FOUND' })
  })

  it('lets platform staff read it, but never attaches the customer OTP for them', async () => {
    const order = await service.getOrderById('o1', { userId: 'admin-1', isPlatformStaff: true })
    expect(order.id).toBe('o1')
    expect(order.deliveryOtp).toBeUndefined()
  })

  it('lets staff of the order\'s own shop read it, but not another shop\'s staff', async () => {
    await expect(service.getOrderById('o1', { userId: 's1', shopId: 'shop-1' })).resolves.toBeTruthy()
    await expect(service.getOrderById('o1', { userId: 's2', shopId: 'shop-2' }))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('stays unscoped for trusted internal callers that pass no viewer', async () => {
    await expect(service.getOrderById('o1')).resolves.toMatchObject({ id: 'o1' })
  })
})

describe('OrdersService.getActiveOrder', () => {
  it('attaches the OTP for the owner\'s out-for-delivery order', async () => {
    const { service } = makeService()
    const order = await service.getActiveOrder(OWNER)
    expect(order.deliveryOtp).toBe('4821')
  })

  it('returns null when there is no active order', async () => {
    const { service } = makeService({ getActiveOrder: vi.fn().mockResolvedValue(null) })
    await expect(service.getActiveOrder(OWNER)).resolves.toBeNull()
  })

  it('never fails the fetch when the OTP lookup errors', async () => {
    const { service } = makeService({ getActiveDeliveryOtp: vi.fn().mockRejectedValue(new Error('db down')) })
    const order = await service.getActiveOrder(OWNER)
    expect(order.id).toBe('o1')
    expect(order.deliveryOtp).toBeUndefined()
  })
})
