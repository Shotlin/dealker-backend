import { beforeEach, describe, expect, it, vi } from 'vitest'

// Regression: a vendor whose KYC was approved from the dashboard (/admin/vendor-kyc/:id/review) ended up
// ACTIVE with NO shop row, so every product submit said "Complete your KYC first". Approval now provisions the
// shop, and listing creation repairs the same situation for vendors approved before the fix.

vi.hoisted(() => {
  const d = { JWT_ACCESS_SECRET: 'a'.repeat(64), JWT_REFRESH_SECRET: 'b'.repeat(64), COOKIE_SECRET: 'c'.repeat(32),
    DB_NAME: 'x', DB_USER: 'x', DB_PASSWORD: 'x' }
  for (const [k, v] of Object.entries(d)) process.env[k] ||= v
})

const h = vi.hoisted(() => ({ ensureShop: vi.fn(), client: { query: vi.fn(), release: vi.fn() }, query: vi.fn() }))
vi.mock('../../../src/config/database.js', () => ({ query: h.query, getClient: async () => h.client }))
vi.mock('../../../src/config/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../../../src/modules/vendors/vendors.repository.js', () => ({ VendorsRepository: class { ensureShop(...a) { return h.ensureShop(...a) } } }))
vi.mock('../../../src/modules/subscriptions/subscriptions.service.js', () => ({
  SubscriptionsService: class { async assertCanList() {} },
}))
vi.mock('../../../src/modules/qc/qc.service.js', () => ({ QcService: class {}, QC_STATUSES: [] }))

const { listingsService } = await import('../../../src/modules/listings/listings.service.js')

const VENDOR = '5355a067-3152-4383-a4e4-caa69ca1783d'
const input = { name: 'iPhone 16', categoryId: 'c1', condition: 'REFURBISHED', stock: 1, price: 50000, images: ['a', 'b', 'c'] }

/** shopRows: what the "active shop" SELECT returns on each call; status: the vendor's status. */
function db({ shopRows, status }) {
  const shops = [...shopRows]
  h.client.query.mockImplementation(async (sql) => {
    if (/^(BEGIN|ROLLBACK)/.test(sql)) return { rows: [] }
    if (/FROM shops s JOIN vendors v/.test(sql)) return { rows: shops.shift() ?? [] }
    if (/SELECT status FROM vendors/.test(sql)) return { rows: status ? [{ status }] : [] }
    if (/INSERT INTO products/.test(sql)) throw Object.assign(new Error('REACHED_PRODUCT_INSERT'), { reached: true })
    return { rows: [] }
  })
}

describe('listingsService.create — vendor shop provisioning', () => {
  beforeEach(() => { h.ensureShop.mockReset(); h.client.query.mockReset() })

  it('an ACTIVE vendor with no shop gets one created and the listing goes ahead', async () => {
    db({ shopRows: [[], [{ id: 'shop-1' }]], status: 'ACTIVE' })
    h.ensureShop.mockResolvedValue({ ok: true, shopId: 'shop-1' })
    await expect(listingsService.create(input, { vendorId: VENDOR })).rejects.toMatchObject({ reached: true })
    expect(h.ensureShop).toHaveBeenCalledWith(VENDOR, h.client)
  })

  it('a vendor that already has an active shop never triggers provisioning', async () => {
    db({ shopRows: [[{ id: 'shop-1' }]], status: 'ACTIVE' })
    await expect(listingsService.create(input, { vendorId: VENDOR })).rejects.toMatchObject({ reached: true })
    expect(h.ensureShop).not.toHaveBeenCalled()
  })

  it('an unfinished business profile gives a clear 409, not "complete KYC"', async () => {
    db({ shopRows: [[]], status: 'ACTIVE' })
    h.ensureShop.mockResolvedValue({ ok: false, message: 'Vendor has not completed their business profile yet (missing: map location).' })
    await expect(listingsService.create(input, { vendorId: VENDOR })).rejects.toMatchObject({ statusCode: 409, code: 'SHOP_PROFILE_INCOMPLETE' })
  })

  it('a vendor still in onboarding is still told to finish KYC and no shop is created', async () => {
    db({ shopRows: [[]], status: 'PENDING_ONBOARDING' })
    await expect(listingsService.create(input, { vendorId: VENDOR })).rejects.toMatchObject({ statusCode: 409, code: 'NO_ACTIVE_SHOP' })
    expect(h.ensureShop).not.toHaveBeenCalled()
  })
})

describe('kycAdmin.review — approval leaves a live shop behind', () => {
  it('APPROVE / ACTIVATE provision the shop; an incomplete profile blocks with 422', async () => {
    const { kycAdmin: svc } = await import('../../../src/modules/vendor-kyc-admin/kyc-admin.service.js')
    h.client.query.mockReset()
    h.client.query.mockImplementation(async (sql) => {
      if (/FROM vendors WHERE id/.test(sql)) return { rows: [{ id: VENDOR, status: 'KYC_SUBMITTED', is_active: false }] }
      if (/FROM vendor_documents/.test(sql)) return { rows: [{ status: 'VERIFIED', document_type: 'PAN_CARD' }] }
      return { rows: [], rowCount: 1 }
    })
    h.query.mockResolvedValue({ rows: [], rowCount: 0 })
    vi.spyOn(svc, 'detail').mockResolvedValue({ ok: true })

    h.ensureShop.mockResolvedValue({ ok: false, message: 'missing map location' })
    await expect(svc.review(VENDOR, { action: 'APPROVE' }, 'admin-1')).rejects.toMatchObject({ statusCode: 422, code: 'SHOP_PROFILE_INCOMPLETE' })
    expect(h.client.query.mock.calls.some(([s]) => /UPDATE vendors SET status/.test(s))).toBe(false)

    h.ensureShop.mockResolvedValue({ ok: true, shopId: 's1' })
    await svc.review(VENDOR, { action: 'APPROVE' }, 'admin-1')
    expect(h.ensureShop).toHaveBeenLastCalledWith(VENDOR, h.client)
    expect(h.client.query.mock.calls.some(([s]) => /UPDATE vendors SET status/.test(s))).toBe(true)
  })

  it('SUSPEND does not try to provision a shop', async () => {
    const { kycAdmin: svc } = await import('../../../src/modules/vendor-kyc-admin/kyc-admin.service.js')
    h.ensureShop.mockReset()
    h.client.query.mockImplementation(async (sql) => {
      if (/FROM vendors WHERE id/.test(sql)) return { rows: [{ id: VENDOR, status: 'ACTIVE', is_active: true }] }
      return { rows: [], rowCount: 1 }
    })
    await svc.review(VENDOR, { action: 'SUSPEND', comments: 'policy' }, 'admin-1')
    expect(h.ensureShop).not.toHaveBeenCalled()
  })
})
