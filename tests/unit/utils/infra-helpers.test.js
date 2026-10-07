import { describe, expect, it, vi } from 'vitest'
import { computeRequestHash, requireIdempotency } from '../../../src/utils/idempotency.js'
import { emitEvent } from '../../../src/utils/outbox.js'

describe('Infrastructure Helpers Unit Tests (Phase 1C)', () => {
  describe('computeRequestHash', () => {
    it('generates consistent 64-char SHA-256 hex string for identical payloads', () => {
      const payload = { vendorName: 'Fresh Meat Co', items: [1, 2] }
      const hash1 = computeRequestHash(payload)
      const hash2 = computeRequestHash(payload)

      expect(hash1).toHaveLength(64)
      expect(hash1).toBe(hash2)
    })

    it('generates different SHA-256 hashes for different payloads', () => {
      const hash1 = computeRequestHash({ a: 1 })
      const hash2 = computeRequestHash({ a: 2 })

      expect(hash1).not.toBe(hash2)
    })
  })

  describe('emitEvent (Outbox Helper)', () => {
    it('throws error if active DB client transaction is missing', async () => {
      await expect(emitEvent(null, { eventType: 'A', aggregateType: 'B', aggregateId: 'c', payload: { x: 1 } }))
        .rejects.toThrow('emitEvent requires an active database transaction client')
    })

    it('throws error if payload is empty or non-object', async () => {
      const mockClient = { query: vi.fn() }
      await expect(emitEvent(mockClient, { eventType: 'A', aggregateType: 'B', aggregateId: 'c', payload: {} }))
        .rejects.toThrow('emitEvent payload MUST be a non-empty object')
    })

    it('inserts event into outbox_events table inside active client transaction', async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({
          rows: [{ id: 'evt-123', event_type: 'VENDOR_CREATED', aggregate_type: 'VENDOR', aggregate_id: 'v-1', created_at: new Date() }],
        }),
      }

      const res = await emitEvent(mockClient, {
        eventType: 'VENDOR_CREATED',
        aggregateType: 'VENDOR',
        aggregateId: 'v-1',
        payload: { name: 'Meat Co' },
      })

      expect(mockClient.query).toHaveBeenCalledOnce()
      expect(res.id).toBe('evt-123')
      expect(res.event_type).toBe('VENDOR_CREATED')
    })
  })
})
