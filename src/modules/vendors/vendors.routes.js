/**
 * Vendor Routes — Fastify Plugin for Vendor Domain Endpoints
 * Source of truth: Blueprint §06.1, Phase 2A
 *
 * @module modules/vendors/vendors.routes
 */

import { VendorsRepository } from './vendors.repository.js'
import { VendorsService } from './vendors.service.js'
import { VendorsController } from './vendors.controller.js'
import {
  CreateVendorSchema,
  UpdateVendorSchema,
  UpdateVendorStatusSchema,
  UpdateVendorProfileSchema,
  UpdateVendorSettingsSchema,
  VendorQuerySchema,
} from './vendors.schema.js'
import { randomBytes } from 'node:crypto'
import { AuthService } from '../auth/auth.service.js'
import { AuthRepository } from '../auth/auth.repository.js'
import { VendorStaffRepository } from './vendor-staff.repository.js'
import { requireVendorScope } from '../../middlewares/vendor-scope.js'
import { requirePermission } from '../../middlewares/permission-check.js'
import { query } from '../../config/database.js'

export async function vendorRoutes(fastify) {
  const repository = new VendorsRepository()
  const service = new VendorsService(repository)
  const controller = new VendorsController(service)

  // 1. Create new vendor (Admin / Onboarding)
  fastify.post('/', {
    preHandler: [fastify.authenticate, fastify.requirePermission('vendors.create')],
    schema: { body: CreateVendorSchema },
    handler: controller.create,
  })

  // 1b. Self-registration: a signed-in user (OTP-verified phone) opens their own vendor account.
  // It starts as PENDING_ONBOARDING; the vendor then completes Business Profile + KYC and an admin approves.
  fastify.post('/register', {
    preHandler: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'email'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 100 },
          email: { type: 'string', format: 'email', maxLength: 255 },
        },
        additionalProperties: false,
      },
    },
    handler: async (request, reply) => {
      const userId = request.user.id
      const { rows: urows } = await query('SELECT id, phone, name, role FROM users WHERE id = $1', [userId])
      const user = urows[0]
      if (!user?.phone) return reply.code(400).send({ success: false, message: 'Your account has no verified phone number.' })
      const { rows: linked } = await query(
        `SELECT 1 FROM vendor_users vu JOIN vendors v ON v.id = vu.vendor_id
          WHERE vu.user_id = $1 AND vu.is_active = true AND vu.deleted_at IS NULL AND v.deleted_at IS NULL LIMIT 1`, [userId])
      if (linked[0]) return reply.code(409).send({ success: false, message: 'This number is already linked to a vendor account.' })

      const name = request.body.name.trim()
      const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'vendor'}-${randomBytes(2).toString('hex')}`
      const vendor = await service.createVendor({ name, email: request.body.email.trim().toLowerCase(), phone: user.phone, slug, status: 'PENDING_ONBOARDING' })
      await new VendorStaffRepository().createMembership({ vendorId: vendor.id, userId, role: 'VENDOR_OWNER' })
      if (!user.name) await query('UPDATE users SET name = $2 WHERE id = $1', [userId, name])

      const session = await new AuthService(new AuthRepository()).issueVendorSession(user)
      return reply.code(201).send({ success: true, data: { vendor, ...session } })
    },
  })

  // 2. List & search vendors
  fastify.get('/', {
    preHandler: [fastify.authenticate, fastify.requirePermission('vendors.view')],
    schema: { querystring: VendorQuerySchema },
    handler: controller.list,
  })

  // 3. Get vendor by ID
  // NOTE: getById/update/updateProfile/updateSettings use
  // middlewares/permission-check.js#requirePermission, NOT
  // fastify.requirePermission — the fastify decorator (auth.plugin.js)
  // recomputes the effective permission set from
  // ROLE_PERMISSIONS[request.user.platform_role || request.user.role],
  // which for a vendor-scoped JWT resolves to the base 'CUSTOMER' role
  // (vendors have no platform_role, and `role` is the underlying users
  // row's role, not their vendor role) — it silently ignores the real
  // `vendorRoles`/`permissions` claims the login flow puts on the JWT
  // specifically for vendor use. Found live: every vendor self-service
  // call 403'd with "requires 'vendors.view' permission" despite the
  // JWT genuinely carrying it. `middlewares/permission-check.js`'s
  // variant correctly reads `user.permissions` directly for a non-HQ
  // caller (computeEffectivePermissions) — the same fix already applied
  // to modules/vendor-procurement's vendor-facing routes.
  fastify.get('/:vendorId', {
    preHandler: [
      fastify.authenticate,
      requirePermission('vendors.view'),
      requireVendorScope({ allowOnboarding: true }),
    ],
    handler: controller.getById,
  })

  // 4. Update vendor details
  fastify.patch('/:vendorId', {
    preHandler: [
      fastify.authenticate,
      requirePermission('vendors.update'),
      requireVendorScope({ allowOnboarding: true }),
    ],
    schema: { body: UpdateVendorSchema },
    handler: controller.update,
  })

  // 5. Update vendor status (Activate / Suspend / Verify)
  // Deliberately LEFT on fastify.requirePermission (unlike 3/4/7/8 above)
  // — see the spawned task on VENDOR_OWNER's role permissions before ever
  // switching this one. VENDOR_OWNER's real ROLE_PERMISSIONS set already
  // includes 'vendors.suspend', so swapping this to the correct
  // JWT-reading middleware without first fixing that role definition (or
  // adding requireVendorScope here) would let any vendor suspend/delete
  // any OTHER vendor by ID — right now that's accidentally blocked only
  // because this route's permission check doesn't read the JWT's real
  // permissions at all.
  fastify.patch('/:vendorId/status', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('vendors.suspend'),
    ],
    schema: { body: UpdateVendorStatusSchema },
    handler: controller.updateStatus,
  })

  // 5b. Admin KYC decision from the dashboard (Approve / Ask correction / Suspend).
  // Records the transition in vendor_kyc_reviews so the audit trail stays complete.
  fastify.patch('/:vendorId/kyc', {
    preHandler: [fastify.authenticate, fastify.requirePermission('vendors.suspend')],
    schema: {
      body: {
        type: 'object',
        required: ['kycStatus'],
        properties: {
          kycStatus: { type: 'string', enum: ['UNDER_REVIEW', 'CORRECTION_REQUIRED', 'VERIFIED', 'ACTIVE', 'REJECTED', 'SUSPENDED'] },
          comments: { type: 'string', maxLength: 500 },
        },
        additionalProperties: false,
      },
    },
    handler: async (request, reply) => {
      const { vendorId } = request.params
      const { kycStatus, comments } = request.body
      const { rows: cur } = await query('SELECT status FROM vendors WHERE id = $1 AND deleted_at IS NULL', [vendorId])
      if (!cur[0]) return reply.code(404).send({ success: false, message: 'Vendor not found' })
      const action = { VERIFIED: 'APPROVE', ACTIVE: 'APPROVE', REJECTED: 'REJECT', CORRECTION_REQUIRED: 'REQUEST_CORRECTION', UNDER_REVIEW: 'START_REVIEW' }[kycStatus]
      if (['ACTIVE', 'VERIFIED'].includes(kycStatus)) {
        const shop = await repository.ensureShop(vendorId)
        if (!shop.ok) return reply.code(422).send({ success: false, message: shop.message })
      }
      const { rows } = await query(
        `UPDATE vendors SET status = $2, is_active = $3, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [vendorId, kycStatus, ['ACTIVE', 'VERIFIED'].includes(kycStatus)],
      )
      if (action) {
        await query(
          `INSERT INTO vendor_kyc_reviews (vendor_id, reviewer_id, action, previous_status, new_status, comments)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [vendorId, request.user?.id ?? null, action, cur[0].status, kycStatus, comments ?? null],
        )
      }
      return { success: true, data: rows[0] }
    },
  })

  // 6. Soft delete vendor — same deliberate exception as #5 above.
  fastify.delete('/:vendorId', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('vendors.suspend'),
    ],
    handler: controller.delete,
  })

  // 7. Update vendor profile (KYC & Address)
  fastify.patch('/:vendorId/profile', {
    preHandler: [
      fastify.authenticate,
      requirePermission('vendors.update'),
      requireVendorScope({ allowOnboarding: true }),
    ],
    schema: { body: UpdateVendorProfileSchema },
    handler: controller.updateProfile,
  })

  // 8. Update vendor settings (Operating Config & Financials)
  fastify.patch('/:vendorId/settings', {
    preHandler: [
      fastify.authenticate,
      requirePermission('vendors.update'),
      requireVendorScope(),
    ],
    schema: { body: UpdateVendorSettingsSchema },
    handler: controller.updateSettings,
  })
}

export default vendorRoutes
