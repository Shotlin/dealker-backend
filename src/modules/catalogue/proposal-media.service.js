/**
 * Proposal Media Service — Business Logic for Media, Variants & Specifications
 * Source of truth: Blueprint §06.2, Phase 3B
 *
 * @module modules/catalogue/proposal-media.service
 */

import { logger } from '../../config/logger.js'

export class ProposalMediaService {
  /**
   * @param {import('./proposal-media.repository.js').ProposalMediaRepository} repository
   * @param {import('./catalogue.repository.js').CatalogueRepository} proposalRepository
   */
  constructor(repository, proposalRepository) {
    this.repository = repository
    this.proposalRepository = proposalRepository
  }

  async validateProposalState(proposalId, vendorId) {
    const proposal = await this.proposalRepository.findProposalById(proposalId)
    if (!proposal) {
      const err = new Error('Product proposal not found')
      err.statusCode = 404
      err.code = 'PROPOSAL_NOT_FOUND'
      throw err
    }

    if (proposal.vendor_id !== vendorId) {
      const err = new Error('Forbidden — proposal does not belong to your vendor')
      err.statusCode = 403
      err.code = 'CROSS_SHOP_ACCESS_DENIED'
      throw err
    }

    if (proposal.status === 'PUBLISHED') {
      const err = new Error('Cannot modify proposal media or variants after it is PUBLISHED')
      err.statusCode = 400
      err.code = 'PROPOSAL_PUBLISHED_LOCKED'
      throw err
    }

    return proposal
  }

  // ─── MEDIA ──────────────────────────────────────────
  async addMedia(proposalId, vendorId, mediaData) {
    await this.validateProposalState(proposalId, vendorId)
    const media = await this.repository.addMedia(proposalId, mediaData)
    logger.info({ proposalId, mediaId: media.id, type: media.media_type }, 'Proposal media added')
    return media
  }

  async getMedia(proposalId) {
    return this.repository.getProposalMedia(proposalId)
  }

  async deleteMedia(proposalId, mediaId, vendorId) {
    await this.validateProposalState(proposalId, vendorId)
    const deleted = await this.repository.deleteMedia(mediaId)
    logger.info({ proposalId, mediaId }, 'Proposal media deleted')
    return deleted
  }

  // ─── VARIANTS ───────────────────────────────────────
  async addVariant(proposalId, vendorId, variantData) {
    await this.validateProposalState(proposalId, vendorId)

    const duplicate = await this.repository.findDuplicateVariant(proposalId, variantData.sku, variantData.attributes)
    if (duplicate) {
      const err = new Error('Variant with this SKU or attribute combination already exists')
      err.statusCode = 409
      err.code = 'DUPLICATE_VARIANT'
      throw err
    }

    const variant = await this.repository.addVariant(proposalId, variantData)
    logger.info({ proposalId, variantId: variant.id, sku: variant.sku }, 'Proposal variant added')
    return variant
  }

  async getVariants(proposalId) {
    return this.repository.getProposalVariants(proposalId)
  }

  // ─── SPECIFICATIONS ─────────────────────────────────
  async addSpecification(proposalId, vendorId, specData) {
    await this.validateProposalState(proposalId, vendorId)
    const spec = await this.repository.addSpecification(proposalId, specData)
    logger.info({ proposalId, key: spec.key }, 'Proposal specification added')
    return spec
  }

  async getSpecifications(proposalId) {
    return this.repository.getProposalSpecifications(proposalId)
  }
}
