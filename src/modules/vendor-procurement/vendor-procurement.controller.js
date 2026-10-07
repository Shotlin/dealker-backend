/**
 * Vendor Procurement Controller — HTTP layer (Big Phase 3)
 *
 * @module modules/vendor-procurement/vendor-procurement.controller
 */

export class VendorProcurementController {
  /**
   * @param {import('./vendor-procurement.service.js').VendorProcurementService} service
   */
  constructor(service) {
    this.service = service
  }

  createRequest = async (req, reply) => {
    const actorId = req.userId ?? req.user?.id
    const result = await this.service.createDraft(actorId, req.body, { scopedShopId: req.shopId ?? null })
    return reply.status(201).send({ success: true, data: result })
  }

  updateRequest = async (req, reply) => {
    const { requestId } = req.params
    const actorId = req.userId ?? req.user?.id
    const result = await this.service.updateDraft(requestId, actorId, req.body, {
      scopedShopId: req.shopId ?? null,
    })
    return reply.status(200).send({ success: true, data: result })
  }

  publishRequest = async (req, reply) => {
    const { requestId } = req.params
    const actorId = req.userId ?? req.user?.id
    const result = await this.service.publishRequest(requestId, actorId, {
      scopedShopId: req.shopId ?? null,
    })
    return reply.status(200).send({ success: true, data: result })
  }

  cancelRequest = async (req, reply) => {
    const { requestId } = req.params
    const actorId = req.userId ?? req.user?.id
    const result = await this.service.cancelRequest(requestId, actorId, req.body?.reason ?? null, {
      scopedShopId: req.shopId ?? null,
    })
    return reply.status(200).send({ success: true, data: result })
  }

  expireRequest = async (req, reply) => {
    const { requestId } = req.params
    const actorId = req.userId ?? req.user?.id
    const result = await this.service.expireRequest(requestId, actorId, {
      scopedShopId: req.shopId ?? null,
    })
    return reply.status(200).send({ success: true, data: result })
  }

  listRequests = async (req, reply) => {
    const result = await this.service.listRequests(req.query ?? {}, { scopedShopId: req.shopId ?? null })
    return reply.status(200).send({
      success: true,
      data: result.requests,
      pagination: { page: result.page, limit: result.limit, total: result.total },
    })
  }

  getRequest = async (req, reply) => {
    const { requestId } = req.params
    const result = await this.service.getRequest(requestId, { scopedShopId: req.shopId ?? null })
    return reply.status(200).send({ success: true, data: result })
  }

  // ── Vendor-side handlers (Big Phase 4) ────────────────────────

  getVendorInbox = async (req, reply) => {
    const vendorId = req.vendorId
    const result = await this.service.getVendorInbox(vendorId, req.query ?? {})
    return reply.status(200).send({
      success: true,
      data: result.requests,
      pagination: { page: result.page, limit: result.limit, total: result.total },
    })
  }

  getVendorRequestDetail = async (req, reply) => {
    const { requestId } = req.params
    const vendorId = req.vendorId
    const result = await this.service.getVendorRequestDetail(requestId, vendorId, req.userId ?? req.user?.id)
    return reply.status(200).send({ success: true, data: result })
  }

  acceptFixedOffer = async (req, reply) => {
    const { requestId } = req.params
    const vendorId = req.vendorId
    const actorId = req.userId ?? req.user?.id
    const actorRole = req.user?.vendorRoles?.[0] ?? 'VENDOR_OWNER'
    const result = await this.service.acceptFixedOffer(requestId, vendorId, actorId, actorRole)
    return reply.status(200).send({ success: true, data: result })
  }

  declineRequest = async (req, reply) => {
    const { requestId } = req.params
    const vendorId = req.vendorId
    const actorId = req.userId ?? req.user?.id
    const result = await this.service.declineRequest(requestId, vendorId, actorId)
    return reply.status(200).send({ success: true, data: result })
  }

  // ── RFQ quote handlers (Big Phase 5) ──────────────────────────

  submitQuote = async (req, reply) => {
    const { requestId } = req.params
    const vendorId = req.vendorId
    const actorId = req.userId ?? req.user?.id
    const actorRole = req.user?.vendorRoles?.[0] ?? 'VENDOR_OWNER'
    const result = await this.service.submitQuote(requestId, vendorId, actorId, req.body, actorRole)
    return reply.status(201).send({ success: true, data: result })
  }

  updateQuote = async (req, reply) => {
    const { quoteId } = req.params
    const vendorId = req.vendorId
    const actorId = req.userId ?? req.user?.id
    const result = await this.service.updateQuote(quoteId, vendorId, actorId, req.body)
    return reply.status(200).send({ success: true, data: result })
  }

  withdrawQuote = async (req, reply) => {
    const { quoteId } = req.params
    const vendorId = req.vendorId
    const actorId = req.userId ?? req.user?.id
    const result = await this.service.withdrawQuote(quoteId, vendorId, actorId)
    return reply.status(200).send({ success: true, data: result })
  }

  listQuotes = async (req, reply) => {
    const { requestId } = req.params
    const result = await this.service.listQuotesForRequest(requestId, { scopedShopId: req.shopId ?? null })
    return reply.status(200).send({ success: true, data: result })
  }

  awardQuote = async (req, reply) => {
    const { quoteId } = req.params
    const actorId = req.userId ?? req.user?.id
    const result = await this.service.awardQuote(quoteId, actorId, { scopedShopId: req.shopId ?? null })
    return reply.status(200).send({ success: true, data: result })
  }

