/**
 * Vendor KYC & Onboarding Service — State Machine Engine & Business Logic
 * Source of truth: Blueprint §06.1, Phase 2B
 *
 * @module modules/vendors/vendor-kyc.service
 */

import { ERROR_CODES } from '../../constants/errors.js'
import { logger } from '../../config/logger.js'

// Strict State Transition Matrix per Blueprint §06.1
const ALLOWED_TRANSITIONS = {
  PENDING_ONBOARDING: ['KYC_SUBMITTED'],
  CORRECTION_REQUIRED: ['KYC_SUBMITTED'],
  KYC_SUBMITTED: ['UNDER_REVIEW'],
  UNDER_REVIEW: ['VERIFIED', 'CORRECTION_REQUIRED', 'REJECTED'],
  VERIFIED: ['ACTIVE'],
  ACTIVE: ['SUSPENDED', 'DEACTIVATED'],
  SUSPENDED: ['ACTIVE'],
  DEACTIVATED: [],
  REJECTED: [],
}

export class VendorKycService {
  /**
   * @param {import('./vendors.repository.js').VendorsRepository} vendorRepository
   * @param {import('./vendor-kyc.repository.js').VendorKycRepository} kycRepository
   */
  constructor(vendorRepository, kycRepository) {
    this.vendorRepository = vendorRepository
    this.kycRepository = kycRepository
  }

  /**
   * Validate state transition against strict matrix
   * @param {string} currentStatus
   * @param {string} nextStatus
   */
  validateStateTransition(currentStatus, nextStatus) {
    const allowed = ALLOWED_TRANSITIONS[currentStatus] || []
    if (!allowed.includes(nextStatus)) {
      const err = new Error(`Invalid state transition from ${currentStatus} to ${nextStatus}`)
      err.statusCode = 400
      err.code = 'INVALID_STATE_TRANSITION'
      throw err
    }
  }

  /**
   * Vendor submits KYC documents & metadata
   * @param {string} vendorId
   * @param {object} payload
   * @returns {Promise<object>}
   */
  async submitKyc(vendorId, payload) {
    const vendor = await this.vendorRepository.findById(vendorId)
    if (!vendor) {
      const err = new Error('Vendor not found')
      err.statusCode = 404
      err.code = 'VENDOR_NOT_FOUND'
      throw err
    }

    // Validate state transition (allows PENDING_ONBOARDING -> KYC_SUBMITTED or CORRECTION_REQUIRED -> KYC_SUBMITTED)
    const targetStatus = 'KYC_SUBMITTED'
    this.validateStateTransition(vendor.status, targetStatus)

    // Save document metadata
    const savedDocs = []
    for (const doc of payload.documents) {
      const saved = await this.kycRepository.saveDocument(vendorId, doc)
      savedDocs.push(saved)
    }

    // Update profile numbers if provided
    if (payload.profile) {
      await this.vendorRepository.updateProfile(vendorId, payload.profile)
    }

    // Update vendor status to KYC_SUBMITTED
    const updatedVendor = await this.kycRepository.updateVendorStatus(vendorId, targetStatus)

    // Log review action
    await this.kycRepository.logReview({
      vendor_id: vendorId,
      action: 'SUBMIT',
      previous_status: vendor.status,
      new_status: targetStatus,
      comments: 'KYC documents submitted by vendor',
    })

    logger.info({ vendorId, docCount: savedDocs.length }, 'Vendor KYC submitted successfully')
    return {
      vendor: updatedVendor,
      documents: savedDocs,
    }
  }

  /**
   * Admin / Compliance reviewer performs review action
   * @param {string} vendorId
   * @param {string} reviewerId
   * @param {object} reviewPayload
   * @returns {Promise<object>}
   */
  async reviewKyc(vendorId, reviewerId, reviewPayload) {
    const vendor = await this.vendorRepository.findById(vendorId)
    if (!vendor) {
      const err = new Error('Vendor not found')
      err.statusCode = 404
      err.code = 'VENDOR_NOT_FOUND'
      throw err
    }

    const { action, comments } = reviewPayload
    let targetStatus

    switch (action) {
      case 'START_REVIEW':
        targetStatus = 'UNDER_REVIEW'
        break
      case 'APPROVE':
        targetStatus = 'VERIFIED'
        break
      case 'REQUEST_CORRECTION':
        targetStatus = 'CORRECTION_REQUIRED'
        break
      case 'REJECT':
        targetStatus = 'REJECTED'
        break
      default:
        throw new Error(`Unsupported review action: ${action}`)
    }

    // Validate state transition
    this.validateStateTransition(vendor.status, targetStatus)

    // Update status
    const updatedVendor = await this.kycRepository.updateVendorStatus(vendorId, targetStatus)

    // Log review
    const reviewLog = await this.kycRepository.logReview({
      vendor_id: vendorId,
      reviewer_id: reviewerId,
      action,
      previous_status: vendor.status,
      new_status: targetStatus,
      comments: comments || null,
    })

    logger.info({ vendorId, reviewerId, action, targetStatus }, 'Vendor KYC review action completed')
    return {
      vendor: updatedVendor,
      reviewLog,
    }
  }

  /**
   * Get onboarding progress & KYC status for vendor
   * @param {string} vendorId
   * @returns {Promise<object>}
   */
  async getOnboardingStatus(vendorId) {
    const vendor = await this.vendorRepository.findById(vendorId)
    if (!vendor) {
      const err = new Error('Vendor not found')
      err.statusCode = 404
      err.code = 'VENDOR_NOT_FOUND'
      throw err
    }

    const documents = await this.kycRepository.getVendorDocuments(vendorId)
    const history = await this.kycRepository.getReviewHistory(vendorId)

    return {
      vendorId: vendor.id,
      status: vendor.status,
      isActive: vendor.is_active,
      documents,
      history,
    }
  }
}
