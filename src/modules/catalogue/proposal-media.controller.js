/**
 * Proposal Media Controller — HTTP Handler Layer for Proposal Media, Variants & Specs
 * Source of truth: Blueprint §06.2, Phase 3B
 *
 * @module modules/catalogue/proposal-media.controller
 */

export class ProposalMediaController {
  /**
   * @param {import('./proposal-media.service.js').ProposalMediaService} service
   */
  constructor(service) {
    this.service = service
  }

  addMedia = async (req, reply) => {
    const { proposalId } = req.params
    const vendorId = req.vendorId || req.user.vendorId
    const media = await this.service.addMedia(proposalId, vendorId, req.body)
    return reply.status(201).send({ success: true, data: media })
  }

  getMedia = async (req, reply) => {
    const { proposalId } = req.params
    const media = await this.service.getMedia(proposalId)
    return reply.status(200).send({ success: true, data: media })
  }

  deleteMedia = async (req, reply) => {
    const { proposalId, mediaId } = req.params
    const vendorId = req.vendorId || req.user.vendorId
    await this.service.deleteMedia(proposalId, mediaId, vendorId)
    return reply.status(200).send({ success: true, message: 'Media deleted successfully' })
  }

  addVariant = async (req, reply) => {
    const { proposalId } = req.params
    const vendorId = req.vendorId || req.user.vendorId
    const variant = await this.service.addVariant(proposalId, vendorId, req.body)
    return reply.status(201).send({ success: true, data: variant })
  }

  getVariants = async (req, reply) => {
    const { proposalId } = req.params
    const variants = await this.service.getVariants(proposalId)
    return reply.status(200).send({ success: true, data: variants })
  }

  addSpecification = async (req, reply) => {
    const { proposalId } = req.params
    const vendorId = req.vendorId || req.user.vendorId
    const spec = await this.service.addSpecification(proposalId, vendorId, req.body)
    return reply.status(201).send({ success: true, data: spec })
  }

  getSpecifications = async (req, reply) => {
    const { proposalId } = req.params
    const specs = await this.service.getSpecifications(proposalId)
    return reply.status(200).send({ success: true, data: specs })
  }
}
