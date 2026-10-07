import { describe, expect, it, vi } from 'vitest'

const databaseMock = vi.hoisted(() => ({ query: vi.fn(async () => ({ rows: [] })) }))
vi.mock('../../../src/config/database.js', () => ({ query: databaseMock.query }))

import { InventoryRepository } from '../../../src/modules/inventory/inventory.repository.js'

describe('Inventory Repository — FEFO & Concurrency Quantity Guard (Spec §5.4.1, §7.8.2, §7.8.5)', () => {
  // `inventory_lots` (migration 104) has no `state`/`version` columns —
  // the query used to reference both and would have thrown "column does
  // not exist" the moment it was ever called in production; it never was
  // (reserveFefo has no callers), which is how it stayed unnoticed until
  // it was fixed to match the real deployed schema. These assertions were
  // pinned to the bug itself; updated to the corrected SQL.
  it('findAvailableLotsFefo appends FOR UPDATE SKIP LOCKED, filters on real availability/expiry columns only', async () => {
    const repo = new InventoryRepository()
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] })
    const mockClient = { query: mockQuery }

    await repo.findAvailableLotsFefo('w-1', 'p-1', mockClient)

    expect(mockQuery).toHaveBeenCalledTimes(1)
    const sql = mockQuery.mock.calls[0][0]
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(sql).not.toContain('state')
    expect(sql).not.toContain('version')
    expect(sql).toContain('expiry_date > CURRENT_DATE')
    expect(sql).toContain('(quantity_on_hand - quantity_reserved) > 0')
    expect(sql).toContain('ORDER BY expiry_date ASC, created_at ASC')
  })

  it('reserveLotQuantityGuard uses atomic SQL update checking (quantity_on_hand - quantity_reserved) >= $2', async () => {
    const repo = new InventoryRepository()
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [{ id: 'lot-1', quantity_on_hand: 10, quantity_reserved: 3 }],
    })
    const mockClient = { query: mockQuery }

    const result = await repo.reserveLotQuantityGuard('lot-1', 3, mockClient)

    expect(result).not.toBeNull()
    expect(result.id).toBe('lot-1')
    expect(mockQuery).toHaveBeenCalledTimes(1)
    const sql = mockQuery.mock.calls[0][0]
    expect(sql).toContain('(quantity_on_hand - quantity_reserved) >= $2')
    expect(sql).not.toContain('version')
  })

  // Regression test for a real, live production incident (2026-09-26):
  // writeLedgerEntry used to always run on the shared pool's own query()
  // regardless of an in-progress transaction, opening a SECOND connection
  // for a write that's causally dependent on a lock the FIRST connection
  // (consumeLotOnHand's own UPDATE, run on the real transaction client)
  // was already holding uncommitted — a guaranteed self-deadlock. Every
  // `placeOrder` reaching this step hung forever until the pool was fully
  // exhausted. Fixed to accept and use the passed transaction client, the
  // same pattern `consumeLotOnHand`/`reserveLotQuantityGuard` already used.
  it('writeLedgerEntry runs on the passed transaction client, never a second, unrelated connection', async () => {
    const repo = new InventoryRepository()
    const mockQuery = vi.fn().mockResolvedValue({ rows: [{ id: 'ledger-1' }] })
    const mockClient = { query: mockQuery }

    await repo.writeLedgerEntry(
      {
        lot_id: 'lot-1',
        warehouse_id: 'wh-1',
        product_id: 'prod-1',
        movement_type: 'OUTBOUND',
        quantity_change: -3,
        balance_after: 7,
        reference_type: 'ORDER_ITEM',
        reference_id: 'oi-1',
        actor_id: 'actor-1',
      },
      mockClient
    )

    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(mockQuery.mock.calls[0][0]).toContain('INSERT INTO stock_ledger_entries')
  })

  // Regression test for a real, live playback bug (2026-09-26): vendor
  // quality-video evidence is often recorded on an iPhone (HEVC/H.265),
  // which Android's video_player plays inconsistently — confirmed live
  // against a real production asset. Both real read paths for a video URL
  // must transcode to H.264 on delivery via toH264VideoUrl.
  it('findQualityTraceForOrderItems transcodes video_url to H.264 for Android playback compatibility', async () => {
    databaseMock.query.mockResolvedValueOnce({
      rows: [
        {
          order_item_id: 'oi-1',
          video_url: 'https://res.cloudinary.com/demo/video/upload/v1/evidence/clip.mp4',
        },
      ],
    })
    const repo = new InventoryRepository()

    const rows = await repo.findQualityTraceForOrderItems(['oi-1'])

    expect(rows[0].video_url).toBe('https://res.cloudinary.com/demo/video/upload/vc_h264/v1/evidence/clip.mp4')
  })

  it('listLots also transcodes video_url to H.264 (powers the dashboard Inventory page preview)', async () => {
    databaseMock.query.mockResolvedValueOnce({
      rows: [{ id: 'lot-1', video_url: 'https://res.cloudinary.com/demo/video/upload/v1/evidence/clip.mp4' }],
    })
    const repo = new InventoryRepository()

    const rows = await repo.listLots('wh-1', 'p-1')

    expect(rows[0].video_url).toBe('https://res.cloudinary.com/demo/video/upload/vc_h264/v1/evidence/clip.mp4')
  })
})
