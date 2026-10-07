#!/usr/bin/env node
/**
 * Rider acceptance E2E — Big Phase 18.
 *
 * Drives the REAL HTTP API of a locally running backend (:4500) through
 * the blueprint's primary acceptance flow (§29):
 *
 *   2 riders sign in (demo OTP) → go online → publish GPS near the shop
 *   → admin creates a COD manual order → the real auto-assign fans out
 *   offers to both riders → BOTH ACCEPT CONCURRENTLY → exactly one wins
 *   → winner picks up → COD delivery is BLOCKED until collection →
 *   collection recorded (idempotent) → delivered with the customer OTP
 *   → earning credited exactly once → ledger/history/audit verified →
 *   admin settles the cash → assignments + business UPI endpoints →
 *   suspend/un-suspend effects.
 *
 * Prerequisites: backend running (`npm run dev` or `npm start`), Docker
 * infra up, .env with ALLOW_DEMO_OTP=true + demo phones, local admin
 * password known (set via SQL for the E2E run).
 *
 * Usage: node tests/e2e/rider-acceptance.mjs
 */
import 'dotenv/config'
import pg from 'pg'

const BASE = process.env.E2E_BASE_URL || 'http://localhost:4500/api/v1'
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'admin@bakaloo.com'
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'E2eAdmin$2026'
const DEMO_OTP = '123456'
const SHOP_LAT = 22.5726
const SHOP_LNG = 88.3639
// ~1.2 km from the shop — inside the 15 km auto-assign radius.
const RIDER_A_POS = { latitude: 22.578, longitude: 88.37 }
const RIDER_B_POS = { latitude: 22.568, longitude: 88.366 }

const results = []
let failures = 0

function record(name, pass, detail = '') {
  results.push({ name, pass, detail })
  if (!pass) failures += 1
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function api(method, path, { body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body ?? {}),
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    // non-JSON response body
  }
  return { status: res.status, json }
}

async function loginRider(phone) {
  await api('POST', '/auth/send-otp', { body: { phone, role: 'RIDER' } })
  const res = await api('POST', '/auth/verify-otp', {
    body: { phone, otp: DEMO_OTP, role: 'RIDER' },
  })
  if (res.status !== 200 || !res.json?.data?.accessToken) {
    throw new Error(`Rider ${phone} login failed: ${JSON.stringify(res.json)}`)
  }
  return { token: res.json.data.accessToken, userId: res.json.data.user.id }
}

