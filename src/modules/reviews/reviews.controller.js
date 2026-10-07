import { success, error } from '../../utils/apiResponse.js'

/**
 * Reviews controller — handles product reviews
 */
export class ReviewsController {
  constructor(service) {
    this.service = service
  }

  /**
   * GET /products/:productId — Get reviews for a product
   */
  async getProductReviews(request, reply) {
    const { productId } = request.params
    const { page = 1, limit = 10 } = request.query
    const reviews = await this.service.getProductReviews(productId, { page, limit })
    return reply.code(200).send(success(reviews, 'Reviews fetched successfully'))
  }

  /**
   * GET /eligibility/:productId — Check whether current user can review a product
   */
  async checkReviewEligibility(request, reply) {
    const { productId } = request.params
    const eligibility = await this.service.checkReviewEligibility(request.user.id, productId)
    return reply.code(200).send(success(eligibility, 'Review eligibility fetched successfully'))
  }

  /**
   * GET /order/:orderId — Get the current user's existing reviews for one order
   */
  async getReviewsByOrder(request, reply) {
    const { orderId } = request.params
    const reviews = await this.service.getReviewsByOrder(request.user.id, orderId)
    return reply.code(200).send(success(reviews, 'Order reviews fetched successfully'))
  }

  /**
   * POST / — Create a review
   *
   * Previously had no try/catch at all — every validation failure the
   * service throws (wrong order status, duplicate review, bad rating)
   * fell through to Fastify's default handler and came back as a generic
   * "Internal server error" 500 with the real reason only visible in the
   * server logs, never in the response the customer's app actually saw.
   */
  async createReview(request, reply) {
    try {
      const { productId, orderId, rating, comment } = request.body
      const review = await this.service.createReview(request.user.id, {
        productId,
        orderId,
        rating,
        comment,
      })
      return reply.code(201).send(success(review, 'Review created successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Unable to create review'))
    }
  }

  /**
   * PATCH /:id — Update a review
   */
  async updateReview(request, reply) {
    try {
      const { id } = request.params
      const { rating, comment } = request.body
      const review = await this.service.updateReview(request.user.id, id, { rating, comment })
      return reply.code(200).send(success(review, 'Review updated successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Unable to update review'))
    }
  }

  /**
   * DELETE /:id — Delete a review
   */
  async deleteReview(request, reply) {
    try {
      const { id } = request.params
      await this.service.deleteReview(request.user.id, id)
      return reply.code(200).send(success(null, 'Review deleted successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Unable to delete review'))
    }
  }

  /**
   * GET /my-reviews — Get user's reviews
   */
  async getMyReviews(request, reply) {
    const { page = 1, limit = 10 } = request.query
    const reviews = await this.service.getUserReviews(request.user.id, { page, limit })
    return reply.code(200).send(success(reviews, 'Your reviews fetched successfully'))
  }
}
