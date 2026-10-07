import { cacheDeletePattern } from '../../utils/cache.js'

/**
 * Reviews service — business logic for reviews
 */
export class ReviewsService {
  constructor(repository) {
    this.repository = repository
  }

  async getProductReviews(productId, { page, limit }) {
    const offset = (page - 1) * limit
    return await this.repository.getProductReviews(productId, { offset, limit })
  }

  async checkReviewEligibility(userId, productId) {
    return await this.repository.checkReviewEligibility(userId, productId)
  }

  async getReviewsByOrder(userId, orderId) {
    return await this.repository.getReviewsByOrder(userId, orderId)
  }

  // Product listing/detail responses are cached — recomputing the DB
  // columns alone would leave a customer looking at a stale cached rating
  // until the TTL expired. Mirrors the cache keys products.service.js
  // busts on any other product-affecting mutation.
  async _syncProductRating(productId) {
    await this.repository.recomputeProductRating(productId)
    await cacheDeletePattern(`products:detail:*:${productId}`)
    await cacheDeletePattern('products:list:*')
    await cacheDeletePattern('products:featured*')
  }

  async createReview(userId, { productId, orderId, rating, comment }) {
    // Validate rating
    if (rating < 1 || rating > 5) {
      throw { statusCode: 400, message: 'Rating must be between 1 and 5' }
    }

    // Check if user has purchased this product in the order
    const hasOrder = await this.repository.checkUserOrder(userId, orderId, productId)
    if (!hasOrder) {
      throw {
        statusCode: 400,
        message: 'You can only review products from orders that have been delivered to you',
      }
    }

    // Check if already reviewed
    const existingReview = await this.repository.getReviewByOrder(userId, orderId, productId)
    if (existingReview) {
      throw { statusCode: 400, message: 'You have already reviewed this product for this order' }
    }

    const review = await this.repository.createReview(userId, { productId, orderId, rating, comment })
    await this._syncProductRating(productId)
    return review
  }

  async updateReview(userId, reviewId, { rating, comment }) {
    if (rating && (rating < 1 || rating > 5)) {
      throw { statusCode: 400, message: 'Rating must be between 1 and 5' }
    }

    const review = await this.repository.getReviewById(reviewId)
    if (!review) {
      throw { statusCode: 404, message: 'Review not found' }
    }

    if (review.user_id !== userId) {
      throw { statusCode: 403, message: 'You can only update your own reviews' }
    }

    const updated = await this.repository.updateReview(reviewId, { rating, comment })
    if (rating !== undefined) {
      await this._syncProductRating(review.product_id)
    }
    return updated
  }

  async deleteReview(userId, reviewId) {
    const review = await this.repository.getReviewById(reviewId)
    if (!review) {
      throw { statusCode: 404, message: 'Review not found' }
    }

    if (review.user_id !== userId) {
      throw { statusCode: 403, message: 'You can only delete your own reviews' }
    }

    await this.repository.deleteReview(reviewId)
    await this._syncProductRating(review.product_id)
  }

  async getUserReviews(userId, { page, limit }) {
    const offset = (page - 1) * limit
    return await this.repository.getUserReviews(userId, { offset, limit })
  }
}