  // ── Service profile + eligibility preview handlers (Big Phase 6) ──

  getVendorServiceProfile = async (req, reply) => {
    const vendorId = req.vendorId
    const result = await this.service.getVendorServiceProfile(vendorId)
    return reply.status(200).send({ success: true, data: result })
  }

  updateVendorServiceProfile = async (req, reply) => {
    const vendorId = req.vendorId ?? req.params.vendorId
    const result = await this.service.updateVendorServiceProfile(vendorId, req.body)
    return reply.status(200).send({ success: true, data: result })
  }

  getAdminVendorServiceProfile = async (req, reply) => {
    const { vendorId } = req.params
    const result = await this.service.getVendorServiceProfile(vendorId)
    return reply.status(200).send({ success: true, data: result })
  }

  getEligibleVendorPreview = async (req, reply) => {
    const { shop_id, items } = req.body ?? {}
    const result = await this.service.getEligibleVendorPreview(shop_id, items ?? [])
    return reply.status(200).send({ success: true, data: result })
  }

  // ── Supply order tracking handlers (Big Phase 8) ──────────────

  listSupplyOrders = async (req, reply) => {
    const result = await this.service.listSupplyOrders(req.query ?? {}, { scopedShopId: req.shopId ?? null })
    return reply.status(200).send({
      success: true,
      data: result.supplies,
      pagination: { page: result.page, limit: result.limit, total: result.total },
    })
  }

  getSupplyOrder = async (req, reply) => {
    const { supplyId } = req.params
    const result = await this.service.getSupplyOrder(supplyId, { scopedShopId: req.shopId ?? null })
    return reply.status(200).send({ success: true, data: result })
  }

  getVendorSupplies = async (req, reply) => {
    const vendorId = req.vendorId
    const result = await this.service.getVendorSupplyInbox(vendorId, req.query ?? {})
    return reply.status(200).send({
      success: true,
      data: result.supplies,
      pagination: { page: result.page, limit: result.limit, total: result.total },
    })
  }

  submitReview = async (req, reply) => {
    const { supplyId } = req.params
    const actorId = req.userId ?? req.user?.id
    const result = await this.service.submitReview(supplyId, actorId, req.body, {
      scopedShopId: req.shopId ?? null,
    })
    return reply.status(201).send({ success: true, data: result })
  }

  getVendorPerformance = async (req, reply) => {
    const { vendorId } = req.params
    const result = await this.service.getVendorPerformance(vendorId)
    return reply.status(200).send({ success: true, data: result })
  }

  getVendorReviews = async (req, reply) => {
    const { vendorId } = req.params
    const result = await this.service.getVendorReviews(vendorId, req.query ?? {})
    return reply.status(200).send({
      success: true,
      data: result.reviews,
      pagination: { page: result.page, limit: result.limit, total: result.total },
    })
  }

  getOwnPerformance = async (req, reply) => {
    const vendorId = req.vendorId
    const result = await this.service.getOwnPerformance(vendorId)
    return reply.status(200).send({ success: true, data: result })
  }

  getOwnReviews = async (req, reply) => {
    const vendorId = req.vendorId
    const result = await this.service.getOwnReviews(vendorId, req.query ?? {})
    return reply.status(200).send({
      success: true,
      data: result.reviews,
      pagination: { page: result.page, limit: result.limit, total: result.total },
    })
  }

  markDelivered = async (req, reply) => {
    const { supplyId } = req.params
    const actorId = req.userId ?? req.user?.id
    const result = await this.service.markDelivered(supplyId, actorId, { scopedShopId: req.shopId ?? null })
    return reply.status(200).send({ success: true, data: result })
  }

  receiveSupply = async (req, reply) => {
    const { supplyId } = req.params
    const actorId = req.userId ?? req.user?.id
    const result = await this.service.receiveSupply(supplyId, actorId, req.body, {
      scopedShopId: req.shopId ?? null,
    })
    return reply.status(200).send({ success: true, data: result })
  }

  attachEvidence = async (req, reply) => {
    const { supplyId } = req.params
    const vendorId = req.vendorId
    const actorId = req.userId ?? req.user?.id
    const actorRole = req.user?.vendorRoles?.[0] ?? 'VENDOR_OWNER'
    const result = await this.service.attachEvidence(supplyId, vendorId, actorId, req.body, actorRole)
    return reply.status(201).send({ success: true, data: result })
  }

  updateSupplyStatus = async (req, reply) => {
    const { supplyId } = req.params
    const vendorId = req.vendorId
    const actorId = req.userId ?? req.user?.id
    const actorRole = req.user?.vendorRoles?.[0] ?? 'VENDOR_OWNER'
    const result = await this.service.updateSupplyStatus(
      supplyId,
      vendorId,
      actorId,
      req.body?.status,
      {
        delivery_reference: req.body?.delivery_reference ?? null,
        dispatch_note: req.body?.dispatch_note ?? null,
        vehicle_note: req.body?.vehicle_note ?? null,
        note: req.body?.note ?? null,
      },
      actorRole
    )
    return reply.status(200).send({ success: true, data: result })
  }

  getVendorSupplyDetail = async (req, reply) => {
    const { supplyId } = req.params
    const vendorId = req.vendorId
    const result = await this.service.getVendorSupplyDetail(supplyId, vendorId)
    return reply.status(200).send({ success: true, data: result })
  }
}
