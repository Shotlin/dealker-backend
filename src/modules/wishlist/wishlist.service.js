/**
 * Wishlist service — business logic for wishlist
 */
export class WishlistService {
  constructor(repository) {
    this.repository = repository
  }

  async getWishlist(userId) {
    return await this.repository.getWishlist(userId)
  }

  async addItem(userId, productId) {
    // Check if product exists and is available
    const product = await this.repository.getProduct(productId)
    if (!product) {
      throw new Error('Product not found')
    }
    if (!product.is_available) {
      throw new Error('Product is not available')
    }

    // Check if already in wishlist
    const exists = await this.repository.checkWishlistItem(userId, productId)
    if (exists) {
      throw new Error('Product already in wishlist')
    }

    return await this.repository.addItem(userId, productId)
  }

  async removeItem(userId, productId) {
    return await this.repository.removeItem(userId, productId)
  }

  async clearWishlist(userId) {
    return await this.repository.clearWishlist(userId)
  }

  async moveToCart(userId) {
    const wishlistItems = await this.repository.getWishlist(userId)
    
    if (wishlistItems.items.length === 0) {
      return { movedCount: 0 }
    }

    const movedCount = await this.repository.moveToCart(userId, wishlistItems.items)
    await this.repository.clearWishlist(userId)

    return { movedCount }
  }
}
