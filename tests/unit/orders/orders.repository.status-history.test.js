import { describe, expect, it, vi } from 'vitest'

/**
 * Regression coverage for the second bug behind "Internal Server Error" on
 * every order placement, found live in prod logs after the order-number
 * fix (orders.repository.order-number.test.js) was already deployed:
 *
 * `order_status_history` was first created by migration 015 with columns
 * `changed_by`/`note`/`changed_at`. Every other module that touches this
 * table (admin/orders, delivery, shop-orders, invoiceGenerator.js) reads
 * and writes those column names. A later migration (106) tried to
 * re-define the same table with `actor_id`/`notes`/`created_at`, but its
 * `CREATE TABLE IF NOT EXISTS` was a no-op against the already-existing
 * 015 table — those columns never existed in any deployed database.
 * `OrdersRepository#logStatusTransition` used the 106 names, so its INSERT
 * failed with `column "actor_id" of relation "order_status_history" does
 * not exist` on every call, inside `placeOrder`'s transaction, causing the
 * whole order-placement request to roll back and 500 — even after the
 * order-number bug was fixed and orders could otherwise be created.
 *
 * The fix also threads the checkout transaction's own `client` through to
 * this call from `placeOrder`: without it, the INSERT would run on a
 * different pool connection than the one that created (but not yet
 * committed) the order row, and would fail the `order_status_history
 * .order_id` foreign key because that connection can't see an uncommitted
 * row from another connection.
 */
vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(async () => ({ rows: [{ id: 'history-row-1' }] })),
}))

const { query: pooledQuery } = await import('../../../src/config/database.js')
const { OrdersRepository } = await import('../../../src/modules/orders/orders.repository.js')

describe('OrdersRepository.logStatusTransition', () => {
  it('inserts using the columns the table actually has (changed_by/note), not the never-deployed actor_id/notes', async () => {
    const repo = new OrdersRepository()
    const client = { query: vi.fn(async () => ({ rows: [{ id: 'history-row-1' }] })) }

    await repo.logStatusTransition('order-1', null, 'ORDER_PLACED', 'cust-1', 'Order placed from mobile checkout', client)

    expect(client.query).toHaveBeenCalledTimes(1)
    const [sql, params] = client.query.mock.calls[0]
    expect(sql).toContain('changed_by')
    expect(sql).toContain('note')
    expect(sql).not.toContain('actor_id')
    expect(sql).not.toMatch(/\bnotes\b/)
    expect(sql).not.toContain('created_at')
    expect(params).toEqual(['order-1', null, 'ORDER_PLACED', 'cust-1', 'Order placed from mobile checkout'])
  })

  it('runs on the given transaction client, not the shared pool, when one is passed', async () => {
    const repo = new OrdersRepository()
    const client = { query: vi.fn(async () => ({ rows: [{ id: 'history-row-1' }] })) }

    await repo.logStatusTransition('order-1', 'ORDER_PLACED', 'CANCELLED', 'cust-1', 'reason', client)

    expect(client.query).toHaveBeenCalledTimes(1)
    expect(pooledQuery).not.toHaveBeenCalled()
  })

  it('falls back to the shared pool when no client is passed (existing non-transactional callers: cancel, quote checkout, admin transitions)', async () => {
    const repo = new OrdersRepository()

    await repo.logStatusTransition('order-1', 'ORDER_PLACED', 'CANCELLED', 'cust-1', 'reason')

    expect(pooledQuery).toHaveBeenCalledTimes(1)
    const [sql] = pooledQuery.mock.calls[0]
    expect(sql).toContain('changed_by')
    expect(sql).toContain('note')
  })
})

describe('OrdersRepository.findOrderById status history ordering', () => {
  it('orders order_status_history by changed_at, the column that actually exists — not created_at', async () => {
    pooledQuery.mockClear()
    pooledQuery
      .mockResolvedValueOnce({ rows: [{ id: 'order-1' }] }) // orders
      .mockResolvedValueOnce({ rows: [] }) // order_items
      .mockResolvedValueOnce({ rows: [] }) // fulfilment_tasks
      .mockResolvedValueOnce({ rows: [] }) // order_status_history

    const repo = new OrdersRepository()
    await repo.findOrderById('order-1')

    const historyCall = pooledQuery.mock.calls.find(([sql]) => sql.includes('order_status_history'))
    expect(historyCall[0]).toContain('ORDER BY changed_at ASC')
    expect(historyCall[0]).not.toContain('created_at')
  })
})
