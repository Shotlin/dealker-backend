/**
 * Vendor Procurement Repository — Data Access Layer (requests, items, recipients)
 * Source of truth: vendor_procurement_blueprint/01_VENDOR_REQUIREMENTS.md §6, §17
 *
 * Distinct from the internal purchase-order repository in
 * src/modules/procurement/procurement.repository.js (migration 100 flow).
 *
 * @module modules/vendor-procurement/vendor-procurement.repository
 */

import { query, getClient } from '../../config/database.js'

export class VendorProcurementRepository {
  // ── Requests ───────────────────────────────────────────────────

  async insertRequest(requestData) {
    const { rows } = await query(
      `INSERT INTO procurement_requests
         (request_number, shop_id, mode, title, required_delivery_at, response_deadline,
          notes, quality_instructions, substitutes_allowed, offer_total, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        requestData.request_number,
        requestData.shop_id,
        requestData.mode,
        requestData.title,
        requestData.required_delivery_at ?? null,
        requestData.response_deadline ?? null,
        requestData.notes ?? null,
        requestData.quality_instructions ?? null,
        requestData.substitutes_allowed ?? false,
        requestData.offer_total ?? null,
        requestData.created_by ?? null,
      ]
    )
    return rows[0]
  }

  async insertRequestItem(requestId, itemData) {
    const { rows } = await query(
      `INSERT INTO procurement_request_items
         (request_id, category_id, product_id, item_name, requested_quantity, unit, spec_note, fixed_unit_price, fixed_line_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        requestId,
        itemData.category_id,
        itemData.product_id ?? null,
        itemData.item_name,
        itemData.requested_quantity,
        itemData.unit ?? 'KG',
        itemData.spec_note ?? null,
        itemData.fixed_unit_price ?? null,
        itemData.fixed_line_total ?? null,
      ]
    )
    return rows[0]
  }

