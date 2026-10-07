/**
 * Cart, Loyalty & Quote Controller — HTTP Handlers
 * Source of truth: Blueprint §06.6, Phase 7
 *
 * @module modules/cart-quote/cart-quote.controller
 */

export class CartQuoteController {
  /**
   * @param {import('./cart-quote.service.js').CartQuoteService} service
   */
  constructor(service) {
    this.service = service
  }

  getCart = async (req, reply) => {
    const customerId = req.userId || req.user.id
    const cart = await this.service.getCart(customerId)
    return reply.status(200).send({ success: true, data: cart })
  }

  addItem = async (req, reply) => {
    const customerId = req.userId || req.user.id
    const cart = await this.service.addItem(customerId, req.body)
    return reply.status(200).send({ success: true, data: cart })
  }

  updateItemQuantity = async (req, reply) => {
    const customerId = req.userId || req.user.id
    const { productId } = req.params
    const cart = await this.service.updateItemQuantity(customerId, productId, req.body.quantity)
    return reply.status(200).send({ success: true, data: cart })
  }

  removeItem = async (req, reply) => {
    const customerId = req.userId || req.user.id
    const { productId } = req.params
    const cart = await this.service.removeItem(customerId, productId)
    return reply.status(200).send({ success: true, data: cart })
  }

  clearCart = async (req, reply) => {
    const customerId = req.userId || req.user.id
    const result = await this.service.clearCart(customerId)
    return reply.status(200).send({ success: true, data: result })
  }

  getLoyaltyHistory = async (req, reply) => {
    const customerId = req.userId || req.user.id
    const history = await this.service.getLoyaltyHistory(customerId)
    return reply.status(200).send({ success: true, data: history })
  }

  processLoyaltyTransaction = async (req, reply) => {
    const customerId = req.userId || req.user.id
    const tx = await this.service.processLoyaltyTransaction(customerId, req.body)
    return reply.status(201).send({ success: true, data: tx })
  }

  generateCheckoutQuote = async (req, reply) => {
    const customerId = req.userId || req.user.id
    const quote = await this.service.generateCheckoutQuote(customerId, req.body)
    return reply.status(201).send({ success: true, data: quote })
  }

  getQuoteByNumber = async (req, reply) => {
    const { quoteNumber } = req.params
    const quote = await this.service.getQuoteByNumber(quoteNumber)
    return reply.status(200).send({ success: true, data: quote })
  }
}
