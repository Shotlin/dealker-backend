import { describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn().mockResolvedValue({ rows: [] })

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: (...args) => queryMock(...args),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

import { CustomerActivityRepository } from '../../../src/modules/admin/customer-activity/customer-activity.repository.js'

describe('CustomerActivityRepository.resolveUser', () => {
  it('queries by id for a UUID input', async () => {
    queryMock.mockClear()
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
    const repo = new CustomerActivityRepository()

    const result = await repo.resolveUser('11111111-1111-1111-1111-111111111111')

    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/WHERE id = \$1/)
    expect(params).toEqual(['11111111-1111-1111-1111-111111111111'])
    expect(result).toEqual({ id: 'user-1' })
  })

  it('queries by phone for a 10-digit phone input', async () => {
    queryMock.mockClear()
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
    const repo = new CustomerActivityRepository()

    await repo.resolveUser('9876543210')

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/WHERE phone = \$1/)
    expect(params).toEqual(['9876543210'])
  })

  it('returns null without querying for neither a UUID nor a phone number', async () => {
    queryMock.mockClear()
    const repo = new CustomerActivityRepository()

    const result = await repo.resolveUser('not-a-valid-input')

    expect(queryMock).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })

  it('normalizes a +91-prefixed phone number to the stored bare 10-digit form', async () => {
    queryMock.mockClear()
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
    const repo = new CustomerActivityRepository()

    await repo.resolveUser('+91 98765 43210')

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/WHERE phone = \$1/)
    expect(params).toEqual(['9876543210'])
  })

  it('normalizes a leading-zero phone number the same way', async () => {
    queryMock.mockClear()
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
    const repo = new CustomerActivityRepository()

    await repo.resolveUser('09876543210')

    const [, params] = queryMock.mock.calls[0]
    expect(params).toEqual(['9876543210'])
  })
})

describe('CustomerActivityRepository.searchUsers', () => {
  it('returns no results and never queries for a too-short input', async () => {
    queryMock.mockClear()
    const repo = new CustomerActivityRepository()

    const result = await repo.searchUsers('9')

    expect(queryMock).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })

  it('delegates a full UUID straight to resolveUser (single exact result)', async () => {
    queryMock.mockClear()
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
    const repo = new CustomerActivityRepository()

    const result = await repo.searchUsers('11111111-1111-1111-1111-111111111111')

    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql] = queryMock.mock.calls[0]
    expect(sql).toMatch(/WHERE id = \$1/)
    expect(result).toEqual([{ id: 'user-1' }])
  })

  it('matches a partial phone number by ILIKE, ranking exact/prefix matches first', async () => {
    queryMock.mockClear()
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'user-1', phone: '9800000001' }] })
    const repo = new CustomerActivityRepository()

    await repo.searchUsers('980000')

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/phone ILIKE \$1/)
    expect(sql).toMatch(/name ILIKE \$2/)
    expect(sql).toMatch(/ORDER BY/)
    expect(sql).toMatch(/\(phone = \$3\) DESC/)
    expect(sql).toMatch(/\(phone LIKE \$4\) DESC/)
    expect(sql).toMatch(/LIMIT \$5/)
    expect(params).toEqual(['%980000%', '%980000%', '980000', '980000%', 8])
  })

  it('normalizes a +91-prefixed phone before building the ILIKE pattern', async () => {
    queryMock.mockClear()
    queryMock.mockResolvedValueOnce({ rows: [] })
    const repo = new CustomerActivityRepository()

    await repo.searchUsers('+919800000001')

    const [, params] = queryMock.mock.calls[0]
    // the phone-side pattern must be the normalized 10-digit form, not the
    // raw "+919800000001" the admin actually typed/pasted
    expect(params[0]).toBe('%9800000001%')
  })

  it('still searches by name when the input has too few digits to be a phone fragment', async () => {
    queryMock.mockClear()
    queryMock.mockResolvedValueOnce({ rows: [] })
    const repo = new CustomerActivityRepository()

    await repo.searchUsers('sayan')

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).not.toMatch(/phone ILIKE/)
    expect(sql).toMatch(/name ILIKE \$1/)
    expect(params[0]).toBe('%sayan%')
  })

  it('respects a custom limit', async () => {
    queryMock.mockClear()
    queryMock.mockResolvedValueOnce({ rows: [] })
    const repo = new CustomerActivityRepository()

    await repo.searchUsers('980000', 3)

    const [, params] = queryMock.mock.calls[0]
    expect(params[params.length - 1]).toBe(3)
  })
})

describe('CustomerActivityRepository.getTimeline', () => {
  it('passes filters/pagination params in order and maps rows', async () => {
    queryMock.mockClear()
    queryMock.mockResolvedValueOnce({
      rows: [
        { event_type: 'WALLET', event_at: '2026-07-02T12:39:48.461Z', meta: { amount: 104 }, total_count: 1 },
      ],
    })
    const repo = new CustomerActivityRepository()

    const result = await repo.getTimeline('user-1', {
      eventType: 'WALLET',
      from: '2026-01-01',
      to: '2026-12-31',
      limit: 20,
      offset: 0,
    })

    expect(queryMock).toHaveBeenCalledTimes(1)
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/UNION ALL/)
    expect(sql).toMatch(/COUNT\(\*\) OVER\(\)/)
    expect(sql).toMatch(/ORDER BY event_at DESC/)
    expect(params).toEqual(['user-1', 'WALLET', '2026-01-01', '2026-12-31', 20, 0])
    expect(result).toEqual({
      events: [{ eventType: 'WALLET', eventAt: '2026-07-02T12:39:48.461Z', meta: { amount: 104 } }],
      total: 1,
    })
  })

  it('returns zero total for an empty result without throwing', async () => {
    queryMock.mockClear()
    queryMock.mockResolvedValueOnce({ rows: [] })
    const repo = new CustomerActivityRepository()

    const result = await repo.getTimeline('user-1', { limit: 20, offset: 0 })

    expect(result).toEqual({ events: [], total: 0 })
  })

  it('every lane filters on the same user id ($1)', async () => {
    queryMock.mockClear()
    queryMock.mockResolvedValueOnce({ rows: [] })
    const repo = new CustomerActivityRepository()

    await repo.getTimeline('user-1', { limit: 20, offset: 0 })

    const [sql] = queryMock.mock.calls[0]
    // 9 lanes (orders, order_status, wallet, notifications, reviews,
    // product_views, cart_events, address_added, address_removed) — every
    // one must scope to user_id = $1, otherwise this would leak another
    // customer's activity into the timeline.
    const userIdMatches = sql.match(/user_id = \$1/g) || []
    expect(userIdMatches.length).toBe(9)
  })
})
