/**
 * Vendor procurement schema invariants — static migration assertions (Big Phase 2)
 *
 * The vendor-facing procurement tables (migrations 133–136) must carry the
 * load-bearing invariants from blueprint 01 §17, §21 as database constraints,
 * not just service-level checks. This test reads the migration SQL directly so
 * it runs without a live database (mirrors the ShopProductsRepository
 * "SQL safety" test style).
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/database/migrations'
)

const read = (file) => readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')

const requestsSql = read('133_vendor_procurement_requests.sql')
const quotesSql = read('134_vendor_procurement_quotes.sql')
const supplySql = read('135_vendor_procurement_supply_orders.sql')
const receiptsSql = read('136_vendor_procurement_evidence_receipts_reviews.sql')

describe('migration 133 — requests, request items, recipients', () => {
  it('creates procurement_requests with the blueprint request statuses', () => {
    expect(requestsSql).toContain("CREATE TABLE IF NOT EXISTS procurement_requests (")
    expect(requestsSql).toContain(
      "status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'AWARDED', 'IN_FULFILMENT', 'COMPLETED', 'CANCELLED', 'EXPIRED'))"
    )
  })

  it('constrains procurement mode to FIXED_OFFER / RFQ', () => {
    expect(requestsSql).toContain("mode TEXT NOT NULL CHECK (mode IN ('FIXED_OFFER', 'RFQ'))")
  })

  it('keeps one recipient row per (request, vendor)', () => {
    expect(requestsSql).toContain('CONSTRAINT uq_procurement_recipient UNIQUE (request_id, vendor_id)')
  })

  it('scopes every request to a store and persists award freeze columns', () => {
    expect(requestsSql).toContain('shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE RESTRICT')
    expect(requestsSql).toContain('awarded_vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL')
    expect(requestsSql).toContain('award_total NUMERIC(12,2)')
  })

  it('requires positive requested quantities and explicit units', () => {
    expect(requestsSql).toContain('requested_quantity NUMERIC(10,2) NOT NULL CHECK (requested_quantity > 0)')
    expect(requestsSql).toContain("unit TEXT NOT NULL CHECK (unit IN ('KG', 'PC', 'PACK', 'LTR'))")
  })
})

describe('migration 134 — quotes and quote items', () => {
  it('only allows quotes from persisted recipients (targeting enforcement)', () => {
    expect(quotesSql).toContain('recipient_id UUID NOT NULL REFERENCES procurement_recipients(id) ON DELETE CASCADE')
  })

  it('uses a partial unique index so a request can have at most one SELECTED quote', () => {
    expect(quotesSql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_one_selected_quote_per_request\s*\n\s*ON procurement_quotes\(request_id\)\s*\n\s*WHERE status = 'SELECTED';/
    )
  })

  it('keeps quote totals non-negative and quote item lines positive', () => {
    expect(quotesSql).toContain('grand_total NUMERIC(12,2) NOT NULL CHECK (grand_total >= 0)')
    expect(quotesSql).toContain('quoted_quantity NUMERIC(10,2) NOT NULL CHECK (quoted_quantity > 0)')
  })
})

describe('migration 135 — supply orders, items, timeline', () => {
  it('declares the full supply state machine including exception states', () => {
    const statuses = [
      'AWARDED', 'ACCEPTED', 'PROCESSING', 'CLEANING', 'VIDEO_SUBMITTED',
      'PACKED', 'READY_FOR_DISPATCH', 'DISPATCHED', 'DELIVERED_PENDING_RECEIPT',
      'RECEIVED', 'CLOSED', 'CANCELLED', 'REJECTED_AT_RECEIPT',
    ]
    for (const status of statuses) {
      expect(supplySql).toContain(`'${status}'`)
    }
  })

  it('allows exactly one supply order per request (v1: no split awards)', () => {
    expect(supplySql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_one_supply_order_per_request\s*\n\s*ON procurement_supply_orders\(request_id\);/
    )
  })

  it('freezes the awarded commercial amount at creation', () => {
    expect(supplySql).toContain('award_amount NUMERIC(12,2) NOT NULL CHECK (award_amount >= 0)')
  })

  it('records an append-only supply timeline', () => {
    expect(supplySql).toContain('CREATE TABLE IF NOT EXISTS procurement_supply_events (')
    expect(supplySql).toContain('to_status TEXT NOT NULL')
    expect(supplySql).not.toMatch(/procurement_supply_events[\s\S]*updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/)
  })
})

describe('migration 136 — evidence, receipts, reviews', () => {
  it('supports quality video evidence with Cloudinary identifiers', () => {
    expect(receiptsSql).toContain("evidence_type TEXT NOT NULL CHECK (evidence_type IN ('QUALITY_VIDEO', 'QUALITY_IMAGE', 'PACKING_IMAGE', 'DISPATCH_PROOF', 'OTHER'))")
    expect(receiptsSql).toContain('media_public_id VARCHAR(255) NOT NULL')
  })

  it('limits receipts to one per supply order', () => {
    expect(receiptsSql).toMatch(/supply_order_id UUID NOT NULL UNIQUE REFERENCES procurement_supply_orders\(id\)/)
  })

  it('preserves the receiving variance (accepted + rejected <= received)', () => {
    expect(receiptsSql).toContain(
      'CONSTRAINT chk_receipt_accepted_plus_rejected CHECK (accepted_quantity + rejected_quantity <= received_quantity)'
    )
  })

  it('links accepted stock to an inventory lot for traceability', () => {
    expect(receiptsSql).toContain('inventory_lot_id UUID REFERENCES inventory_lots(id) ON DELETE SET NULL')
  })

  it('stores the six rating dimensions on a 1-5 scale', () => {
    for (const dimension of [
      'rating_freshness',
      'rating_cleaning',
      'rating_packaging',
      'rating_quantity_accuracy',
      'rating_punctuality',
      'rating_overall',
    ]) {
      expect(receiptsSql).toMatch(new RegExp(`${dimension} SMALLINT NOT NULL CHECK \\(${dimension} BETWEEN 1 AND 5\\)`))
    }
  })

  it('uses the shared issue category enumeration', () => {
    expect(receiptsSql).toContain(
      "issue_category TEXT CHECK (issue_category IN ('QUANTITY_SHORTAGE', 'QUALITY', 'FRESHNESS', 'CLEANING', 'PACKAGING', 'LATE_DELIVERY', 'DAMAGED', 'DOCUMENTATION', 'OTHER'))"
    )
  })
})

describe('migration 143 — supply order item product linkage', () => {
  const supplyOrderItemsSql = read('143_procurement_supply_order_items_product_id.sql')

  it('adds a nullable product_id FK to procurement_supply_order_items so a request item’s exact SKU survives award', () => {
    expect(supplyOrderItemsSql).toContain('ALTER TABLE procurement_supply_order_items')
    expect(supplyOrderItemsSql).toContain(
      'ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES products(id) ON DELETE SET NULL'
    )
  })
})

describe('REQUEST_ITEM_SCHEMA — product_id is now required, not just category + free text', () => {
  it('rejects a CreateRequestSchema item that has no product_id', async () => {
    const { CreateRequestSchema } = await import('../../../src/modules/vendor-procurement/vendor-procurement.schema.js')
    const itemSchema = CreateRequestSchema.properties.items.items
    expect(itemSchema.required).toContain('product_id')
  })
})
