import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VendorKycService } from '../../../src/modules/vendors/vendor-kyc.service.js'

describe('Phase 2B Vendor KYC & Onboarding Workflow Unit Tests', () => {
  let vendorRepoMock
  let kycRepoMock
  let service

  beforeEach(() => {
    vendorRepoMock = {
      findById: vi.fn(),
      updateProfile: vi.fn(),
    }
    kycRepoMock = {
      saveDocument: vi.fn(),
      getVendorDocuments: vi.fn(),
      logReview: vi.fn(),
      getReviewHistory: vi.fn(),
      updateVendorStatus: vi.fn(),
    }
    service = new VendorKycService(vendorRepoMock, kycRepoMock)
  })

  describe('State Machine & Transitions', () => {
    it('allows valid transition PENDING_ONBOARDING -> KYC_SUBMITTED', () => {
      expect(() => service.validateStateTransition('PENDING_ONBOARDING', 'KYC_SUBMITTED')).not.toThrow()
    })

    it('allows valid transition UNDER_REVIEW -> VERIFIED', () => {
      expect(() => service.validateStateTransition('UNDER_REVIEW', 'VERIFIED')).not.toThrow()
    })

    it('allows valid transition UNDER_REVIEW -> CORRECTION_REQUIRED', () => {
      expect(() => service.validateStateTransition('UNDER_REVIEW', 'CORRECTION_REQUIRED')).not.toThrow()
    })

    it('allows resubmission CORRECTION_REQUIRED -> KYC_SUBMITTED', () => {
      expect(() => service.validateStateTransition('CORRECTION_REQUIRED', 'KYC_SUBMITTED')).not.toThrow()
    })

    it('rejects invalid state transition PENDING_ONBOARDING -> VERIFIED with 400 INVALID_STATE_TRANSITION', () => {
      expect(() => service.validateStateTransition('PENDING_ONBOARDING', 'VERIFIED')).toThrow('Invalid state transition')
    })
  })

  describe('VendorKycService.submitKyc', () => {
    it('submits KYC documents and advances status from PENDING_ONBOARDING to KYC_SUBMITTED', async () => {
      vendorRepoMock.findById.mockResolvedValueOnce({ id: 'v-1', status: 'PENDING_ONBOARDING' })
      kycRepoMock.saveDocument.mockResolvedValueOnce({ id: 'doc-1', document_type: 'GSTIN_CERTIFICATE' })
      kycRepoMock.updateVendorStatus.mockResolvedValueOnce({ id: 'v-1', status: 'KYC_SUBMITTED' })

      const payload = {
        documents: [{ document_type: 'GSTIN_CERTIFICATE', file_key: 'keys/gstin.pdf' }],
      }

      const res = await service.submitKyc('v-1', payload)

      expect(kycRepoMock.saveDocument).toHaveBeenCalledOnce()
      expect(kycRepoMock.updateVendorStatus).toHaveBeenCalledWith('v-1', 'KYC_SUBMITTED')
      expect(res.vendor.status).toBe('KYC_SUBMITTED')
    })
  })

  describe('VendorKycService.reviewKyc', () => {
    it('approves KYC and advances status from UNDER_REVIEW to VERIFIED', async () => {
      vendorRepoMock.findById.mockResolvedValueOnce({ id: 'v-1', status: 'UNDER_REVIEW' })
      kycRepoMock.updateVendorStatus.mockResolvedValueOnce({ id: 'v-1', status: 'VERIFIED', is_active: true })
      kycRepoMock.logReview.mockResolvedValueOnce({ id: 'rev-1', action: 'APPROVE' })

      const res = await service.reviewKyc('v-1', 'rev-user-1', { action: 'APPROVE', comments: 'Documents verified' })

      expect(kycRepoMock.updateVendorStatus).toHaveBeenCalledWith('v-1', 'VERIFIED')
      expect(res.vendor.status).toBe('VERIFIED')
    })

    it('requests correction and transitions UNDER_REVIEW -> CORRECTION_REQUIRED', async () => {
      vendorRepoMock.findById.mockResolvedValueOnce({ id: 'v-1', status: 'UNDER_REVIEW' })
      kycRepoMock.updateVendorStatus.mockResolvedValueOnce({ id: 'v-1', status: 'CORRECTION_REQUIRED' })

      const res = await service.reviewKyc('v-1', 'rev-user-1', { action: 'REQUEST_CORRECTION', comments: 'Re-upload GSTIN' })

      expect(kycRepoMock.updateVendorStatus).toHaveBeenCalledWith('v-1', 'CORRECTION_REQUIRED')
      expect(res.vendor.status).toBe('CORRECTION_REQUIRED')
    })

    it('rejects KYC and transitions UNDER_REVIEW -> REJECTED', async () => {
      vendorRepoMock.findById.mockResolvedValueOnce({ id: 'v-1', status: 'UNDER_REVIEW' })
      kycRepoMock.updateVendorStatus.mockResolvedValueOnce({ id: 'v-1', status: 'REJECTED' })

      const res = await service.reviewKyc('v-1', 'rev-user-1', { action: 'REJECT', comments: 'Fraudulent documents' })

      expect(kycRepoMock.updateVendorStatus).toHaveBeenCalledWith('v-1', 'REJECTED')
      expect(res.vendor.status).toBe('REJECTED')
    })
  })
})
