import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProposalMediaService } from '../../../src/modules/catalogue/proposal-media.service.js'

describe('Phase 3B Proposal Media & Variant Attributes Unit Tests', () => {
  let repositoryMock
  let proposalRepoMock
  let service

  beforeEach(() => {
    repositoryMock = {
      unsetPrimaryImage: vi.fn(),
      addMedia: vi.fn(),
      getProposalMedia: vi.fn(),
      deleteMedia: vi.fn(),
      findDuplicateVariant: vi.fn(),
      addVariant: vi.fn(),
      getProposalVariants: vi.fn(),
      addSpecification: vi.fn(),
      getProposalSpecifications: vi.fn(),
    }
    proposalRepoMock = {
      findProposalById: vi.fn(),
    }
    service = new ProposalMediaService(repositoryMock, proposalRepoMock)
  })

  describe('Media Management', () => {
    it('adds proposal media metadata cleanly', async () => {
      proposalRepoMock.findProposalById.mockResolvedValueOnce({ id: 'p-1', vendor_id: 'v-1', status: 'DRAFT' })
      repositoryMock.addMedia.mockResolvedValueOnce({ id: 'm-1', media_type: 'IMAGE', is_primary: true })

      const media = await service.addMedia('p-1', 'v-1', {
        media_type: 'IMAGE',
        file_key: 'key-1',
        is_primary: true,
      })

      expect(repositoryMock.addMedia).toHaveBeenCalledOnce()
      expect(media.is_primary).toBe(true)
    })

    it('rejects media addition if proposal is PUBLISHED', async () => {
      proposalRepoMock.findProposalById.mockResolvedValueOnce({ id: 'p-1', vendor_id: 'v-1', status: 'PUBLISHED' })

      await expect(
        service.addMedia('p-1', 'v-1', { media_type: 'IMAGE', file_key: 'key-1' })
      ).rejects.toThrow('Cannot modify proposal media or variants after it is PUBLISHED')
    })
  })

  describe('Variant Management', () => {
    it('adds product variant cleanly', async () => {
      proposalRepoMock.findProposalById.mockResolvedValueOnce({ id: 'p-1', vendor_id: 'v-1', status: 'DRAFT' })
      repositoryMock.findDuplicateVariant.mockResolvedValueOnce(null)
      repositoryMock.addVariant.mockResolvedValueOnce({ id: 'var-1', sku: 'VAR-1', name: '500g Pack' })

      const variant = await service.addVariant('p-1', 'v-1', { sku: 'VAR-1', name: '500g Pack' })

      expect(repositoryMock.addVariant).toHaveBeenCalledOnce()
      expect(variant.sku).toBe('VAR-1')
    })

    it('throws 409 DUPLICATE_VARIANT on duplicate variant SKU or attributes', async () => {
      proposalRepoMock.findProposalById.mockResolvedValueOnce({ id: 'p-1', vendor_id: 'v-1', status: 'DRAFT' })
      repositoryMock.findDuplicateVariant.mockResolvedValueOnce({ id: 'var-existing' })

      await expect(
        service.addVariant('p-1', 'v-1', { sku: 'VAR-DUP', name: 'Duplicate' })
      ).rejects.toThrow('Variant with this SKU or attribute combination already exists')
    })
  })

  describe('Specification Management', () => {
    it('adds or updates proposal specification', async () => {
      proposalRepoMock.findProposalById.mockResolvedValueOnce({ id: 'p-1', vendor_id: 'v-1', status: 'DRAFT' })
      repositoryMock.addSpecification.mockResolvedValueOnce({ id: 'spec-1', key: 'Cut Type', value: 'Boneless' })

      const spec = await service.addSpecification('p-1', 'v-1', { key: 'Cut Type', value: 'Boneless' })

      expect(repositoryMock.addSpecification).toHaveBeenCalledWith('p-1', { key: 'Cut Type', value: 'Boneless' })
      expect(spec.key).toBe('Cut Type')
    })
  })
})
