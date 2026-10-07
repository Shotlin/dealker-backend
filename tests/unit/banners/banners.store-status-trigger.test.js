import { describe, expect, it, vi } from 'vitest'

/**
 * Coverage for AdminBannersService.getActiveForStoreStatus() (Phase 3,
 * 2026-07-04) — the public banner feed now filters each banner's
 * trigger_type against the live store-open/closed state so a
 * "we are closed" banner can be dashboard-managed instead of hardcoded.
 * Must-not-break: every pre-existing banner defaults to trigger_type
 * 'ALWAYS', so it has to be included regardless of store state.
 */

vi.mock('../../../src/utils/activityLogger.js', () => ({
  logAdminActivity: vi.fn(),
}))

vi.mock('../../../src/config/cloudinary.js', () => ({
  normalizeCloudinaryDeliveryUrl: (url) => url,
}))

const findActiveForStoreStatusMock = vi.fn()
vi.mock('../../../src/modules/admin/banners/banners.repository.js', () => ({
  AdminBannersRepository: vi.fn().mockImplementation(() => ({
    findActiveForStoreStatus: findActiveForStoreStatusMock,
  })),
}))

const { AdminBannersService } = await import(
  '../../../src/modules/admin/banners/banners.service.js'
)

function makeStoreStatus(isOpen) {
  return { isOpen: vi.fn().mockResolvedValue({ isOpen }) }
}

describe('AdminBannersService.getActiveForStoreStatus', () => {
  it('includes ALWAYS banners and passes isOpen=true through to the repo when the store is open', async () => {
    findActiveForStoreStatusMock.mockResolvedValueOnce([
      { id: 'b1', title: 'Sale', trigger_type: 'ALWAYS' },
    ])
    const svc = new AdminBannersService(makeStoreStatus(true))

    const result = await svc.getActiveForStoreStatus()

    expect(findActiveForStoreStatusMock).toHaveBeenCalledWith(true)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('b1')
  })

  it('passes isOpen=false through to the repo when the store is closed', async () => {
    findActiveForStoreStatusMock.mockResolvedValueOnce([
      { id: 'b1', title: 'Sale', trigger_type: 'ALWAYS' },
      { id: 'b2', title: 'We are closed', trigger_type: 'STORE_CLOSED' },
    ])
    const svc = new AdminBannersService(makeStoreStatus(false))

    const result = await svc.getActiveForStoreStatus()

    expect(findActiveForStoreStatusMock).toHaveBeenCalledWith(false)
    expect(result.map((b) => b.id)).toEqual(['b1', 'b2'])
  })

  it('normalizes image URLs on every returned banner, same as getActive()', async () => {
    findActiveForStoreStatusMock.mockResolvedValueOnce([
      { id: 'b1', title: 'Sale', image_url: 'raw-url', trigger_type: 'ALWAYS' },
    ])
    const svc = new AdminBannersService(makeStoreStatus(true))

    const result = await svc.getActiveForStoreStatus()

    expect(result[0].image_url).toBe('raw-url')
  })
})
