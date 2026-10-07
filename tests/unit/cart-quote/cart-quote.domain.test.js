import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CartQuoteService } from '../../../src/modules/cart-quote/cart-quote.service.js'

describe('Phase 7 Cart, Loyalty Ledger & Checkout Quote Unit Tests', () => {
  let repositoryMock
  let service

  beforeEach(() => {
    repositoryMock = {
      findOrCreateCart: vi.fn(),
      getCartWithItems: vi.fn(),
      addOrUpdateCartItem: vi.fn(),
      updateCartItemQuantity: vi.fn(),
      removeCartItem: vi.fn(),
      clearCart: vi.fn(),
      findProductById: vi.fn(),
      findOrCreateLoyaltyAccount: vi.fn(),
      findLoyaltyTxByIdempotencyKey: vi.fn(),
      writeLoyaltyTransaction: vi.fn(),
      getLoyaltyHistory: vi.fn(),
      createQuote: vi.fn(),
      findQuoteByNumber: vi.fn(),
    }
    service = new CartQuoteService(repositoryMock)
  })

  describe('Customer Cart & Availability', () => {
    it('adds item to cart with product price snapshot', async () => {
      repositoryMock.findProductById.mockResolvedValueOnce({ id: 'p-1', name: 'Fresh Cut Pork', price: 250, status: 'ACTIVE' })
      repositoryMock.findOrCreateCart.mockResolvedValueOnce({ id: 'cart-1', customer_id: 'c-1' })
      repositoryMock.getCartWithItems.mockResolvedValueOnce({ id: 'cart-1', items: [{ product_id: 'p-1', quantity: 2, unit_price: 250 }] })

      const cart = await service.addItem('c-1', { product_id: 'p-1', quantity: 2 })

      expect(repositoryMock.addOrUpdateCartItem).toHaveBeenCalledWith(
        'cart-1',
        'p-1',
        2,
        250,
        expect.objectContaining({ name: 'Fresh Cut Pork', unit_price: 250 })
      )
      expect(cart.items).toHaveLength(1)
    })

    it('rejects adding inactive/unavailable product with 400 UNAVAILABLE_PRODUCT_REJECTED', async () => {
      repositoryMock.findProductById.mockResolvedValueOnce({ id: 'p-inactive', status: 'INACTIVE' })

      await expect(service.addItem('c-1', { product_id: 'p-inactive', quantity: 1 })).rejects.toThrow(
        'Product is unavailable or out of stock'
      )
    })

    it('removes item from cart cleanly', async () => {
      repositoryMock.findOrCreateCart.mockResolvedValueOnce({ id: 'cart-1' })
      repositoryMock.removeCartItem.mockResolvedValueOnce(true)
      repositoryMock.getCartWithItems.mockResolvedValueOnce({ id: 'cart-1', items: [] })

      const cart = await service.removeItem('c-1', 'p-1')
      expect(repositoryMock.removeCartItem).toHaveBeenCalledWith('cart-1', 'p-1')
      expect(cart.items).toHaveLength(0)
    })
  })

  describe('Loyalty Ledger', () => {
    it('records EARN loyalty transaction and updates balance', async () => {
      repositoryMock.findOrCreateLoyaltyAccount.mockResolvedValueOnce({ id: 'acc-1', points_balance: 50 })
      repositoryMock.writeLoyaltyTransaction.mockResolvedValueOnce({ id: 'tx-1', transaction_type: 'EARN', points: 100, balance_after: 150 })

      const tx = await service.processLoyaltyTransaction('c-1', { transaction_type: 'EARN', points: 100 })

      expect(repositoryMock.writeLoyaltyTransaction).toHaveBeenCalledWith('acc-1', 'EARN', 100, 150, null, null)
      expect(tx.balance_after).toBe(150)
    })

    it('skips duplicate transaction when idempotency key exists', async () => {
      repositoryMock.findLoyaltyTxByIdempotencyKey.mockResolvedValueOnce({ id: 'tx-dup', idempotency_key: 'KEY-123' })

      const tx = await service.processLoyaltyTransaction('c-1', {
        transaction_type: 'EARN',
        points: 50,
        idempotency_key: 'KEY-123',
      })

      expect(repositoryMock.writeLoyaltyTransaction).not.toHaveBeenCalled()
      expect(tx.id).toBe('tx-dup')
    })

    it('rejects REDEEM when loyalty balance is insufficient (400 INSUFFICIENT_LOYALTY_BALANCE)', async () => {
      repositoryMock.findOrCreateLoyaltyAccount.mockResolvedValueOnce({ id: 'acc-1', points_balance: 20 })

      await expect(
        service.processLoyaltyTransaction('c-1', { transaction_type: 'REDEEM', points: 100 })
      ).rejects.toThrow('Insufficient loyalty balance')
    })
  })

  describe('Checkout Quote Engine', () => {
    it('generates checkout quote with subtotal, tax, and discount snapshots', async () => {
      repositoryMock.getCartWithItems.mockResolvedValueOnce({
        id: 'cart-1',
        items: [{ product_id: 'p-1', product_name: 'Pork Chops', quantity: 2, unit_price: 200 }],
      })
      repositoryMock.createQuote.mockResolvedValueOnce({
        quote_number: 'Q-100',
        subtotal: 400,
        tax_amount: 20,
        total_payable: 420,
      })

      const quote = await service.generateCheckoutQuote('c-1')

      expect(repositoryMock.createQuote).toHaveBeenCalledWith(
        expect.objectContaining({
          subtotal: 400,
          tax_amount: 20,
          total_payable: 420,
        })
      )
      expect(quote.quote_number).toBe('Q-100')
    })

    it('rejects quote generation for empty cart (400 EMPTY_CART_QUOTE_REJECTED)', async () => {
      repositoryMock.getCartWithItems.mockResolvedValueOnce({ id: 'cart-1', items: [] })

      await expect(service.generateCheckoutQuote('c-1')).rejects.toThrow('Cart is empty')
    })

    it('rejects retrieval of expired quote (400 QUOTE_EXPIRED)', async () => {
      const pastExpiry = new Date(Date.now() - 1000).toISOString()
      repositoryMock.findQuoteByNumber.mockResolvedValueOnce({ quote_number: 'Q-OLD', expires_at: pastExpiry })

      await expect(service.getQuoteByNumber('Q-OLD')).rejects.toThrow('Checkout quote has expired')
    })
  })
})
