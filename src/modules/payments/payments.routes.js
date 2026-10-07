import { PaymentsController } from './payments.controller.js'
import { PaymentsService } from './payments.service.js'
import { PaymentsRepository } from './payments.repository.js'
import {
  createPaymentOrderSchema,
  verifyPaymentSchema,
  paymentStatusSchema,
  paymentHistorySchema,
  refundSchema,
} from './payments.schema.js'

/**
 * Payments routes plugin
 * Prefix: /api/v1/payments
 */
export default async function paymentsRoutes(fastify) {
  const repository = new PaymentsRepository()
  const service = new PaymentsService(repository, fastify)
  const controller = new PaymentsController(service)

  // ─── Customer routes (AUTH) ─────────────────────────────

  // POST /create-order — Create Razorpay payment order
  fastify.post('/create-order', {
    schema: createPaymentOrderSchema,
    preHandler: [fastify.authenticate],
  }, controller.createPaymentOrder.bind(controller))

  // POST /verify — Verify payment signature
  fastify.post('/verify', {
    schema: verifyPaymentSchema,
    preHandler: [fastify.authenticate],
  }, controller.verifyPayment.bind(controller))

  // GET /history — Payment history
  fastify.get('/history', {
    schema: paymentHistorySchema,
    preHandler: [fastify.authenticate],
  }, controller.history.bind(controller))

  // GET /status/:razorpayOrderId — "what's the real payment status?" poll,
  // for an ambiguous client-side Razorpay callback outcome.
  fastify.get('/status/:razorpayOrderId', {
    schema: paymentStatusSchema,
    preHandler: [fastify.authenticate],
  }, controller.status.bind(controller))

  // ─── Webhook (NO AUTH — verified by Razorpay signature) ────────────

  // POST /webhook — Razorpay event webhook
  // Raw body must be preserved for signature verification.
  fastify.post('/webhook', {
    config: { rawBody: true },
    schema: {
      body: { type: 'object', additionalProperties: true },
    },
  }, controller.webhook.bind(controller))

  // ─── Admin routes ───────────────────────────────────────

  // POST /:id/refund — Initiate refund [ADMIN]
  fastify.post('/:id/refund', {
    schema: refundSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.refund.bind(controller))
}
