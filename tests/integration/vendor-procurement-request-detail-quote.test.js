/**
 * getVendorRequestDetail's `quote` field against real PostgreSQL.
 *
 * Guards the fix that lets the vendor app tell "submit a new RFQ quote"
 * apart from "edit my live quote": before this, the request-detail response
 * had no way for a vendor to discover their own quote's id, so "Edit Quote"
 * always re-POSTed (create) and the backend rejected it with
 * PROCUREMENT_QUOTE_EXISTS. Covers: no quote yet -> null; after submit ->
 * the vendor's own quote with matching items/total; after update -> the new
 * values reflected; after withdrawal -> null again (WITHDRAWN is not a
 * "live" status). Also checks a FIXED_OFFER request never computes a quote.
 *
 * SKIPS itself when no database is reachable. Fixtures deleted in afterAll.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { config } from 'dotenv'
import pg from 'pg'

config()

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
}

let dbUp = false
try {
  const probe = new pg.Pool({ ...dbConfig, max: 1, connectionTimeoutMillis: 2000 })
  await probe.query('SELECT 1')
  await probe.end()
  dbUp = true
} catch {
  dbUp = false
}

import { VendorProcurementService } from '../../src/modules/vendor-procurement/vendor-procurement.service.js'
import { query, closePool } from '../../src/config/database.js'

const suffix = Math.random().toString(36).slice(2, 10)
const ids = { vendors: [] }

beforeAll(async () => {
  if (!dbUp) return

  const shop = await query(
    `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, serviceable_pincodes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [`Detail Store ${suffix}`, `detail-store-${suffix}`, `DT${suffix.slice(0, 6)}`, '1 Detail Lane', 'Kolkata', 'West Bengal', '700001', 22.5726, 88.3639, ['700001']]
  )
  ids.shop = shop.rows[0].id

  const category = await query(
    `INSERT INTO categories (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Detail Fish ${suffix}`, `detail-fish-${suffix}`]
  )
  ids.category = category.rows[0].id

  const vendor = await query(
    `INSERT INTO vendors (name, slug, email, phone, status)
     VALUES ($1, $2, $3, $4, 'ACTIVE') RETURNING id`,
    [`Detail Vendor ${suffix}`, `detail-vendor-${suffix}`, `detail-${suffix}@example.test`, `96${suffix.replace(/\D/g, '').padEnd(8, '1').slice(0, 8)}`]
  )
  ids.vendor = vendor.rows[0].id

  // RFQ request — the mode this feature applies to.
  const rfqRequest = await query(
    `INSERT INTO procurement_requests
       (request_number, shop_id, mode, status, title, required_delivery_at, response_deadline)
     VALUES ($1, $2, 'RFQ', 'PUBLISHED', $3, NOW() + interval '3 days', NOW() + interval '1 day')
     RETURNING id`,
    [`PRQ-DET-${suffix}`, ids.shop, 'Request-detail quote test']
  )
  ids.rfqRequest = rfqRequest.rows[0].id

  const rfqItem = await query(
    `INSERT INTO procurement_request_items (request_id, category_id, item_name, requested_quantity, unit)
     VALUES ($1, $2, 'Rohu', 15, 'KG') RETURNING id`,
    [ids.rfqRequest, ids.category]
  )
  ids.rfqItem = rfqItem.rows[0].id

  await query(
    `INSERT INTO procurement_recipients (request_id, vendor_id, eligibility) VALUES ($1, $2, '{}'::jsonb)`,
    [ids.rfqRequest, ids.vendor]
  )

  // A FIXED_OFFER sibling request — must never compute a quote field.
  const fixedRequest = await query(
    `INSERT INTO procurement_requests
       (request_number, shop_id, mode, status, title, required_delivery_at, response_deadline, offer_total)
     VALUES ($1, $2, 'FIXED_OFFER', 'PUBLISHED', $3, NOW() + interval '3 days', NOW() + interval '1 day', 1000)
     RETURNING id`,
    [`PRQ-DETF-${suffix}`, ids.shop, 'Fixed offer sibling']
  )
  ids.fixedRequest = fixedRequest.rows[0].id
  await query(
    `INSERT INTO procurement_request_items (request_id, category_id, item_name, requested_quantity, unit, fixed_unit_price)
     VALUES ($1, $2, 'Rohu', 15, 'KG', 66.67) RETURNING id`,
    [ids.fixedRequest, ids.category]
  )
  await query(
    `INSERT INTO procurement_recipients (request_id, vendor_id, eligibility) VALUES ($1, $2, '{}'::jsonb)`,
    [ids.fixedRequest, ids.vendor]
  )
})

afterAll(async () => {
  if (dbUp) {
    for (const requestId of [ids.rfqRequest, ids.fixedRequest]) {
      await query(`DELETE FROM procurement_quotes WHERE request_id = $1`, [requestId])
      await query(`DELETE FROM procurement_recipients WHERE request_id = $1`, [requestId])
      await query(`DELETE FROM procurement_request_items WHERE request_id = $1`, [requestId])
      await query(`DELETE FROM procurement_requests WHERE id = $1`, [requestId])
    }
    await query(`DELETE FROM vendor_users WHERE vendor_id = $1`, [ids.vendor])
    await query(`DELETE FROM vendors WHERE id = $1`, [ids.vendor])
    await query(`DELETE FROM categories WHERE id = $1`, [ids.category])
    await query(`DELETE FROM shops WHERE id = $1`, [ids.shop])
    await closePool()
  }
})

describe.skipIf(!dbUp)('getVendorRequestDetail — live quote surfacing', () => {
  const service = new VendorProcurementService()

  it('has no quote before the vendor has submitted one', async () => {
    const detail = await service.getVendorRequestDetail(ids.rfqRequest, ids.vendor)
    expect(detail.quote).toBeNull()
  })

  it('surfaces the vendor\'s own quote after submission, with items and total', async () => {
    const submitted = await service.submitQuote(ids.rfqRequest, ids.vendor, null, {
      items: [{ request_item_id: ids.rfqItem, quoted_quantity: 15, unit_price: 220 }],
      note: 'Fresh catch, same-day delivery',
    })

    const detail = await service.getVendorRequestDetail(ids.rfqRequest, ids.vendor)
    expect(detail.quote).not.toBeNull()
    expect(detail.quote.id).toBe(submitted.id)
    expect(detail.quote.status).toBe('SUBMITTED')
    expect(Number(detail.quote.grand_total)).toBe(3300)
    expect(detail.quote.items).toHaveLength(1)
    expect(detail.quote.items[0].request_item_id).toBe(ids.rfqItem)
    expect(Number(detail.quote.items[0].quoted_quantity)).toBe(15)
    expect(Number(detail.quote.items[0].unit_price)).toBe(220)

    ids.quoteId = submitted.id
  })

  it('reflects an edited quote\'s new values (the "Edit Quote" path)', async () => {
    await service.updateQuote(ids.quoteId, ids.vendor, null, {
      items: [{ request_item_id: ids.rfqItem, quoted_quantity: 15, unit_price: 235 }],
    })

    const detail = await service.getVendorRequestDetail(ids.rfqRequest, ids.vendor)
    expect(detail.quote.id).toBe(ids.quoteId)
    expect(detail.quote.status).toBe('UPDATED')
    expect(Number(detail.quote.grand_total)).toBe(3525)
    expect(Number(detail.quote.items[0].unit_price)).toBe(235)
  })

  it('goes back to null once the quote is withdrawn', async () => {
    await service.withdrawQuote(ids.quoteId, ids.vendor, null)

    const detail = await service.getVendorRequestDetail(ids.rfqRequest, ids.vendor)
    expect(detail.quote).toBeNull()
  })

  it('never computes a quote for a FIXED_OFFER request', async () => {
    const detail = await service.getVendorRequestDetail(ids.fixedRequest, ids.vendor)
    expect(detail.quote).toBeNull()
  })
})
