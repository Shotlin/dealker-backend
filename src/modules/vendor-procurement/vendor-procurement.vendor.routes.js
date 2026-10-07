/**
 * Vendor Procurement Vendor Routes — vendor-side surface (Big Phase 4+)
 * Source of truth: vendor_procurement_blueprint/01_VENDOR_REQUIREMENTS.md §18.2
 *
 * Mounted at /api/v1/vendor-procurement/vendor. Vendor scope resolution:
 * requireVendorScope({ requireVendor: true }) supports OTP-login vendor staff
 * (membership-resolved), JWT vendor claims, and HQ override via X-Vendor-Id.
 *
 * @module modules/vendor-procurement/vendor-procurement.vendor.routes
 */

import { VendorProcurementRepository } from './vendor-procurement.repository.js'
import { VendorProcurementService } from './vendor-procurement.service.js'
import { VendorProcurementController } from './vendor-procurement.controller.js'
import { requireVendorScope } from '../../middlewares/vendor-scope.js'
import { requirePermission } from '../../middlewares/permission-check.js'
import { SubmitQuoteSchema, UpdateQuoteSchema, ServiceProfileSchema, UpdateSupplyStatusSchema, AttachEvidenceSchema } from './vendor-procurement.schema.js'

export async function vendorProcurementVendorRoutes(fastify) {
  const service = new VendorProcurementService(new VendorProcurementRepository(), fastify)
  const controller = new VendorProcurementController(service)
  const vendorScope = [fastify.authenticate, requirePermission('procurement.view'), requireVendorScope({ requireVendor: true })]
  const vendorRespond = [fastify.authenticate, requirePermission('procurement.respond'), requireVendorScope({ requireVendor: true })]

  // 1. Request inbox — tabs: NEW | RESPONDED | CLOSED
  fastify.get('/requests', {
    preHandler: vendorScope,
    handler: controller.getVendorInbox,
  })

  // 2. Request detail (own recipient state only)
  fastify.get('/requests/:requestId', {
    preHandler: vendorScope,
    handler: controller.getVendorRequestDetail,
  })

  // 3. Accept fixed offer (first-accept wins, race-safe)
  fastify.post('/requests/:requestId/accept', {
    preHandler: vendorRespond,
    handler: controller.acceptFixedOffer,
  })

  // 4. Decline request
  fastify.post('/requests/:requestId/decline', {
    preHandler: vendorRespond,
    handler: controller.declineRequest,
  })

  // 5. Submit RFQ quote
  fastify.post('/requests/:requestId/quote', {
    preHandler: vendorRespond,
    schema: { body: SubmitQuoteSchema },
    handler: controller.submitQuote,
  })

  // 6. Edit own live quote
  fastify.patch('/quotes/:quoteId', {
    preHandler: vendorRespond,
    schema: { body: UpdateQuoteSchema },
    handler: controller.updateQuote,
  })

  // 7. Withdraw own live quote
  fastify.post('/quotes/:quoteId/withdraw', {
    preHandler: vendorRespond,
    handler: controller.withdrawQuote,
  })

  // 8. Own service profile (categories / areas / store assignments)
  fastify.get('/service-profile', {
    preHandler: vendorScope,
    handler: controller.getVendorServiceProfile,
  })

  fastify.put('/service-profile', {
    preHandler: [fastify.authenticate, requirePermission('vendors.update'), requireVendorScope({ requireVendor: true })],
    schema: { body: ServiceProfileSchema },
    handler: controller.updateVendorServiceProfile,
  })

  // 9. Own supply orders
  fastify.get('/supplies', {
    preHandler: vendorScope,
    handler: controller.getVendorSupplies,
  })

  fastify.get('/supplies/:supplyId', {
    preHandler: vendorScope,
    handler: controller.getVendorSupplyDetail,
  })

  fastify.post('/supplies/:supplyId/status', {
    preHandler: vendorRespond,
    schema: { body: UpdateSupplyStatusSchema },
    handler: controller.updateSupplyStatus,
  })

  fastify.post('/supplies/:supplyId/evidence', {
    preHandler: vendorRespond,
    schema: { body: AttachEvidenceSchema },
    handler: controller.attachEvidence,
  })

  // 10. Own performance summary + recent feedback
  fastify.get('/performance', {
    preHandler: vendorScope,
    handler: controller.getOwnPerformance,
  })

  fastify.get('/reviews', {
    preHandler: vendorScope,
    handler: controller.getOwnReviews,
  })
}

export default vendorProcurementVendorRoutes
