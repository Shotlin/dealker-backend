/**
 * Catalogue & Product Proposal Service — Business Logic & State Machine Engine
 * Source of truth: Blueprint §06.2, Phase 3A
 *
 * @module modules/catalogue/catalogue.service
 */

import { logger } from '../../config/logger.js'

function generateSlug(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// State Machine Transition Matrix per Blueprint §06.2
const PROPOSAL_TRANSITIONS = {
  DRAFT: ['SUBMITTED'],
  CORRECTION_REQUIRED: ['SUBMITTED'],
  SUBMITTED: ['UNDER_REVIEW'],
  UNDER_REVIEW: ['APPROVED', 'CORRECTION_REQUIRED', 'REJECTED'],
  APPROVED: ['PUBLISHED'],
  PUBLISHED: [],
  REJECTED: [],
}

export class CatalogueService {
  /**
   * @param {import('./catalogue.repository.js').CatalogueRepository} repository
   */
  constructor(repository) {
    this.repository = repository
  }

  // ─── BRANDS ─────────────────────────────────────────
  async createBrand(data) {
    const slug = data.slug || generateSlug(data.name)
    return this.repository.createBrand({ ...data, slug })
  }

  async listBrands() {
    return this.repository.listBrands()
  }

  // ─── PROPOSAL WORKFLOW ──────────────────────────────
  validateStateTransition(currentStatus, nextStatus) {
    const allowed = PROPOSAL_TRANSITIONS[currentStatus] || []
    if (!allowed.includes(nextStatus)) {
      const err = new Error(`Invalid state transition from ${currentStatus} to ${nextStatus}`)
      err.statusCode = 400
      err.code = 'INVALID_STATE_TRANSITION'
      throw err
    }
  }

  async createProposal(vendorId, data) {
    const slug = data.slug || generateSlug(data.title)

    if (data.sku) {
      const duplicate = await this.repository.findProposalDuplicateSku(vendorId, data.sku)
      if (duplicate) {
        const err = new Error('Product proposal with this SKU already exists for vendor')
        err.statusCode = 409
        err.code = 'DUPLICATE_PROPOSAL_SKU'
        throw err
      }
    }

    const proposal = await this.repository.createProposal(vendorId, { ...data, slug })
    logger.info({ vendorId, proposalId: proposal.id, title: proposal.title }, 'Product proposal created')
    return proposal
  }

  async submitProposal(proposalId, vendorId) {
    const proposal = await this.repository.findProposalById(proposalId)
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

    const targetStatus = 'SUBMITTED'
    this.validateStateTransition(proposal.status, targetStatus)

    const updated = await this.repository.updateProposalStatus(proposalId, targetStatus)
    await this.repository.logProposalReview({
      proposalId,
      action: 'SUBMIT',
      previousStatus: proposal.status,
      newStatus: targetStatus,
      comments: 'Proposal submitted by vendor',
    })

    logger.info({ proposalId, vendorId }, 'Product proposal submitted successfully')
    return updated
  }

  async reviewProposal(proposalId, reviewerId, reviewPayload) {
    const proposal = await this.repository.findProposalById(proposalId)
    if (!proposal) {
      const err = new Error('Product proposal not found')
      err.statusCode = 404
      err.code = 'PROPOSAL_NOT_FOUND'
      throw err
    }

    const { action, comments } = reviewPayload
    let targetStatus

    switch (action) {
      case 'START_REVIEW':
        targetStatus = 'UNDER_REVIEW'
        break
      case 'APPROVE':
        targetStatus = 'APPROVED'
        break
      case 'REQUEST_CORRECTION':
        targetStatus = 'CORRECTION_REQUIRED'
        break
      case 'REJECT':
        targetStatus = 'REJECTED'
        break
      case 'PUBLISH':
        targetStatus = 'PUBLISHED'
        break
      default:
        throw new Error(`Unsupported review action: ${action}`)
    }

    this.validateStateTransition(proposal.status, targetStatus)

    const updated = await this.repository.updateProposalStatus(proposalId, targetStatus)
    await this.repository.logProposalReview({
      proposalId,
      reviewerId,
      action,
      previousStatus: proposal.status,
      newStatus: targetStatus,
      comments: comments || null,
    })

    // If published, automatically create/link master product entry
    if (targetStatus === 'PUBLISHED') {
      await this.repository.createMasterProductFromProposal(proposal)
      logger.info({ proposalId }, 'Master product published from approved proposal')
    }

    logger.info({ proposalId, reviewerId, action, targetStatus }, 'Product proposal review action completed')
    return updated
  }

  async getProposalById(proposalId) {
    const proposal = await this.repository.findProposalById(proposalId)
    if (!proposal) {
      const err = new Error('Product proposal not found')
      err.statusCode = 404
      err.code = 'PROPOSAL_NOT_FOUND'
      throw err
    }
    return proposal
  }

  async listProposals(params) {
    return this.repository.listProposals(params)
  }
}
