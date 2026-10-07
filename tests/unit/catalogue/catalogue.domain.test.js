import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CatalogueService } from '../../../src/modules/catalogue/catalogue.service.js'

describe('Phase 3A Catalogue & Product Proposals Unit Tests', () => {
  let repositoryMock
  let service

  beforeEach(() => {
    repositoryMock = {
      createBrand: vi.fn(),
      findBrandById: vi.fn(),
      listBrands: vi.fn(),
      findProposalDuplicateSku: vi.fn(),
      createProposal: vi.fn(),
      findProposalById: vi.fn(),
      updateProposal: vi.fn(),
      updateProposalStatus: vi.fn(),
      logProposalReview: vi.fn(),
      listProposals: vi.fn(),
      createMasterProductFromProposal: vi.fn(),
    }
    service = new CatalogueService(repositoryMock)
  })

  describe('Brands Domain', () => {
    it('creates brand with generated slug', async () => {
      repositoryMock.createBrand.mockResolvedValueOnce({ id: 'b-1', name: 'Fresh Cut', slug: 'fresh-cut' })
      const brand = await service.createBrand({ name: 'Fresh Cut' })
      expect(repositoryMock.createBrand).toHaveBeenCalledWith({ name: 'Fresh Cut', slug: 'fresh-cut' })
      expect(brand.slug).toBe('fresh-cut')
    })
  })

  describe('Proposal State Machine & Workflow', () => {
    it('allows valid transition DRAFT -> SUBMITTED', () => {
      expect(() => service.validateStateTransition('DRAFT', 'SUBMITTED')).not.toThrow()
    })

    it('allows valid transition UNDER_REVIEW -> APPROVED', () => {
      expect(() => service.validateStateTransition('UNDER_REVIEW', 'APPROVED')).not.toThrow()
    })

    it('allows transition APPROVED -> PUBLISHED', () => {
      expect(() => service.validateStateTransition('APPROVED', 'PUBLISHED')).not.toThrow()
    })

    it('rejects invalid transition DRAFT -> PUBLISHED with 400 INVALID_STATE_TRANSITION', () => {
      expect(() => service.validateStateTransition('DRAFT', 'PUBLISHED')).toThrow('Invalid state transition')
    })
  })

  describe('CatalogueService.createProposal', () => {
    it('creates product proposal cleanly', async () => {
      repositoryMock.findProposalDuplicateSku.mockResolvedValueOnce(null)
      repositoryMock.createProposal.mockResolvedValueOnce({ id: 'prop-1', title: 'Ribeye Steak', sku: 'SKU-123', status: 'DRAFT' })

      const res = await service.createProposal('v-1', { title: 'Ribeye Steak', sku: 'SKU-123' })
      expect(res.id).toBe('prop-1')
      expect(res.status).toBe('DRAFT')
    })

    it('throws 409 DUPLICATE_PROPOSAL_SKU on duplicate SKU', async () => {
      repositoryMock.findProposalDuplicateSku.mockResolvedValueOnce({ id: 'prop-existing' })

      await expect(
        service.createProposal('v-1', { title: 'Ribeye', sku: 'SKU-EXISTING' })
      ).rejects.toThrow('Product proposal with this SKU already exists')
    })
  })

  describe('CatalogueService.submitProposal', () => {
    it('submits proposal and transitions DRAFT -> SUBMITTED', async () => {
      repositoryMock.findProposalById.mockResolvedValueOnce({ id: 'prop-1', vendor_id: 'v-1', status: 'DRAFT' })
      repositoryMock.updateProposalStatus.mockResolvedValueOnce({ id: 'prop-1', status: 'SUBMITTED' })

      const updated = await service.submitProposal('prop-1', 'v-1')

      expect(repositoryMock.updateProposalStatus).toHaveBeenCalledWith('prop-1', 'SUBMITTED')
      expect(updated.status).toBe('SUBMITTED')
    })

    it('rejects submission if vendor does not own proposal (403 CROSS_SHOP_ACCESS_DENIED)', async () => {
      repositoryMock.findProposalById.mockResolvedValueOnce({ id: 'prop-1', vendor_id: 'v-other', status: 'DRAFT' })

      await expect(service.submitProposal('prop-1', 'v-1')).rejects.toThrow('Forbidden')
    })
  })

  describe('CatalogueService.reviewProposal', () => {
    it('approves proposal and transitions UNDER_REVIEW -> APPROVED', async () => {
      repositoryMock.findProposalById.mockResolvedValueOnce({ id: 'prop-1', status: 'UNDER_REVIEW' })
      repositoryMock.updateProposalStatus.mockResolvedValueOnce({ id: 'prop-1', status: 'APPROVED' })

      const updated = await service.reviewProposal('prop-1', 'admin-1', { action: 'APPROVE', comments: 'Looks good' })

      expect(repositoryMock.updateProposalStatus).toHaveBeenCalledWith('prop-1', 'APPROVED')
      expect(updated.status).toBe('APPROVED')
    })

    it('publishes approved proposal and creates master product entry', async () => {
      const proposal = { id: 'prop-1', title: 'Steak', slug: 'steak', status: 'APPROVED', target_price: 500 }
      repositoryMock.findProposalById.mockResolvedValueOnce(proposal)
      repositoryMock.updateProposalStatus.mockResolvedValueOnce({ id: 'prop-1', status: 'PUBLISHED' })

      const updated = await service.reviewProposal('prop-1', 'admin-1', { action: 'PUBLISH' })

      expect(repositoryMock.createMasterProductFromProposal).toHaveBeenCalledWith(proposal)
      expect(updated.status).toBe('PUBLISHED')
    })

    it('requests correction and transitions UNDER_REVIEW -> CORRECTION_REQUIRED', async () => {
      repositoryMock.findProposalById.mockResolvedValueOnce({ id: 'prop-1', status: 'UNDER_REVIEW' })
      repositoryMock.updateProposalStatus.mockResolvedValueOnce({ id: 'prop-1', status: 'CORRECTION_REQUIRED' })

      const updated = await service.reviewProposal('prop-1', 'admin-1', { action: 'REQUEST_CORRECTION', comments: 'Fix description' })

      expect(repositoryMock.updateProposalStatus).toHaveBeenCalledWith('prop-1', 'CORRECTION_REQUIRED')
      expect(updated.status).toBe('CORRECTION_REQUIRED')
    })
  })
})
