import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { env } from '../../../src/config/env.js'
import { AllocationService } from '../../../src/modules/allocation/allocation.service.js'

const PLATFORM = { id: 'platform-shop', created_at: '2026-01-01', distance_km: null, delivery_radius_km: 5 }

function makeService(overrides = {}) {
  const repo = {
    findShopsByPincode: vi.fn().mockResolvedValue([PLATFORM]),
    findShopsByRadius: vi.fn().mockResolvedValue([PLATFORM]),
    findByShopIds: vi.fn().mockResolvedValue([{ shop_id: PLATFORM.id, name: 'Dealker Official' }]),
    findByUserId: vi.fn().mockResolvedValue([]),
    replaceForUser: vi.fn().mockResolvedValue(1),
    ...overrides,
  }
  return { svc: new AllocationService(repo, { queue: { add: vi.fn() } }), repo }
}

describe('single-store mode — Dealker Official serves all of India', () => {
  let before
  beforeEach(() => { before = env.SINGLE_STORE_MODE; env.SINGLE_STORE_MODE = true })
  afterEach(() => { env.SINGLE_STORE_MODE = before })

  it('resolves the official store for a guest with no location at all', async () => {
    const { svc } = makeService()
    const res = await svc.resolveForLocation({})
    expect(res.success).toBe(true)
    expect(res.data.shops).toHaveLength(1)
    expect(res.data.shops[0]).toMatchObject({ shop_id: 'platform-shop', is_primary: true, name: 'Dealker Official' })
  })

  it('still rejects a missing location when single-store mode is off', async () => {
    env.SINGLE_STORE_MODE = false
    const { svc } = makeService()
    const res = await svc.resolveForLocation({})
    expect(res).toMatchObject({ success: false, code: 'INVALID_LOCATION' })
  })

  it('allocates a customer with no allocation to the official store on first read', async () => {
    const findByUserId = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'a1', shop_id: 'platform-shop', name: 'Dealker Official', distance_km: null, matched_pincode: null, is_primary: true }])
    const { svc, repo } = makeService({ findByUserId })
    const ids = await svc.getStorefrontShopIds('user-with-no-address')
    expect(repo.replaceForUser).toHaveBeenCalledWith('user-with-no-address', [
      expect.objectContaining({ shop_id: 'platform-shop', is_primary: true }),
    ])
    expect(ids).toEqual(['platform-shop'])
  })

  it('does not touch allocations that already exist', async () => {
    const existing = [{ id: 'a1', shop_id: 'platform-shop', name: 'Dealker Official', distance_km: null, matched_pincode: null, is_primary: true }]
    const { svc, repo } = makeService({ findByUserId: vi.fn().mockResolvedValue(existing) })
    await svc.getStorefrontShopIds('u2')
    expect(repo.replaceForUser).not.toHaveBeenCalled()
  })
})
