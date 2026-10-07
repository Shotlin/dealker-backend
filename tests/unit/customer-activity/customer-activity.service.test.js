import { describe, expect, it, vi } from 'vitest'

import { CustomerActivityService } from '../../../src/modules/admin/customer-activity/customer-activity.service.js'

function makeRepoMock(overrides = {}) {
  return {
    resolveUser: vi.fn().mockResolvedValue({ id: 'user-1', name: 'Ashish', phone: '6354302166' }),
    searchUsers: vi.fn().mockResolvedValue([{ id: 'user-1', name: 'Ashish', phone: '6354302166' }]),
    getTimeline: vi.fn().mockResolvedValue({ events: [], total: 0 }),
    ...overrides,
  }
}

describe('CustomerActivityService.searchUsers', () => {
  it('forwards the raw query to the repository and returns its results', async () => {
    const repo = makeRepoMock()
    const service = new CustomerActivityService(repo)

    const result = await service.searchUsers('980000')

    expect(repo.searchUsers).toHaveBeenCalledWith('980000')
    expect(result).toEqual([{ id: 'user-1', name: 'Ashish', phone: '6354302166' }])
  })

  it('returns an empty array when nothing matches, never throwing', async () => {
    const repo = makeRepoMock({ searchUsers: vi.fn().mockResolvedValue([]) })
    const service = new CustomerActivityService(repo)

    const result = await service.searchUsers('zzzzzz')

    expect(result).toEqual([])
  })
})

describe('CustomerActivityService.resolveUser', () => {
  it('returns success with the user when found', async () => {
    const repo = makeRepoMock()
    const service = new CustomerActivityService(repo)

    const result = await service.resolveUser('6354302166')

    expect(result).toEqual({ success: true, user: { id: 'user-1', name: 'Ashish', phone: '6354302166' } })
  })

  it('returns a failure message when no user matches', async () => {
    const repo = makeRepoMock({ resolveUser: vi.fn().mockResolvedValue(null) })
    const service = new CustomerActivityService(repo)

    const result = await service.resolveUser('0000000000')

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/no user found/i)
  })
})

describe('CustomerActivityService.getTimeline', () => {
  it('forwards filters to the repository and builds pagination from the total', async () => {
    const repo = makeRepoMock({
      getTimeline: vi.fn().mockResolvedValue({
        events: [{ eventType: 'WALLET', eventAt: '2026-07-02T12:39:48.461Z', meta: {} }],
        total: 45,
      }),
    })
    const service = new CustomerActivityService(repo)

    const result = await service.getTimeline('user-1', {
      page: 2,
      limit: 20,
      eventType: 'WALLET',
      from: '2026-01-01',
      to: '2026-12-31',
    })

    expect(repo.getTimeline).toHaveBeenCalledWith('user-1', {
      eventType: 'WALLET',
      from: '2026-01-01',
      to: '2026-12-31',
      limit: 20,
      offset: 20,
    })
    expect(result.events).toHaveLength(1)
    expect(result.pagination).toEqual({ page: 2, limit: 20, total: 45, totalPages: 3 })
  })

  it('defaults to page 1 when no page is given', async () => {
    const repo = makeRepoMock()
    const service = new CustomerActivityService(repo)

    const result = await service.getTimeline('user-1', {})

    expect(result.pagination.page).toBe(1)
  })
})
