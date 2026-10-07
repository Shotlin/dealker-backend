import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrdersService } from '../../../src/modules/orders/orders.service.js'

describe('Phase 8 Orders 17-State Machine & Fulfilment Unit Tests', () => {
  let repositoryMock
  let quoteRepoMock
  let service

  beforeEach(() => {
    repositoryMock = {
      createOrder: vi.fn(),
      addOrderItem: vi.fn(),
      findOrderById: vi.fn(),
      findOrderByNumber: vi.fn(),
      updateOrderStatus: vi.fn(),
      logStatusTransition: vi.fn(),
      createFulfilmentTask: vi.fn(),
      updateFulfilmentTaskStatus: vi.fn(),
      logAudit: vi.fn(),
      listOrders: vi.fn(),
    }
    quoteRepoMock = {
      findQuoteByNumber: vi.fn(),
    }
    service = new OrdersService(repositoryMock, quoteRepoMock)
  })

  describe('Order Creation from Checkout Quote', () => {
    it('creates order from valid checkout quote preserving price snapshots', async () => {
      const futureExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString()
      quoteRepoMock.findQuoteByNumber.mockResolvedValueOnce({
        id: 'q-1',
        quote_number: 'Q-100',
        customer_id: 'c-1',
        expires_at: futureExpiry,
        subtotal: 500,
        discount_amount: 50,
        loyalty_redeemed_amount: 20,
        tax_amount: 21.5,
        total_payable: 451.5,
        cart_snapshot: {
          items: [{ product_id: 'p-1', name: 'Fresh Meat', quantity: 2, unit_price: 250, subtotal: 500 }],
        },
      })
      repositoryMock.createOrder.mockResolvedValueOnce({ id: 'ord-1', order_number: 'ORD-100', status: 'ORDER_PLACED' })
      repositoryMock.addOrderItem.mockResolvedValueOnce({ id: 'oi-1', product_name: 'Fresh Meat', subtotal: 500 })

      const order = await service.createOrderFromQuote('c-1', { quote_number: 'Q-100' })

      expect(repositoryMock.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({ customer_id: 'c-1', total_payable: 451.5, status: 'ORDER_PLACED' })
      )
      expect(repositoryMock.addOrderItem).toHaveBeenCalledWith(
        'ord-1',
        expect.objectContaining({ product_name: 'Fresh Meat', unit_price: 250 })
      )
      expect(order.id).toBe('ord-1')
    })

    it('rejects order creation if quote belongs to different customer (403 CROSS_CUSTOMER_ACCESS_DENIED)', async () => {
      quoteRepoMock.findQuoteByNumber.mockResolvedValueOnce({ id: 'q-1', customer_id: 'c-other', expires_at: new Date(Date.now() + 1000).toISOString() })

      await expect(service.createOrderFromQuote('c-1', { quote_number: 'Q-100' })).rejects.toThrow('Forbidden')
    })

    it('rejects order creation from expired quote (400 QUOTE_EXPIRED)', async () => {
      const pastExpiry = new Date(Date.now() - 1000).toISOString()
      quoteRepoMock.findQuoteByNumber.mockResolvedValueOnce({ id: 'q-1', customer_id: 'c-1', expires_at: pastExpiry })

      await expect(service.createOrderFromQuote('c-1', { quote_number: 'Q-OLD' })).rejects.toThrow('Checkout quote has expired')
    })
  })

  describe('17-State Machine Workflow', () => {
    it('executes valid state transition ORDER_PLACED -> PAYMENT_PENDING', async () => {
      repositoryMock.findOrderById.mockResolvedValueOnce({ id: 'ord-1', status: 'ORDER_PLACED' })
      repositoryMock.updateOrderStatus.mockResolvedValueOnce({ id: 'ord-1', status: 'PAYMENT_PENDING' })

      const updated = await service.transitionOrderStatus('ord-1', 'admin-1', 'PAYMENT_PENDING')

      expect(repositoryMock.updateOrderStatus).toHaveBeenCalledWith('ord-1', 'PAYMENT_PENDING')
      expect(updated.status).toBe('PAYMENT_PENDING')
    })

    it('rejects invalid state transition ORDER_PLACED -> DELIVERED with 400 INVALID_ORDER_TRANSITION', async () => {
      repositoryMock.findOrderById.mockResolvedValueOnce({ id: 'ord-1', status: 'ORDER_PLACED' })

      await expect(service.transitionOrderStatus('ord-1', 'admin-1', 'DELIVERED')).rejects.toThrow('Invalid order transition')
    })

    it('rejects state transition on COMPLETED order with 400 ORDER_IMMUTABLE_LOCKED', async () => {
      repositoryMock.findOrderById.mockResolvedValueOnce({ id: 'ord-1', status: 'COMPLETED' })

      await expect(service.transitionOrderStatus('ord-1', 'admin-1', 'CANCELLED')).rejects.toThrow('cannot be modified')
    })
  })

  describe('Fulfilment Tasks (Picking & Packing)', () => {
    it('creates picking task and updates status', async () => {
      repositoryMock.findOrderById.mockResolvedValueOnce({ id: 'ord-1', status: 'STOCK_RESERVED' })
      repositoryMock.createFulfilmentTask.mockResolvedValueOnce({ id: 'task-1', task_type: 'PICKING', status: 'PENDING' })
      repositoryMock.updateFulfilmentTaskStatus.mockResolvedValueOnce({ id: 'task-1', task_type: 'PICKING', status: 'COMPLETED' })

      const task = await service.createFulfilmentTask('ord-1', 'picker-1', { task_type: 'PICKING' })
      expect(task.task_type).toBe('PICKING')

      const updatedTask = await service.updateFulfilmentTaskStatus('task-1', 'picker-1', 'COMPLETED', 'All items picked')
      expect(updatedTask.status).toBe('COMPLETED')
    })
  })
})
