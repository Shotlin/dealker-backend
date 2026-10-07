/**
 * Vendor Procurement Service — Store Requirement Lifecycle (Big Phase 3)
 * Source of truth: vendor_procurement_blueprint/01_VENDOR_REQUIREMENTS.md §6, §7, §8
 *
 * Covers the request core: draft create/update, list/get, publish (eligible
 * vendor resolution + persisted recipients), cancel and expire. Award (fixed
 * offer / RFQ) arrives in Big Phases 4–5 and extends this state machine.
 *
 * @module modules/vendor-procurement/vendor-procurement.service
 */

import crypto from 'node:crypto'
import { getClient } from '../../config/database.js'
import { emit, emitInTx } from '../../utils/audit-log.js'
import { ShopProductsRepository } from '../shop-products/shop-products.repository.js'
import { cacheDeletePattern } from '../../utils/cache.js'
import { logger } from '../../config/logger.js'
import { resolveEligibleVendors } from './vendor-eligibility.js'
import { ProcurementNotifier } from './vendor-procurement.notifications.js'
import { VendorProcurementRepository } from './vendor-procurement.repository.js'

export const REQUEST_TRANSITIONS = {
  DRAFT: ['PUBLISHED', 'CANCELLED'],
  PUBLISHED: ['AWARDED', 'CANCELLED', 'EXPIRED'],
  AWARDED: ['IN_FULFILMENT', 'CANCELLED'],
  IN_FULFILMENT: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
}

const UNITS = new Set(['KG', 'PC', 'PACK', 'LTR'])

/**
 * Vendor-controlled supply transitions (blueprint §9). RECEIVED/CLOSED are
 * store/admin-controlled and arrive with the receiving flow (Big Phase 13).
 * The PACKED transition additionally requires accepted quality evidence —
 * enforced in updateSupplyStatus and hardened in Big Phase 12.
 */
export const SUPPLY_TRANSITIONS = {
  AWARDED: ['ACCEPTED'],
  ACCEPTED: ['PROCESSING'],
  PROCESSING: ['CLEANING'],
  CLEANING: ['PACKED'],
  VIDEO_SUBMITTED: ['PACKED'],
  PACKED: ['READY_FOR_DISPATCH'],
  READY_FOR_DISPATCH: ['DISPATCHED'],
  DISPATCHED: [],
  DELIVERED_PENDING_RECEIPT: [],
  RECEIVED: [],
  CLOSED: [],
  CANCELLED: [],
  REJECTED_AT_RECEIPT: [],
}

function procurementError(message, statusCode, code) {
  const err = new Error(message)
  err.statusCode = statusCode
  err.code = code
  return err
}

export class VendorProcurementService {
  /**
   * @param {import('./vendor-procurement.repository.js').VendorProcurementRepository} repository
   */
  constructor(repository = new VendorProcurementRepository(), fastify = null) {
    this.repository = repository
    this.notifier = new ProcurementNotifier(fastify)
  }

  validateStateTransition(currentStatus, nextStatus) {
    const allowed = REQUEST_TRANSITIONS[currentStatus] || []
    if (!allowed.includes(nextStatus)) {
      throw procurementError(
        `Invalid state transition from ${currentStatus} to ${nextStatus}`,
        400,
        'INVALID_STATE_TRANSITION'
      )
    }
  }

  /**
   * Store-scope guard: a request may only be touched by HQ or by staff whose
   * resolved shop scope matches the request's shop.
   */
  assertShopAccess(scopedShopId, resourceShopId) {
    if (scopedShopId && resourceShopId && scopedShopId !== resourceShopId) {
      throw procurementError(
        'Forbidden — procurement request belongs to another store',
        403,
        'CROSS_SHOP_ACCESS_DENIED'
      )
    }
  }

  // ── Draft lifecycle ────────────────────────────────────────────

