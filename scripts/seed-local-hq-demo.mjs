/**
 * Idempotent local-dev demo data for the HQ dashboard's Vendors, Inventory,
 * and Finance pages — all empty out of the box because those tables have no
 * bootstrap seed elsewhere in this repo.
 *
 * Seeds: one warehouse, three vendors (+ profiles), a handful of inventory
 * lots against existing catalog products, one shop, and two monthly
 * shop_financials periods (July PAID, August PENDING) sized off the real
 * order totals from seed_extended_catalog.mjs so the Finance page lines up
 * with what Orders/HQ Command already show.
 */
import 'dotenv/config'
import pg from 'pg'

async function main() {
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // ── Warehouse ──────────────────────────────────────────────
    const { rows: whRows } = await client.query(
      `INSERT INTO warehouses (name, code, address, city, state, pincode, is_active)
       VALUES ('HQ Central FC', 'HQ-FC-01', '14 Cold Chain Logistics Park', 'New Delhi', 'Delhi', '110037', true)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    )
    const warehouseId = whRows[0].id

    // ── Vendors + profiles ─────────────────────────────────────
    const vendors = [
      {
        name: 'MeatCraft Farms Ltd.',
        slug: 'meatcraft-farms-ltd',
        email: 'ops@meatcraftfarms.example',
        phone: '9811100001',
        status: 'VERIFIED',
        fssai: 'FSSAI-11521034000192',
        gstin: '07AAACM1234F1Z5',
      },
      {
        name: 'Satara Organic Farms',
        slug: 'satara-organic-farms',
        email: 'contact@sataraorganic.example',
        phone: '9811100002',
        status: 'KYC_SUBMITTED',
        fssai: 'FSSAI-10021045000381',
        gstin: '27AACCS5678G1Z2',
      },
      {
        name: 'Northern Dairy Co-op',
        slug: 'northern-dairy-coop',
        email: 'supply@northerndairy.example',
        phone: '9811100003',
        status: 'PENDING_ONBOARDING',
        fssai: 'FSSAI-10019022000917',
        gstin: null,
      },
    ]

    const vendorIds = []
    for (const v of vendors) {
      const { rows } = await client.query(
        `INSERT INTO vendors (name, slug, email, phone, status, is_active)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (slug) DO UPDATE SET status = EXCLUDED.status, name = EXCLUDED.name
         RETURNING id`,
        [v.name, v.slug, v.email, v.phone, v.status]
      )
      const vendorId = rows[0].id
      vendorIds.push({ id: vendorId, name: v.name })

      await client.query(
        `INSERT INTO vendor_profiles (vendor_id, legal_name, fssai_license, gstin, city, state)
         VALUES ($1, $2, $3, $4, 'New Delhi', 'Delhi')
         ON CONFLICT (vendor_id) DO UPDATE SET fssai_license = EXCLUDED.fssai_license, gstin = EXCLUDED.gstin`,
        [vendorId, v.name, v.fssai, v.gstin]
      )
    }

    // ── Inventory lots (against real catalog products) ────────
    const { rows: products } = await client.query(
      `SELECT id, name FROM products WHERE is_active = true ORDER BY created_at ASC LIMIT 6`
    )

    const lotPlan = [
      { qty: 420.5, reserved: 60, daysToExpiry: 3 },
      { qty: 180.0, reserved: 0, daysToExpiry: 7 },
      { qty: 95.25, reserved: 20, daysToExpiry: 1 },
      { qty: 640.0, reserved: 150, daysToExpiry: 14 },
      { qty: 12.0, reserved: 0, daysToExpiry: 2 },
      { qty: 300.0, reserved: 45, daysToExpiry: 10 },
    ]

    let lotSeq = 1
    for (let i = 0; i < products.length; i++) {
      const plan = lotPlan[i % lotPlan.length]
      const batchNumber = `LOT-2026-${String(lotSeq).padStart(4, '0')}`
      lotSeq++
      await client.query(
        `INSERT INTO inventory_lots (warehouse_id, product_id, batch_number, expiry_date, quantity_on_hand, quantity_reserved)
         VALUES ($1, $2, $3, CURRENT_DATE + $4::int, $5, $6)
         ON CONFLICT (warehouse_id, product_id, batch_number)
         DO UPDATE SET quantity_on_hand = EXCLUDED.quantity_on_hand, quantity_reserved = EXCLUDED.quantity_reserved`,
        [warehouseId, products[i].id, batchNumber, plan.daysToExpiry, plan.qty, plan.reserved]
      )
    }

    // ── Product recalls (Quality & Recalls page) ───────────────
    const recallPlan = [
      {
        recall_number: 'RECALL-2026-LOCAL-001',
        title: `Cold-chain excursion — ${products[2]?.name ?? 'Fresh produce'}`,
        reason: 'Storage temperature exceeded 6°C for over 40 minutes during transit; precautionary recall.',
        status: 'ACTIVE',
        product: products[2],
        batch_number: 'LOT-2026-0003',
        affected_quantity: 95.25,
      },
      {
        recall_number: 'RECALL-2026-LOCAL-002',
        title: `Packaging defect — ${products[4]?.name ?? 'Perishable item'}`,
        reason: 'Vendor QC flagged seal integrity failures on a subset of units from this batch.',
        status: 'COMPLETED',
        product: products[4],
        batch_number: 'LOT-2026-0005',
        affected_quantity: 12.0,
      },
    ]

    for (const r of recallPlan) {
      if (!r.product) continue
      const { rows: recallRows } = await client.query(
        `INSERT INTO product_recalls (recall_number, title, reason, status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (recall_number) DO UPDATE SET status = EXCLUDED.status
         RETURNING id`,
        [r.recall_number, r.title, r.reason, r.status]
      )
      const recallId = recallRows[0].id
      const { rows: existingItems } = await client.query(
        `SELECT id FROM recall_items WHERE recall_id = $1 AND batch_number = $2`,
        [recallId, r.batch_number]
      )
      if (existingItems.length === 0) {
        await client.query(
          `INSERT INTO recall_items (recall_id, product_id, batch_number, affected_quantity)
           VALUES ($1, $2, $3, $4)`,
          [recallId, r.product.id, r.batch_number, r.affected_quantity]
        )
      }
    }

    // ── Shop (needed for Finance & Payouts) ────────────────────
    const { rows: shopRows } = await client.query(
      `INSERT INTO shops (
         name, slug, branch_code, address_line1, city, state, pincode, lat, lng,
         commission_rate, bank_account_number, bank_ifsc, bank_name, bank_holder_name,
         is_active, is_verified
       )
       VALUES (
         'Meet Commerce — HQ Central', 'meet-commerce-hq-central', 'HQ-001',
         '14 Cold Chain Logistics Park', 'New Delhi', 'Delhi', '110037',
         28.6139, 77.2090,
         12.00, '000501234567', 'HDFC0000123', 'HDFC Bank', 'Meet Commerce HQ Central',
         true, true
       )
       ON CONFLICT (branch_code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    )
    const shopId = shopRows[0].id

    // ── Shop financials (sized off real seeded order totals) ──
    const periods = [
      {
        period_start: '2026-07-01',
        period_end: '2026-07-31',
        gross_revenue: 73259.0,
        total_orders: 62,
        payout_status: 'PAID',
        paid_at: '2026-08-03 10:30:00+00',
        payout_ref: 'PAYOUT-2026-07-HQ001',
      },
      {
        period_start: '2026-08-01',
        period_end: '2026-08-31',
        gross_revenue: 908613.0,
        total_orders: 54,
        payout_status: 'PENDING',
        paid_at: null,
        payout_ref: null,
      },
    ]

    for (const p of periods) {
      const commission = Math.round(p.gross_revenue * 0.12 * 100) / 100
      const deliveryCosts = Math.round(p.gross_revenue * 0.015 * 100) / 100
      const refunds = Math.round(p.gross_revenue * 0.005 * 100) / 100
      const netRevenue = Math.round((p.gross_revenue - commission) * 100) / 100
      const payoutAmount = Math.round((netRevenue - deliveryCosts - refunds) * 100) / 100
      const avgOrderValue = Math.round((p.gross_revenue / p.total_orders) * 100) / 100

      await client.query(
        `INSERT INTO shop_financials (
           shop_id, period_type, period_start, period_end,
           gross_revenue, net_revenue, total_orders, avg_order_value,
           platform_commission, delivery_costs, refund_amount,
           payout_amount, payout_status, payout_ref, paid_at
         )
         VALUES ($1, 'MONTHLY', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (shop_id, period_type, period_start) DO UPDATE SET
           gross_revenue = EXCLUDED.gross_revenue,
           net_revenue = EXCLUDED.net_revenue,
           total_orders = EXCLUDED.total_orders,
           avg_order_value = EXCLUDED.avg_order_value,
           platform_commission = EXCLUDED.platform_commission,
           delivery_costs = EXCLUDED.delivery_costs,
           refund_amount = EXCLUDED.refund_amount,
           payout_amount = EXCLUDED.payout_amount,
           payout_status = EXCLUDED.payout_status,
           payout_ref = EXCLUDED.payout_ref,
           paid_at = EXCLUDED.paid_at`,
        [
          shopId,
          p.period_start,
          p.period_end,
          p.gross_revenue,
          netRevenue,
          p.total_orders,
          avgOrderValue,
          commission,
          deliveryCosts,
          refunds,
          payoutAmount,
          p.payout_status,
          p.payout_ref,
          p.paid_at,
        ]
      )
    }

    // ── Abandoned carts (Retention page) ───────────────────────
    const { rows: demoUsers } = await client.query(
      `SELECT id, name, phone FROM users WHERE name IN ('Aarav Mehta', 'Neha Sharma', 'Rohan Das') ORDER BY name`
    )

    const cartPlan = [
      { hoursAgo: 3, itemIdx: [0, 1], qty: [2, 1], priority: 82.5, reminders: 0 },
      { hoursAgo: 20, itemIdx: [2], qty: [3], priority: 65.0, reminders: 1 },
      { hoursAgo: 50, itemIdx: [3, 4, 5], qty: [1, 2, 1], priority: 48.25, reminders: 2 },
    ]

    for (let i = 0; i < demoUsers.length && i < cartPlan.length; i++) {
      const user = demoUsers[i]
      const plan = cartPlan[i]
      const items = plan.itemIdx.map((idx, j) => ({ product: products[idx % products.length], qty: plan.qty[j] }))
      const cartValue = items.reduce((sum, it) => sum + it.qty * 199, 0)

      const { rows: cartRows } = await client.query(
        `INSERT INTO abandoned_carts (user_id, status, abandoned_at, item_count, total_quantity, cart_value, priority_score, reminder_count, last_reminder_sent_at)
         VALUES ($1, 'OPEN', NOW() - ($2 || ' hours')::interval, $3, $4, $5, $6, $7, ${plan.reminders > 0 ? "NOW() - INTERVAL '1 hour'" : 'NULL'})
         ON CONFLICT (user_id) WHERE status = 'OPEN' DO UPDATE SET
           abandoned_at = EXCLUDED.abandoned_at,
           item_count = EXCLUDED.item_count,
           total_quantity = EXCLUDED.total_quantity,
           cart_value = EXCLUDED.cart_value,
           priority_score = EXCLUDED.priority_score,
           reminder_count = EXCLUDED.reminder_count
         RETURNING id`,
        [user.id, plan.hoursAgo, items.length, items.reduce((s, it) => s + it.qty, 0), cartValue, plan.priority, plan.reminders]
      )
      const cartId = cartRows[0].id

      await client.query(`DELETE FROM abandoned_cart_items WHERE abandoned_cart_id = $1`, [cartId])
      for (const it of items) {
        await client.query(
          `INSERT INTO abandoned_cart_items (abandoned_cart_id, product_id, product_name, product_unit, quantity, unit_price, list_price, line_total)
           VALUES ($1, $2, $3, 'piece', $4, 199, 199, $5)`,
          [cartId, it.product.id, it.product.name, it.qty, it.qty * 199]
        )
      }
    }

    await client.query('COMMIT')

    console.log('✅ HQ demo data ready')
    console.log(`   warehouse:  HQ Central FC (${warehouseId})`)
    console.log(`   vendors:    ${vendorIds.map((v) => v.name).join(', ')}`)
    console.log(`   inventory:  ${products.length} lots seeded`)
    console.log(`   shop:       Meet Commerce — HQ Central (${shopId})`)
    console.log(`   financials: 2 monthly periods (Jul PAID, Aug PENDING)`)
    console.log(`   abandoned carts: ${demoUsers.length} open episodes`)
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('❌ seed-local-hq-demo failed:', err.message)
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
}

main()
