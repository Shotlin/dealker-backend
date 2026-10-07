import { afterEach, describe, expect, it, vi } from 'vitest'

const mockClient = {
  query: vi.fn(),
  release: vi.fn(),
}

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(() => Promise.resolve(mockClient)),
}))

import { query } from '../../../src/config/database.js'
import { AbandonedCartsRepository } from '../../../src/modules/abandoned-carts/abandoned-carts.repository.js'

const USER_ID = '11111111-1111-1111-1111-111111111111'
const CART_ID = '22222222-2222-2222-2222-222222222222'

function enrichedCartFixture() {
  return {
    subtotal: 150,
    items: [
      {
        productId: 'p1',
        shopId: 's1',
        name: 'Test Product',
        thumbnailUrl: 'https://example.com/img.png',
        unit: 'kg',
        quantity: 2,
        effectivePrice: 50,
        price: 60,
        lineTotal: 100,
      },
      {
        productId: 'p2',
        shopId: 's1',
        name: 'Second Product',
        thumbnailUrl: null,
        unit: 'piece',
        quantity: 1,
        effectivePrice: 50,
        price: 50,
        lineTotal: 50,
      },
    ],
  }
}

describe('AbandonedCartsRepository.recordAbandonment', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('inserts a new OPEN episode with the given priority score when no OPEN row exists yet', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT ... FOR UPDATE -> no existing row
      .mockResolvedValueOnce({ rows: [{ id: CART_ID }] }) // INSERT abandoned_carts RETURNING id
      .mockResolvedValueOnce(undefined) // INSERT abandoned_cart_events (DETECTED)
      .mockResolvedValueOnce(undefined) // DELETE abandoned_cart_items
      .mockResolvedValueOnce(undefined) // INSERT item 1
      .mockResolvedValueOnce(undefined) // INSERT item 2
      .mockResolvedValueOnce(undefined) // COMMIT

    const repo = new AbandonedCartsRepository()
    const result = await repo.recordAbandonment(
      USER_ID,
      enrichedCartFixture(),
      1_700_000_000_000,
      { score: 72.5, breakdown: { cartValue: { raw: 150 } } }
    )

    expect(result).toEqual({ id: CART_ID, isNew: true })

    const insertCall = mockClient.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO abandoned_carts')
    )
    expect(insertCall).toBeTruthy()
    expect(insertCall[1]).toEqual([
      USER_ID,
      1_700_000_000_000,
      2, // item_count
      3, // total_quantity (2 + 1)
      150, // cart_value
      72.5, // priority_score
      JSON.stringify({ cartValue: { raw: 150 } }),
    ])

    const eventCall = mockClient.query.mock.calls.find(
      ([sql]) => sql.includes('INSERT INTO abandoned_cart_events') && sql.includes('$2')
    )
    expect(eventCall[1]).toEqual([CART_ID, 'DETECTED'])

    expect(mockClient.query).toHaveBeenCalledWith('COMMIT')
    expect(mockClient.release).toHaveBeenCalled()
  })

  it('refreshes an existing OPEN episode instead of inserting a duplicate, and ignores the passed-in priority score', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: CART_ID }] }) // SELECT ... FOR UPDATE -> existing row
      .mockResolvedValueOnce(undefined) // UPDATE abandoned_carts
      .mockResolvedValueOnce(undefined) // INSERT abandoned_cart_events (RESWEPT)
      .mockResolvedValueOnce(undefined) // DELETE abandoned_cart_items
      .mockResolvedValueOnce(undefined) // INSERT item 1
      .mockResolvedValueOnce(undefined) // INSERT item 2
      .mockResolvedValueOnce(undefined) // COMMIT

    const repo = new AbandonedCartsRepository()
    const result = await repo.recordAbandonment(
      USER_ID,
      enrichedCartFixture(),
      1_700_000_000_000,
      { score: 99, breakdown: {} } // should be ignored — episode already exists
    )

    expect(result).toEqual({ id: CART_ID, isNew: false })

    const updateCall = mockClient.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE abandoned_carts')
    )
    expect(updateCall).toBeTruthy()
    // No priority_score/abandoned_at in the refresh UPDATE
    expect(updateCall[0]).not.toContain('priority_score')
    expect(updateCall[0]).not.toContain('abandoned_at')

    const eventCall = mockClient.query.mock.calls.find(
      ([sql]) => sql.includes('INSERT INTO abandoned_cart_events') && sql.includes('$2')
    )
    expect(eventCall[1]).toEqual([CART_ID, 'RESWEPT'])
  })

  it('rolls back and releases the client if any statement in the transaction throws', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(new Error('boom')) // SELECT ... FOR UPDATE fails

    const repo = new AbandonedCartsRepository()
    await expect(
      repo.recordAbandonment(USER_ID, enrichedCartFixture(), Date.now(), null)
    ).rejects.toThrow('boom')

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK')
    expect(mockClient.release).toHaveBeenCalled()
  })
})

describe('AbandonedCartsRepository — recovery/conversion flips', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('markRecoveredByUserId only flips a row that is currently OPEN', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] }).mockResolvedValueOnce(undefined)

    const repo = new AbandonedCartsRepository()
    const row = await repo.markRecoveredByUserId(USER_ID)

    expect(row).toEqual({ id: CART_ID })
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain("status = 'OPEN'")
    expect(sql).toContain("SET status = 'RECOVERED'")
    expect(params).toEqual([USER_ID])
  })

  it('markRecoveredByUserId is a harmless no-op when there is no open episode', async () => {
    query.mockResolvedValueOnce({ rows: [] })

    const repo = new AbandonedCartsRepository()
    const row = await repo.markRecoveredByUserId(USER_ID)

    expect(row).toBeNull()
    // No event should be logged for a no-op
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('markConvertedByUserId records the converted_order_id', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: CART_ID }] }).mockResolvedValueOnce(undefined)

    const repo = new AbandonedCartsRepository()
    const orderId = '33333333-3333-3333-3333-333333333333'
    const row = await repo.markConvertedByUserId(USER_ID, orderId)

    expect(row).toEqual({ id: CART_ID })
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain("SET status = 'CONVERTED'")
    expect(params).toEqual([USER_ID, orderId])
  })
})

describe('AbandonedCartsRepository.getUserRecoveryRate', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when the user has no closed episodes yet', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    const repo = new AbandonedCartsRepository()
    expect(await repo.getUserRecoveryRate(USER_ID)).toBeNull()
  })

  it('computes the recovered-or-converted ratio over closed episodes', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { status: 'RECOVERED' },
        { status: 'CONVERTED' },
        { status: 'EXPIRED' },
        { status: 'EXPIRED' },
      ],
    })
    const repo = new AbandonedCartsRepository()
    expect(await repo.getUserRecoveryRate(USER_ID)).toBe(0.5)
  })
})

describe('AbandonedCartsRepository.getCustomerLTV', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('uses the canonical orders customer and payment columns', async () => {
    query.mockResolvedValueOnce({ rows: [{ ltv: '420.50', order_count: 3 }] })

    const repo = new AbandonedCartsRepository()
    await expect(repo.getCustomerLTV(USER_ID)).resolves.toEqual({
      ltv: 420.5,
      orderCount: 3,
    })

    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('SUM(total_payable)')
    expect(sql).toContain('customer_id = $1')
    expect(sql).not.toContain('total_amount')
    expect(sql).not.toContain('FROM orders WHERE user_id')
    expect(params).toEqual([USER_ID])
  })
})
