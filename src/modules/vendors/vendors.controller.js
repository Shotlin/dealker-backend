/**
 * Vendor Controller — HTTP Handler Layer for Vendor Domain
 * Source of truth: Blueprint §06.1, Phase 2A
 *
 * @module modules/vendors/vendors.controller
 */

export class VendorsController {
  /**
   * @param {import('./vendors.service.js').VendorsService} service
   */
  constructor(service) {
    this.service = service
  }

  create = async (req, reply) => {
    const vendor = await this.service.createVendor(req.body)
    return reply.status(201).send({ success: true, data: vendor })
  }

  // getById/update/updateProfile/updateSettings all carry `requireVendorScope()`
  // in their preHandler chain (vendors.routes.js), which resolves
  // `request.vendorId` from the CALLER's own JWT for a vendor-scoped token —
  // never from the URL — and only trusts the `:vendorId` URL param for a
  // platform/admin caller. Reading `req.params.vendorId` directly here
  // instead bypassed that entirely: any vendor-scoped JWT could view/edit
  // ANY other vendor's profile just by putting a different UUID in the URL,
  // since the scope check only validated the CALLER's own membership, not
  // that the caller and the URL target were the same vendor.

  getById = async (req, reply) => {
    const vendor = await this.service.getVendorById(req.vendorId)
    return reply.status(200).send({ success: true, data: vendor })
  }

  update = async (req, reply) => {
    const updated = await this.service.updateVendor(req.vendorId, req.body)
    return reply.status(200).send({ success: true, data: updated })
  }

  updateStatus = async (req, reply) => {
    const { vendorId } = req.params
    const { status, reason } = req.body
    const updated = await this.service.updateVendorStatus(vendorId, status, reason)
    return reply.status(200).send({ success: true, data: updated })
  }

  delete = async (req, reply) => {
    const { vendorId } = req.params
    await this.service.deleteVendor(vendorId)
    return reply.status(200).send({ success: true, message: 'Vendor deleted successfully' })
  }

  list = async (req, reply) => {
    const result = await this.service.listVendors(req.query)
    return reply.status(200).send({ success: true, ...result })
  }

  updateProfile = async (req, reply) => {
    const updated = await this.service.updateProfile(req.vendorId, req.body)
    return reply.status(200).send({ success: true, data: updated })
  }

  updateSettings = async (req, reply) => {
    const updated = await this.service.updateSettings(req.vendorId, req.body)
    return reply.status(200).send({ success: true, data: updated })
  }
}