async function main() {
  const db = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'grocery_db',
    user: process.env.DB_USER || 'grocery_user',
    password: process.env.DB_PASSWORD || 'grocery_password_dev',
  })

  try {
    // ── 0. Logins ──────────────────────────────────────────────────
    const adminLogin = await api('POST', '/admin/auth/login', {
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    })
    record(
      'Admin login',
      adminLogin.status === 200 && !!adminLogin.json?.data?.accessToken,
    )
    const adminToken = adminLogin.json.data.accessToken

    const riderA = await loginRider('9000000001')
    const riderB = await loginRider('9000000002')
    record('Rider A login (demo OTP)', !!riderA.token)
    record('Rider B login (demo OTP)', !!riderB.token)

    const customerLogin = await loginRider('9000000003')
    const customerId = customerLogin.userId
    record('Customer account available', !!customerId)

    // ── 1. Riders go online + publish GPS near the shop ────────────
    for (const [label, rider, pos] of [
      ['Rider A online', riderA, RIDER_A_POS],
      ['Rider B online', riderB, RIDER_B_POS],
    ]) {
      const t = await api('PATCH', '/delivery/toggle-online', {
        body: { isOnline: true },
        token: rider.token,
      })
      record(label, t.status === 200, `status=${t.status}`)
      const loc = await api('PATCH', '/delivery/location', {
        body: { latitude: pos.latitude, longitude: pos.longitude },
        token: rider.token,
      })
      record(`${label.split(' ')[1]} GPS published`, loc.status === 200)
    }

    // ── 2. Admin creates a COD manual order (auto-assign triggers) ─
    let product = await db.query(
      `SELECT product_id, shop_id, price FROM shop_products
       WHERE price IS NOT NULL AND price > 0 LIMIT 1`,
    )
    if (product.rows.length === 0) {
      // Local seed rows may carry a NULL price — give the E2E row a real
      // price so the COD amount due is non-zero (test-environment data fix).
      product = await db.query(
        `SELECT sp.product_id, sp.shop_id, sp.price FROM shop_products sp LIMIT 1`,
      )
      await db.query(
        `UPDATE shop_products SET price = 199.00, is_available = true
         WHERE product_id = $1 AND shop_id = $2`,
        [product.rows[0].product_id, product.rows[0].shop_id],
      )
    }
    const { product_id: productId, shop_id: shopId } = product.rows[0]
    const order = await api('POST', '/admin/orders/manual', {
      token: adminToken,
      body: {
        userId: customerId,
        shopId,
        items: [{ productId, quantity: 1 }],
        paymentMethod: 'COD',
        deliveryAddress: {
          label: 'E2E',
          addressLine1: '12 MG Road',
          landmark: 'Test landmark',
          lat: SHOP_LAT + 0.01,
          lng: SHOP_LNG + 0.01,
        },
      },
    })
    const orderId = order.json?.data?.id ?? order.json?.data?.order?.id
    record('COD manual order created', !!orderId, `status=${order.status} id=${orderId}`)
    if (!orderId) throw new Error('No order id — cannot continue')

    // The manual-order service queues auto-assign with an inline
    // fallback in non-prod. Give the inline path a beat, then check.
    await new Promise((r) => setTimeout(r, 1500))

    const dbState = await db.query(
      `SELECT status, auto_assignment_status, payment_method, delivery_fee, total_payable
       FROM orders WHERE id = $1`,
      [orderId],
    )
    const row = dbState.rows[0]
    record(
      'Order CONFIRMED + COD',
      row?.status === 'CONFIRMED' && row?.payment_method === 'COD',
      `status=${row?.status} pay=${row?.payment_method}`,
    )
    if (Number(row?.total_payable ?? 0) <= 0) {
      // Zero-total orders make the COD gate vacuous — adjust the local
      // test order so the amount-due checks exercise real money.
      await db.query(
        `UPDATE orders SET delivery_fee = 40, subtotal = 159, total_payable = 199
         WHERE id = $1`,
        [orderId],
      )
      row.total_payable = 199
    }

    const assignmentCount = await db.query(
      `SELECT count(*)::int AS n FROM delivery_assignments
       WHERE order_id = $1 AND status = 'ASSIGNED'`,
      [orderId],
    )
    record(
      'Auto-assign fanned out offers to eligible riders',
      assignmentCount.rows[0].n >= 1,
      `${assignmentCount.rows[0].n} offer(s)`,
    )

    // ── 3. Both riders see the offer ───────────────────────────────
    const [offerA, offerB] = await Promise.all([
      api('GET', '/delivery/orders?status=ASSIGNED', { token: riderA.token }),
      api('GET', '/delivery/orders?status=ASSIGNED', { token: riderB.token }),
    ])
    const aSees = (offerA.json?.data ?? []).some((o) => o.id === orderId || o.orderId === orderId)
    const bSees = (offerB.json?.data ?? []).some((o) => o.id === orderId || o.orderId === orderId)
    record('Rider A sees the offer', aSees)
    record('Rider B sees the offer', bSees)

    // ── 4. THE RACE: concurrent accepts — exactly one winner ───────
    const [acceptA, acceptB] = await Promise.all([
      api('PATCH', `/delivery/orders/${orderId}/accept`, { token: riderA.token }),
      api('PATCH', `/delivery/orders/${orderId}/accept`, { token: riderB.token }),
    ])
    console.log(
      `  [debug] accept A: ${acceptA.status} ${JSON.stringify(acceptA.json).slice(0, 160)}`,
    )
    console.log(
      `  [debug] accept B: ${acceptB.status} ${JSON.stringify(acceptB.json).slice(0, 160)}`,
    )
    const winners = [acceptA, acceptB].filter((r) => r.status === 200)
    const losers = [acceptA, acceptB].filter((r) => r.status === 409)
    record('Race: exactly one accept succeeded', winners.length === 1)
    record('Race: the loser received a 409 conflict', losers.length === 1)
    const loserCode =
      losers[0]?.json?.code || losers[0]?.json?.data?.code || 'unknown'
    record(
      'Race: loser conflict is order-taken semantics',
      ['ORDER_ALREADY_CLAIMED', 'ORDER_NOT_AVAILABLE', 'ORDER_NOT_ASSIGNABLE'].includes(
        loserCode,
      ),
      loserCode,
    )
    const winner = acceptA.status === 200 ? { rider: riderA, res: acceptA, pos: RIDER_A_POS } : { rider: riderB, res: acceptB, pos: RIDER_B_POS }
    const loser = acceptA.status === 200 ? { rider: riderB, label: 'B' } : { rider: riderA, label: 'A' }
    // The delivery OTP belongs to the CUSTOMER: the rider's accept response
    // and order list must never carry it. The E2E reads it from the DB the
    // way the customer's own app receives it.
    record(
      'Accept response does NOT leak the delivery OTP to the rider',
      !JSON.stringify(winner.res.json ?? {}).match(/deliveryOtp|delivery_otp/),
    )
    const otpRow = await db.query(
      `SELECT delivery_otp FROM delivery_assignments
        WHERE order_id = $1 AND status = 'ACCEPTED' LIMIT 1`,
      [orderId],
    )
    const deliveryOtp = otpRow.rows[0]?.delivery_otp
    record('Delivery OTP stored server-side for the customer', !!deliveryOtp)
    const riderList = await api('GET', '/delivery/orders', { token: winner.rider.token })
    record(
      'Rider order list does NOT leak the delivery OTP',
      !JSON.stringify(riderList.json ?? {}).includes(`"${deliveryOtp}"`) &&
        !JSON.stringify(riderList.json ?? {}).match(/deliveryOtp|delivery_otp/),
    )

    // ── 5. No second offer for the busy rider (§10) ────────────────
    // (Winner now holds an IN-progress assignment; create a second order
    // and confirm the winner is NOT offered it while the loser is.)
    const order2 = await api('POST', '/admin/orders/manual', {
      token: adminToken,
      body: {
        userId: customerId,
        shopId,
        items: [{ productId, quantity: 1 }],
        paymentMethod: 'COD',
        deliveryAddress: { label: 'E2E-2', addressLine1: '14 MG Road' },
      },
    })
    const order2Id = order2.json?.data?.id ?? order2.json?.data?.order?.id
    await new Promise((r) => setTimeout(r, 1500))
    const winnerOffers = await api('GET', '/delivery/orders?status=ASSIGNED', {
      token: winner.rider.token,
    })
    const winnerGotSecond = (winnerOffers.json?.data ?? []).some(
      (o) => o.id === order2Id || o.orderId === order2Id,
    )
    record(
      'Single-order rule: busy rider received NO second offer',
      !winnerGotSecond,
    )
    const loserOffers = await api('GET', '/delivery/orders?status=ASSIGNED', {
      token: loser.rider.token,
    })
    const loserGotSecond = (loserOffers.json?.data ?? []).some(
      (o) => o.id === order2Id || o.orderId === order2Id,
    )
    record('Available rider received the second offer', loserGotSecond)

    // ── 6. Store pickup scan (FreshCuts invoice QR) ────────────────
    const numRow = await db.query(`SELECT order_number FROM orders WHERE id = $1`, [orderId])
    const orderNumber = numRow.rows[0]?.order_number
    const qr = `FRESHCUTS-ORDER|${orderNumber}|${orderId}`
    const badQr = await api('POST', '/delivery/pickup-tokens/verify', {
      body: { qr: `FRESHCUTS-ORDER|${orderNumber}|00000000-0000-4000-8000-000000000000` },
      token: winner.rider.token,
    })
    record('Scan of an unknown order rejected', badQr.status === 404 || badQr.status === 403, `status=${badQr.status}`)
    const otherRiderScan = await api('POST', '/delivery/pickup-tokens/verify', {
      body: { qr },
      token: loser.rider.token,
    })
    record(
      "Another rider cannot verify this order's code (WRONG_RIDER)",
      otherRiderScan.status === 403 && otherRiderScan.json?.code === 'WRONG_RIDER',
      `status=${otherRiderScan.status}`,
    )
    const scan = await api('POST', '/delivery/pickup-tokens/verify', {
      body: { qr },
      token: winner.rider.token,
    })
    record(
      'Pickup QR verified → price-free checklist',
      scan.status === 200 &&
        Array.isArray(scan.json?.data?.items) &&
        !JSON.stringify(scan.json?.data ?? {}).match(/"(price|total|subtotal)"/),
      `items=${scan.json?.data?.items?.length}`,
    )
    const pending = await api('GET', `/delivery/orders/${orderId}/pending-checklist`, {
      token: winner.rider.token,
    })
    record('Pending checklist recoverable after scan', pending.status === 200)

    // ── 6b. Pickup ─────────────────────────────────────────────────
    const pickup = await api('PATCH', `/delivery/orders/${orderId}/pickup`, {
      token: winner.rider.token,
    })
    record('Pickup confirmed → IN_TRANSIT', pickup.status === 200)

    // ── 7. COD delivery blocked before collection (§14) ────────────
    const earlyDeliver = await api('PATCH', `/delivery/orders/${orderId}/deliver`, {
      body: { otp: deliveryOtp },
      token: winner.rider.token,
    })
    record(
      'Delivery BLOCKED before COD collection',
      earlyDeliver.status === 409 &&
        (earlyDeliver.json?.code || earlyDeliver.json?.data?.code) ===
          'COD_COLLECTION_REQUIRED',
      `status=${earlyDeliver.status}`,
    )

    // ── 8. Collection: mismatch rejected, correct split accepted,
    //      same-key replay is idempotent ────────────────────────────
    const totalDue = Number(row?.total_payable || 0)
    const mismatch = await api(
      'POST',
      `/delivery/orders/${orderId}/collection`,
      {
        body: {
          cashAmount: Math.max(0, totalDue - 50),
          upiAmount: 0,
          idempotencyKey: 'collection-wrong',
        },
        token: winner.rider.token,
      },
    )
    record(
      'Collection amount mismatch rejected',
      mismatch.status === 400 &&
        (mismatch.json?.code || mismatch.json?.data?.code) ===
          'COLLECTION_AMOUNT_MISMATCH',
    )

    const collect = await api('POST', `/delivery/orders/${orderId}/collection`, {
      body: {
        cashAmount: totalDue,
        upiAmount: 0,
        idempotencyKey: `collection-${orderId}`,
      },
      token: winner.rider.token,
    })
    record('Collection recorded (201)', collect.status === 201)

    const replay = await api('POST', `/delivery/orders/${orderId}/collection`, {
      body: {
        cashAmount: totalDue,
        upiAmount: 0,
        idempotencyKey: `collection-${orderId}`,
      },
      token: winner.rider.token,
    })
    record('Same-key retry replayed (idempotent)', replay.status === 200)

    // ── 9. Deliver with the customer OTP ───────────────────────────
    const deliver = await api('PATCH', `/delivery/orders/${orderId}/deliver`, {
      body: { otp: deliveryOtp },
      token: winner.rider.token,
    })
    const summary = deliver.json?.data?.completionSummary
    record(
      'Delivery completed with completion summary',
      deliver.status === 200 && summary != null,
      `earned=${summary?.earnedAmount}`,
    )

    // ── 10. Earning credited EXACTLY ONCE ──────────────────────────
    const earnings = await db.query(
      `SELECT count(*)::int AS n FROM rider_earnings WHERE order_id = $1`,
      [orderId],
    )
    record(
      'Earning row exactly once for the order',
      earnings.rows[0].n === 1,
      `${earnings.rows[0].n} row(s)`,
    )

    const earningsApi = await api(
      'GET',
      '/delivery/earnings?period=today',
      { token: winner.rider.token },
    )
    const totalToday = Number(earningsApi.json?.data?.totalEarnings ?? -1)
    record('Earnings API reflects the credited amount', totalToday >= summary?.earnedAmount)

    // ── 11. Ledger + history + audit ───────────────────────────────
    const ledger = await api('GET', '/delivery/collections/summary', {
      token: winner.rider.token,
    })
    record(
      'Cash ledger: collected today ≥ order total',
      Number(ledger.json?.data?.collectedToday ?? 0) >= totalDue,
    )
    const collectionsRows = await db.query(
      `SELECT count(*)::int AS n FROM delivery_collections WHERE order_id = $1`,
      [orderId],
    )
    record(
      'Collection row exactly once per order (constraint)',
      collectionsRows.rows[0].n === 1,
    )

    const history = await api('GET', '/delivery/history?page=1&limit=10', {
      token: winner.rider.token,
    })
    const historyRows = history.json?.data?.orders ?? []
    const inHistory = historyRows.some(
      (h) =>
        h.order_number?.toUpperCase() === winner.res.json?.data?.orderNumber?.toUpperCase?.() ||
        h.order_id === orderId,
    )
    record('Delivery history lists the completed order', history.status === 200 && inHistory)

    // ── 12. Admin sees the truth (dashboard alignment) ─────────────
    const adminList = await api(
      'GET',
      '/admin/riders?limit=25',
      { token: adminToken },
    )
    const adminRiders = adminList.json?.data?.riders ?? []
    const winnerAdmin = adminRiders.find((r) => r.id === winner.rider.userId)
    record(
      'Admin list shows winner idle (not busy) after delivery',
      !!winnerAdmin && winnerAdmin.is_busy === false,
    )

    const adminCollections = await api(
      'GET',
      `/admin/riders/${winner.rider.userId}/collections`,
      { token: adminToken },
    )
    record(
      'Admin sees the rider collection',
      adminCollections.status === 200 &&
        (adminCollections.json?.data ?? []).some((c) => c.order_id === orderId),
    )

    const settlement = await api(
      'POST',
      `/admin/riders/${winner.rider.userId}/settlements`,
      {
        token: adminToken,
        body: {
          amount: totalDue,
          method: 'CASH',
          reference: `e2e-${orderId.slice(0, 8)}`,
        },
      },
    )
    record('Admin recorded a cash settlement', settlement.status === 200)

    const ledgerAfter = await api('GET', '/delivery/collections/summary', {
      token: winner.rider.token,
    })
    record(
      'Cash in hand settled → zero pending',
      Number(ledgerAfter.json?.data?.cashInHand ?? -1) === 0,
      `cashInHand=${ledgerAfter.json?.data?.cashInHand}`,
    )

    // Assignments + business UPI
    const assignEmpty = await api(
      'PUT',
      `/admin/riders/${winner.rider.userId}/assignments`,
      { token: adminToken, body: { shopIds: [shopId] } },
    )
    record('Store assignment PUT accepted', assignEmpty.status === 200)
    const assignGet = await api(
      'GET',
      `/admin/riders/${winner.rider.userId}/assignments`,
      { token: adminToken },
    )
    record(
      'Store assignment persisted',
      (assignGet.json?.data ?? []).some((a) => a.shop_id === shopId && a.is_active),
    )

    const upi = await api(
      'PUT',
      `/admin/riders/${winner.rider.userId}/business-upi`,
      { token: adminToken, body: { businessUpiId: 'freshcuts@e2e' } },
    )
    record('Business UPI set', upi.status === 200)

    // ── 13. Suspend / un-suspend effects ───────────────────────────
    const suspend = await api('PUT', `/admin/riders/${loser.rider.userId}/suspend`, {
      token: adminToken,
      body: { suspended: true },
    })
    record('Admin suspend accepted', suspend.status === 200)
    const onlineCheck = await db.query(
      `SELECT is_online FROM rider_profiles WHERE user_id = $1`,
      [loser.rider.userId],
    )
    record(
      'Suspension forced the rider offline',
      onlineCheck.rows[0]?.is_online === false,
    )
    const blockedToggle = await api('PATCH', '/delivery/toggle-online', {
      body: { isOnline: true },
      token: loser.rider.token,
    })
    record(
      'Suspended rider blocked from going online (403 RIDER_SUSPENDED)',
      blockedToggle.status === 403 &&
        (blockedToggle.json?.code || blockedToggle.json?.data?.code) ===
          'RIDER_SUSPENDED',
    )
    const unsuspend = await api(
      'PUT',
      `/admin/riders/${loser.rider.userId}/suspend`,
      { token: adminToken, body: { suspended: false } },
    )
    record('Un-suspend accepted', unsuspend.status === 200)

    // ── Done ───────────────────────────────────────────────────────
    console.log(
      `\n${failures === 0 ? '🎉' : '💥'} ${results.length - failures}/${results.length} checks passed`,
    )
    process.exitCode = failures === 0 ? 0 : 1
  } finally {
    await db.end()
  }
}

main().catch((err) => {
  console.error('E2E crashed:', err)
  process.exit(1)
})
