/**
 * Vendor Staff Controller — HTTP Handler Layer for Staff & Role Management
 * Source of truth: Blueprint §06.1, Phase 2C
 *
 * @module modules/vendors/vendor-staff.controller
 */

export class VendorStaffController {
  /**
   * @param {import('./vendor-staff.service.js').VendorStaffService} service
   */
  constructor(service) {
    this.service = service
  }

  inviteStaff = async (req, reply) => {
    const { vendorId } = req.params
    const actorId = req.userId || req.user.id
    const result = await this.service.inviteStaff(vendorId, actorId, req.body)
    return reply.status(201).send({ success: true, data: result })
  }

  respondInvitation = async (req, reply) => {
    const userId = req.userId || req.user.id
    const result = await this.service.respondInvitation(userId, req.body)
    return reply.status(200).send({ success: true, ...result })
  }

  updateStaffRole = async (req, reply) => {
    const { vendorId, userId } = req.params
    const actorId = req.userId || req.user.id
    const { role } = req.body
    const result = await this.service.updateStaffRole(vendorId, userId, role, actorId)
    return reply.status(200).send({ success: true, data: result })
  }

  suspendStaff = async (req, reply) => {
    const { vendorId, userId } = req.params
    const actorId = req.userId || req.user.id
    const result = await this.service.suspendStaff(vendorId, userId, actorId)
    return reply.status(200).send({ success: true, data: result })
  }

  reactivateStaff = async (req, reply) => {
    const { vendorId, userId } = req.params
    const actorId = req.userId || req.user.id
    const result = await this.service.reactivateStaff(vendorId, userId, actorId)
    return reply.status(200).send({ success: true, data: result })
  }

  removeStaff = async (req, reply) => {
    const { vendorId, userId } = req.params
    const actorId = req.userId || req.user.id
    await this.service.removeStaff(vendorId, userId, actorId)
    return reply.status(200).send({ success: true, message: 'Staff member removed successfully' })
  }

  listStaff = async (req, reply) => {
    const { vendorId } = req.params
    const result = await this.service.listStaff(vendorId)
    return reply.status(200).send({ success: true, data: result })
  }
}
