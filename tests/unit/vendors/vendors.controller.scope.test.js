import { describe, expect, it, vi } from 'vitest'

// Regression test for a cross-vendor IDOR: getById/update/updateProfile/
// updateSettings all sit behind `requireVendorScope()`, which resolves
// `request.vendorId` from the CALLER's own vendor JWT (never the URL) for a
// vendor-scoped token. The controller used to read `req.params.vendorId`
// directly instead — so a vendor JWT could view/edit ANY other vendor's
// profile just by putting a different UUID in the URL, since the scope
// middleware only validated the caller's OWN membership, never that the URL
// target matched it. These tests prove the controller now uses the
// middleware-resolved `req.vendorId`, ignoring whatever the URL says.

const { VendorsController } = await import('../../../src/modules/vendors/vendors.controller.js')

function fakeReply() {
  const reply = {};
  reply.status = vi.fn().mockReturnValue(reply)
  reply.send = vi.fn().mockReturnValue(reply)
  return reply
}

describe('VendorsController — vendor-scope IDOR regression', () => {
  const OWN_VENDOR_ID = 'own-vendor-uuid'
  const OTHER_VENDOR_ID = 'someone-elses-vendor-uuid'

  it('getById operates on the caller\'s own vendorId, never the URL param', async () => {
    const service = { getVendorById: vi.fn().mockResolvedValue({ id: OWN_VENDOR_ID }) }
    const controller = new VendorsController(service)
    const req = { vendorId: OWN_VENDOR_ID, params: { vendorId: OTHER_VENDOR_ID } }

    await controller.getById(req, fakeReply())

    expect(service.getVendorById).toHaveBeenCalledWith(OWN_VENDOR_ID)
    expect(service.getVendorById).not.toHaveBeenCalledWith(OTHER_VENDOR_ID)
  })

  it('update operates on the caller\'s own vendorId, never the URL param', async () => {
    const service = { updateVendor: vi.fn().mockResolvedValue({}) }
    const controller = new VendorsController(service)
    const req = { vendorId: OWN_VENDOR_ID, params: { vendorId: OTHER_VENDOR_ID }, body: { name: 'x' } }

    await controller.update(req, fakeReply())

    expect(service.updateVendor).toHaveBeenCalledWith(OWN_VENDOR_ID, { name: 'x' })
  })

  it('updateProfile operates on the caller\'s own vendorId, never the URL param', async () => {
    const service = { updateProfile: vi.fn().mockResolvedValue({}) }
    const controller = new VendorsController(service)
    const req = { vendorId: OWN_VENDOR_ID, params: { vendorId: OTHER_VENDOR_ID }, body: { gstin: 'GST1' } }

    await controller.updateProfile(req, fakeReply())

    expect(service.updateProfile).toHaveBeenCalledWith(OWN_VENDOR_ID, { gstin: 'GST1' })
  })

  it('updateSettings operates on the caller\'s own vendorId, never the URL param', async () => {
    const service = { updateSettings: vi.fn().mockResolvedValue({}) }
    const controller = new VendorsController(service)
    const req = { vendorId: OWN_VENDOR_ID, params: { vendorId: OTHER_VENDOR_ID }, body: { commission_rate: 5 } }

    await controller.updateSettings(req, fakeReply())

    expect(service.updateSettings).toHaveBeenCalledWith(OWN_VENDOR_ID, { commission_rate: 5 })
  })

  it('an admin caller (request.vendorId resolved from the URL by the middleware) still targets the intended vendor', async () => {
    // For a platform/admin caller, requireVendorScope() itself sets
    // request.vendorId = the URL's vendorId (after validating it exists) —
    // this is NOT the controller reading req.params directly, it's the
    // already-resolved value the middleware trusted for an admin. Proves the
    // fix doesn't accidentally break legitimate admin-targets-a-vendor use.
    const service = { getVendorById: vi.fn().mockResolvedValue({ id: OTHER_VENDOR_ID }) }
    const controller = new VendorsController(service)
    const req = { vendorId: OTHER_VENDOR_ID, params: { vendorId: OTHER_VENDOR_ID } }

    await controller.getById(req, fakeReply())

    expect(service.getVendorById).toHaveBeenCalledWith(OTHER_VENDOR_ID)
  })
})
