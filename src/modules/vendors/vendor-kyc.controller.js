/**
 * Vendor KYC Controller — HTTP Handler Layer for Onboarding & KYC Workflow
 * Source of truth: Blueprint §06.1, Phase 2B
 *
 * @module modules/vendors/vendor-kyc.controller
 */

export class VendorKycController {
  /**
   * @param {import('./vendor-kyc.service.js').VendorKycService} service
   */
  constructor(service) {
    this.service = service
  }

  // submitKyc/getOnboardingStatus both carry `requireVendorScope()`, which
  // resolves `request.vendorId` from the caller's own vendor JWT (never the
  // URL) for a vendor-scoped token — reading `req.params.vendorId` directly
  // let any vendor submit/view KYC documents for a DIFFERENT vendor id, the
  // same class of bug fixed in vendors.controller.js. `reviewKyc` is
  // intentionally left on `req.params.vendorId` — it has no vendor-scope
  // middleware at all (admin/compliance-only, gated by
  // `vendor_documents.verify`), so it's meant to target an arbitrary vendor.

  submitKyc = async (req, reply) => {
    const result = await this.service.submitKyc(req.vendorId, req.body)
    return reply.status(200).send({ success: true, data: result })
  }

  reviewKyc = async (req, reply) => {
    const { vendorId } = req.params
    const reviewerId = req.userId || req.user.id
    const result = await this.service.reviewKyc(vendorId, reviewerId, req.body)
    return reply.status(200).send({ success: true, data: result })
  }

  getOnboardingStatus = async (req, reply) => {
    const result = await this.service.getOnboardingStatus(req.vendorId)
    return reply.status(200).send({ success: true, data: result })
  }
}
