import { success } from '../../utils/apiResponse.js'

/**
 * Wishlist controller — handles wishlist operations
 */
export class WishlistController {
  constructor(service) {
    this.service = service
  }

  /**
   * GET / — Get user's wishlist
   */
  async getWishlist(request, reply) {
    const wishlist = await this.service.getWishlist(request.user.id)
    return reply.code(200).send(success(wishlist, 'Wishlist fetched successfully'))
  }

  /**
   * POST /items — Add item to wishlist
   */
  async addItem(request, reply) {
    const { productId } = request.body
    const item = await this.service.addItem(request.user.id, productId)
    return reply.code(201).send(success(item, 'Item added to wishlist'))
  }

  /**
   * DELETE /items/:productId — Remove item from wishlist
   */
  async removeItem(request, reply) {
    const { productId } = request.params
    await this.service.removeItem(request.user.id, productId)
    return reply.code(200).send(success(null, 'Item removed from wishlist'))
  }

  /**
   * DELETE / — Clear wishlist
   */
  async clearWishlist(request, reply) {
    await this.service.clearWishlist(request.user.id)
    return reply.code(200).send(success(null, 'Wishlist cleared'))
  }

  /**
   * POST /move-to-cart — Move all wishlist items to cart
   */
  async moveToCart(request, reply) {
    const result = await this.service.moveToCart(request.user.id)
    return reply.code(200).send(success(result, 'Items moved to cart'))
  }
}
