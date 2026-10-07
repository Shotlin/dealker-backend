/**
 * Vendor eligibility targeting against real PostgreSQL (Big Phase 6 — Scenario A)
 *
 * Proves store-first targeting with the real vendor service profile tables:
 * a Kolkata vendor with matching service areas is a publish recipient, a
 * Delhi-only vendor is not, a suspended Kolkata vendor is not, and an
 * explicitly assigned vendor is included regardless of pincodes. Also covers
 * the eligible-vendor preview (no persistence) and service-profile updates.
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
import { query, pool, closePool } from '../../src/config/database.js'

const dbQuery = (text, params) => pool.query(text, params)
const suffix = Math.random().toString(36).slice(2, 10)
const ids = { vendors: [] }

beforeAll(async () => {
  if (!dbUp) return

  const shop = await query(
    `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, serviceable_pincodes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [`Target Store ${suffix}`, `target-store-${suffix}`, `TS${suffix.slice(0, 6)}`, '1 Target Lane', 'Kolkata', 'West Bengal', '700001', 22.5726, 88.3639, ['700001']]
  )
  ids.shop = shop.rows[0].id

  const delhiShop = await query(
    `INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, serviceable_pincodes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [`Delhi Store ${suffix}`, `delhi-store-${suffix}`, `DS${suffix.slice(0, 6)}`, '2 Target Lane', 'Delhi', 'Delhi', '110001', 28.6139, 77.209, ['110001']]
  )
  ids.delhiShop = delhiShop.rows[0].id

  const category = await query(
    `INSERT INTO categories (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Target Chicken ${suffix}`, `target-chicken-${suffix}`]
  )
  ids.category = category.rows[0].id

  // vendor-kolkata: ACTIVE, Kolkata areas, matching category, active user membership
  // vendor-delhi: ACTIVE, Delhi-only areas
  // vendor-suspended: ACTIVE profile but SUSPENDED vendor row
  // vendor-assigned: Delhi areas but explicitly assigned to the Kolkata store
  // vendor-empty: ACTIVE, has a user, but no service profile at all (unknown → passes area)
  const vendorDefs = [
    ['vendor-kolkata', 'ACTIVE', ['700001'], true, false],
    ['vendor-delhi', 'ACTIVE', ['110001'], true, false],
    ['vendor-suspended', 'SUSPENDED', ['700001'], true, false],
    ['vendor-assigned', 'ACTIVE', ['110001'], true, true],
    ['vendor-empty', 'ACTIVE', [], true, false],
  ]
  for (const [key, status, pincodes, withMembership, assignToKolkata] of vendorDefs) {
    const vendor = await query(
      `INSERT INTO vendors (name, slug, email, phone, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        `Target ${key} ${suffix}`, `target-${key}-${suffix}`,
        `target-${key}-${suffix}@example.test`,
        `94${ids.vendors.length}${suffix.replace(/\D/g, '').padEnd(3, '4').slice(0, 7)}0`.slice(0, 15),
        status,
      ]
    )
    const vendorId = vendor.rows[0].id
    ids[key] = vendorId
    ids.vendors.push(vendorId)

    for (const pincode of pincodes) {
      await query(`INSERT INTO vendor_service_areas (vendor_id, pincode) VALUES ($1, $2)`, [vendorId, pincode])
    }
    await query(`INSERT INTO vendor_supply_categories (vendor_id, category_id) VALUES ($1, $2)`, [vendorId, ids.category])

    if (withMembership) {
      const user = await query(`INSERT INTO users (phone) VALUES ($1) RETURNING id`, [
        `93${ids.vendors.length}${suffix.replace(/\D/g, '').padEnd(3, '6').slice(0, 7)}0`.slice(0, 15),
      ])
      ids.users = ids.users ?? []
      ids.users.push(user.rows[0].id)
      await query(`INSERT INTO vendor_users (vendor_id, user_id, role) VALUES ($1, $2, 'VENDOR_OWNER')`, [vendorId, user.rows[0].id])
    }

    if (assignToKolkata) {
      await query(`INSERT INTO vendor_store_assignments (vendor_id, shop_id) VALUES ($1, $2)`, [vendorId, ids.shop])
    }
  }

  const request = await query(
    `INSERT INTO procurement_requests
       (request_number, shop_id, mode, status, title, required_delivery_at, response_deadline)
     VALUES ($1, $2, 'RFQ', 'DRAFT', $3, NOW() + interval '2 days', NOW() + interval '1 day')
     RETURNING id`,
    [`PRQ-TGT-${suffix}`, ids.shop, 'Targeting verification request']
  )
  ids.request = request.rows[0].id

  const item = await query(
    `INSERT INTO procurement_request_items (request_id, category_id, item_name, requested_quantity, unit)
     VALUES ($1, $2, 'Chicken', 20, 'KG') RETURNING id`,
    [ids.request, ids.category]
  )
  ids.requestItem = item.rows[0].id
})

afterAll(async () => {
  if (!dbUp) return
  await query(`DELETE FROM procurement_recipients WHERE request_id = $1`, [ids.request])
  await query(`DELETE FROM procurement_request_items WHERE request_id = $1`, [ids.request])
  await query(`DELETE FROM procurement_requests WHERE id = $1`, [ids.request])
  await query(`DELETE FROM vendor_users WHERE vendor_id = ANY($1)`, [ids.vendors])
  await query(`DELETE FROM vendor_store_assignments WHERE vendor_id = ANY($1)`, [ids.vendors])
  await query(`DELETE FROM vendor_service_areas WHERE vendor_id = ANY($1)`, [ids.vendors])
  await query(`DELETE FROM vendor_supply_categories WHERE vendor_id = ANY($1)`, [ids.vendors])
  await query(`DELETE FROM vendors WHERE id = ANY($1)`, [ids.vendors])
  await query(`DELETE FROM users WHERE id = ANY($1)`, [ids.users ?? []])
  await query(`DELETE FROM categories WHERE id = $1`, [ids.category])
  await query(`DELETE FROM shops WHERE id IN ($1, $2)`, [ids.shop, ids.delhiShop])
  await closePool()
})

describe.skipIf(!dbUp)('store-first targeting with service profiles (Scenario A)', () => {
  it('publishes to the Kolkata vendor but not the Delhi-only or suspended vendors', async () => {
    const service = new VendorProcurementService()

    const result = await service.publishRequest(ids.request, null)

    const recipientVendorIds = result.recipients.map((r) => r.vendor_id)
    expect(recipientVendorIds).toContain(ids['vendor-kolkata'])
    expect(recipientVendorIds).toContain(ids['vendor-assigned']) // explicit assignment overrides area
    expect(recipientVendorIds).toContain(ids['vendor-empty']) // unknown profile → passes with recorded gap
    expect(recipientVendorIds).not.toContain(ids['vendor-delhi'])
    expect(recipientVendorIds).not.toContain(ids['vendor-suspended'])

    // Persisted rows match the resolution (containment — other ACTIVE vendors
    // may legitimately exist in a shared local database).
    const persisted = await dbQuery(
      `SELECT vendor_id FROM procurement_recipients WHERE request_id = $1`,
      [ids.request]
    )
    const persistedIds = persisted.rows.map((r) => r.vendor_id)
    expect(persistedIds).toContain(ids['vendor-kolkata'])
    expect(persistedIds).not.toContain(ids['vendor-delhi'])
    expect(persistedIds).not.toContain(ids['vendor-suspended'])

    // Cleanup request state so afterAll delete ordering is unaffected.
    await dbQuery(`DELETE FROM procurement_recipients WHERE request_id = $1`, [ids.request])
    await dbQuery(`UPDATE procurement_requests SET status = 'DRAFT', published_at = NULL WHERE id = $1`, [ids.request])
  })

  it('previews eligible vendors without persisting recipients', async () => {
    const service = new VendorProcurementService()

    const preview = await service.getEligibleVendorPreview(ids.shop, [{ category_id: ids.category }])

    const eligibleIds = preview.eligible.map((v) => v.vendor_id)
    expect(eligibleIds).toContain(ids['vendor-kolkata'])
    expect(eligibleIds).not.toContain(ids['vendor-delhi'])

    const rejectedDelhi = preview.rejected.find((r) => r.vendor_id === ids['vendor-delhi'])
    expect(rejectedDelhi.reasons).toContain('area_match')
    const rejectedSuspended = preview.rejected.find((r) => r.vendor_id === ids['vendor-suspended'])
    expect(rejectedSuspended.reasons).toContain('vendor_status')

    const persisted = await dbQuery(`SELECT COUNT(*)::int AS n FROM procurement_recipients WHERE request_id = $1`, [ids.request])
    expect(persisted.rows[0].n).toBe(0)
  })

  it('updates a vendor service profile (replace-all) and reflects it in the preview', async () => {
    const service = new VendorProcurementService()

    // Give the Delhi vendor a Kolkata service area → it becomes eligible.
    const updated = await service.updateVendorServiceProfile(ids['vendor-delhi'], {
      category_ids: [ids.category],
      service_pincodes: ['700001', '110001'],
      shop_ids: [],
    })

    expect(updated.service_pincodes.sort()).toEqual(['110001', '700001'])
    expect(updated.store_assignments).toHaveLength(0)

    const preview = await service.getEligibleVendorPreview(ids.shop, [{ category_id: ids.category }])
    expect(preview.eligible.map((v) => v.vendor_id)).toContain(ids['vendor-delhi'])

    // Restore the Delhi-only profile.
    await service.updateVendorServiceProfile(ids['vendor-delhi'], {
      category_ids: [ids.category],
      service_pincodes: ['110001'],
      shop_ids: [],
    })
    const restored = await service.getEligibleVendorPreview(ids.shop, [{ category_id: ids.category }])
    expect(restored.eligible.map((v) => v.vendor_id)).not.toContain(ids['vendor-delhi'])
  })
})
