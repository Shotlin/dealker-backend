/**
 * Vendor Staff Routes — Fastify Plugin for Vendor Staff Management Endpoints
 * Source of truth: Blueprint §06.1, Phase 2C
 *
 * @module modules/vendors/vendor-staff.routes
 */

import { VendorsRepository } from './vendors.repository.js'
import { VendorStaffRepository } from './vendor-staff.repository.js'
import { VendorStaffService } from './vendor-staff.service.js'
import { VendorStaffController } from './vendor-staff.controller.js'
import { InviteStaffSchema, UpdateStaffRoleSchema, RespondInvitationSchema } from './vendor-staff.schema.js'
import { requireVendorScope } from '../../middlewares/vendor-scope.js'

export async function vendorStaffRoutes(fastify) {
  const vendorRepository = new VendorsRepository()
  const repository = new VendorStaffRepository()
  const service = new VendorStaffService(repository, vendorRepository)
  const controller = new VendorStaffController(service)

  // 1. Invite staff member
  fastify.post('/:vendorId/staff/invite', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('vendor_staff.create'),
      requireVendorScope(),
    ],
    schema: { body: InviteStaffSchema },
    handler: controller.inviteStaff,
  })

  // 2. Accept / Reject invitation (User endpoint)
  fastify.post('/invitations/respond', {
    preHandler: [fastify.authenticate],
    schema: { body: RespondInvitationSchema },
    handler: controller.respondInvitation,
  })

  // 3. List vendor staff members
  fastify.get('/:vendorId/staff', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('vendor_staff.view'),
      requireVendorScope(),
    ],
    handler: controller.listStaff,
  })

  // 4. Update staff role
  fastify.patch('/:vendorId/staff/:userId/role', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('vendor_staff.update'),
      requireVendorScope(),
    ],
    schema: { body: UpdateStaffRoleSchema },
    handler: controller.updateStaffRole,
  })

  // 5. Suspend staff member
  fastify.post('/:vendorId/staff/:userId/suspend', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('vendor_staff.update'),
      requireVendorScope(),
    ],
    handler: controller.suspendStaff,
  })

  // 6. Reactivate staff member
  fastify.post('/:vendorId/staff/:userId/reactivate', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('vendor_staff.update'),
      requireVendorScope(),
    ],
    handler: controller.reactivateStaff,
  })

  // 7. Remove staff member
  fastify.delete('/:vendorId/staff/:userId', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('vendor_staff.delete'),
      requireVendorScope(),
    ],
    handler: controller.removeStaff,
  })
}

export default vendorStaffRoutes