  async createDraft(actorId, payload, { scopedShopId = null } = {}) {
    this.assertShopAccess(scopedShopId, payload.shop_id)

    const items = this.normalizeItems(payload.mode, payload.items ?? [])
    this.assertItemsValid(items)

    const offerTotal = this.computeOfferTotal(payload.mode, items)
    const requestNumber = `PRQ-${this.dateStamp()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const request = await this.repository.insertRequest({
        request_number: requestNumber,
        shop_id: payload.shop_id,
        mode: payload.mode,
        title: payload.title,
        required_delivery_at: payload.required_delivery_at,
        response_deadline: payload.response_deadline,
        notes: payload.notes,
        quality_instructions: payload.quality_instructions,
        substitutes_allowed: payload.substitutes_allowed,
        offer_total: offerTotal,
        created_by: actorId,
      })
      const insertedItems = []
      for (const item of items) {
        insertedItems.push(await this.repository.insertRequestItem(request.id, item))
      }

      await emitInTx(client, 'procurement.request.created', {
        actor_user_id: actorId,
        target_type: 'procurement_request',
        target_id: request.id,
        after: { request_number: request.request_number, mode: request.mode, shop_id: request.shop_id },
      })

      await client.query('COMMIT')
      logger.info({ requestId: request.id, requestNumber }, 'Vendor procurement request draft created')
      return { ...request, items: insertedItems }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async updateDraft(requestId, actorId, patch, { scopedShopId = null } = {}) {
    const request = await this.repository.findRequestById(requestId)
    if (!request) {
      throw procurementError('Procurement request not found', 404, 'PROCUREMENT_REQUEST_NOT_FOUND')
    }
    this.assertShopAccess(scopedShopId, request.shop_id)
    if (request.status !== 'DRAFT') {
      throw procurementError(
        'Only draft requests can be edited',
        409,
        'PROCUREMENT_REQUEST_NOT_EDITABLE'
      )
    }

    const next = { ...request, ...patch }
    const items = patch.items
      ? this.normalizeItems(next.mode, patch.items)
      : await this.repository.findRequestItems(requestId)
    if (patch.items) this.assertItemsValid(items)

    const offerTotal = this.computeOfferTotal(next.mode, items)

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const updated = await this.repository.updateRequestDraft(requestId, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.required_delivery_at !== undefined ? { required_delivery_at: patch.required_delivery_at } : {}),
        ...(patch.response_deadline !== undefined ? { response_deadline: patch.response_deadline } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.quality_instructions !== undefined ? { quality_instructions: patch.quality_instructions } : {}),
        ...(patch.substitutes_allowed !== undefined ? { substitutes_allowed: patch.substitutes_allowed } : {}),
        ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
        offer_total: offerTotal,
      })
      let updatedItems = null
      if (patch.items) {
        updatedItems = await this.repository.replaceRequestItems(requestId, items)
      }

      await emitInTx(client, 'procurement.request.updated', {
        actor_user_id: actorId,
        target_type: 'procurement_request',
        target_id: requestId,
        before: { status: request.status, offer_total: request.offer_total },
        after: { status: 'DRAFT', offer_total: offerTotal },
      })

      await client.query('COMMIT')
      return {
        ...updated,
        items: updatedItems ?? items,
      }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // ── Publish ────────────────────────────────────────────────────

  async publishRequest(requestId, actorId, { scopedShopId = null } = {}) {
    const request = await this.repository.findRequestById(requestId)
    if (!request) {
      throw procurementError('Procurement request not found', 404, 'PROCUREMENT_REQUEST_NOT_FOUND')
    }
    this.assertShopAccess(scopedShopId, request.shop_id)
    this.validateStateTransition(request.status, 'PUBLISHED')

    const items = await this.repository.findRequestItems(requestId)
    if (items.length === 0) {
      throw procurementError('Cannot publish a requirement without items', 422, 'PROCUREMENT_REQUEST_EMPTY')
    }
    if (!request.response_deadline) {
      throw procurementError('A response deadline is required before publishing', 422, 'PROCUREMENT_DEADLINE_REQUIRED')
    }
    if (new Date(request.response_deadline).getTime() <= Date.now()) {
      throw procurementError('The response deadline must be in the future', 422, 'PROCUREMENT_DEADLINE_PAST')
    }
    if (!request.required_delivery_at) {
      throw procurementError('A required delivery time is needed before publishing', 422, 'PROCUREMENT_DELIVERY_REQUIRED')
    }
    if (request.mode === 'FIXED_OFFER') {
      const missingPrice = items.some((item) => item.fixed_unit_price == null)
      if (missingPrice) {
        throw procurementError(
          'Fixed offer items must carry a fixed unit price before publishing',
          422,
          'PROCUREMENT_FIXED_PRICE_REQUIRED'
        )
      }
    }

    const candidates = await this.repository.findEligibleVendorCandidates(request.shop_id)
    const shop = {
      pincode: request.shop_pincode,
      serviceable_pincodes: request.shop_serviceable_pincodes,
      city: request.shop_city,
    }
    const { recipients, rejected } = resolveEligibleVendors(candidates, shop, request, items)
    if (recipients.length === 0) {
      throw procurementError(
        'No eligible vendors match this requirement — resolve targeting before publishing',
        409,
        'PROCUREMENT_NO_ELIGIBLE_VENDORS'
      )
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const publishedRows = await this.repository.updateRequestStatus(requestId, 'PUBLISHED', {
        published_at: new Date().toISOString(),
      })
      if (!publishedRows) {
        throw procurementError('Procurement request not found', 404, 'PROCUREMENT_REQUEST_NOT_FOUND')
      }
      const persisted = await this.repository.insertRecipients(requestId, recipients)

      await emitInTx(client, 'procurement.request.published', {
        actor_user_id: actorId,
        target_type: 'procurement_request',
        target_id: requestId,
        before: { status: 'DRAFT' },
        after: { status: 'PUBLISHED', recipient_count: persisted.length, rejected_count: rejected.length },
      })

      await client.query('COMMIT')
      logger.info(
        { requestId, recipients: persisted.length, rejected: rejected.length },
        'Vendor procurement request published'
      )

      // Post-commit: notify every recipient vendor's users (never fails publish).
      this.notifier.requestPublished(persisted, {
        requestId,
        requestNumber: publishedRows.request_number,
        shopName: request.shop_name,
        requiredDeliveryAt: request.required_delivery_at,
        mode: request.mode,
      })

      return { request: publishedRows, recipients: persisted, rejected_count: rejected.length }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // ── Cancel / expire ────────────────────────────────────────────

  async cancelRequest(requestId, actorId, reason = null, { scopedShopId = null } = {}) {
    const request = await this.repository.findRequestById(requestId)
    if (!request) {
      throw procurementError('Procurement request not found', 404, 'PROCUREMENT_REQUEST_NOT_FOUND')
    }
    this.assertShopAccess(scopedShopId, request.shop_id)
    this.validateStateTransition(request.status, 'CANCELLED')

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const cancelled = await this.repository.updateRequestStatus(requestId, 'CANCELLED', {
        closed_at: new Date().toISOString(),
        cancel_reason: reason,
      })
      await this.repository.expireUnrespondedRecipients(requestId)

      await emitInTx(client, 'procurement.request.cancelled', {
        actor_user_id: actorId,
        target_type: 'procurement_request',
        target_id: requestId,
        before: { status: request.status },
        after: { status: 'CANCELLED', reason },
      })

      await client.query('COMMIT')
      logger.info({ requestId }, 'Vendor procurement request cancelled')

      const recipients = await this.repository.listRecipients(requestId)
      this.notifier.requestClosed(recipients, {
        requestId,
        requestNumber: request.request_number,
        status: 'CANCELLED',
      })

      return cancelled
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async expireRequest(requestId, actorId, { scopedShopId = null } = {}) {
    const request = await this.repository.findRequestById(requestId)
    if (!request) {
      throw procurementError('Procurement request not found', 404, 'PROCUREMENT_REQUEST_NOT_FOUND')
    }
    this.assertShopAccess(scopedShopId, request.shop_id)
    this.validateStateTransition(request.status, 'EXPIRED')

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const expired = await this.repository.updateRequestStatus(requestId, 'EXPIRED', {
        closed_at: new Date().toISOString(),
      })
      await this.repository.expireUnrespondedRecipients(requestId)

      await emitInTx(client, 'procurement.request.expired', {
        actor_user_id: actorId,
        target_type: 'procurement_request',
        target_id: requestId,
        before: { status: request.status },
        after: { status: 'EXPIRED' },
      })

      await client.query('COMMIT')
      logger.info({ requestId }, 'Vendor procurement request expired')

      const recipients = await this.repository.listRecipients(requestId)
      this.notifier.requestClosed(recipients, {
        requestId,
        requestNumber: request.request_number,
        status: 'EXPIRED',
      })

      return expired
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // ── Reads ──────────────────────────────────────────────────────

  async listRequests(queryParams, { scopedShopId = null } = {}) {
    const shopId = scopedShopId ?? queryParams.shop_id ?? null
    const page = Math.max(1, Number(queryParams.page) || 1)
    const limit = Math.min(100, Math.max(1, Number(queryParams.limit) || 20))
    return this.repository.listRequests({
      shopId,
      status: queryParams.status ?? null,
      mode: queryParams.mode ?? null,
      search: queryParams.search ?? null,
      page,
      limit,
    })
  }

  async getRequest(requestId, { scopedShopId = null } = {}) {
    const request = await this.repository.findRequestById(requestId)
    if (!request) {
      throw procurementError('Procurement request not found', 404, 'PROCUREMENT_REQUEST_NOT_FOUND')
    }
    this.assertShopAccess(scopedShopId, request.shop_id)

    const [items, recipients] = await Promise.all([
      this.repository.findRequestItems(requestId),
      this.repository.listRecipients(requestId),
    ])

    // Surface the awarded supply order's live fulfilment status here too —
    // previously the store/admin request-detail view had no visibility at
    // all into what the awarded vendor was actually doing after award (had
    // to separately know to go look in the unlinked Supply Orders list).
    const supplyOrderId = await this.repository.findSupplyOrderByRequestId(requestId)
    const supplyOrder = supplyOrderId ? await this.repository.findSupplyOrderById(supplyOrderId) : null

    return { ...request, items, recipients, supply_order: supplyOrder }
  }

  // ── Vendor side: inbox, detail, fixed-offer accept/decline ────

  assertVendorRespondable(vendor) {
    if (!vendor || vendor.is_active === false || vendor.status !== 'ACTIVE') {
      throw procurementError(
        'This vendor account is suspended or inactive — responding to requirements is disabled',
        403,
        'VENDOR_NOT_RESPONDABLE'
      )
    }
  }

  async getVendorInbox(vendorId, { filter = 'NEW', page = 1, limit = 20 } = {}) {
    const normalizedFilter = ['NEW', 'RESPONDED', 'CLOSED'].includes(filter) ? filter : 'NEW'
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20))
    const safePage = Math.max(1, Number(page) || 1)
    return this.repository.listVendorRequests({
      vendorId,
      filter: normalizedFilter,
      page: safePage,
      limit: safeLimit,
    })
  }

  /**
   * Vendor request detail. Vendors only ever see requests they were targeted
   * for, and only their own recipient/response state (no cross-vendor leak).
   */
  async getVendorRequestDetail(requestId, vendorId, actorId = null) {
    const request = await this.repository.findRequestById(requestId)
    if (!request) {
      throw procurementError('Procurement request not found', 404, 'PROCUREMENT_REQUEST_NOT_FOUND')
    }
    const recipient = await this.repository.findRecipientByRequestAndVendor(requestId, vendorId)
    if (!recipient) {
      throw procurementError('Procurement request not found', 404, 'PROCUREMENT_REQUEST_NOT_FOUND')
    }

    const items = await this.repository.findRequestItems(requestId)

    // Fixed offers show the vendor's own price inputs; RFQ hides commercial terms.
    const visibleItems = request.mode === 'FIXED_OFFER'
      ? items
      : items.map(({ fixed_unit_price, fixed_line_total, ...rest }) => rest)

    await this.repository.markRecipientViewed(recipient.id)

    // RFQ only — a fixed offer has no per-vendor quote to edit. Lets the
    // client tell "submit a new quote" apart from "edit my live quote" and
    // pre-fill the edit form with real, persisted values instead of
    // re-deriving them (or silently re-POSTing a duplicate).
    const myQuote = request.mode === 'RFQ'
      ? await this.repository.findLiveQuoteByRequestAndVendor(requestId, vendorId)
      : null

    return {
      request: {
        id: request.id,
        request_number: request.request_number,
        mode: request.mode,
        status: request.status,
        title: request.title,
        required_delivery_at: request.required_delivery_at,
        response_deadline: request.response_deadline,
        notes: request.notes,
        quality_instructions: request.quality_instructions,
        offer_total: request.mode === 'FIXED_OFFER' ? request.offer_total : null,
        shop_name: request.shop_name,
        shop_city: request.shop_city,
        shop_pincode: request.shop_pincode,
      },
      items: visibleItems,
      recipient,
      quote: myQuote,
    }
  }

  /**
   * Fixed-offer first-accept. Exactly one concurrent accepter wins:
   * the request row is locked FOR UPDATE inside the transaction, then a
   * conditional UPDATE (status = 'PUBLISHED') decides the winner; the loser
   * observes status AWARDED and receives ALREADY_AWARDED.
   */
  async acceptFixedOffer(requestId, vendorId, actorId, actorRole = 'VENDOR_OWNER') {
    const vendor = await this.repository.findVendorStatus(vendorId)
    this.assertVendorRespondable(vendor)

    const request = await this.repository.findRequestById(requestId)
    if (!request) {
      throw procurementError('Procurement request not found', 404, 'PROCUREMENT_REQUEST_NOT_FOUND')
    }
    if (request.mode !== 'FIXED_OFFER') {
      throw procurementError('Only fixed-offer requests can be accepted', 409, 'PROCUREMENT_NOT_FIXED_OFFER')
    }
    const recipient = await this.repository.findRecipientByRequestAndVendor(requestId, vendorId)
    if (!recipient) {
      throw procurementError('Procurement request not found', 404, 'PROCUREMENT_REQUEST_NOT_FOUND')
    }
    if (!['NEW', 'VIEWED'].includes(recipient.status)) {
      throw procurementError(
        'This offer is no longer available to you',
        409,
        'ALREADY_AWARDED'
      )
    }
    if (request.response_deadline && new Date(request.response_deadline).getTime() <= Date.now()) {
      throw procurementError('The response deadline for this offer has passed', 409, 'PROCUREMENT_DEADLINE_PASSED')
    }
    if (request.offer_total == null) {
      throw procurementError('This request has no fixed offer amount', 409, 'PROCUREMENT_NO_OFFER_AMOUNT')
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')

      const locked = await this.repository.lockRequestTx(client, requestId)
      if (!locked || locked.status !== 'PUBLISHED') {
        await client.query('ROLLBACK')
        throw procurementError(
          'This offer has already been awarded to another vendor',
          409,
          'ALREADY_AWARDED'
        )
      }

      const awarded = await this.repository.awardRequestTx(client, requestId, vendorId, request.offer_total)
      if (!awarded) {
        await client.query('ROLLBACK')
        throw procurementError(
          'This offer has already been awarded to another vendor',
          409,
          'ALREADY_AWARDED'
        )
      }

      await this.repository.setRecipientStatus(recipient.id, 'AWARDED')
      await this.repository.setOtherRecipientsNotSelectedTx(client, requestId, recipient.id)

      const items = await this.repository.findRequestItems(requestId)
      const supplyNumber = `SUP-${this.dateStamp()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`
      const supplyOrder = await this.repository.insertSupplyOrderTx(client, {
        supply_number: supplyNumber,
        request_id: requestId,
        vendor_id: vendorId,
        shop_id: request.shop_id,
        quote_id: null,
        source_mode: 'FIXED_OFFER',
        status: 'AWARDED',
        award_amount: request.offer_total,
        promised_delivery_at: request.required_delivery_at,
        created_by: actorId,
      })
      await this.repository.insertSupplyOrderItemsTx(
        client,
        supplyOrder.id,
        items.map((item) => ({
          request_item_id: item.id,
          category_id: item.category_id,
          product_id: item.product_id ?? null,
          item_name: item.item_name,
          agreed_quantity: item.requested_quantity,
          unit: item.unit,
          agreed_unit_price: item.fixed_unit_price ?? 0,
          agreed_line_total: item.fixed_line_total ?? 0,
        }))
      )
      await this.repository.insertSupplyEventTx(client, {
        supply_order_id: supplyOrder.id,
        from_status: null,
        to_status: 'AWARDED',
        actor_id: actorId,
        actor_role: actorRole,
        note: 'Fixed offer accepted — supply order created',
      })

      await emitInTx(client, 'procurement.fixed_offer.awarded', {
        actor_user_id: actorId,
        target_type: 'procurement_request',
        target_id: requestId,
        before: { status: 'PUBLISHED' },
        after: {
          status: 'AWARDED',
          vendor_id: vendorId,
          supply_order_id: supplyOrder.id,
          award_total: request.offer_total,
        },
      })

      await client.query('COMMIT')
      logger.info({ requestId, vendorId, supplyOrderId: supplyOrder.id }, 'Fixed offer accepted — winner decided')

      this.notifier.offerAwarded(vendorId, {
        requestId,
        requestNumber: request.request_number,
        supplyNumber: supplyOrder.supply_number,
        awardTotal: request.offer_total,
      })
      this.notifier.offerAcceptedByVendor(request.created_by, {
        requestId,
        requestNumber: request.request_number,
        supplyNumber: supplyOrder.supply_number,
      })

      return { request: awarded, supply_order: supplyOrder }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async declineRequest(requestId, vendorId, actorId) {
    const vendor = await this.repository.findVendorStatus(vendorId)
    this.assertVendorRespondable(vendor)

    const request = await this.repository.findRequestById(requestId)
    if (!request) {
      throw procurementError('Procurement request not found', 404, 'PROCUREMENT_REQUEST_NOT_FOUND')
    }
    const recipient = await this.repository.findRecipientByRequestAndVendor(requestId, vendorId)
    if (!recipient) {
      throw procurementError('Procurement request not found', 404, 'PROCUREMENT_REQUEST_NOT_FOUND')
    }
    if (!['NEW', 'VIEWED'].includes(recipient.status)) {
      throw procurementError('This request is no longer open to decline', 409, 'PROCUREMENT_RECIPIENT_CLOSED')
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const declined = await this.repository.setRecipientStatus(recipient.id, 'DECLINED')

      await emitInTx(client, 'procurement.request.declined', {
        actor_user_id: actorId,
        target_type: 'procurement_request',
        target_id: requestId,
        after: { vendor_id: vendorId, recipient_status: 'DECLINED' },
      })

      await client.query('COMMIT')
      return declined
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }


  // ── RFQ quotes (Big Phase 5) ───────────────────────────────────

  assertQuoteWindowOpen(request) {
    if (request.response_deadline && new Date(request.response_deadline).getTime() <= Date.now()) {
      throw procurementError('The quote deadline for this request has passed', 409, 'PROCUREMENT_DEADLINE_PASSED')
    }
  }

  normalizeQuoteItems(items) {
    if (!Array.isArray(items) || items.length === 0) {
      throw procurementError('A quote needs at least one item line', 422, 'PROCUREMENT_QUOTE_ITEMS_REQUIRED')
    }
    return items.map((item) => {
      const quoted = Number(item.quoted_quantity)
      const unitPrice = Number(item.unit_price)
      if (!(quoted > 0)) {
        throw procurementError('Quoted quantities must be greater than zero', 422, 'PROCUREMENT_QUOTE_ITEM_INVALID')
      }
      if (!(unitPrice >= 0)) {
        throw procurementError('Unit prices cannot be negative', 422, 'PROCUREMENT_QUOTE_ITEM_INVALID')
      }
      return {
        request_item_id: item.request_item_id,
        quoted_quantity: quoted,
        unit_price: unitPrice,
        line_total: Number((quoted * unitPrice).toFixed(2)),
      }
    })
  }

  computeQuoteTotal(items) {
    return Number(items.reduce((sum, item) => sum + item.line_total, 0).toFixed(2))
  }

  /**
   * Vendor submits an RFQ quote. Guards: vendor ACTIVE, targeted (recipient),
   * request PUBLISHED RFQ, deadline open, no prior live quote (edit instead).
   * The recipient moves to RESPONDED inside the same transaction.
   */
  async submitQuote(requestId, vendorId, actorId, payload, actorRole = 'VENDOR_OWNER') {
    const vendor = await this.repository.findVendorStatus(vendorId)
    this.assertVendorRespondable(vendor)

    const request = await this.repository.findRequestById(requestId)
    if (!request) {
      throw procurementError('Procurement request not found', 404, 'PROCUREMENT_REQUEST_NOT_FOUND')
    }
    if (request.mode !== 'RFQ') {
      throw procurementError('Quotes can only be submitted for RFQ requests', 409, 'PROCUREMENT_NOT_RFQ')
    }
    if (request.status !== 'PUBLISHED') {
      throw procurementError('This request is no longer open for quotes', 409, 'PROCUREMENT_REQUEST_CLOSED')
    }
    this.assertQuoteWindowOpen(request)

    const recipient = await this.repository.findRecipientByRequestAndVendor(requestId, vendorId)
    if (!recipient) {
      throw procurementError('Procurement request not found', 404, 'PROCUREMENT_REQUEST_NOT_FOUND')
    }

    const existingQuotes = await this.repository.listQuotesForRequest(requestId)
    if (existingQuotes.some((q) => q.vendor_id === vendorId && ['SUBMITTED', 'UPDATED'].includes(q.status))) {
      throw procurementError('You already have a live quote — edit it instead', 409, 'PROCUREMENT_QUOTE_EXISTS')
    }

    const items = this.normalizeQuoteItems(payload.items)
    const requestItemIds = new Set((await this.repository.findRequestItems(requestId)).map((i) => i.id))
    for (const item of items) {
      if (!requestItemIds.has(item.request_item_id)) {
        throw procurementError('Quotes may only include requested items', 422, 'PROCUREMENT_QUOTE_ITEM_UNKNOWN')
      }
    }
    const grandTotal = this.computeQuoteTotal(items)

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const quote = await this.repository.insertQuoteTx(client, {
        request_id: requestId,
        recipient_id: recipient.id,
        vendor_id: vendorId,
        grand_total: grandTotal,
        promised_delivery_at: payload.promised_delivery_at,
        note: payload.note,
        validity_until: payload.validity_until,
      })
      const persistedItems = await this.repository.insertQuoteItemsTx(client, quote.id, items)
      await this.repository.markRecipientResponded(recipient.id)

      await emitInTx(client, 'procurement.quote.submitted', {
        actor_user_id: actorId,
        target_type: 'procurement_request',
        target_id: requestId,
        after: { vendor_id: vendorId, quote_id: quote.id, grand_total: grandTotal },
      })

      await client.query('COMMIT')
      logger.info({ requestId, vendorId, quoteId: quote.id, grandTotal }, 'RFQ quote submitted')

      this.notifier.quoteSubmittedToStore(request.created_by, {
        requestId,
        requestNumber: request.request_number,
        vendorName: vendor.name,
        grandTotal,
      })

      return { ...quote, items: persistedItems }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Vendor edits their own live quote while the window is open.
   */
  async updateQuote(quoteId, vendorId, actorId, payload) {
    const vendor = await this.repository.findVendorStatus(vendorId)
    this.assertVendorRespondable(vendor)

    const quote = await this.repository.findQuoteById(quoteId)
    if (!quote || quote.vendor_id !== vendorId) {
      throw procurementError('Quote not found', 404, 'PROCUREMENT_QUOTE_NOT_FOUND')
    }
    if (!['SUBMITTED', 'UPDATED'].includes(quote.status)) {
      throw procurementError('This quote is locked and can no longer be edited', 409, 'PROCUREMENT_QUOTE_LOCKED')
    }

    const request = await this.repository.findRequestById(quote.request_id)
    if (!request || request.status !== 'PUBLISHED') {
      throw procurementError('This request is no longer open for quotes', 409, 'PROCUREMENT_REQUEST_CLOSED')
    }
    this.assertQuoteWindowOpen(request)

    const client = await getClient()
    try {
      await client.query('BEGIN')
      let persisted = null
      if (payload.items) {
        const items = this.normalizeQuoteItems(payload.items)
        const requestItemIds = new Set((await this.repository.findRequestItems(request.id)).map((i) => i.id))
        for (const item of items) {
          if (!requestItemIds.has(item.request_item_id)) {
            throw procurementError('Quotes may only include requested items', 422, 'PROCUREMENT_QUOTE_ITEM_UNKNOWN')
          }
        }
        await this.repository.updateQuoteTx(client, quoteId, {
          grand_total: this.computeQuoteTotal(items),
          ...(payload.promised_delivery_at !== undefined ? { promised_delivery_at: payload.promised_delivery_at } : {}),
          ...(payload.note !== undefined ? { note: payload.note } : {}),
          ...(payload.validity_until !== undefined ? { validity_until: payload.validity_until } : {}),
        })
        await client.query(`DELETE FROM procurement_quote_items WHERE quote_id = $1`, [quoteId])
        await this.repository.insertQuoteItemsTx(client, quoteId, items)
      } else {
        await this.repository.updateQuoteTx(client, quoteId, {
          ...(payload.promised_delivery_at !== undefined ? { promised_delivery_at: payload.promised_delivery_at } : {}),
          ...(payload.note !== undefined ? { note: payload.note } : {}),
          ...(payload.validity_until !== undefined ? { validity_until: payload.validity_until } : {}),
        })
      }
      persisted = await this.repository.findQuoteById(quoteId)

      await emitInTx(client, 'procurement.quote.updated', {
        actor_user_id: actorId,
        target_type: 'procurement_quote',
        target_id: quoteId,
        before: { grand_total: quote.grand_total, status: quote.status },
        after: { grand_total: persisted.grand_total, status: persisted.status },
      })

      await client.query('COMMIT')
      return persisted
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async withdrawQuote(quoteId, vendorId, actorId) {
    const quote = await this.repository.findQuoteById(quoteId)
    if (!quote || quote.vendor_id !== vendorId) {
      throw procurementError('Quote not found', 404, 'PROCUREMENT_QUOTE_NOT_FOUND')
    }
    if (!['SUBMITTED', 'UPDATED'].includes(quote.status)) {
      throw procurementError('This quote is locked and can no longer be withdrawn', 409, 'PROCUREMENT_QUOTE_LOCKED')
    }

    const withdrawn = await this.repository.setQuoteStatus(quoteId, 'WITHDRAWN')

    await emit('procurement.quote.withdrawn', {
      actor_user_id: actorId,
      target_type: 'procurement_quote',
      target_id: quoteId,
      before: { status: quote.status },
      after: { status: 'WITHDRAWN' },
    })
    return withdrawn
  }

  /**
   * Admin/store awards one quote. Freezes the commercial terms onto the
   * request (awarded_vendor_id + award_total), marks other quotes and
   * recipients NOT_SELECTED, and creates the supply order from the quote —
   * all in one transaction. The partial unique index
   * uq_one_selected_quote_per_request is the final single-winner guarantee.
   */
  async awardQuote(quoteId, actorId, { scopedShopId = null } = {}) {
    const quote = await this.repository.findQuoteById(quoteId)
    if (!quote) {
      throw procurementError('Quote not found', 404, 'PROCUREMENT_QUOTE_NOT_FOUND')
    }
    if (!['SUBMITTED', 'UPDATED'].includes(quote.status)) {
      throw procurementError('Only a live quote can be awarded', 409, 'PROCUREMENT_QUOTE_NOT_AWARDABLE')
    }

    const request = await this.repository.findRequestById(quote.request_id)
    if (!request) {
      throw procurementError('Procurement request not found', 404, 'PROCUREMENT_REQUEST_NOT_FOUND')
    }
    this.assertShopAccess(scopedShopId, request.shop_id)
    this.validateStateTransition(request.status, 'AWARDED')

    const client = await getClient()
    try {
      await client.query('BEGIN')

      await this.repository.lockRequestTx(client, request.id)
      const awarded = await this.repository.awardRequestTx(client, request.id, quote.vendor_id, quote.grand_total)
      if (!awarded) {
        await client.query('ROLLBACK')
        throw procurementError(
          'This request has already been awarded to another vendor',
          409,
          'ALREADY_AWARDED'
        )
      }

      await this.repository.setQuoteStatus(quoteId, 'SELECTED')
      await this.repository.setOtherQuotesNotSelectedTx(client, request.id, quoteId)

      const recipient = await this.repository.findRecipientByRequestAndVendor(request.id, quote.vendor_id)
      if (recipient) {
        await this.repository.setRecipientStatus(recipient.id, 'AWARDED')
      }
      await this.repository.setOtherRecipientsNotSelectedTx(client, request.id, recipient ? recipient.id : '00000000-0000-0000-0000-000000000000')

      const quoteItems = (await this.repository.findQuoteById(quoteId)).items
      const requestItems = await this.repository.findRequestItems(request.id)
      const requestItemById = new Map(requestItems.map((i) => [i.id, i]))
      const supplyNumber = `SUP-${this.dateStamp()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`

      const supplyOrder = await this.repository.insertSupplyOrderTx(client, {
        supply_number: supplyNumber,
        request_id: request.id,
        vendor_id: quote.vendor_id,
        shop_id: request.shop_id,
        quote_id: quoteId,
        source_mode: 'RFQ',
        status: 'AWARDED',
        award_amount: quote.grand_total,
        promised_delivery_at: quote.promised_delivery_at ?? request.required_delivery_at,
        created_by: actorId,
      })
      await this.repository.insertSupplyOrderItemsTx(
        client,
        supplyOrder.id,
        quoteItems.map((item) => {
          const source = requestItemById.get(item.request_item_id)
          return {
            request_item_id: item.request_item_id,
            category_id: source ? source.category_id : null,
            product_id: source ? source.product_id ?? null : null,
            item_name: source ? source.item_name : 'Item',
            agreed_quantity: item.quoted_quantity,
            unit: source ? source.unit : 'KG',
            agreed_unit_price: item.unit_price,
            agreed_line_total: item.line_total,
          }
        })
      )
      await this.repository.insertSupplyEventTx(client, {
        supply_order_id: supplyOrder.id,
        from_status: null,
        to_status: 'AWARDED',
        actor_id: actorId,
        actor_role: 'HQ_ADMIN',
        note: 'RFQ quote awarded — supply order created',
      })

      await emitInTx(client, 'procurement.quote.awarded', {
        actor_user_id: actorId,
        target_type: 'procurement_request',
        target_id: request.id,
        before: { status: request.status },
        after: { status: 'AWARDED', vendor_id: quote.vendor_id, supply_order_id: supplyOrder.id, award_total: quote.grand_total },
      })

      await client.query('COMMIT')
      logger.info({ requestId: request.id, quoteId, supplyOrderId: supplyOrder.id }, 'RFQ quote awarded')

      const allQuotes = await this.repository.listQuotesForRequest(request.id)
      const loserVendorIds = allQuotes
        .filter((q) => q.vendor_id !== quote.vendor_id && q.status === 'NOT_SELECTED')
        .map((q) => q.vendor_id)
      this.notifier.rfqAwarded(quote.vendor_id, loserVendorIds, {
        requestId: request.id,
        requestNumber: request.request_number,
        supplyNumber: supplyOrder.supply_number,
      })
      this.notifier.offerAcceptedByVendor(request.created_by, {
        requestId: request.id,
        requestNumber: request.request_number,
        supplyNumber: supplyOrder.supply_number,
      })

      return { request: awarded, supply_order: supplyOrder }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }


  async listQuotesForRequest(requestId, { scopedShopId = null } = {}) {
    const request = await this.repository.findRequestById(requestId)
    if (!request) {
      throw procurementError('Procurement request not found', 404, 'PROCUREMENT_REQUEST_NOT_FOUND')
    }
    this.assertShopAccess(scopedShopId, request.shop_id)
    return this.repository.listQuotesForRequest(requestId)
  }


  // ── Vendor service profile + eligibility preview (Big Phase 6) ──

  async getVendorServiceProfile(vendorId) {
    const profile = await this.repository.getVendorServiceProfile(vendorId)
    if (!profile) {
      throw procurementError('Vendor not found', 404, 'VENDOR_NOT_FOUND')
    }
    return profile
  }

  async updateVendorServiceProfile(vendorId, payload) {
    const vendor = await this.repository.findVendorStatus(vendorId)
    if (!vendor) {
      throw procurementError('Vendor not found', 404, 'VENDOR_NOT_FOUND')
    }
    const normalizedPincodes = [...new Set((payload.service_pincodes ?? []).map((pin) => String(pin).trim()))]
    return this.repository.updateVendorServiceProfile(vendorId, {
      category_ids: payload.category_ids ?? [],
      service_pincodes: normalizedPincodes,
      shop_ids: payload.shop_ids ?? [],
    })
  }

  /**
   * Eligible-vendor preview for the create-requirement flow: given a store and
   * draft items, returns who would receive the requirement and why — without
   * persisting anything.
   */
  async getEligibleVendorPreview(shopId, items = []) {
    const shop = await this.repository.findShopById(shopId)
    if (!shop) {
      throw procurementError('Shop not found', 404, 'SHOP_NOT_FOUND')
    }

    const candidates = await this.repository.findEligibleVendorCandidates(shopId)
    const { recipients, rejected } = resolveEligibleVendors(candidates, shop, { mode: 'PREVIEW' }, items)

    return {
      eligible_count: recipients.length,
      eligible: recipients.map((r) => ({
        vendor_id: r.vendorId,
        eligibility: r.eligibility,
      })),
      rejected: rejected.map((r) => ({
        vendor_id: r.vendorId,
        reasons: Object.entries(r.eligibility.checks)
          .filter(([, passed]) => !passed)
          .map(([check]) => check),
      })),
    }
  }

  // ── Supply order tracking reads (Big Phase 8) ─────────────────

  async listSupplyOrders(queryParams, { scopedShopId = null, vendorId = null } = {}) {
    const page = Math.max(1, Number(queryParams?.page) || 1)
    const limit = Math.min(100, Math.max(1, Number(queryParams?.limit) || 20))
    return this.repository.listSupplyOrders({
      shopId: scopedShopId ?? queryParams?.shop_id ?? null,
      vendorId: vendorId ?? queryParams?.vendor_id ?? null,
      status: queryParams?.status ?? null,
      search: queryParams?.search ?? null,
      page,
      limit,
    })
  }

  async getSupplyOrder(supplyOrderId, { scopedShopId = null, vendorId = null } = {}) {
    const supply = await this.repository.findSupplyOrderById(supplyOrderId)
    if (!supply) {
      throw procurementError('Supply order not found', 404, 'SUPPLY_ORDER_NOT_FOUND')
    }
    this.assertShopAccess(scopedShopId, supply.shop_id)
    if (vendorId && supply.vendor_id !== vendorId) {
      throw procurementError('Supply order not found', 404, 'SUPPLY_ORDER_NOT_FOUND')
    }
    return supply
  }

  async getVendorSupplyInbox(vendorId, queryParams) {
    return this.listSupplyOrders(queryParams, { vendorId })
  }

  async getVendorSupplyDetail(supplyOrderId, vendorId) {
    return this.getSupplyOrder(supplyOrderId, { vendorId })
  }


  // ── Supply fulfilment state machine (Big Phase 11) ────────────

  /**
   * Vendor-side operational transition. Dispatch carries the optional
   * delivery note/vehicle fields. RECEIVED/CLOSED are store-controlled and
   * rejected here for vendor callers.
   */
  async updateSupplyStatus(supplyOrderId, vendorId, actorId, nextStatus, extra = {}, actorRole = 'VENDOR_OWNER') {
    const supply = await this.repository.findSupplyOrderById(supplyOrderId)
    if (!supply) {
      throw procurementError('Supply order not found', 404, 'SUPPLY_ORDER_NOT_FOUND')
    }
    if (supply.vendor_id !== vendorId) {
      throw procurementError('Supply order not found', 404, 'SUPPLY_ORDER_NOT_FOUND')
    }

    const allowed = SUPPLY_TRANSITIONS[supply.status] || []
    if (!allowed.includes(nextStatus)) {
      throw procurementError(
        `Invalid supply transition from ${supply.status} to ${nextStatus}`,
        400,
        'INVALID_STATE_TRANSITION'
      )
    }
    if (nextStatus === 'PACKED') {
      const hasEvidence = (supply.evidence ?? []).some(
        (item) =>
          ['QUALITY_VIDEO', 'QUALITY_IMAGE'].includes(item.evidence_type) &&
          item.review_status !== 'REJECTED'
      )
      if (!hasEvidence) {
        throw procurementError(
          'Quality video evidence is required before packing',
          409,
          'SUPPLY_EVIDENCE_REQUIRED'
        )
      }
      // Keep the timeline explicit: the evidence row transitions CLEANING →
      // VIDEO_SUBMITTED when uploaded (Phase 12 route), so arriving at PACKED
      // from CLEANING with evidence is valid.
    }

    const statusExtra = {}
    if (nextStatus === 'DISPATCHED') {
      statusExtra.dispatched_at = new Date().toISOString()
      statusExtra.delivery_reference = extra.delivery_reference ?? null
      statusExtra.dispatch_note = extra.dispatch_note ?? null
      statusExtra.vehicle_note = extra.vehicle_note ?? null
    }

    const updated = await this.repository.updateSupplyStatus(supplyOrderId, nextStatus, statusExtra)
    await this.repository.insertSupplyEvent({
      supply_order_id: supplyOrderId,
      from_status: supply.status,
      to_status: nextStatus,
      actor_id: actorId,
      actor_role: actorRole,
      note: extra.note ?? null,
    })

    await emit('procurement.supply.status_changed', {
      actor_user_id: actorId,
      target_type: 'procurement_supply_order',
      target_id: supplyOrderId,
      before: { status: supply.status },
      after: { status: nextStatus },
    })

    logger.info({ supplyOrderId, from: supply.status, to: nextStatus }, 'Supply status updated')
    return updated
  }

  /**
   * Vendor uploads quality evidence (video) for a supply order. Persists the
   * metadata, transitions CLEANING → VIDEO_SUBMITTED in one transaction, and
   * audits the upload. PACKED stays gated until accepted evidence exists.
   */
  async attachEvidence(supplyOrderId, vendorId, actorId, payload, actorRole = 'VENDOR_OWNER') {
    const supply = await this.repository.findSupplyOrderById(supplyOrderId)
    if (!supply) {
      throw procurementError('Supply order not found', 404, 'SUPPLY_ORDER_NOT_FOUND')
    }
    if (supply.vendor_id !== vendorId) {
      throw procurementError('Supply order not found', 404, 'SUPPLY_ORDER_NOT_FOUND')
    }
    if (!['ACCEPTED', 'PROCESSING', 'CLEANING'].includes(supply.status)) {
      throw procurementError(
        'Evidence can only be uploaded while the supply is being prepared',
        409,
        'SUPPLY_NOT_PREPARABLE'
      )
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const evidence = await this.repository.insertEvidence({
        supply_order_id: supplyOrderId,
        vendor_id: vendorId,
        evidence_type: payload.evidence_type ?? 'QUALITY_VIDEO',
        media_public_id: payload.media_public_id,
        media_url: payload.media_url,
        mime_type: payload.mime_type,
        duration_seconds: payload.duration_seconds,
        size_bytes: payload.size_bytes,
        uploaded_by: actorId,
        review_status: 'PENDING',
      })

      if (supply.status === 'CLEANING') {
        await this.repository.updateSupplyStatus(supplyOrderId, 'VIDEO_SUBMITTED')
        await this.repository.insertSupplyEvent({
          supply_order_id: supplyOrderId,
          from_status: 'CLEANING',
          to_status: 'VIDEO_SUBMITTED',
          actor_id: actorId,
          actor_role: actorRole,
          note: 'Quality evidence uploaded',
        })
      }

      await emitInTx(client, 'procurement.supply.evidence_uploaded', {
        actor_user_id: actorId,
        target_type: 'procurement_supply_order',
        target_id: supplyOrderId,
        after: { evidence_id: evidence.id, evidence_type: evidence.evidence_type },
      })

      await client.query('COMMIT')
      logger.info({ supplyOrderId, evidenceId: evidence.id }, 'Quality evidence uploaded')
      return evidence
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Next action descriptor for the vendor UI CTA (blueprint §15.8).
   */
  nextActionFor(supply) {
    const map = {
      AWARDED: 'Mark Accepted',
      ACCEPTED: 'Mark Processing Started',
      PROCESSING: 'Mark Cleaning Started',
      CLEANING: (supply.evidence ?? []).some((e) => e.evidence_type === 'QUALITY_VIDEO')
        ? 'Mark Packed'
        : 'Upload Quality Video',
      VIDEO_SUBMITTED: 'Mark Packed',
      PACKED: 'Mark Ready for Dispatch',
      READY_FOR_DISPATCH: 'Mark Dispatched',
    }
    return map[supply.status] ?? null
  }

  // ── Store receipt + inventory bridge (Big Phase 13) ───────────

  async markDelivered(supplyOrderId, actorId, { scopedShopId = null } = {}) {
    const supply = await this.repository.findSupplyOrderById(supplyOrderId)
    if (!supply) {
      throw procurementError('Supply order not found', 404, 'SUPPLY_ORDER_NOT_FOUND')
    }
    this.assertShopAccess(scopedShopId, supply.shop_id)
    this.validateSupplyTransition(supply.status, 'DELIVERED_PENDING_RECEIPT')

    const updated = await this.repository.updateSupplyStatus(supplyOrderId, 'DELIVERED_PENDING_RECEIPT', {
      delivered_at: new Date().toISOString(),
    })
    await this.repository.insertSupplyEvent({
      supply_order_id: supplyOrderId,
      from_status: supply.status,
      to_status: 'DELIVERED_PENDING_RECEIPT',
      actor_id: actorId,
      actor_role: 'SHOP_STAFF',
      note: 'Store marked delivery received pending receipt',
    })
    return updated
  }

  validateSupplyTransition(currentStatus, nextStatus) {
    const allowed = SUPPLY_TRANSITIONS[currentStatus] || []
    const extended = currentStatus === 'DISPATCHED' ? [...allowed, 'DELIVERED_PENDING_RECEIPT'] : allowed
    if (!extended.includes(nextStatus)) {
      throw procurementError(
        `Invalid supply transition from ${currentStatus} to ${nextStatus}`,
        400,
        'INVALID_STATE_TRANSITION'
      )
    }
  }

  /**
   * Store confirms receipt with per-item variance. Only accepted quantity of
   * product-mapped items enters inventory via the existing inbound path
   * (registerInbound); unmapped items record the variance and skip inventory
   * with an explicit flag. Physical receipt is the source of truth — an
   * inventory failure never rolls back the receipt.
   */
  async receiveSupply(supplyOrderId, actorId, payload, { scopedShopId = null } = {}) {
    const supply = await this.repository.findSupplyOrderById(supplyOrderId)
    if (!supply) {
      throw procurementError('Supply order not found', 404, 'SUPPLY_ORDER_NOT_FOUND')
    }
    this.assertShopAccess(scopedShopId, supply.shop_id)
    if (supply.status !== 'DELIVERED_PENDING_RECEIPT') {
      throw procurementError(
        'Supply must be marked delivered before receipt can be confirmed',
        409,
        'SUPPLY_NOT_PENDING_RECEIPT'
      )
    }

    const items = payload.items ?? []
    if (items.length === 0) {
      throw procurementError('Receipt requires at least one item line', 422, 'RECEIPT_ITEMS_REQUIRED')
    }
    const supplyItems = new Map(supply.items.map((item) => [item.id, item]))
    const normalized = items.map((line) => {
      const supplyItem = supplyItems.get(line.supply_order_item_id)
      if (!supplyItem) {
        throw procurementError('Receipt line references an unknown supply item', 422, 'RECEIPT_ITEM_UNKNOWN')
      }
      const received = Number(line.received_quantity ?? 0)
      const accepted = Number(line.accepted_quantity ?? 0)
      const rejected = Number(line.rejected_quantity ?? 0)
      if (received < 0 || accepted < 0 || rejected < 0 || accepted + rejected > received) {
        throw procurementError(
          `Accepted + rejected quantity cannot exceed received quantity for ${supplyItem.item_name}`,
          422,
          'RECEIPT_QUANTITY_INVALID'
        )
      }
      return {
        supply_order_item_id: line.supply_order_item_id,
        requested_quantity: Number(supplyItem.agreed_quantity),
        received_quantity: received,
        accepted_quantity: accepted,
        rejected_quantity: rejected,
        // Pre-filled from the request → award chain (see
        // insertSupplyOrderItemsTx's `product_id`, migration 143) whenever
        // the receiving line itself didn't override it — staff confirming
        // an already-known SKU no longer has to re-pick it from scratch,
        // but can still correct it per line if needed.
        product_id: line.product_id ?? supplyItem.product_id ?? null,
        issue_category: line.issue_category ?? null,
        issue_note: line.issue_note ?? null,
        expiry_date: line.expiry_date ?? null,
      }
    })

    const anyAccepted = normalized.some((line) => line.accepted_quantity > 0)
    const receiptStatus = anyAccepted ? 'RECEIVED' : 'REJECTED_AT_RECEIPT'

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const receipt = await this.repository.insertReceipt(client, {
        supply_order_id: supplyOrderId,
        shop_id: supply.shop_id,
        status: receiptStatus,
        received_by: actorId,
        note: payload.note,
        photo_url: payload.photo_url,
      })
      const receiptItems = []
      for (const line of normalized) {
        receiptItems.push(await this.repository.insertReceiptItem(client, receipt.id, line))
      }

      const updated = await this.repository.markSupplyReceived(supplyOrderId, receiptStatus, receiptStatus === 'RECEIVED' ? new Date().toISOString() : null)
      await this.repository.insertSupplyEvent({
        supply_order_id: supplyOrderId,
        from_status: 'DELIVERED_PENDING_RECEIPT',
        to_status: receiptStatus,
        actor_id: actorId,
        actor_role: 'SHOP_STAFF',
        note: receiptStatus === 'RECEIVED' ? 'Receipt confirmed' : 'Rejected at receipt',
      })
      if (receiptStatus === 'RECEIVED') {
        await this.repository.markRequestCompleted(supply.request_id)
      }

      await emitInTx(client, 'procurement.supply.received', {
        actor_user_id: actorId,
        target_type: 'procurement_supply_order',
        target_id: supplyOrderId,
        before: { status: 'DELIVERED_PENDING_RECEIPT' },
        after: { status: receiptStatus, receipt_id: receipt.id },
      })

      await client.query('COMMIT')

      // Marketplace stock bridge (post-commit): accepted quantities should
      // update the destination shop's seller listings (shop_products stock
      // + stock_movements ledger). The FEFO lot path was removed with the
      // grocery inventory subsystem; Phase 6 wires the shop_products stock
      // update here once B2B receipts are keyed to seller SKUs.
      if (receiptStatus === 'RECEIVED') {
        logger.info(
          { supplyOrderId: supply.id, shopId: supply.shop_id, lines: normalized.length },
          'B2B receipt accepted — seller-listing stock sync lands in Phase 6'
        )
      }

      logger.info({ supplyOrderId, status: receiptStatus }, 'Supply receipt confirmed')
      return { receipt, supply_order: updated, inventory: inventoryResults }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Bridge a vendor's accepted receipt line into the sellable
   * `shop_products.stock_quantity` for that exact shop + product, so
   * "10 kg received" genuinely becomes "10 kg available to sell" without an
   * admin re-typing the number by hand. Runs in its own short transaction
   * (separate from receiveSupply's, which already committed by the time
   * this is called — see that method's own post-commit inventory bridge).
   *
   * Deliberately does NOT auto-create a shop_products row: a product must
   * already be added to this shop's catalog (with a real price) via the
   * dashboard's "Add Product to Shop" flow before vendor stock can flow
   * into it — that is a distinct, admin-owned pricing decision. When no
   * matching shop_products row exists yet, this just marks the receipt
   * line as not-yet-linked; the vendor batch itself is still fully
   * recorded in inventory_lots and remains linkable later.
   *
   * @param {import('../shop-products/shop-products.repository.js').ShopProductsRepository} shopProductsRepository
   * @param {{shopId:string, productId:string, quantity:number, actorId:string,
   *   supplyOrderId:string, supplyNumber:string, vendorId:string|null,
   *   receiptItemId:string, inventoryLotId:string}} ctx
   * @param {object} resultEntry - mutated in place with shop_stock_* fields
   */
  async _syncShopProductStockFromReceipt(shopProductsRepository, ctx, resultEntry) {
    const shopProduct = await shopProductsRepository.findByShopAndProduct(ctx.shopId, ctx.productId)
    if (!shopProduct || shopProduct.deleted_at) {
      resultEntry.shop_stock_linked = false
      return
    }

    // `shop_products.stock_quantity` is a plain INTEGER (migration 031)
    // while a vendor's received quantity (`inventory_lots.quantity_on_hand`)
    // is NUMERIC(10,2) — fractional kg is a real, expected case here. Round
    // to the nearest whole unit rather than truncate (truncating would
    // always under-credit the shop, e.g. 2.9kg -> 2 instead of 3). A
    // genuinely sub-1-unit receipt (e.g. 0.4kg) rounds to 0, which is not a
    // valid non-zero stock_movements delta — skip the sync rather than
    // force a fake delta; the vendor batch itself is still fully recorded
    // in inventory_lots either way, so nothing is lost, only the sellable
    // count doesn't move for a quantity too small for this integer column
    // to represent. Converting stock_quantity itself to NUMERIC would be a
    // platform-wide change (cart validation, purchase limits, the
    // adjust-stock schema's own integer-only delta, mobile's int parsing)
    // and is out of scope here — flagged separately, not silently patched.
    const roundedQuantity = Math.round(Number(ctx.quantity))
    if (roundedQuantity === 0) {
      resultEntry.shop_stock_linked = false
      resultEntry.shop_stock_skip_reason = 'QUANTITY_ROUNDS_TO_ZERO'
      return
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { stockProduct } = await shopProductsRepository.applyStockChange(client, {
        shopProductId: shopProduct.id,
        delta: roundedQuantity,
        type: 'PROCUREMENT_RECEIPT',
        reason: `Received from supply order ${ctx.supplyNumber}`,
        actor: { userId: ctx.actorId, shopRole: null },
        source: 'API',
        metadata: {
          supply_order_id: ctx.supplyOrderId,
          supply_number: ctx.supplyNumber,
          receipt_item_id: ctx.receiptItemId,
          inventory_lot_id: ctx.inventoryLotId,
          vendor_id: ctx.vendorId,
          quantity_received: Number(ctx.quantity),
        },
        orderId: null,
      })
      await client.query('COMMIT')

      resultEntry.shop_stock_linked = true
      resultEntry.shop_product_id = shopProduct.id
      resultEntry.shop_stock_quantity_after = stockProduct.stock_quantity

      // Mirrors ShopProductsService#invalidateShopCache (kept inline here
      // rather than instantiating the whole service for one cache clear).
      await Promise.all([
        cacheDeletePattern(`bakaloo:shop-products:v1:${ctx.shopId}:*`),
        cacheDeletePattern('products:*'),
        cacheDeletePattern('bakaloo:tab_home:*'),
        cacheDeletePattern('bakaloo:sections:public:*'),
      ])
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // ── Reviews + performance (Big Phase 14) ──────────────────────

  /**
   * Store/admin rates a completed supply. One review per supply (UNIQUE);
   * requires RECEIVED status so ratings always follow confirmed receipt.
   */
  async submitReview(supplyOrderId, actorId, payload, { scopedShopId = null } = {}) {
    const supply = await this.repository.findSupplyOrderById(supplyOrderId)
    if (!supply) {
      throw procurementError('Supply order not found', 404, 'SUPPLY_ORDER_NOT_FOUND')
    }
    this.assertShopAccess(scopedShopId, supply.shop_id)
    if (!['RECEIVED', 'CLOSED'].includes(supply.status)) {
      throw procurementError(
        'Supplies can only be rated after receipt is confirmed',
        409,
        'SUPPLY_NOT_REVIEWABLE'
      )
    }

    const receipt = await this.repository.findReceiptBySupply(supplyOrderId)
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const review = await this.repository.insertReview(client, {
        supply_order_id: supplyOrderId,
        vendor_id: supply.vendor_id,
        shop_id: supply.shop_id,
        receipt_id: receipt?.id ?? null,
        rated_by: actorId,
        rating_freshness: payload.rating_freshness,
        rating_cleaning: payload.rating_cleaning,
        rating_packaging: payload.rating_packaging,
        rating_quantity_accuracy: payload.rating_quantity_accuracy,
        rating_punctuality: payload.rating_punctuality,
        rating_overall: payload.rating_overall,
        comment: payload.comment,
        issue_category: payload.issue_category,
        issue_note: payload.issue_note,
      })

      await emitInTx(client, 'procurement.supply.reviewed', {
        actor_user_id: actorId,
        target_type: 'procurement_supply_order',
        target_id: supplyOrderId,
        after: { review_id: review.id, rating_overall: payload.rating_overall, issue_category: payload.issue_category ?? null },
      })

      await client.query('COMMIT')
      logger.info({ supplyOrderId, reviewId: review.id }, 'Vendor supply review posted')
      return review
    } catch (err) {
      await client.query('ROLLBACK')
      if (err.code === '23505') {
        throw procurementError('This supply order has already been reviewed', 409, 'SUPPLY_ALREADY_REVIEWED')
      }
      throw err
    } finally {
      client.release()
    }
  }

  async getVendorPerformance(vendorId) {
    const vendor = await this.repository.findVendorStatus(vendorId)
    if (!vendor) {
      throw procurementError('Vendor not found', 404, 'VENDOR_NOT_FOUND')
    }
    const performance = await this.repository.getVendorPerformance(vendorId)
    return { vendor: { id: vendor.id, name: vendor.name, status: vendor.status }, performance }
  }

  async getVendorReviews(vendorId, queryParams = {}) {
    const page = Math.max(1, Number(queryParams?.page) || 1)
    const limit = Math.min(50, Math.max(1, Number(queryParams?.limit) || 10))
    return this.repository.listVendorReviews(vendorId, { page, limit })
  }

  /**
   * Vendor app: own performance + reviews (vendor scope enforced upstream).
   */
  async getOwnPerformance(vendorId) {
    return this.getVendorPerformance(vendorId)
  }

  async getOwnReviews(vendorId, queryParams) {
    return this.getVendorReviews(vendorId, queryParams)
  }

  // ── Item normalization helpers ─────────────────────────────────

  normalizeItems(mode, items) {
    return items.map((item) => {
      const normalized = {
        category_id: item.category_id,
        product_id: item.product_id ?? null,
        item_name: item.item_name,
        requested_quantity: item.requested_quantity,
        unit: UNITS.has(item.unit) ? item.unit : 'KG',
        spec_note: item.spec_note ?? null,
        fixed_unit_price: null,
        fixed_line_total: null,
      }
      if (mode === 'FIXED_OFFER') {
        normalized.fixed_unit_price = item.fixed_unit_price
        normalized.fixed_line_total = Number(
          (Number(item.requested_quantity) * Number(item.fixed_unit_price)).toFixed(2)
        )
      }
      return normalized
    })
  }

  assertItemsValid(items) {
    if (!Array.isArray(items) || items.length === 0) {
      throw procurementError('At least one item is required', 422, 'PROCUREMENT_ITEMS_REQUIRED')
    }
    for (const item of items) {
      if (!item.category_id || !item.product_id || !item.item_name) {
        throw procurementError(
          'Each item needs a category, a specific catalog product, and a name',
          422,
          'PROCUREMENT_ITEM_INVALID'
        )
      }
      if (!(Number(item.requested_quantity) > 0)) {
        throw procurementError('Item quantities must be greater than zero', 422, 'PROCUREMENT_ITEM_INVALID')
      }
    }
  }

  computeOfferTotal(mode, items) {
    if (mode !== 'FIXED_OFFER') return null
    return Number(items.reduce((sum, item) => sum + Number(item.fixed_line_total ?? 0), 0).toFixed(2))
  }

  dateStamp() {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '')
  }
}
