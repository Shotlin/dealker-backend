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

    // New reviews wait for moderation; only PUBLISHED ones are shown and counted.
    const autoPublish = await this.repository.getAutoPublish()
    const status = autoPublish ? 'PUBLISHED' : 'SUBMITTED'
    const review = await this.repository.createReview(userId, { productId, orderId, rating, comment, status })
    if (autoPublish) await this._syncProductRating(productId)
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

    // A hidden or removed review is the platform's decision; the customer can't bring it back by editing.
    if (['HIDDEN', 'REMOVED'].includes(review.status)) {
      throw { statusCode: 403, message: 'This review can no longer be edited' }
    }
    if (rating === undefined && comment === undefined) return review

    // Edited text/rating goes back through moderation (otherwise an approved
    // review could be swapped for anything). Unchanged content keeps its state.
    const changed = (rating !== undefined && rating !== review.rating) ||
      (comment !== undefined && (comment || null) !== (review.comment || null))
    let status
    if (changed) status = (await this.repository.getAutoPublish()) ? 'PUBLISHED' : 'SUBMITTED'

    const updated = await this.repository.updateReview(reviewId, { rating, comment, status })
    if (changed) await this._syncProductRating(review.product_id)
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

    // Deleting would free the one-review-per-order slot and dodge a moderation decision.
    if (['HIDDEN', 'REMOVED'].includes(review.status)) {
      throw { statusCode: 403, message: 'This review can no longer be deleted' }
    }

    await this.repository.deleteReview(reviewId)
    await this._syncProductRating(review.product_id)
  }

  async getUserReviews(userId, { page, limit }) {
    const offset = (page - 1) * limit
    return await this.repository.getUserReviews(userId, { offset, limit })
  }

  // ── vendor (shop) reviews ───────────────────────────────────────────────

  async getVendorReviews(vendorId, { page, limit }) {
    const offset = (page - 1) * limit
    return await this.repository.getVendorReviews(vendorId, { offset, limit })
  }

  async getVendorReviewsByOrder(userId, orderId) {
    return await this.repository.getVendorReviewsByOrder(userId, orderId)
  }

  async createVendorReview(userId, { vendorId, orderId, rating, comment }) {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw { statusCode: 400, message: 'Rating must be a whole number between 1 and 5' }
    }
    const received = await this.repository.checkUserVendorOrder(userId, orderId, vendorId)
    if (!received) {
      throw { statusCode: 400, message: 'You can only review a seller after receiving an order from them' }
    }
    if (await this.repository.getVendorReviewByOrder(userId, orderId, vendorId)) {
      throw { statusCode: 400, message: 'You have already reviewed this seller for this order' }
    }
    const autoPublish = await this.repository.getAutoPublish()
    const review = await this.repository.createVendorReview(userId, {
      vendorId, orderId, rating, comment, status: autoPublish ? 'PUBLISHED' : 'SUBMITTED',
    })
    if (autoPublish) await this.repository.recomputeVendorRating(vendorId)
    return review
  }

  // ── reports ──────────────────────────────────────────────────────────────

  async reportReview(userId, kind, reviewId, reason) {
    const text = String(reason || '').trim()
    if (text.length < 3) throw { statusCode: 400, message: 'Please tell us what is wrong with this review' }
    if (text.length > 500) throw { statusCode: 400, message: 'Reason is too long (max 500 characters)' }
    const res = await this.repository.reportReview(kind, reviewId, userId, text)
    if (!res.found) throw { statusCode: 404, message: 'Review not found' }
    if (res.own) throw { statusCode: 400, message: 'You cannot report your own review' }
    return { reported: true }
  }
}
