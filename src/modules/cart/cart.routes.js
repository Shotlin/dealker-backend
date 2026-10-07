import { CartController } from './cart.controller.js'
import { CartService } from './cart.service.js'
import { CartRepository } from './cart.repository.js'
import { BillSummaryService } from './bill-summary.service.js'
import { PaymentSettingsService } from '../payment-settings/payment-settings.service.js'
import { ProductsService } from '../products/products.service.js'
import { ProductsRepository } from '../products/products.repository.js'
import {
  getCartSchema,
  addItemSchema,
  updateItemSchema,
  removeItemSchema,
  clearCartSchema,
  validateCartSchema,
  getCartSummarySchema,
  getQuickAddSchema,
  updateTipSchema,
  updateDeliveryInstructionsSchema,
} from './cart.schema.js'

/**
 * Cart routes plugin
 * Prefix: /api/v1/cart
 * All routes require authentication
 */
export default async function cartRoutes(fastify) {
  const repository = new CartRepository()
  const service = new CartService(repository, { fastify })
  const paymentSettingsService = new PaymentSettingsService()
  const billSummaryService = new BillSummaryService({
    cartService: service,
    cartRepository: repository,
    paymentSettingsService,
  })
  const productsService = new ProductsService(new ProductsRepository())
  const controller = new CartController(service, billSummaryService, repository, productsService)

  // All cart routes require auth
  fastify.addHook('preHandler', fastify.authenticate)

  // GET / — Get current cart
  fastify.get('/', {
    schema: getCartSchema,
  }, controller.get.bind(controller))

  // GET /summary — Full bill breakdown
  fastify.get('/summary', {
    schema: getCartSummarySchema,
  }, controller.getSummary.bind(controller))

  // GET /quick-add — "Quick Add" rail suggestions based on cart contents
  fastify.get('/quick-add', {
    schema: getQuickAddSchema,
  }, controller.getQuickAdd.bind(controller))

  // POST /items — Add item to cart
  fastify.post('/items', {
    schema: addItemSchema,
  }, controller.addItem.bind(controller))

  // PUT /items/:productId — Update quantity
  fastify.put('/items/:productId', {
    schema: updateItemSchema,
  }, controller.updateItem.bind(controller))

  // DELETE /items/:productId — Remove item
  fastify.delete('/items/:productId', {
    schema: removeItemSchema,
  }, controller.removeItem.bind(controller))

  // DELETE / — Clear cart
  fastify.delete('/', {
    schema: clearCartSchema,
  }, controller.clear.bind(controller))

  // POST /validate — Validate cart before checkout
  fastify.post('/validate', {
    schema: validateCartSchema,
  }, controller.validate.bind(controller))

  // PUT /tip — Save tip amount
  fastify.put('/tip', {
    schema: updateTipSchema,
  }, controller.updateTip.bind(controller))

  // PUT /delivery-instructions — Save delivery instructions
  fastify.put('/delivery-instructions', {
    schema: updateDeliveryInstructionsSchema,
  }, controller.updateInstructions.bind(controller))
}
