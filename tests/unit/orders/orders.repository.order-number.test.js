import { describe, expect, it, vi } from 'vitest'
import { OrdersRepository } from '../../../src/modules/orders/orders.repository.js'

/**
 * Regression coverage for the bug that made every single order placement
 * fail in production: `RETURNING order_date` (no cast) hands node-postgres
 * a `date` column, which its default type parser turns into a native JS
 * `Date` object — `String(dateObject)` stringifies as
 * "Wed Sep 23 2026 00:00:00 GMT+0000 (...)" (no dashes, so
 * `.replaceAll('-','')` is a no-op), and `.slice(0,10)` grabs "Wed Sep 23"
 * (10 chars, with a space) instead of "20260923". The resulting order
 * number ("FC-KOL-Wed Sep 23-0001", 22 chars) always overflowed
 * `orders.order_number VARCHAR(20)`. The `orders` table had zero rows in
 * production before this fix — no order had ever completed through this
 * path. The fix casts `order_date::text` in SQL, so Postgres formats the
 * date deterministically as 'YYYY-MM-DD' before it ever reaches the driver.
 */
describe('OrdersRepository.generateCheckoutOrderNumber', () => {
  function makeClient({ orderPrefix = 'KOL', orderDateText = '2026-09-23', lastValue = 1 } = {}) {
    const query = vi.fn(async (sql) => {
      if (sql.includes('FROM shops')) {
        return { rows: [{ order_prefix: orderPrefix }] }
      }
      if (sql.includes('INSERT INTO order_number_sequences')) {
        // The fix: `RETURNING order_date::text` — Postgres itself returns
        // a plain 'YYYY-MM-DD' string here, never a JS Date object.
        expect(sql).toContain('order_date::text')
        return { rows: [{ order_date: orderDateText, last_value: lastValue }] }
      }
      throw new Error(`Unexpected query: ${sql}`)
    })
    return { query }
  }

  it('produces a clean, correctly-formatted order number that fits VARCHAR(20)', async () => {
    const repo = new OrdersRepository()
    const client = makeClient({ orderPrefix: 'KOL', orderDateText: '2026-09-23', lastValue: 1 })

    const orderNumber = await repo.generateCheckoutOrderNumber(client, 'shop-1')

    expect(orderNumber).toBe('FC-KOL-20260923-0001')
    expect(orderNumber.length).toBeLessThanOrEqual(20)
  })

  it('pads the daily sequence to 4 digits', async () => {
    const repo = new OrdersRepository()
    const client = makeClient({ orderPrefix: 'HQC', orderDateText: '2026-01-05', lastValue: 42 })

    const orderNumber = await repo.generateCheckoutOrderNumber(client, 'shop-2')

    expect(orderNumber).toBe('FC-HQC-20260105-0042')
  })

  it('throws a clear, actionable error instead of a raw DB overflow when a store\'s order_prefix would push the number past 20 chars', async () => {
    const repo = new OrdersRepository()
    // A hypothetical longer branch code (e.g. "DELHI") — 20 + 5 extra
    // chars over the KOL/HQC baseline definitely exceeds VARCHAR(20).
    const client = makeClient({ orderPrefix: 'DELHI-BRANCH', orderDateText: '2026-09-23', lastValue: 1 })

    await expect(repo.generateCheckoutOrderNumber(client, 'shop-3')).rejects.toThrow(
      /exceeds 20 characters/
    )
  })

  it('falls back to a 3-char "STR" prefix (not the old 4-char "SHOP", which itself overflowed) when the store has no order_prefix configured', async () => {
    const repo = new OrdersRepository()
    const query = vi.fn(async (sql) => {
      if (sql.includes('FROM shops')) {
        // Mirrors the real COALESCE(NULLIF(order_prefix, ''), 'STR') SQL —
        // this test just confirms the JS side trusts whatever comes back.
        return { rows: [{ order_prefix: 'STR' }] }
      }
      return { rows: [{ order_date: '2026-09-23', last_value: 1 }] }
    })
    const orderNumber = await repo.generateCheckoutOrderNumber({ query }, 'shop-4')
    expect(orderNumber).toBe('FC-STR-20260923-0001')
    expect(orderNumber.length).toBeLessThanOrEqual(20)
  })
})
