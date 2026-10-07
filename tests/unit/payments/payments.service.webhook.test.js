import { beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'

/**
 * Regression coverage for `PaymentsService#handleWebhook` — raw-body
 * signature verification, non-2xx-worthy rejection of bad signatures,
 * event-id deduplication, the payment.failed-can't-downgrade-PAID guard,
 * and refund.processed persistence. See payments.service.complete-verified
 * -payment.test.js for the finalization cascade itself.
 */

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  getClient: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [] })), release: vi.fn() })),
}))
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../../src/config/bullmq.js', () => ({
  orderQueue: { add: vi.fn(async () => {}) },
}))
vi.mock('../../../src/config/razorpay.js', () => ({
  razorpay: null,
  getRazorpayKeyId: () => 'rzp_test_key',
  getRazorpayKeySecret: () => 'test-key-secret',
  getRazorpayWebhookSecret: () => 'test-webhook-secret',
  getRazorpayMode: () => 'TEST',
  refreshRazorpayClient: vi.fn(),
}))

process.env.RAZORPAY_WEBHOOK_SECRET = 'test-webhook-secret'
vi.mock('../../../src/config/env.js', () => ({
  env: { RAZORPAY_WEBHOOK_SECRET: 'test-webhook-secret', RAZORPAY_KEY_SECRET: 'test-key-secret' },
}))

import { PaymentsService } from '../../../src/modules/payments/payments.service.js'

function sign(rawBody, secret = 'test-webhook-secret') {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
}

function makeService({ completeVerifiedPaymentImpl } = {}) {
  const repo = {
    recordWebhookEvent: vi.fn(async () => ({ id: 'evt-row-1' })),
    findByRazorpayOrderId: vi.fn(async () => null),
    findByRazorpayPaymentId: vi.fn(async () => null),
    updatePayment: vi.fn(async () => ({})),
    updateRefund: vi.fn(async () => ({})),
  }
  const ordersRepo = { updateStatus: vi.fn(async () => ({})) }
  const service = new PaymentsService(repo)
  service.ordersRepo = ordersRepo
  service.completeVerifiedPayment = completeVerifiedPaymentImpl || vi.fn(async () => ({ success: true }))
  return { service, repo, ordersRepo }
}

describe('PaymentsService.handleWebhook — signature verification', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects when raw body is unavailable (never falls back to JSON.stringify(parsedBody))', async () => {
    const { service, repo } = makeService()
    const result = await service.handleWebhook({ event: 'payment.captured' }, 'anything', undefined)

    expect(result.success).toBe(false)
    expect(repo.recordWebhookEvent).not.toHaveBeenCalled()
  })

  it('rejects an invalid signature and records it as a rejected event (never silently accepted)', async () => {
    const { service, repo } = makeService()
    const rawBody = JSON.stringify({ event: 'payment.captured', payload: {} })

    const result = await service.handleWebhook({ event: 'payment.captured' }, 'not-the-real-signature', rawBody)

    expect(result.success).toBe(false)
    expect(repo.recordWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ signatureValid: false, processingStatus: 'REJECTED_BAD_SIGNATURE' })
    )
  })

  it('accepts a correctly-signed raw body and processes the event', async () => {
    const completeVerifiedPaymentImpl = vi.fn(async () => ({ success: true }))
    const { service, repo } = makeService({ completeVerifiedPaymentImpl })
    repo.findByRazorpayOrderId.mockResolvedValue({ id: 'pay-1', orderId: 'order-1' })

    const body = { event: 'payment.captured', payload: { payment: { entity: { id: 'rzp_pay_1', order_id: 'rzp_order_1', method: 'upi' } } } }
    const rawBody = JSON.stringify(body)
    const signature = sign(rawBody)

    const result = await service.handleWebhook(body, signature, rawBody, 'evt_unique_1')

    expect(result.success).toBe(true)
    expect(completeVerifiedPaymentImpl).toHaveBeenCalledWith('rzp_order_1', expect.objectContaining({
      razorpayPaymentId: 'rzp_pay_1',
      source: 'PAYMENT_WEBHOOK_PAYMENT.CAPTURED',
    }))
  })

  it('deduplicates a re-delivered event by event id — does not reprocess', async () => {
    const completeVerifiedPaymentImpl = vi.fn(async () => ({ success: true }))
    const { service, repo } = makeService({ completeVerifiedPaymentImpl })
    repo.recordWebhookEvent.mockResolvedValue(null) // ON CONFLICT DO NOTHING → no row → duplicate

    const body = { event: 'payment.captured', payload: { payment: { entity: { id: 'rzp_pay_2', order_id: 'rzp_order_2' } } } }
    const rawBody = JSON.stringify(body)
    const signature = sign(rawBody)

    const result = await service.handleWebhook(body, signature, rawBody, 'evt_dupe')

    expect(result).toEqual({ success: true, duplicate: true })
    expect(completeVerifiedPaymentImpl).not.toHaveBeenCalled()
  })
})

