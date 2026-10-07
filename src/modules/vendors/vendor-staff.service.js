/**
 * Vendor Staff Service — Business Logic for Staff Management & Invitations
 * Source of truth: Blueprint §06.1, Phase 2C
 *
 * @module modules/vendors/vendor-staff.service
 */

import crypto from 'node:crypto'
import { logger } from '../../config/logger.js'
import { invalidateVendorStaffCache } from '../../middlewares/vendor-scope.js'

export class VendorStaffService {
  /**
   * @param {import('./vendor-staff.repository.js').VendorStaffRepository} repository
   * @param {import('./vendors.repository.js').VendorsRepository} vendorRepository
   */
  constructor(repository, vendorRepository) {
    this.repository = repository
    this.vendorRepository = vendorRepository
  }

  /**
   * Invite staff member to vendor
   * @param {string} vendorId
   * @param {string} actorId
   * @param {object} payload
   * @returns {Promise<object>}
   */
  async inviteStaff(vendorId, actorId, payload) {
    const vendor = await this.vendorRepository.findById(vendorId)
    if (!vendor) {
      const err = new Error('Vendor not found')
      err.statusCode = 404
      err.code = 'VENDOR_NOT_FOUND'
      throw err
    }

    const { email, role = 'VENDOR_OPERATOR' } = payload
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days TTL

    const invitation = await this.repository.createInvitation({
      vendorId,
      email,
      role,
      token,
      invitedBy: actorId,
      expiresAt,
    })

    await this.repository.logAudit({
      vendorId,
      actorId,
      action: 'INVITE',
      newRole: role,
    })

    logger.info({ vendorId, email, role }, 'Staff invitation issued successfully')
    return invitation
  }

  /**
   * Respond to invitation (ACCEPT or REJECT)
   * @param {string} userId
   * @param {object} payload
   * @returns {Promise<object>}
   */
  async respondInvitation(userId, payload) {
    const { token, action } = payload
    const invitation = await this.repository.findInvitationByToken(token)

    if (!invitation) {
      const err = new Error('Invitation token not found')
      err.statusCode = 404
      err.code = 'INVITATION_NOT_FOUND'
      throw err
    }

    if (invitation.status !== 'PENDING') {
      const err = new Error(`Invitation is no longer pending (status: ${invitation.status})`)
      err.statusCode = 400
      err.code = 'INVITATION_EXPIRED'
      throw err
    }

    if (new Date(invitation.expires_at) < new Date()) {
      await this.repository.updateInvitationStatus(invitation.id, 'EXPIRED')
      const err = new Error('Invitation token has expired')
      err.statusCode = 400
      err.code = 'INVITATION_EXPIRED'
      throw err
    }

    if (action === 'REJECT') {
      await this.repository.updateInvitationStatus(invitation.id, 'REJECTED')
      await this.repository.logAudit({
        vendorId: invitation.vendor_id,
        userId,
        action: 'REJECT',
      })
      return { success: true, message: 'Invitation rejected' }
    }

    // ACCEPT action
    await this.repository.updateInvitationStatus(invitation.id, 'ACCEPTED')
    const membership = await this.repository.createMembership({
      vendorId: invitation.vendor_id,
      userId,
      role: invitation.role,
    })

    await this.repository.logAudit({
      vendorId: invitation.vendor_id,
      userId,
      action: 'ACCEPT',
      newRole: invitation.role,
    })

    logger.info({ vendorId: invitation.vendor_id, userId, role: invitation.role }, 'Staff invitation accepted')
    return { success: true, membership }
  }

  /**
   * Update staff role
   * @param {string} vendorId
   * @param {string} userId
   * @param {string} newRole
   * @param {string} actorId
   * @returns {Promise<object>}
   */
  async updateStaffRole(vendorId, userId, newRole, actorId) {
    const membership = await this.repository.findMembership(vendorId, userId)
    if (!membership) {
      const err = new Error('Staff membership not found')
      err.statusCode = 404
      err.code = 'STAFF_NOT_FOUND'
      throw err
    }

    const oldRole = membership.role
    const updated = await this.repository.updateMembership(vendorId, userId, { role: newRole })

    await invalidateVendorStaffCache(userId, vendorId)
    await this.repository.logAudit({
      vendorId,
      userId,
      actorId,
      action: 'ROLE_CHANGE',
      oldRole,
      newRole,
    })

    logger.info({ vendorId, userId, oldRole, newRole }, 'Staff role updated successfully')
    return updated
  }

  /**
   * Suspend staff member
   * @param {string} vendorId
   * @param {string} userId
   * @param {string} actorId
   * @returns {Promise<object>}
   */
  async suspendStaff(vendorId, userId, actorId) {
    const membership = await this.repository.findMembership(vendorId, userId)
    if (!membership) {
      const err = new Error('Staff membership not found')
      err.statusCode = 404
      err.code = 'STAFF_NOT_FOUND'
      throw err
    }

    const updated = await this.repository.updateMembership(vendorId, userId, { is_active: false })
    await invalidateVendorStaffCache(userId, vendorId)

    await this.repository.logAudit({
      vendorId,
      userId,
      actorId,
      action: 'SUSPEND',
    })

    logger.info({ vendorId, userId }, 'Staff member suspended')
    return updated
  }

  /**
   * Reactivate staff member
   * @param {string} vendorId
   * @param {string} userId
   * @param {string} actorId
   * @returns {Promise<object>}
   */
  async reactivateStaff(vendorId, userId, actorId) {
    const membership = await this.repository.findMembership(vendorId, userId)
    if (!membership) {
      const err = new Error('Staff membership not found')
      err.statusCode = 404
      err.code = 'STAFF_NOT_FOUND'
      throw err
    }

    const updated = await this.repository.updateMembership(vendorId, userId, { is_active: true })
    await invalidateVendorStaffCache(userId, vendorId)

    await this.repository.logAudit({
      vendorId,
      userId,
      actorId,
      action: 'REACTIVATE',
    })

    logger.info({ vendorId, userId }, 'Staff member reactivated')
    return updated
  }

  /**
   * Remove staff member
   * @param {string} vendorId
   * @param {string} userId
   * @param {string} actorId
   * @returns {Promise<boolean>}
   */
  async removeStaff(vendorId, userId, actorId) {
    const membership = await this.repository.findMembership(vendorId, userId)
    if (!membership) {
      const err = new Error('Staff membership not found')
      err.statusCode = 404
      err.code = 'STAFF_NOT_FOUND'
      throw err
    }

    await this.repository.updateMembership(vendorId, userId, { is_active: false, deleted_at: new Date() })
    await invalidateVendorStaffCache(userId, vendorId)

    await this.repository.logAudit({
      vendorId,
      userId,
      actorId,
      action: 'REMOVE',
    })

    logger.info({ vendorId, userId }, 'Staff member removed from vendor')
    return true
  }

  /**
   * List staff members for vendor
   * @param {string} vendorId
   * @returns {Promise<Array>}
   */
  async listStaff(vendorId) {
    return this.repository.listStaff(vendorId)
  }
}