  async updateRequestDraft(requestId, patch) {
    const set = []
    const params = [requestId]
    const columns = {
      title: 'title',
      required_delivery_at: 'required_delivery_at',
      response_deadline: 'response_deadline',
      notes: 'notes',
      quality_instructions: 'quality_instructions',
      substitutes_allowed: 'substitutes_allowed',
      offer_total: 'offer_total',
      mode: 'mode',
    }
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        params.push(patch[key])
        set.push(`${column} = $${params.length}`)
      }
    }
    if (set.length === 0) {
      return this.findRequestById(requestId)
    }
    const { rows } = await query(
      `UPDATE procurement_requests SET ${set.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      params
    )
    return rows[0] ?? null
  }

  async replaceRequestItems(requestId, items) {
    await query(`DELETE FROM procurement_request_items WHERE request_id = $1`, [requestId])
    const inserted = []
    for (const itemData of items) {
      inserted.push(await this.insertRequestItem(requestId, itemData))
    }
    return inserted
  }

  async findRequestById(id) {
    const { rows } = await query(
      `SELECT r.*, s.name AS shop_name, s.city AS shop_city, s.pincode AS shop_pincode,
              s.serviceable_pincodes AS shop_serviceable_pincodes
         FROM procurement_requests r
         JOIN shops s ON s.id = r.shop_id
        WHERE r.id = $1 AND r.deleted_at IS NULL
        LIMIT 1`,
      [id]
    )
    return rows[0] ?? null
  }

  async findRequestItems(requestId) {
    const { rows } = await query(
      `SELECT i.*, c.name AS category_name,
              p.thumbnail_url AS product_image_url
         FROM procurement_request_items i
         JOIN categories c ON c.id = i.category_id
         LEFT JOIN products p ON p.id = i.product_id
        WHERE i.request_id = $1
        ORDER BY i.created_at, i.id`,
      [requestId]
    )
    return rows
  }

  async listRequests({ shopId = null, status = null, mode = null, search = null, page = 1, limit = 20 }) {
    const conditions = ['r.deleted_at IS NULL']
    const params = []
    if (shopId) {
      params.push(shopId)
      conditions.push(`r.shop_id = $${params.length}`)
    }
    if (status) {
      params.push(status)
      conditions.push(`r.status = $${params.length}`)
    }
    if (mode) {
      params.push(mode)
      conditions.push(`r.mode = $${params.length}`)
    }
    if (search) {
      params.push(`%${search}%`)
      conditions.push(`(r.title ILIKE $${params.length} OR r.request_number ILIKE $${params.length})`)
    }
    const where = conditions.join(' AND ')

    const countParams = [...params]
    const countResult = await query(
      `SELECT COUNT(*)::int AS total FROM procurement_requests r WHERE ${where}`,
      countParams
    )

    params.push(limit)
    params.push((page - 1) * limit)
    const offsetIndex = params.length
    const limitIndex = params.length - 1
    const { rows } = await query(
      `SELECT r.id, r.request_number, r.shop_id, r.mode, r.status, r.title,
              r.required_delivery_at, r.response_deadline, r.offer_total, r.award_total,
              r.awarded_vendor_id, r.published_at, r.closed_at, r.created_at,
              v.name AS awarded_vendor_name, s.name AS shop_name, s.city AS shop_city,
              (SELECT COUNT(*)::int FROM procurement_recipients rec WHERE rec.request_id = r.id) AS recipient_count,
              (SELECT COUNT(*)::int FROM procurement_recipients rec WHERE rec.request_id = r.id AND rec.status IN ('RESPONDED', 'AWARDED')) AS responded_count
         FROM procurement_requests r
         JOIN shops s ON s.id = r.shop_id
         LEFT JOIN vendors v ON v.id = r.awarded_vendor_id
        WHERE ${where}
        ORDER BY r.created_at DESC
        LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params
    )

    return { requests: rows, total: countResult.rows[0].total, page, limit }
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  async updateRequestStatus(requestId, status, extra = {}) {
    const { rows } = await query(
      `UPDATE procurement_requests
          SET status = $2,
              published_at = COALESCE($3, published_at),
              closed_at = COALESCE($4, closed_at),
              cancel_reason = COALESCE($5, cancel_reason)
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [requestId, status, extra.published_at ?? null, extra.closed_at ?? null, extra.cancel_reason ?? null]
    )
    return rows[0] ?? null
  }

  // ── Recipients ─────────────────────────────────────────────────

  async insertRecipients(requestId, recipients) {
    if (recipients.length === 0) return []
    const values = []
    const params = []
    recipients.forEach((recipient, index) => {
      const base = index * 4
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}::jsonb, $${base + 4})`)
      params.push(requestId, recipient.vendorId, JSON.stringify(recipient.eligibility ?? {}), 'NEW')
    })
    const { rows } = await query(
      `INSERT INTO procurement_recipients (request_id, vendor_id, eligibility, status)
       VALUES ${values.join(', ')}
       ON CONFLICT (request_id, vendor_id) DO NOTHING
       RETURNING *`,
      params
    )
    return rows
  }

  async listRecipients(requestId) {
    const { rows } = await query(
      `SELECT rec.*, v.name AS vendor_name, v.phone AS vendor_phone, v.email AS vendor_email
         FROM procurement_recipients rec
         JOIN vendors v ON v.id = rec.vendor_id
        WHERE rec.request_id = $1
        ORDER BY rec.created_at, rec.id`,
      [requestId]
    )
    return rows
  }

  async expireUnrespondedRecipients(requestId) {
    const { rows } = await query(
      `UPDATE procurement_recipients
          SET status = 'EXPIRED', decided_at = NOW()
        WHERE request_id = $1 AND status IN ('NEW', 'VIEWED')
        RETURNING id`,
      [requestId]
    )
    return rows
  }

  // ── Eligibility candidate query ────────────────────────────────

  /**
   * Candidate vendors for publish-time targeting. Only candidates are fetched
   * here; the pure resolver (vendor-eligibility.js) makes the eligibility call.
   */
  async findEligibleVendorCandidates(shopId = null) {
    const { rows } = await query(
      `SELECT v.id, v.name, v.status, v.is_active,
              vp.pincode AS profile_pincode, vp.city AS profile_city,
              EXISTS (
                SELECT 1 FROM vendor_users vu
                 WHERE vu.vendor_id = v.id AND vu.is_active AND vu.deleted_at IS NULL
              ) AS has_active_user,
              COALESCE((
                SELECT array_agg(vsc.category_id)
                  FROM vendor_supply_categories vsc
                 WHERE vsc.vendor_id = v.id
              ), '{}') AS categories,
              COALESCE((
                SELECT array_agg(vsa.pincode)
                  FROM vendor_service_areas vsa
                 WHERE vsa.vendor_id = v.id
              ), '{}') AS service_pincodes,
              $1::uuid IS NOT NULL AND EXISTS (
                SELECT 1 FROM vendor_store_assignments vss
                 WHERE vss.vendor_id = v.id AND vss.shop_id = $1::uuid
              ) AS assigned_to_shop
         FROM vendors v
         LEFT JOIN vendor_profiles vp ON vp.vendor_id = v.id
        WHERE v.deleted_at IS NULL AND v.is_active
        ORDER BY v.name`,
      [shopId]
    )
    return rows.map((row) => ({
      ...row,
      categories: row.categories ?? [],
      service_pincodes: row.service_pincodes ?? [],
    }))
  }

  // ── Vendor service profile (categories, areas, store assignments) ──

  async getVendorServiceProfile(vendorId) {
    const vendorResult = await query(
      `SELECT v.id, v.name, v.status, v.is_active, vp.legal_name, vp.city AS profile_city, vp.pincode AS profile_pincode
         FROM vendors v
         LEFT JOIN vendor_profiles vp ON vp.vendor_id = v.id
        WHERE v.id = $1 AND v.deleted_at IS NULL
        LIMIT 1`,
      [vendorId]
    )
    if (!vendorResult.rows[0]) return null

    const categories = await query(
      `SELECT vsc.category_id, c.name AS category_name
         FROM vendor_supply_categories vsc
         JOIN categories c ON c.id = vsc.category_id
        WHERE vsc.vendor_id = $1
        ORDER BY c.name`,
      [vendorId]
    )
    const areas = await query(
      `SELECT pincode FROM vendor_service_areas WHERE vendor_id = $1 ORDER BY pincode`,
      [vendorId]
    )
    const stores = await query(
      `SELECT vss.shop_id, s.name AS shop_name, s.city AS shop_city
         FROM vendor_store_assignments vss
         JOIN shops s ON s.id = vss.shop_id
        WHERE vss.vendor_id = $1
        ORDER BY s.name`,
      [vendorId]
    )

    return {
      vendor: vendorResult.rows[0],
      categories: categories.rows,
      service_pincodes: areas.rows.map((r) => r.pincode),
      store_assignments: stores.rows,
    }
  }

  /**
   * Replace-all update of a vendor's targeting profile in one transaction.
   * FK constraints validate category/shop ids; pincodes are normalized here.
   */
  async updateVendorServiceProfile(vendorId, { category_ids = [], service_pincodes = [], shop_ids = [] }) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`DELETE FROM vendor_supply_categories WHERE vendor_id = $1`, [vendorId])
      await client.query(`DELETE FROM vendor_service_areas WHERE vendor_id = $1`, [vendorId])
      await client.query(`DELETE FROM vendor_store_assignments WHERE vendor_id = $1`, [vendorId])

      for (const categoryId of category_ids) {
        await client.query(
          `INSERT INTO vendor_supply_categories (vendor_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [vendorId, categoryId]
        )
      }
      for (const pincode of service_pincodes) {
        await client.query(
          `INSERT INTO vendor_service_areas (vendor_id, pincode) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [vendorId, pincode]
        )
      }
      for (const shopId of shop_ids) {
        await client.query(
          `INSERT INTO vendor_store_assignments (vendor_id, shop_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [vendorId, shopId]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    return this.getVendorServiceProfile(vendorId)
  }

  async findShopById(shopId) {
    const { rows } = await query(
      `SELECT id, name, city, pincode, serviceable_pincodes FROM shops WHERE id = $1 LIMIT 1`,
      [shopId]
    )
    return rows[0] ?? null
  }

  // ── Vendor inbox (fixed offer / RFQ responses) ─────────────────

  /**
   * Vendor request inbox. Tab semantics (blueprint §15.4):
   *   NEW       — recipient NEW/VIEWED and request still PUBLISHED
   *   RESPONDED — recipient RESPONDED (quote submitted) or DECLINED
   *   CLOSED    — recipient AWARDED/NOT_SELECTED/EXPIRED or request no longer PUBLISHED
   */
  async listVendorRequests({ vendorId, filter = 'NEW', page = 1, limit = 20 }) {
    const conditions = [
      'r.deleted_at IS NULL',
      'rec.vendor_id = $1',
    ]
    if (filter === 'NEW') {
      conditions.push(`rec.status IN ('NEW', 'VIEWED')`)
      conditions.push(`r.status = 'PUBLISHED'`)
    } else if (filter === 'RESPONDED') {
      conditions.push(`rec.status IN ('RESPONDED', 'DECLINED')`)
      conditions.push(`r.status = 'PUBLISHED'`)
    } else {
      conditions.push(`(rec.status IN ('AWARDED', 'NOT_SELECTED', 'EXPIRED') OR r.status <> 'PUBLISHED')`)
    }
    const where = conditions.join(' AND ')

    const countResult = await query(
      `SELECT COUNT(*)::int AS total
         FROM procurement_recipients rec
         JOIN procurement_requests r ON r.id = rec.request_id
        WHERE ${where}`,
      [vendorId]
    )

    const { rows } = await query(
      `SELECT r.id, r.request_number, r.shop_id, r.mode, r.status, r.title,
              r.required_delivery_at, r.response_deadline, r.offer_total, r.quality_instructions,
              rec.status AS recipient_status, rec.responded_at AS recipient_responded_at, rec.viewed_at AS recipient_viewed_at,
              s.name AS shop_name, s.city AS shop_city,
              (SELECT jsonb_agg(jsonb_build_object('item_name', i.item_name, 'requested_quantity', i.requested_quantity, 'unit', i.unit))
                 FROM procurement_request_items i WHERE i.request_id = r.id) AS item_summary
         FROM procurement_recipients rec
         JOIN procurement_requests r ON r.id = rec.request_id
         JOIN shops s ON s.id = r.shop_id
        WHERE ${where}
        ORDER BY r.response_deadline ASC NULLS LAST, r.published_at DESC
        LIMIT $2 OFFSET $3`,
      [vendorId, limit, (page - 1) * limit]
    )

    return { requests: rows, total: countResult.rows[0].total, page, limit }
  }

  async findRecipientByRequestAndVendor(requestId, vendorId) {
    const { rows } = await query(
      `SELECT * FROM procurement_recipients WHERE request_id = $1 AND vendor_id = $2 LIMIT 1`,
      [requestId, vendorId]
    )
    return rows[0] ?? null
  }

  async markRecipientViewed(recipientId) {
    await query(
      `UPDATE procurement_recipients SET status = 'VIEWED', viewed_at = NOW()
        WHERE id = $1 AND status = 'NEW'`,
      [recipientId]
    )
  }

  async setRecipientStatus(recipientId, status) {
    const { rows } = await query(
      `UPDATE procurement_recipients SET status = $2, decided_at = NOW() WHERE id = $1 RETURNING *`,
      [recipientId, status]
    )
    return rows[0] ?? null
  }

  /**
   * Marks every other still-open recipient of a request as NOT_SELECTED.
   * Used when one vendor wins (fixed-offer accept or RFQ award).
   */
  async setOtherRecipientsNotSelectedTx(client, requestId, winnerRecipientId) {
    await client.query(
      `UPDATE procurement_recipients
          SET status = 'NOT_SELECTED', decided_at = NOW()
        WHERE request_id = $1
          AND id <> $2
          AND status IN ('NEW', 'VIEWED', 'RESPONDED')`,
      [requestId, winnerRecipientId]
    )
  }

  /**
   * Sets a recipient's responded timestamp (quote submitted / response recorded).
   */
  async markRecipientResponded(recipientId) {
    await query(
      `UPDATE procurement_recipients SET status = 'RESPONDED', responded_at = NOW()
        WHERE id = $1 AND status IN ('NEW', 'VIEWED', 'RESPONDED')`,
      [recipientId]
    )
  }

  // ── Award + supply order creation (transactional) ─────────────

  /**
   * Conditional award — THE race-safety anchor for first-accept.
   * Returns the awarded row, or null when the request is no longer PUBLISHED
   * (another vendor won / request closed). Caller must hold the row lock via
   * lockRequestForAwardTx or rely on this conditional UPDATE inside a transaction.
   */
  async awardRequestTx(client, requestId, vendorId, awardTotal) {
    const { rows } = await client.query(
      `UPDATE procurement_requests
          SET status = 'AWARDED',
              awarded_vendor_id = $2,
              awarded_at = NOW(),
              award_total = $3
        WHERE id = $1 AND status = 'PUBLISHED' AND deleted_at IS NULL
        RETURNING *`,
      [requestId, vendorId, awardTotal]
    )
    return rows[0] ?? null
  }

  /**
   * Row-level lock on the request inside an open transaction — serialises
   * concurrent fixed-offer accepts so the conditional award is decisive.
   */
  async lockRequestTx(client, requestId) {
    const { rows } = await client.query(
      `SELECT * FROM procurement_requests WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [requestId]
    )
    return rows[0] ?? null
  }

  async insertSupplyOrderTx(client, supplyData) {
    const { rows } = await client.query(
      `INSERT INTO procurement_supply_orders
         (supply_number, request_id, vendor_id, shop_id, quote_id, source_mode,
          status, award_amount, promised_delivery_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        supplyData.supply_number,
        supplyData.request_id,
        supplyData.vendor_id,
        supplyData.shop_id,
        supplyData.quote_id ?? null,
        supplyData.source_mode,
        supplyData.status ?? 'AWARDED',
        supplyData.award_amount,
        supplyData.promised_delivery_at ?? null,
        supplyData.created_by ?? null,
      ]
    )
    return rows[0]
  }

  async insertSupplyOrderItemsTx(client, supplyOrderId, items) {
    const inserted = []
    for (const item of items) {
      const { rows } = await client.query(
        `INSERT INTO procurement_supply_order_items
           (supply_order_id, request_item_id, category_id, product_id, item_name, agreed_quantity, unit, agreed_unit_price, agreed_line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          supplyOrderId,
          item.request_item_id ?? null,
          item.category_id ?? null,
          item.product_id ?? null,
          item.item_name,
          item.agreed_quantity,
          item.unit ?? 'KG',
          item.agreed_unit_price ?? 0,
          item.agreed_line_total ?? 0,
        ]
      )
      inserted.push(rows[0])
    }
    return inserted
  }

  /**
   * Updates supply status + the operational timestamps that go with it.
   */
  async updateSupplyStatus(supplyOrderId, status, extra = {}) {
    const { rows } = await query(
      `UPDATE procurement_supply_orders
          SET status = $2,
              delivery_reference = COALESCE($3, delivery_reference),
              dispatch_note = COALESCE($4, dispatch_note),
              vehicle_note = COALESCE($5, vehicle_note),
              dispatched_at = COALESCE($6, dispatched_at),
              closed_at = COALESCE($7, closed_at)
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [
        supplyOrderId,
        status,
        extra.delivery_reference ?? null,
        extra.dispatch_note ?? null,
        extra.vehicle_note ?? null,
        extra.dispatched_at ?? null,
        extra.closed_at ?? null,
      ]
    )
    return rows[0] ?? null
  }

  /**
   * Persists quality-evidence metadata for a supply order (Big Phase 12).
   */
  async insertEvidence(evidenceData) {
    const { rows } = await query(
      `INSERT INTO procurement_evidence
         (supply_order_id, vendor_id, evidence_type, media_public_id, media_url,
          mime_type, duration_seconds, size_bytes, uploaded_by, review_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        evidenceData.supply_order_id,
        evidenceData.vendor_id,
        evidenceData.evidence_type ?? 'QUALITY_VIDEO',
        evidenceData.media_public_id,
        evidenceData.media_url,
        evidenceData.mime_type ?? null,
        evidenceData.duration_seconds ?? null,
        evidenceData.size_bytes ?? null,
        evidenceData.uploaded_by ?? null,
        evidenceData.review_status ?? 'PENDING',
      ]
    )
    return rows[0]
  }

  // ── Reviews + vendor performance (Big Phase 14) ───────────────

  async insertReview(client, reviewData) {
    const { rows } = await client.query(
      `INSERT INTO vendor_supply_reviews
         (supply_order_id, vendor_id, shop_id, receipt_id, rated_by,
          rating_freshness, rating_cleaning, rating_packaging,
          rating_quantity_accuracy, rating_punctuality, rating_overall,
          comment, issue_category, issue_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        reviewData.supply_order_id,
        reviewData.vendor_id,
        reviewData.shop_id,
        reviewData.receipt_id ?? null,
        reviewData.rated_by ?? null,
        reviewData.rating_freshness,
        reviewData.rating_cleaning,
        reviewData.rating_packaging,
        reviewData.rating_quantity_accuracy,
        reviewData.rating_punctuality,
        reviewData.rating_overall,
        reviewData.comment ?? null,
        reviewData.issue_category ?? null,
        reviewData.issue_note ?? null,
      ]
    )
    return rows[0]
  }

  async listVendorReviews(vendorId, { page = 1, limit = 10 } = {}) {
    const countResult = await query(`SELECT COUNT(*)::int AS total FROM vendor_supply_reviews WHERE vendor_id = $1`, [vendorId])
    const { rows } = await query(
      `SELECT vsr.*, s.name AS shop_name, so.supply_number
         FROM vendor_supply_reviews vsr
         JOIN shops s ON s.id = vsr.shop_id
         JOIN procurement_supply_orders so ON so.id = vsr.supply_order_id
        WHERE vsr.vendor_id = $1
        ORDER BY vsr.created_at DESC
        LIMIT $2 OFFSET $3`,
      [vendorId, limit, (page - 1) * limit]
    )
    return { reviews: rows, total: countResult.rows[0].total, page, limit }
  }

  /**
   * Transparent vendor performance summary (blueprint §13.3): plain SQL
   * aggregations, no opaque scoring.
   */
  async getVendorPerformance(vendorId) {
    const supplies = await query(
      `SELECT
          COUNT(*)::int AS total_supplies,
          COUNT(*) FILTER (WHERE status IN ('RECEIVED', 'CLOSED'))::int AS completed_supplies,
          COUNT(*) FILTER (WHERE status NOT IN ('CANCELLED', 'REJECTED_AT_RECEIPT', 'CLOSED'))::int AS active_supplies,
          COUNT(*) FILTER (
            WHERE status IN ('RECEIVED', 'CLOSED')
              AND received_at IS NOT NULL
              AND promised_delivery_at IS NOT NULL
              AND received_at <= promised_delivery_at
          )::int AS on_time_supplies,
          COUNT(*) FILTER (
            WHERE status IN ('RECEIVED', 'CLOSED') AND received_at IS NOT NULL AND promised_delivery_at IS NOT NULL
          )::int AS deliverable_supplies,
          COALESCE(SUM(award_amount) FILTER (WHERE status IN ('RECEIVED', 'CLOSED')), 0) AS total_value,
          COALESCE(SUM(award_amount) FILTER (
            WHERE status IN ('RECEIVED', 'CLOSED')
              AND received_at >= date_trunc('month', NOW())
          ), 0) AS month_value,
          COALESCE((
            SELECT SUM(pri.accepted_quantity)
              FROM procurement_receipt_items pri
              JOIN procurement_receipts pr ON pr.id = pri.receipt_id
              JOIN procurement_supply_orders so ON so.id = pr.supply_order_id
             WHERE so.vendor_id = $1
               AND so.status IN ('RECEIVED', 'CLOSED')
               AND pr.received_at >= date_trunc('month', NOW())
          ), 0) AS month_quantity
         FROM procurement_supply_orders
        WHERE vendor_id = $1 AND deleted_at IS NULL`,
      [vendorId]
    )

    const quality = await query(
      `SELECT
          COALESCE(ROUND(AVG(rating_overall)::numeric, 2), 0) AS avg_rating,
          COUNT(*)::int AS review_count,
          COUNT(*) FILTER (WHERE issue_category IS NOT NULL)::int AS issue_count
         FROM vendor_supply_reviews
        WHERE vendor_id = $1`,
      [vendorId]
    )

    const [monthlyTrend, topProducts] = await Promise.all([
      this.getVendorMonthlyTrend(vendorId),
      this.getVendorTopProducts(vendorId),
    ])

    return {
      total_supplies: supplies.rows[0].total_supplies,
      completed_supplies: supplies.rows[0].completed_supplies,
      active_supplies: supplies.rows[0].active_supplies,
      on_time_rate:
        supplies.rows[0].deliverable_supplies > 0
          ? Number(((supplies.rows[0].on_time_supplies / supplies.rows[0].deliverable_supplies) * 100).toFixed(1))
          : null,
      total_value: supplies.rows[0].total_value,
      month_value: supplies.rows[0].month_value,
      month_quantity: supplies.rows[0].month_quantity,
      avg_rating: quality.rows[0].avg_rating,
      review_count: quality.rows[0].review_count,
      issue_count: quality.rows[0].issue_count,
      monthly_trend: monthlyTrend,
      top_products: topProducts,
    }
  }

  /**
   * Last 6 months of confirmed (RECEIVED/CLOSED) supply value for this
   * vendor, zero-filled via generate_series so a quiet month renders as a
   * real ₹0 bar rather than a gap the chart has to guess at.
   */
  async getVendorMonthlyTrend(vendorId, months = 6) {
    const { rows } = await query(
      `SELECT
          to_char(month_start, 'YYYY-MM') AS month,
          to_char(month_start, 'Mon') AS label,
          COALESCE(SUM(so.award_amount), 0) AS value
         FROM generate_series(
                date_trunc('month', NOW()) - ($2::int - 1) * interval '1 month',
                date_trunc('month', NOW()),
                interval '1 month'
              ) AS month_start
         LEFT JOIN procurement_supply_orders so
                ON so.vendor_id = $1
               AND so.deleted_at IS NULL
               AND so.status IN ('RECEIVED', 'CLOSED')
               AND so.received_at >= month_start
               AND so.received_at < month_start + interval '1 month'
        GROUP BY month_start
        ORDER BY month_start`,
      [vendorId, months]
    )
    return rows.map((row) => ({ month: row.month, label: row.label, value: row.value }))
  }

  /**
   * Best-selling products by confirmed (RECEIVED/CLOSED) supply value —
   * plain aggregation over agreed line totals, the same commercial basis
   * `total_value`/`month_value` above already use. A legacy item with no
   * `product_id` link (free-text, pre-migration-143) groups by its own
   * item_name instead of silently dropping out.
   */
  async getVendorTopProducts(vendorId, limit = 5) {
    const { rows } = await query(
      `SELECT
          soi.product_id,
          COALESCE(p.name, soi.item_name) AS name,
          p.thumbnail_url AS image_url,
          SUM(soi.agreed_quantity) AS quantity,
          (ARRAY_AGG(soi.unit))[1] AS unit,
          SUM(soi.agreed_line_total) AS value
         FROM procurement_supply_order_items soi
         JOIN procurement_supply_orders so ON so.id = soi.supply_order_id
         LEFT JOIN products p ON p.id = soi.product_id
        WHERE so.vendor_id = $1
          AND so.deleted_at IS NULL
          AND so.status IN ('RECEIVED', 'CLOSED')
        GROUP BY soi.product_id, COALESCE(p.name, soi.item_name), p.thumbnail_url
        ORDER BY value DESC
        LIMIT $2`,
      [vendorId, limit]
    )
    return rows.map((row) => ({
      product_id: row.product_id,
      name: row.name,
      image_url: row.image_url,
      quantity: row.quantity,
      unit: row.unit,
      value: row.value,
    }))
  }

  // ── Store receipt (Big Phase 13) ──────────────────────────────

  async insertReceipt(client, receiptData) {
    const { rows } = await client.query(
      `INSERT INTO procurement_receipts
         (supply_order_id, shop_id, status, received_by, note, photo_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        receiptData.supply_order_id,
        receiptData.shop_id,
        receiptData.status ?? 'RECEIVED',
        receiptData.received_by ?? null,
        receiptData.note ?? null,
        receiptData.photo_url ?? null,
      ]
    )
    return rows[0]
  }

  async insertReceiptItem(client, itemId, data) {
    const { rows } = await client.query(
      `INSERT INTO procurement_receipt_items
         (receipt_id, supply_order_item_id, requested_quantity, received_quantity,
          accepted_quantity, rejected_quantity, issue_category, issue_note, inventory_lot_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        itemId,
        data.supply_order_item_id,
        data.requested_quantity,
        data.received_quantity,
        data.accepted_quantity,
        data.rejected_quantity,
        data.issue_category ?? null,
        data.issue_note ?? null,
        data.inventory_lot_id ?? null,
      ]
    )
    return rows[0]
  }

  async linkReceiptItemToLot(receiptItemId, lotId) {
    await query(`UPDATE procurement_receipt_items SET inventory_lot_id = $2 WHERE id = $1`, [receiptItemId, lotId])
  }

  /**
   * Lazily ensures a per-shop warehouse row so accepted stock can enter the
   * existing warehouse-keyed inventory lot model without inventing a second
   * inventory system.
   */
  async ensureShopWarehouse(shopId) {
    const shop = await this.findShopById(shopId)
    if (!shop) {
      const err = new Error('Shop not found')
      err.statusCode = 404
      err.code = 'SHOP_NOT_FOUND'
      throw err
    }
    const code = `SHOP-${shopId.slice(0, 8).toUpperCase()}`
    const existing = await query(`SELECT id FROM warehouses WHERE code = $1 LIMIT 1`, [code])
    if (existing.rows[0]) return existing.rows[0].id

    const created = await query(
      `INSERT INTO warehouses (name, code, address, city, state, pincode)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (code) DO NOTHING
       RETURNING id`,
      [`${shop.name} Store Stock`, code, `${shop.name} store inventory`, shop.city ?? null, null, shop.pincode ?? null]
    )
    if (created.rows[0]) return created.rows[0].id
    const reselected = await query(`SELECT id FROM warehouses WHERE code = $1 LIMIT 1`, [code])
    return reselected.rows[0].id
  }

  /**
   * Read-only counterpart to `ensureShopWarehouse` — looks up the shop's
   * derived warehouse (by the same `SHOP-<id8>` code convention) without
   * creating one. A shop that has never received any vendor stock has no
   * warehouse row yet; callers should treat `null` as "no lots exist",
   * not as an error. Used by shop-products' inventory-lots view so
   * displaying a never-restocked product's lot breakdown doesn't write a
   * throwaway warehouse row on every page view.
   */
  async findShopWarehouseId(shopId) {
    const { rows } = await query(
      `SELECT id FROM warehouses WHERE code = $1 LIMIT 1`,
      [`SHOP-${shopId.slice(0, 8).toUpperCase()}`]
    )
    return rows[0]?.id ?? null
  }

  async findReceiptBySupply(supplyOrderId) {
    const { rows } = await query(
      `SELECT * FROM procurement_receipts WHERE supply_order_id = $1 LIMIT 1`,
      [supplyOrderId]
    )
    return rows[0] ?? null
  }

  async markSupplyReceived(supplyOrderId, status, closedAt = null) {
    const { rows } = await query(
      `UPDATE procurement_supply_orders
          SET status = $2,
              received_at = NOW(),
              closed_at = COALESCE($3, closed_at)
        WHERE id = $1
        RETURNING *`,
      [supplyOrderId, status, closedAt]
    )
    return rows[0] ?? null
  }

  async markRequestCompleted(requestId) {
    const { rows } = await query(
      `UPDATE procurement_requests
          SET status = 'COMPLETED', closed_at = NOW()
        WHERE id = $1 AND status = 'AWARDED'
        RETURNING *`,
      [requestId]
    )
    return rows[0] ?? null
  }

  async insertSupplyEvent(eventData) {
    const { rows } = await query(
      `INSERT INTO procurement_supply_events (supply_order_id, from_status, to_status, actor_id, actor_role, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        eventData.supply_order_id,
        eventData.from_status ?? null,
        eventData.to_status,
        eventData.actor_id ?? null,
        eventData.actor_role ?? null,
        eventData.note ?? null,
      ]
    )
    return rows[0]
  }

  async insertSupplyEventTx(client, eventData) {
    const { rows } = await client.query(
      `INSERT INTO procurement_supply_events (supply_order_id, from_status, to_status, actor_id, actor_role, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        eventData.supply_order_id,
        eventData.from_status ?? null,
        eventData.to_status,
        eventData.actor_id ?? null,
        eventData.actor_role ?? null,
        eventData.note ?? null,
      ]
    )
    return rows[0]
  }

  /**
   * Fresh vendor status read for respond-time checks — a suspended/deactivated
   * vendor must not be able to accept or quote even if it was eligible at publish.
   */
  async findVendorStatus(vendorId) {
    const { rows } = await query(
      // `name` is additive — every existing caller only ever read
      // id/status/is_active (eligibility checks), but getVendorPerformance
      // also builds a `{id, name, status}` vendor block from this same row,
      // and without it the vendor app's Performance screen always fell back
      // to its generic "Your store" placeholder instead of the real name.
      `SELECT id, name, status, is_active FROM vendors WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [vendorId]
    )
    return rows[0] ?? null
  }

  // ── RFQ quotes (Big Phase 5) ───────────────────────────────────

  /**
   * Quote comparison list for a request (admin/store view). Includes vendor
   * performance context columns when available; commercial fields come from
   * the quote rows themselves.
   */
  async listQuotesForRequest(requestId) {
    const { rows } = await query(
      `SELECT q.id, q.request_id, q.vendor_id, q.status, q.grand_total,
              q.promised_delivery_at, q.note, q.validity_until, q.submitted_at, q.updated_at,
              v.name AS vendor_name, v.phone AS vendor_phone, v.email AS vendor_email,
              (SELECT COUNT(*)::int FROM vendor_supply_reviews vsr WHERE vsr.vendor_id = q.vendor_id) AS completed_review_count,
              (SELECT ROUND(AVG(vsr.rating_overall)::numeric, 2) FROM vendor_supply_reviews vsr WHERE vsr.vendor_id = q.vendor_id) AS vendor_rating,
              (SELECT COUNT(*)::int FROM procurement_receipt_items pri
                 JOIN procurement_receipts pr ON pr.id = pri.receipt_id
                 JOIN procurement_supply_orders pso ON pso.id = pr.supply_order_id
                WHERE pso.vendor_id = q.vendor_id AND pri.issue_category IS NOT NULL) AS vendor_issue_count,
              qi.items AS quote_items
         FROM procurement_quotes q
         JOIN vendors v ON v.id = q.vendor_id
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
                    'id', i.id, 'request_item_id', i.request_item_id,
                    'quoted_quantity', i.quoted_quantity, 'unit_price', i.unit_price,
                    'line_total', i.line_total)) AS items
           FROM procurement_quote_items i WHERE i.quote_id = q.id
         ) qi ON true
        WHERE q.request_id = $1
        ORDER BY q.grand_total ASC`,
      [requestId]
    )
    return rows
  }

  async findQuoteById(quoteId) {
    const { rows } = await query(`SELECT * FROM procurement_quotes WHERE id = $1 LIMIT 1`, [quoteId])
    const quote = rows[0] ?? null
    if (!quote) return null
    const items = await query(
      `SELECT * FROM procurement_quote_items WHERE quote_id = $1 ORDER BY created_at, id`,
      [quoteId]
    )
    return { ...quote, items: items.rows }
  }

  async findQuoteItemsByRequestAndVendor(requestId, vendorId) {
    const { rows } = await query(
      `SELECT i.* FROM procurement_quote_items i
         JOIN procurement_quotes q ON q.id = i.quote_id
        WHERE q.request_id = $1 AND q.vendor_id = $2`,
      [requestId, vendorId]
    )
    return rows
  }

  /**
   * A vendor's own still-editable quote (SUBMITTED/UPDATED) for a request, if
   * any — lets the vendor app tell "submit a new quote" from "edit my live
   * quote" apart, and pre-fill the edit form with real persisted values.
   */
  async findLiveQuoteByRequestAndVendor(requestId, vendorId) {
    const { rows } = await query(
      `SELECT * FROM procurement_quotes
        WHERE request_id = $1 AND vendor_id = $2 AND status IN ('SUBMITTED', 'UPDATED')
        LIMIT 1`,
      [requestId, vendorId]
    )
    const quote = rows[0] ?? null
    if (!quote) return null
    const items = await query(
      `SELECT * FROM procurement_quote_items WHERE quote_id = $1 ORDER BY created_at, id`,
      [quote.id]
    )
    return { ...quote, items: items.rows }
  }

  async insertQuoteTx(client, quoteData) {
    const { rows } = await client.query(
      `INSERT INTO procurement_quotes
         (request_id, recipient_id, vendor_id, grand_total, promised_delivery_at, note, validity_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        quoteData.request_id,
        quoteData.recipient_id,
        quoteData.vendor_id,
        quoteData.grand_total,
        quoteData.promised_delivery_at ?? null,
        quoteData.note ?? null,
        quoteData.validity_until ?? null,
      ]
    )
    return rows[0]
  }

  async insertQuoteItemsTx(client, quoteId, items) {
    const inserted = []
    for (const item of items) {
      const { rows } = await client.query(
        `INSERT INTO procurement_quote_items
           (quote_id, request_item_id, quoted_quantity, unit_price, line_total)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [quoteId, item.request_item_id, item.quoted_quantity, item.unit_price, item.line_total]
      )
      inserted.push(rows[0])
    }
    return inserted
  }

  async updateQuoteTx(client, quoteId, patch) {
    const set = []
    const params = [quoteId]
    const columns = {
      grand_total: 'grand_total',
      promised_delivery_at: 'promised_delivery_at',
      note: 'note',
      validity_until: 'validity_until',
    }
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        params.push(patch[key])
        set.push(`${column} = $${params.length}`)
      }
    }
    if (set.length > 0) {
      set.push(`status = CASE WHEN status IN ('SUBMITTED', 'UPDATED') THEN 'UPDATED' ELSE status END`)
      await client.query(`UPDATE procurement_quotes SET ${set.join(', ')} WHERE id = $1`, params)
    }
    return this.findQuoteById(quoteId)
  }

  async setQuoteStatus(quoteId, status) {
    const { rows } = await query(
      `UPDATE procurement_quotes SET status = $2, decided_at = NOW() WHERE id = $1 RETURNING *`,
      [quoteId, status]
    )
    return rows[0] ?? null
  }

  /**
   * Marks every other open quote of the request as NOT_SELECTED (award cascade).
   */
  async setOtherQuotesNotSelectedTx(client, requestId, winnerQuoteId) {
    await client.query(
      `UPDATE procurement_quotes
          SET status = 'NOT_SELECTED', decided_at = NOW()
        WHERE request_id = $1 AND id <> $2 AND status IN ('SUBMITTED', 'UPDATED')`,
      [requestId, winnerQuoteId]
    )
  }

  // ── Supply order reads (Big Phase 8 tracking surface) ─────────

  async listSupplyOrders({ shopId = null, vendorId = null, status = null, search = null, page = 1, limit = 20 }) {
    const conditions = ['so.deleted_at IS NULL']
    const params = []
    if (shopId) {
      params.push(shopId)
      conditions.push(`so.shop_id = $${params.length}`)
    }
    if (vendorId) {
      params.push(vendorId)
      conditions.push(`so.vendor_id = $${params.length}`)
    }
    if (status) {
      params.push(status)
      conditions.push(`so.status = $${params.length}`)
    }
    if (search) {
      params.push(`%${search}%`)
      conditions.push(`(so.supply_number ILIKE $${params.length} OR r.request_number ILIKE $${params.length} OR v.name ILIKE $${params.length})`)
    }
    const where = conditions.join(' AND ')

    const countResult = await query(
      `SELECT COUNT(*)::int AS total
         FROM procurement_supply_orders so
         JOIN procurement_requests r ON r.id = so.request_id
         JOIN vendors v ON v.id = so.vendor_id
        WHERE ${where}`,
      params
    )

    params.push(limit, (page - 1) * limit)
    const limitIndex = params.length - 1
    const offsetIndex = params.length
    const { rows } = await query(
      `SELECT so.id, so.supply_number, so.request_id, so.vendor_id, so.shop_id, so.source_mode,
              so.status, so.award_amount, so.promised_delivery_at, so.dispatched_at, so.received_at,
              so.created_at, r.request_number, v.name AS vendor_name, s.name AS shop_name, s.city AS shop_city,
              (SELECT jsonb_agg(jsonb_build_object('item_name', i.item_name, 'agreed_quantity', i.agreed_quantity, 'unit', i.unit))
                 FROM procurement_supply_order_items i WHERE i.supply_order_id = so.id) AS item_summary,
              EXISTS (SELECT 1 FROM procurement_evidence e WHERE e.supply_order_id = so.id AND e.evidence_type = 'QUALITY_VIDEO') AS has_evidence
         FROM procurement_supply_orders so
         JOIN procurement_requests r ON r.id = so.request_id
         JOIN vendors v ON v.id = so.vendor_id
         JOIN shops s ON s.id = so.shop_id
        WHERE ${where}
        ORDER BY so.created_at DESC
        LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params
    )
    return { supplies: rows, total: countResult.rows[0].total, page, limit }
  }

  /**
   * The supply order created when this request was awarded, if any — a
   * request has at most one (unique constraint on procurement_supply_orders,
   * migration 135). Used to surface live fulfilment status on the store/
   * admin-facing request detail page, which otherwise had no visibility at
   * all into what the awarded vendor was actually doing after award.
   */
  async findSupplyOrderByRequestId(requestId) {
    const { rows } = await query(
      `SELECT id FROM procurement_supply_orders WHERE request_id = $1 AND deleted_at IS NULL LIMIT 1`,
      [requestId]
    )
    return rows[0]?.id ?? null
  }

  async findSupplyOrderById(supplyOrderId) {
    const { rows } = await query(
      `SELECT so.*, r.request_number, r.title AS request_title, r.quality_instructions,
              v.name AS vendor_name, v.phone AS vendor_phone, v.email AS vendor_email,
              s.name AS shop_name, s.city AS shop_city, s.pincode AS shop_pincode
         FROM procurement_supply_orders so
         JOIN procurement_requests r ON r.id = so.request_id
         JOIN vendors v ON v.id = so.vendor_id
         JOIN shops s ON s.id = so.shop_id
        WHERE so.id = $1 AND so.deleted_at IS NULL
        LIMIT 1`,
      [supplyOrderId]
    )
    const supply = rows[0] ?? null
    if (!supply) return null

    const [items, events, evidence] = await Promise.all([
      query(`SELECT * FROM procurement_supply_order_items WHERE supply_order_id = $1 ORDER BY created_at, id`, [supplyOrderId]),
      query(`SELECT e.*, u.phone AS actor_phone FROM procurement_supply_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.supply_order_id = $1 ORDER BY e.created_at, e.id`, [supplyOrderId]),
      query(`SELECT * FROM procurement_evidence WHERE supply_order_id = $1 ORDER BY created_at DESC, id`, [supplyOrderId]),
    ])

    return { ...supply, items: items.rows, events: events.rows, evidence: evidence.rows }
  }
}