describe('PaymentsService.handleWebhook — payment.failed guard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('marks FAILED when the payment is still PENDING', async () => {
    const { service, repo, ordersRepo } = makeService()
    repo.findByRazorpayOrderId.mockResolvedValue({ id: 'pay-3', orderId: 'order-3', status: 'PENDING' })

    const body = {
      event: 'payment.failed',
      payload: { payment: { entity: { order_id: 'rzp_order_3', error_code: 'BAD_REQUEST_ERROR', error_description: 'card declined' } } },
    }
    const rawBody = JSON.stringify(body)
    const signature = sign(rawBody)

    await service.handleWebhook(body, signature, rawBody, 'evt_failed_1')

    expect(repo.updatePayment).toHaveBeenCalledWith('pay-3', expect.objectContaining({ status: 'FAILED', errorCode: 'BAD_REQUEST_ERROR' }))
    expect(ordersRepo.updateStatus).toHaveBeenCalledWith('order-3', undefined, { paymentStatus: 'FAILED' })
  })

  it('NEVER downgrades an already-PAID payment — the core reliability fix', async () => {
    const { service, repo, ordersRepo } = makeService()
    repo.findByRazorpayOrderId.mockResolvedValue({ id: 'pay-4', orderId: 'order-4', status: 'PAID' })

    const body = { event: 'payment.failed', payload: { payment: { entity: { order_id: 'rzp_order_4' } } } }
    const rawBody = JSON.stringify(body)
    const signature = sign(rawBody)

    const result = await service.handleWebhook(body, signature, rawBody, 'evt_failed_2')

    expect(result.success).toBe(true)
    expect(repo.updatePayment).not.toHaveBeenCalled()
    expect(ordersRepo.updateStatus).not.toHaveBeenCalled()
  })
})

describe('PaymentsService.handleWebhook — refund.processed', () => {
  beforeEach(() => vi.clearAllMocks())

  it('persists the refund and marks the order REFUNDED when not already recorded', async () => {
    const { service, repo, ordersRepo } = makeService()
    repo.findByRazorpayPaymentId.mockResolvedValue({ id: 'pay-5', orderId: 'order-5', status: 'PAID' })

    const body = {
      event: 'refund.processed',
      payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'rzp_pay_5', amount: 21000 } } },
    }
    const rawBody = JSON.stringify(body)
    const signature = sign(rawBody)

    await service.handleWebhook(body, signature, rawBody, 'evt_refund_1')

    expect(repo.updateRefund).toHaveBeenCalledWith('pay-5', expect.objectContaining({ refundId: 'rfnd_1', refundAmount: 210 }))
    expect(ordersRepo.updateStatus).toHaveBeenCalledWith('order-5', 'REFUNDED', { paymentStatus: 'REFUNDED' })
  })

  it('is idempotent — a payment already REFUNDED (our own admin refund already ran) is left alone', async () => {
    const { service, repo, ordersRepo } = makeService()
    repo.findByRazorpayPaymentId.mockResolvedValue({ id: 'pay-6', orderId: 'order-6', status: 'REFUNDED' })

    const body = {
      event: 'refund.processed',
      payload: { refund: { entity: { id: 'rfnd_2', payment_id: 'rzp_pay_6', amount: 5000 } } },
    }
    const rawBody = JSON.stringify(body)
    const signature = sign(rawBody)

    await service.handleWebhook(body, signature, rawBody, 'evt_refund_2')

    expect(repo.updateRefund).not.toHaveBeenCalled()
    expect(ordersRepo.updateStatus).not.toHaveBeenCalled()
  })
})
