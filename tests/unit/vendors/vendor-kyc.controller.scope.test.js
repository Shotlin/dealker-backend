import { describe, expect, it, vi } from 'vitest'

// Same IDOR regression class as vendors.controller.scope.test.js, for the
// vendor-kyc surface. submitKyc/getOnboardingStatus sit behind
// requireVendorScope() and must operate on the caller's own resolved
// vendorId, never the raw URL param. reviewKyc has no vendor-scope
// middleware at all (admin/compliance-only) and legitimately keeps using
// the URL param to target an arbitrary vendor.

const { VendorKycController } = await import('../../../src/modules/vendors/vendor-kyc.controller.js')

function fakeReply() {
  const reply = {}
  reply.status = vi.fn().mockReturnValue(reply)
  reply.send = vi.fn().mockReturnValue(reply)
  return reply
}

describe('VendorKycController — vendor-scope IDOR regression', () => {
  const OWN_VENDOR_ID = 'own-vendor-uuid'
  const OTHER_VENDOR_ID = 'someone-elses-vendor-uuid'

  it('submitKyc operates on the caller\'s own vendorId, never the URL param', async () => {
    const service = { submitKyc: vi.fn().mockResolvedValue({}) }
    const controller = new VendorKycController(service)
    const req = { vendorId: OWN_VENDOR_ID, params: { vendorId: OTHER_VENDOR_ID }, body: { documents: [] } }

    await controller.submitKyc(req, fakeReply())

    expect(service.submitKyc).toHaveBeenCalledWith(OWN_VENDOR_ID, { documents: [] })
  })

  it('getOnboardingStatus operates on the caller\'s own vendorId, never the URL param', async () => {
    const service = { getOnboardingStatus: vi.fn().mockResolvedValue({}) }
    const controller = new VendorKycController(service)
    const req = { vendorId: OWN_VENDOR_ID, params: { vendorId: OTHER_VENDOR_ID } }

    await controller.getOnboardingStatus(req, fakeReply())

    expect(service.getOnboardingStatus).toHaveBeenCalledWith(OWN_VENDOR_ID)
  })

  it('reviewKyc is intentionally unchanged — admin-only, no vendor-scope middleware, targets the URL vendorId', async () => {
    const service = { reviewKyc: vi.fn().mockResolvedValue({}) }
    const controller = new VendorKycController(service)
    const req = {
      vendorId: undefined,
      params: { vendorId: OTHER_VENDOR_ID },
      userId: 'reviewer-1',
      user: { id: 'reviewer-1' },
      body: { action: 'APPROVE' },
    }

    await controller.reviewKyc(req, fakeReply())

    expect(service.reviewKyc).toHaveBeenCalledWith(OTHER_VENDOR_ID, 'reviewer-1', { action: 'APPROVE' })
  })
})
