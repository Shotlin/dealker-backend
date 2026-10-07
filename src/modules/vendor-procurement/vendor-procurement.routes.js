/**
 * Vendor Procurement Routes — Fastify plugin for store procurement requirements
 * Source of truth: vendor_procurement_blueprint/01_VENDOR_REQUIREMENTS.md §18.1
 *
 * Mounted at /api/v1/vendor-procurement. Store-side (admin/dashboard) surface:
 * drafts, publish, cancel/expire, listing and detail. Vendor-side endpoints
 * (inbox, accept/decline, quotes) register from vendor-procurement.vendor.routes.js
 * in later phases.
 *
 * Permissions: the canonical procurement.* family registered in
 * src/utils/permissions.js is reused (view/create/update/cancel) — the store
 * vs vendor separation is enforced by scope middleware, not new permission verbs.
 *
 * @module modules/vendor-procurement/vendor-procurement.routes
 */

import { VendorProcurementRepository } from './vendor-procurement.repository.js'
import { VendorProcurementService } from './vendor-procurement.service.js'
import { VendorProcurementController } from './vendor-procurement.controller.js'
import {
  CreateRequestSchema,
  UpdateRequestSchema,
  CancelRequestSchema,
  ListRequestsQuerySchema,
  ServiceProfileSchema,
  EligibleVendorPreviewSchema,
  ReceiveSupplySchema,
  SubmitReviewSchema,
} from './vendor-procurement.schema.js'
import { requireShopScope } from '../../middlewares/shop-scope.js'
import { requirePermission } from '../../middlewares/permission-check.js'

export async function vendorProcurementRoutes(fastify) {
  const service = new VendorProcurementService(new VendorProcurementRepository(), fastify)
  const controller = new VendorProcurementController(service)

  // 1. Create draft requirement
  fastify.post('/', {
    preHandler: [fastify.authenticate, requirePermission('procurement.create'), requireShopScope()],
    schema: { body: CreateRequestSchema },
    handler: controller.createRequest,
  })

  // 2. Update draft requirement
  fastify.patch('/:requestId', {
    preHandler: [fastify.authenticate, requirePermission('procurement.update'), requireShopScope()],
    schema: { body: UpdateRequestSchema },
    handler: controller.updateRequest,
  })

  // 3. Publish requirement (resolve eligible vendors, persist recipients)
  fastify.post('/:requestId/publish', {
    preHandler: [fastify.authenticate, requirePermission('procurement.create'), requireShopScope()],
    handler: controller.publishRequest,
  })

  // 4. Cancel requirement
  fastify.post('/:requestId/cancel', {
    preHandler: [fastify.authenticate, requirePermission('procurement.cancel'), requireShopScope()],
    schema: { body: CancelRequestSchema },
    handler: controller.cancelRequest,
  })

  // 5. Expire requirement (deadline pass-through / admin closure)
  fastify.post('/:requestId/expire', {
    preHandler: [fastify.authenticate, requirePermission('procurement.cancel'), requireShopScope()],
    handler: controller.expireRequest,
  })

  // 6. List requirements
  fastify.get('/', {
    preHandler: [fastify.authenticate, requirePermission('procurement.view'), requireShopScope()],
    schema: { querystring: ListRequestsQuerySchema },
    handler: controller.listRequests,
  })

  // 7. Requirement detail (items + persisted recipients)
  fastify.get('/:requestId', {
    preHandler: [fastify.authenticate, requirePermission('procurement.view'), requireShopScope()],
    handler: controller.getRequest,
  })

  // 8. RFQ quote comparison for a request
  fastify.get('/:requestId/quotes', {
    preHandler: [fastify.authenticate, requirePermission('procurement.view'), requireShopScope()],
    handler: controller.listQuotes,
  })

  // 9. Award an RFQ quote (freezes commercial terms, creates supply order)
  fastify.post('/quotes/:quoteId/award', {
    preHandler: [fastify.authenticate, requirePermission('procurement.create'), requireShopScope()],
    handler: controller.awardQuote,
  })

  // 10. Admin: vendor service profile (targeting inputs)
  fastify.get('/admin/vendors/:vendorId/service-profile', {
    preHandler: [fastify.authenticate, requirePermission('vendors.view')],
    handler: controller.getAdminVendorServiceProfile,
  })

  fastify.put('/admin/vendors/:vendorId/service-profile', {
    preHandler: [fastify.authenticate, requirePermission('vendors.update')],
    schema: { body: ServiceProfileSchema },
    handler: controller.updateVendorServiceProfile,
  })

  // 11. Eligible-vendor preview for the create-requirement flow
  fastify.post('/eligible-vendors-preview', {
    preHandler: [fastify.authenticate, requirePermission('procurement.view'), requireShopScope()],
    schema: { body: EligibleVendorPreviewSchema },
    handler: controller.getEligibleVendorPreview,
  })

  // 12. Supply orders list (tracking)
  fastify.get('/supplies', {
    preHandler: [fastify.authenticate, requirePermission('procurement.view'), requireShopScope()],
    handler: controller.listSupplyOrders,
  })

  // 13. Supply order detail (items, timeline, evidence)
  fastify.get('/supplies/:supplyId', {
    preHandler: [fastify.authenticate, requirePermission('procurement.view'), requireShopScope()],
    handler: controller.getSupplyOrder,
  })

  // 14. Mark supply delivered (store confirmation of arrival)
  fastify.post('/supplies/:supplyId/mark-delivered', {
    preHandler: [fastify.authenticate, requirePermission('procurement.update'), requireShopScope()],
    handler: controller.markDelivered,
  })

  // 15. Confirm receipt with per-item variance; accepted stock enters inventory
  fastify.post('/supplies/:supplyId/receive', {
    preHandler: [fastify.authenticate, requirePermission('procurement.update'), requireShopScope()],
    schema: { body: ReceiveSupplySchema },
    handler: controller.receiveSupply,
  })

  // 16. Post-receipt vendor review + issue (one per supply)
  fastify.post('/supplies/:supplyId/review', {
    preHandler: [fastify.authenticate, requirePermission('procurement.update'), requireShopScope()],
    schema: { body: SubmitReviewSchema },
    handler: controller.submitReview,
  })

  // 17. Vendor performance summary (transparent aggregations)
  fastify.get('/vendors/:vendorId/performance', {
    preHandler: [fastify.authenticate, requirePermission('vendors.view')],
    handler: controller.getVendorPerformance,
  })

  // 18. Vendor review history
  fastify.get('/vendors/:vendorId/reviews', {
    preHandler: [fastify.authenticate, requirePermission('vendors.view')],
    handler: controller.getVendorReviews,
  })
}

export default vendorProcurementRoutes
