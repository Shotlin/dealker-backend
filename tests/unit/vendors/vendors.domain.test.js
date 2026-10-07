import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VendorsService } from '../../../src/modules/vendors/vendors.service.js'

describe('Phase 2A Vendor Domain Unit Tests', () => {
  let repositoryMock
  let service

  beforeEach(() => {
    repositoryMock = {
      findById: vi.fn(),
      findBySlug: vi.fn(),
      findDuplicate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      softDelete: vi.fn(),
      findMany: vi.fn(),
      updateProfile: vi.fn(),
      updateSettings: vi.fn(),
    }
    service = new VendorsService(repositoryMock)
  })

  describe('VendorsService.createVendor', () => {
    it('creates new vendor successfully when duplicate checks pass', async () => {
      const vendorData = { name: 'Fresh Meats Vendor', email: 'fresh@vendor.com', phone: '9876543210' }
      const expectedVendor = { id: 'v-1', ...vendorData, slug: 'fresh-meats-vendor', status: 'PENDING_ONBOARDING' }

      repositoryMock.findDuplicate.mockResolvedValueOnce(null)
      repositoryMock.create.mockResolvedValueOnce(expectedVendor)

      const result = await service.createVendor(vendorData)

      expect(repositoryMock.findDuplicate).toHaveBeenCalledWith('fresh@vendor.com', '9876543210')
      expect(result.id).toBe('v-1')
      expect(result.slug).toBe('fresh-meats-vendor')
    })

    it('throws 409 DUPLICATE_ENTRY when duplicate email or phone exists', async () => {
      repositoryMock.findDuplicate.mockResolvedValueOnce({ id: 'v-existing', email: 'dup@vendor.com' })

      await expect(
        service.createVendor({ name: 'Dup Vendor', email: 'dup@vendor.com', phone: '9876543210' })
      ).rejects.toThrow('Vendor with this email or phone already exists')
    })
  })

  describe('VendorsService.getVendorById', () => {
    it('returns vendor record when found', async () => {
      repositoryMock.findById.mockResolvedValueOnce({ id: 'v-1', name: 'Meat Co' })

      const vendor = await service.getVendorById('v-1')
      expect(vendor.name).toBe('Meat Co')
    })

    it('throws 404 VENDOR_NOT_FOUND when vendor does not exist', async () => {
      repositoryMock.findById.mockResolvedValueOnce(null)

      await expect(service.getVendorById('v-missing')).rejects.toThrow('Vendor not found')
    })
  })

  describe('VendorsService.updateVendor', () => {
    it('updates vendor details cleanly', async () => {
      repositoryMock.findById.mockResolvedValueOnce({ id: 'v-1', name: 'Old Name' })
      repositoryMock.findDuplicate.mockResolvedValueOnce(null)
      repositoryMock.update.mockResolvedValueOnce({ id: 'v-1', name: 'New Name', slug: 'new-name' })

      const updated = await service.updateVendor('v-1', { name: 'New Name' })
      expect(updated.name).toBe('New Name')
    })
  })

  describe('VendorsService.updateVendorStatus', () => {
    it('transitions status and updates is_active boolean correctly', async () => {
      repositoryMock.findById.mockResolvedValueOnce({ id: 'v-1', status: 'PENDING_ONBOARDING' })
      repositoryMock.update.mockResolvedValueOnce({ id: 'v-1', status: 'ACTIVE', is_active: true })

      const result = await service.updateVendorStatus('v-1', 'ACTIVE', 'KYC verified')
      expect(repositoryMock.update).toHaveBeenCalledWith('v-1', { status: 'ACTIVE', is_active: true })
      expect(result.status).toBe('ACTIVE')
    })

    it('deactivates vendor when status transitions to SUSPENDED', async () => {
      repositoryMock.findById.mockResolvedValueOnce({ id: 'v-1', status: 'ACTIVE' })
      repositoryMock.update.mockResolvedValueOnce({ id: 'v-1', status: 'SUSPENDED', is_active: false })

      const result = await service.updateVendorStatus('v-1', 'SUSPENDED', 'Compliance violation')
      expect(repositoryMock.update).toHaveBeenCalledWith('v-1', { status: 'SUSPENDED', is_active: false })
      expect(result.is_active).toBe(false)
    })
  })

  describe('VendorsService.deleteVendor', () => {
    it('soft deletes vendor record', async () => {
      repositoryMock.findById.mockResolvedValueOnce({ id: 'v-1' })
      repositoryMock.softDelete.mockResolvedValueOnce(true)

      const success = await service.deleteVendor('v-1')
      expect(success).toBe(true)
    })
  })

  describe('VendorsService.listVendors', () => {
    it('returns paginated vendor list and metadata', async () => {
      repositoryMock.findMany.mockResolvedValueOnce({
        data: [{ id: 'v-1', name: 'Vendor 1' }],
        total: 1,
      })

      const res = await service.listVendors({ page: 1, limit: 10, search: 'Vendor' })
      expect(res.data).toHaveLength(1)
      expect(res.pagination.total).toBe(1)
      expect(res.pagination.totalPages).toBe(1)
    })
  })
})
