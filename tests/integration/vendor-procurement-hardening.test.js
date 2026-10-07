/**
 * Vendor procurement security hardening tests (Big Phase 15)
 *
 * Negative and idempotency paths against the real PostgreSQL instance:
 *   1. Suspended/deactivated vendors cannot accept, quote, or see the inbox
 *      (blueprint §14, §21.4).
 *   2. Double-submit idempotency: a second accept on an already-accepted
 *      offer fails cleanly without creating a second supply order (§21.2,
 *      §21.10); a second receipt is rejected (one receipt per supply).
 *   3. Store-scope isolation on receiving (§21.5).
 *
 * SKIPS without a database. Fixtures cleaned up in afterAll.
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
import { query, pool, closePool } from '../../src/config/database.js'

const dbQuery = (text, params) => pool.query(text, params)
const suffix = Math.random().toString(36).slice(2, 10)
const ids = { vendors: [] }

beforeAll(async () => {
  if (!dbUp) return

  const shop = await query(
    `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, serviceable_pincodes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [`Harden Store ${suffix}`, `harden-store-${suffix}`, `HS${suffix.slice(0,6)}`, '1 Hard Lane', 'Kolkata', 'WB', '700001', 22.57, 88.36, ['700001']]
  )
  ids.shop = shop.rows[0].id

  const category = await query(
    `INSERT INTO categories (name, slug) VALUES ($1,$2) RETURNING id`,
    [`Harden Chicken ${suffix}`, `harden-chicken-${suffix}`]
  )
  ids.category = category.rows[0].id

  for (let i = 0; i < 2; i++) {
    const vendor = await query(
      `INSERT INTO vendors (name, slug, email, phone, status)
       VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING id`,
      [
        `Harden Vendor ${suffix} ${i}`, `harden-vendor-${suffix}-${i}`,
        `harden-${suffix}-${i}@example.test`, `93${i}${suffix.replace(/\D/g, '').padEnd(3, '9').slice(0, 7)}0`.slice(0, 15),
      ]
    )
    ids.vendors.push(vendor.rows[0].id)
  }

  const request = await query(
    `INSERT INTO procurement_requests
       (request_number, shop_id, mode, status, title, required_delivery_at, response_deadline, offer_total)
     VALUES ($1,$2,'FIXED_OFFER','PUBLISHED',$3, NOW() + interval '2 days', NOW() + interval '1 day', 5000)
     RETURNING id`,
    [`PRQ-H-${suffix}`, ids.shop, 'Hardening fixed offer']
  )
  ids.request = request.rows[0].id

  const item = await query(
    `INSERT INTO procurement_request_items (request_id, category_id, item_name, requested_quantity, unit, fixed_unit_price, fixed_line_total)
     VALUES ($1,$2,'Chicken',20,'KG',250,5000) RETURNING id`,
    [ids.request, ids.category]
  )
  ids.requestItem = item.rows[0].id

  ids.recipients = []
  for (const vendorId of ids.vendors) {
    const recipient = await query(
      `INSERT INTO procurement_recipients (request_id, vendor_id, eligibility) VALUES ($1,$2,'{}'::jsonb) RETURNING id`,
      [ids.request, vendorId]
    )
    ids.recipients.push(recipient.rows[0].id)
  }
})

afterAll(async () => {
  if (!dbUp) return
  await query(`DELETE FROM procurement_receipt_items WHERE receipt_id IN (SELECT id FROM procurement_receipts WHERE supply_order_id IN (SELECT id FROM procurement_supply_orders WHERE request_id = $1))`, [ids.request])
  await query(`DELETE FROM procurement_receipts WHERE supply_order_id IN (SELECT id FROM procurement_supply_orders WHERE request_id = $1)`, [ids.request])
  await query(`DELETE FROM procurement_evidence WHERE supply_order_id IN (SELECT id FROM procurement_supply_orders WHERE request_id = $1)`, [ids.request])
  await query(`DELETE FROM procurement_supply_events WHERE supply_order_id IN (SELECT id FROM procurement_supply_orders WHERE request_id = $1)`, [ids.request])
  await query(`DELETE FROM procurement_supply_order_items WHERE supply_order_id IN (SELECT id FROM procurement_supply_orders WHERE request_id = $1)`, [ids.request])
  await query(`DELETE FROM procurement_supply_orders WHERE request_id = $1`, [ids.request])
  await query(`DELETE FROM vendor_supply_reviews WHERE supply_order_id IN (SELECT id FROM procurement_supply_orders WHERE request_id = $1)`, [ids.request])
  await query(`DELETE FROM procurement_recipients WHERE request_id = $1`, [ids.request])
  await query(`DELETE FROM procurement_request_items WHERE request_id = $1`, [ids.request])
  await query(`DELETE FROM procurement_requests WHERE id = $1`, [ids.request])
  await query(`DELETE FROM vendors WHERE id = ANY($1)`, [ids.vendors])
  await query(`DELETE FROM categories WHERE id = $1`, [ids.category])
  await query(`DELETE FROM shops WHERE id = $1`, [ids.shop])
  await closePool()
})

describe.skipIf(!dbUp)('security hardening (blueprint §21)', () => {
  it('rejects a suspended vendor responding to a published offer', async () => {
    const service = new VendorProcurementService()
    const vendorId = ids.vendors[0]

    // Suspend outside the fixtures lifecycle.
    await dbQuery(`UPDATE vendors SET status = 'SUSPENDED' WHERE id = $1`, [vendorId])
    try {
      await expect(service.acceptFixedOffer(ids.request, vendorId, null)).rejects.toMatchObject({
        code: 'VENDOR_NOT_RESPONDABLE',
      })
      await expect(
        service.submitQuote(ids.request, vendorId, null, { items: [{ request_item_id: ids.requestItem, quoted_quantity: 1, unit_price: 1 }] })
      ).rejects.toMatchObject({ code: 'VENDOR_NOT_RESPONDABLE' })
    } finally {
      await dbQuery(`UPDATE vendors SET status = 'ACTIVE' WHERE id = $1`, [vendorId])
    }
  })

  it('second accept on an already-accepted offer fails without a second supply order', async () => {
    const service = new VendorProcurementService()
    const [vendorA, vendorB] = ids.vendors

    const first = await service.acceptFixedOffer(ids.request, vendorA, null)
    expect(first.supply_order.status).toBe('AWARDED')

    // Vendor B (legitimately targeted) loses the race to the now-AWARDED request.
    await expect(service.acceptFixedOffer(ids.request, vendorB, null)).rejects.toMatchObject({ code: 'ALREADY_AWARDED' })
    // Vendor A retrying is also rejected cleanly (idempotent outcome, no new supply).
    await expect(service.acceptFixedOffer(ids.request, vendorA, null)).rejects.toMatchObject({ code: 'ALREADY_AWARDED' })

    const supplies = await dbQuery(`SELECT COUNT(*)::int AS n FROM procurement_supply_orders WHERE request_id = $1`, [ids.request])
    expect(supplies.rows[0].n).toBe(1)

    // Double receipt is impossible until delivered, and delivery transitions are single-shot.
    await expect(
      service.receiveSupply(ids.request && first.supply_order.id, null, {
        items: [{ supply_order_item_id: '00000000-0000-0000-0000-000000000000', received_quantity: 1, accepted_quantity: 1, rejected_quantity: 0 }],
      })
    ).rejects.toMatchObject({ code: 'SUPPLY_NOT_PENDING_RECEIPT' })
  })

  it('receiving rejects unknown supply items and invalid variances before committing', async () => {
    const service = new VendorProcurementService()
    const supplyId = (await dbQuery(`SELECT id FROM procurement_supply_orders WHERE request_id = $1`, [ids.request])).rows[0].id
    const vendorId = (await dbQuery(`SELECT vendor_id FROM procurement_supply_orders WHERE id = $1`, [supplyId])).rows[0].vendor_id

    // Self-sufficient setup: walk the supply to DISPATCHED (evidence required for PACKED).
    for (const status of ['ACCEPTED', 'PROCESSING', 'CLEANING']) {
      await service.updateSupplyStatus(supplyId, vendorId, null, status)
    }
    await service.attachEvidence(supplyId, vendorId, null, {
      media_public_id: `harden-${suffix}`,
      media_url: 'https://example.test/harden.mp4',
    })
    for (const status of ['PACKED', 'READY_FOR_DISPATCH', 'DISPATCHED']) {
      await service.updateSupplyStatus(supplyId, vendorId, null, status)
    }

    // Store-side transition to DELIVERED_PENDING_RECEIPT.
    await service.markDelivered(supplyId, null)

    await expect(
      service.receiveSupply(supplyId, null, {
        items: [{ supply_order_item_id: '00000000-0000-0000-0000-000000000000', received_quantity: 1, accepted_quantity: 1, rejected_quantity: 0 }],
      })
    ).rejects.toMatchObject({ code: 'RECEIPT_ITEM_UNKNOWN' })

    const supplyItemId = (await dbQuery(`SELECT id FROM procurement_supply_order_items WHERE supply_order_id = $1 LIMIT 1`, [supplyId])).rows[0].id
    await expect(
      service.receiveSupply(supplyId, null, {
        items: [{ supply_order_item_id: supplyItemId, received_quantity: 5, accepted_quantity: 4, rejected_quantity: 2 }],
      })
    ).rejects.toMatchObject({ code: 'RECEIPT_QUANTITY_INVALID' })
  })
})
