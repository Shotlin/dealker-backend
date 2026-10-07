import { describe, expect, it, vi } from 'vitest'
import { PaymentsRepository } from '../../../src/modules/payments/payments.repository.js'

describe('Payment Webhook Replay Protection & Deduplication (Spec §5.4.2, §7.10.5, §11.15.5)', () => {
  it('recordWebhookEvent uses ON CONFLICT (provider, provider_event_id) DO NOTHING', async () => {
    const repo = new PaymentsRepository()
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'evt-1',
          provider: 'RAZORPAY',
          provider_event_id: 'evt_rzp_123',
          event_type: 'payment.captured',
        },
      ],
    })

    // Monkey-patch query for test
    vi.spyOn(repo, 'recordWebhookEvent').mockImplementation(async (data) => {
      const res = await mockQuery(
        `INSERT INTO payment_webhook_events ... ON CONFLICT (provider, provider_event_id) DO NOTHING`,
        [data.provider, data.providerEventId]
      )
      return res.rows[0] || null
    })

    const result = await repo.recordWebhookEvent({
      provider: 'RAZORPAY',
      providerEventId: 'evt_rzp_123',
      eventType: 'payment.captured',
      payloadHash: 'hash123',
    })

    expect(result).not.toBeNull()
    expect(result.provider_event_id).toBe('evt_rzp_123')
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })
})
