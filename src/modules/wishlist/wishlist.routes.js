import { WishlistController } from './wishlist.controller.js'
import { WishlistService } from './wishlist.service.js'
import { WishlistRepository } from './wishlist.repository.js'
import {
  getWishlistSchema,
  addItemSchema,
  removeItemSchema,
  clearWishlistSchema,
  moveToCartSchema,
} from './wishlist.schema.js'

/**
 * Wishlist routes plugin
 * Prefix: /api/v1/wishlist
 */
export default async function wishlistRoutes(fastify) {
  const repository = new WishlistRepository()
  const service = new WishlistService(repository)
  const controller = new WishlistController(service)

  // GET / — Get wishlist
  fastify.get('/', {
    schema: getWishlistSchema,
    preHandler: [fastify.authenticate],
  }, controller.getWishlist.bind(controller))

  // POST /items — Add item to wishlist
  fastify.post('/items', {
    schema: addItemSchema,
    preHandler: [fastify.authenticate],
  }, controller.addItem.bind(controller))

  // DELETE /items/:productId — Remove item
  fastify.delete('/items/:productId', {
    schema: removeItemSchema,
    preHandler: [fastify.authenticate],
  }, controller.removeItem.bind(controller))

  // DELETE / — Clear wishlist
  fastify.delete('/', {
    schema: clearWishlistSchema,
    preHandler: [fastify.authenticate],
  }, controller.clearWishlist.bind(controller))

  // POST /move-to-cart — Move to cart
  fastify.post('/move-to-cart', {
    schema: moveToCartSchema,
    preHandler: [fastify.authenticate],
  }, controller.moveToCart.bind(controller))
}
