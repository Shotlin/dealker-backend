import { success, error } from '../../utils/apiResponse.js'

/**
 * Payments controller — thin HTTP layer
 */
export class PaymentsController {
  constructor(service) {
    this.service = service
  }

  /**
   * Create a Razorpay payment order
   */
  async createPaymentOrder(request, reply) {
    const result = await this.service.createPaymentOrder(
      request.user.id,
      request.body.orderId
    )
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'PAYMENT_FAILED'))
    }
    return reply.code(201).send(success(result.data, 'Payment order created'))
  }

  /**
   * Verify Razorpay payment
   */
  async verifyPayment(request, reply) {
    const result = await this.service.verifyPayment(request.user.id, request.body)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'VERIFY_FAILED'))
    }
    return reply.send(success(result.payment, 'Payment verified'))
  }

  /**
   * Razorpay webhook — no app-JWT auth, authenticity comes entirely from
   * the signature check inside `handleWebhook`. Signature verification
   * needs the RAW request bytes (`request.rawBody`, from the
   * `fastify-raw-body` plugin + this route's `config: { rawBody: true }`)
   * — previously this passed the already-JSON-parsed `request.body`
   * instead, which `handleWebhook` then re-`JSON.stringify`'d for the HMAC
   * compare; that is not guaranteed byte-identical to what Razorpay
   * actually signed, so verification could fail unpredictably even for a
   * genuine delivery.
   *
   * An invalid/unverifiable signature (or any other `success:false`
   * result) now returns a non-2xx status so Razorpay's own retry-on-
   * failure logic engages — this previously always returned HTTP 200
   * regardless of outcome, which silently told Razorpay "delivered,
   * don't retry" even when nothing was actually verified or processed.
   */
  async webhook(request, reply) {
    const signature = request.headers['x-razorpay-signature']
    const eventId = request.headers['x-razorpay-event-id']
    const result = await this.service.handleWebhook(request.body, signature, request.rawBody, eventId)
    if (!result.success) {
      return reply.code(400).send({ status: 'error' })
    }
    return reply.send({ status: 'ok' })
  }

  /**
   * "What is the real payment status?" poll — for when a checkout's
   * client-side Razorpay callback returned an ambiguous outcome (network
   * blip, app backgrounded mid-payment). Reads local state only.
   */
  async status(request, reply) {
    const result = await this.service.getPaymentStatus(request.user.id, request.params.razorpayOrderId)
    if (!result.success) {
      return reply.code(404).send(error(result.message, 'PAYMENT_NOT_FOUND'))
    }
    return reply.send(success(result.data, 'Payment status'))
  }

  /**
   * Payment history for current user
   */
  async history(request, reply) {
    const { payments, pagination } = await this.service.getHistory(
      request.user.id,
      request.query
    )
    return reply.send(success(payments, 'Payment history fetched', { pagination }))
  }

  /**
   * Admin: initiate refund
   */
  async refund(request, reply) {
    const result = await this.service.refund(request.params.id, request.body || {})
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'REFUND_FAILED'))
    }
    return reply.send(success(result.payment, 'Refund initiated'))
  }
}
