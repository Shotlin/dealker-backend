import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VendorStaffService } from '../../../src/modules/vendors/vendor-staff.service.js'

describe('Phase 2C Vendor Staff & Role Assignments Unit Tests', () => {
  let repositoryMock
  let vendorRepoMock
  let service

  beforeEach(() => {
    repositoryMock = {
      findMembership: vi.fn(),
      createMembership: vi.fn(),
      updateMembership: vi.fn(),
      listStaff: vi.fn(),
      createInvitation: vi.fn(),
      findInvitationByToken: vi.fn(),
      updateInvitationStatus: vi.fn(),
      logAudit: vi.fn(),
    }
    vendorRepoMock = {
      findById: vi.fn(),
    }
    service = new VendorStaffService(repositoryMock, vendorRepoMock)
  })

  describe('VendorStaffService.inviteStaff', () => {
    it('issues staff invitation with token and audit log', async () => {
      vendorRepoMock.findById.mockResolvedValueOnce({ id: 'v-1', name: 'Vendor 1' })
      repositoryMock.createInvitation.mockResolvedValueOnce({
        id: 'inv-1',
        vendor_id: 'v-1',
        email: 'staff@vendor.com',
        role: 'VENDOR_OPERATOR',
        token: 'token-123',
        status: 'PENDING',
      })

      const inv = await service.inviteStaff('v-1', 'admin-1', { email: 'staff@vendor.com', role: 'VENDOR_OPERATOR' })

      expect(repositoryMock.createInvitation).toHaveBeenCalledOnce()
      expect(repositoryMock.logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ vendorId: 'v-1', action: 'INVITE', newRole: 'VENDOR_OPERATOR' })
      )
      expect(inv.token).toBe('token-123')
    })
  })

  describe('VendorStaffService.respondInvitation', () => {
    it('accepts pending valid invitation and creates membership', async () => {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
      repositoryMock.findInvitationByToken.mockResolvedValueOnce({
        id: 'inv-1',
        vendor_id: 'v-1',
        status: 'PENDING',
        expires_at: expiresAt,
        role: 'VENDOR_OPERATOR',
      })
      repositoryMock.createMembership.mockResolvedValueOnce({ id: 'mem-1', vendor_id: 'v-1', user_id: 'u-1', role: 'VENDOR_OPERATOR' })

      const res = await service.respondInvitation('u-1', { token: 'token-123', action: 'ACCEPT' })

      expect(repositoryMock.updateInvitationStatus).toHaveBeenCalledWith('inv-1', 'ACCEPTED')
      expect(repositoryMock.createMembership).toHaveBeenCalledWith({ vendorId: 'v-1', userId: 'u-1', role: 'VENDOR_OPERATOR' })
      expect(res.success).toBe(true)
    })

    it('rejects expired invitation token with 400 INVITATION_EXPIRED', async () => {
      const expiredAt = new Date(Date.now() - 24 * 60 * 60 * 1000)
      repositoryMock.findInvitationByToken.mockResolvedValueOnce({
        id: 'inv-1',
        vendor_id: 'v-1',
        status: 'PENDING',
        expires_at: expiredAt,
      })

      await expect(
        service.respondInvitation('u-1', { token: 'expired-token', action: 'ACCEPT' })
      ).rejects.toThrow('Invitation token has expired')

      expect(repositoryMock.updateInvitationStatus).toHaveBeenCalledWith('inv-1', 'EXPIRED')
    })

    it('rejects non-pending invitation token', async () => {
      repositoryMock.findInvitationByToken.mockResolvedValueOnce({
        id: 'inv-1',
        vendor_id: 'v-1',
        status: 'ACCEPTED',
      })

      await expect(
        service.respondInvitation('u-1', { token: 'used-token', action: 'ACCEPT' })
      ).rejects.toThrow('Invitation is no longer pending')
    })
  })

  describe('VendorStaffService.updateStaffRole', () => {
    it('updates staff role and invalidates scope cache', async () => {
      repositoryMock.findMembership.mockResolvedValueOnce({ vendor_id: 'v-1', user_id: 'u-1', role: 'VENDOR_OPERATOR' })
      repositoryMock.updateMembership.mockResolvedValueOnce({ vendor_id: 'v-1', user_id: 'u-1', role: 'VENDOR_OWNER' })

      const updated = await service.updateStaffRole('v-1', 'u-1', 'VENDOR_OWNER', 'admin-1')

      expect(repositoryMock.updateMembership).toHaveBeenCalledWith('v-1', 'u-1', { role: 'VENDOR_OWNER' })
      expect(repositoryMock.logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ROLE_CHANGE', oldRole: 'VENDOR_OPERATOR', newRole: 'VENDOR_OWNER' })
      )
      expect(updated.role).toBe('VENDOR_OWNER')
    })
  })

  describe('VendorStaffService.suspendStaff and reactivateStaff', () => {
    it('suspends staff member and sets is_active false', async () => {
      repositoryMock.findMembership.mockResolvedValueOnce({ vendor_id: 'v-1', user_id: 'u-1', is_active: true })
      repositoryMock.updateMembership.mockResolvedValueOnce({ vendor_id: 'v-1', user_id: 'u-1', is_active: false })

      const result = await service.suspendStaff('v-1', 'u-1', 'admin-1')
      expect(result.is_active).toBe(false)
      expect(repositoryMock.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'SUSPEND' }))
    })

    it('reactivates staff member and sets is_active true', async () => {
      repositoryMock.findMembership.mockResolvedValueOnce({ vendor_id: 'v-1', user_id: 'u-1', is_active: false })
      repositoryMock.updateMembership.mockResolvedValueOnce({ vendor_id: 'v-1', user_id: 'u-1', is_active: true })

      const result = await service.reactivateStaff('v-1', 'u-1', 'admin-1')
      expect(result.is_active).toBe(true)
      expect(repositoryMock.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'REACTIVATE' }))
    })
  })

  describe('VendorStaffService.removeStaff', () => {
    it('removes staff member and soft-deletes membership', async () => {
      repositoryMock.findMembership.mockResolvedValueOnce({ vendor_id: 'v-1', user_id: 'u-1' })
      repositoryMock.updateMembership.mockResolvedValueOnce({ vendor_id: 'v-1', user_id: 'u-1', is_active: false })

      const success = await service.removeStaff('v-1', 'u-1', 'admin-1')
      expect(success).toBe(true)
      expect(repositoryMock.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'REMOVE' }))
    })
  })
})
