import { ReviewsController } from './reviews.controller.js'
import { ReviewsService } from './reviews.service.js'
import { ReviewsRepository } from './reviews.repository.js'
import {
  getProductReviewsSchema,
  checkReviewEligibilitySchema,
  getOrderReviewsSchema,
  createReviewSchema,
  updateReviewSchema,
  deleteReviewSchema,
  getMyReviewsSchema,
  getVendorReviewsSchema,
  getVendorOrderReviewsSchema,
  createVendorReviewSchema,
  reportReviewSchema,
} from './reviews.schema.js'

/**
 * Reviews routes plugin
 * Prefix: /api/v1/reviews
 */
export default async function reviewsRoutes(fastify) {
  const repository = new ReviewsRepository()
  const service = new ReviewsService(repository)
  const controller = new ReviewsController(service)

  // GET /products/:productId — Get product reviews
  fastify.get('/products/:productId', {
    schema: getProductReviewsSchema,
  }, controller.getProductReviews.bind(controller))

  // GET /eligibility/:productId — Check whether current user can review
  fastify.get('/eligibility/:productId', {
    schema: checkReviewEligibilitySchema,
    preHandler: [fastify.authenticate],
  }, controller.checkReviewEligibility.bind(controller))

  // GET /order/:orderId — Get current user's existing reviews for one order
  fastify.get('/order/:orderId', {
    schema: getOrderReviewsSchema,
    preHandler: [fastify.authenticate],
  }, controller.getReviewsByOrder.bind(controller))

  // POST / — Create review
  fastify.post('/', {
    schema: createReviewSchema,
    preHandler: [fastify.authenticate],
  }, controller.createReview.bind(controller))

  // PATCH /:id — Update review
  fastify.patch('/:id', {
    schema: updateReviewSchema,
    preHandler: [fastify.authenticate],
  }, controller.updateReview.bind(controller))

  // DELETE /:id — Delete review
  fastify.delete('/:id', {
    schema: deleteReviewSchema,
    preHandler: [fastify.authenticate],
  }, controller.deleteReview.bind(controller))

  // GET /my-reviews — Get user's reviews
  fastify.get('/my-reviews', {
    schema: getMyReviewsSchema,
    preHandler: [fastify.authenticate],
  }, controller.getMyReviews.bind(controller))

  // ── seller reviews ──
  fastify.get('/vendors/order/:orderId', {
    schema: getVendorOrderReviewsSchema,
    preHandler: [fastify.authenticate],
  }, controller.getVendorReviewsByOrder.bind(controller))

  fastify.get('/vendors/:vendorId', {
    schema: getVendorReviewsSchema,
  }, controller.getVendorReviews.bind(controller))

  fastify.post('/vendors', {
    schema: createVendorReviewSchema,
    preHandler: [fastify.authenticate],
  }, controller.createVendorReview.bind(controller))

  // POST /report/:kind/:id — flag a published review for the moderation team
  fastify.post('/report/:kind/:id', {
    schema: reportReviewSchema,
    preHandler: [fastify.authenticate],
  }, controller.reportReview.bind(controller))
}
