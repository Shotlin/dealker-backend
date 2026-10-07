/**
 * Cart, Loyalty & Quote Routes — Fastify Plugin
 * Source of truth: Blueprint §06.6, Phase 7
 *
 * @module modules/cart-quote/cart-quote.routes
 */

import { CartQuoteRepository } from './cart-quote.repository.js'
import { CartQuoteService } from './cart-quote.service.js'
import { CartQuoteController } from './cart-quote.controller.js'
import { AddCartItemSchema, UpdateCartItemSchema, LoyaltyTransactionSchema, GenerateQuoteSchema } from './cart-quote.schema.js'

export async function cartQuoteRoutes(fastify) {
  const repository = new CartQuoteRepository()
  const service = new CartQuoteService(repository)
  const controller = new CartQuoteController(service)

  // 1. Customer Cart
  fastify.get('/cart', {
    preHandler: [fastify.authenticate],
    handler: controller.getCart,
  })

  fastify.post('/cart/items', {
    preHandler: [fastify.authenticate],
    schema: { body: AddCartItemSchema },
    handler: controller.addItem,
  })

  fastify.patch('/cart/items/:productId', {
    preHandler: [fastify.authenticate],
    schema: { body: UpdateCartItemSchema },
    handler: controller.updateItemQuantity,
  })

  fastify.delete('/cart/items/:productId', {
    preHandler: [fastify.authenticate],
    handler: controller.removeItem,
  })

  fastify.delete('/cart', {
    preHandler: [fastify.authenticate],
    handler: controller.clearCart,
  })

  // 2. Loyalty Ledger
  fastify.get('/loyalty', {
    preHandler: [fastify.authenticate],
    handler: controller.getLoyaltyHistory,
  })

  fastify.post('/loyalty/transactions', {
    preHandler: [fastify.authenticate],
    schema: { body: LoyaltyTransactionSchema },
    handler: controller.processLoyaltyTransaction,
  })

  // 3. Checkout Quote Engine
  fastify.post('/checkout/quote', {
    preHandler: [fastify.authenticate],
    schema: { body: GenerateQuoteSchema },
    handler: controller.generateCheckoutQuote,
  })

  fastify.get('/checkout/quote/:quoteNumber', {
    preHandler: [fastify.authenticate],
    handler: controller.getQuoteByNumber,
  })
}

export default cartQuoteRoutes
