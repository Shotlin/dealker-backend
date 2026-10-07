/**
 * Catalogue Controller — HTTP Handler Layer for Brands, Categories, and Proposals
 * Source of truth: Blueprint §06.2, Phase 3A
 *
 * @module modules/catalogue/catalogue.controller
 */

export class CatalogueController {
  /**
   * @param {import('./catalogue.service.js').CatalogueService} service
   */
  constructor(service) {
    this.service = service
  }

  createBrand = async (req, reply) => {
    const brand = await this.service.createBrand(req.body)
    return reply.status(201).send({ success: true, data: brand })
  }

  listBrands = async (req, reply) => {
    const brands = await this.service.listBrands()
    return reply.status(200).send({ success: true, data: brands })
  }

  createProposal = async (req, reply) => {
    const vendorId = req.vendorId || req.user.vendorId || req.body.vendor_id
    const proposal = await this.service.createProposal(vendorId, req.body)
    return reply.status(201).send({ success: true, data: proposal })
  }

  submitProposal = async (req, reply) => {
    const { proposalId } = req.params
    const vendorId = req.vendorId || req.user.vendorId
    const updated = await this.service.submitProposal(proposalId, vendorId)
    return reply.status(200).send({ success: true, data: updated })
  }

  reviewProposal = async (req, reply) => {
    const { proposalId } = req.params
    const reviewerId = req.userId || req.user.id
    const updated = await this.service.reviewProposal(proposalId, reviewerId, req.body)
    return reply.status(200).send({ success: true, data: updated })
  }

  getProposalById = async (req, reply) => {
    const { proposalId } = req.params
    const proposal = await this.service.getProposalById(proposalId)
    return reply.status(200).send({ success: true, data: proposal })
  }

  listProposals = async (req, reply) => {
    const queryParams = {
      ...req.query,
      vendorId: req.vendorId || req.query.vendor_id || null,
    }
    const result = await this.service.listProposals(queryParams)
    return reply.status(200).send({ success: true, ...result })
  }
}
