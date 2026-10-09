/**
 * Vendor timeline — the whole life of a vendor on one screen:
 * Registered → Approved → Subscription → Products → Orders → Sales →
 * Commission → Wallet → Refunds → Reviews → Auction → Renewal.
 *
 * Every figure is read from the real tables; a stage is "done" only when
 * there is something real behind it.
 *
 * @module modules/subscriptions/vendor-timeline.service
 */

import { query } from '../../config/database.js'

const n = (v) => Number(v || 0)

export async function vendorTimeline(vendorId) {
  const v = (await query(`SELECT id, name, status, created_at FROM vendors WHERE id = $1 AND deleted_at IS NULL`, [vendorId])).rows[0]
  if (!v) return null

  const [kyc, sub, subEvents, prod, ord, money, wallet, payouts, refunds, reviews, auctions] = await Promise.all([
    query(`SELECT action, new_status, comments, created_at FROM vendor_kyc_reviews WHERE vendor_id = $1 ORDER BY created_at`, [vendorId]),
    query(
      `SELECT vs.started_at, vs.expires_at, vs.billing_cycle, vs.auto_renew, sp.tier, sp.name AS plan_name
         FROM vendor_subscriptions vs JOIN subscription_plans sp ON sp.id = vs.plan_id
        WHERE vs.vendor_id = $1 AND vs.status = 'ACTIVE' AND (vs.expires_at IS NULL OR vs.expires_at > NOW())
        ORDER BY vs.started_at DESC LIMIT 1`, [vendorId]),
    query(`SELECT event, from_tier, to_tier, created_at FROM subscription_events WHERE vendor_id = $1 ORDER BY created_at DESC LIMIT 20`, [vendorId]),
    query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE sp.approval_status = 'APPROVED')::int AS approved,
              COUNT(*) FILTER (WHERE sp.qc_status = 'QC_PASSED')::int AS qc_passed, MIN(sp.created_at) AS first_at
         FROM shop_products sp JOIN products p ON p.id = sp.product_id
        WHERE p.owner_vendor_id = $1 AND sp.deleted_at IS NULL AND p.deleted_at IS NULL`, [vendorId]),
    query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered,
              COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled, MIN(created_at) AS first_at
         FROM seller_orders WHERE vendor_id = $1`, [vendorId]),
    query(
      `SELECT COALESCE(SUM(item_subtotal) FILTER (WHERE status <> 'CANCELLED'), 0) AS gross,
              COALESCE(SUM(item_subtotal) FILTER (WHERE status = 'DELIVERED'), 0) AS delivered_gross,
              COALESCE(SUM(commission_amount) FILTER (WHERE status <> 'CANCELLED'), 0) AS commission,
              COALESCE(SUM(platform_charge) FILTER (WHERE status <> 'CANCELLED'), 0) AS platform_charge,
              COALESCE(SUM(fee_tax_amount) FILTER (WHERE status <> 'CANCELLED'), 0) AS fee_tax
         FROM seller_orders WHERE vendor_id = $1`, [vendorId]),
    query(`SELECT COALESCE(SUM(amount), 0) AS balance, MAX(created_at) AS last_at FROM settlement_ledger WHERE vendor_id = $1`, [vendorId]),
    query(`SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'PAID'), 0) AS paid, COUNT(*) FILTER (WHERE status = 'PAID')::int AS paid_count, MAX(paid_at) AS last_paid FROM settlement_payouts WHERE vendor_id = $1`, [vendorId]),
    query(`SELECT COUNT(*)::int AS cnt, COALESCE(-SUM(amount), 0) AS amount, MIN(created_at) AS first_at FROM settlement_ledger WHERE vendor_id = $1 AND entry_type = 'REFUND'`, [vendorId]),
    query(
      `SELECT COUNT(*)::int AS cnt, COALESCE(ROUND(AVG(r.rating)::numeric, 2), 0) AS avg, MIN(r.created_at) AS first_at
         FROM reviews r JOIN products p ON p.id = r.product_id WHERE p.owner_vendor_id = $1`, [vendorId]),
    query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'SOLD')::int AS sold,
              COUNT(*) FILTER (WHERE status = 'LIVE')::int AS live, MIN(created_at) AS first_at
         FROM auctions WHERE vendor_id = $1`, [vendorId]),
  ])

  const approvedRow = kyc.rows.find((r) => ['APPROVE', 'ACTIVATE'].includes(r.action))
  const cur = sub.rows[0]
  const P = prod.rows[0]; const O = ord.rows[0]; const M = money.rows[0]; const W = wallet.rows[0]
  const PO = payouts.rows[0]; const R = refunds.rows[0]; const RV = reviews.rows[0]; const A = auctions.rows[0]
  const daysLeft = cur?.expires_at ? Math.ceil((new Date(cur.expires_at) - Date.now()) / 86400000) : null
  const renewalEvent = subEvents.rows.find((e) => e.event === 'RENEWED')

  const stages = [
    { key: 'REGISTERED', label: 'Registered', done: true, at: v.created_at, metrics: [{ label: 'Status', value: v.status.replace(/_/g, ' ').toLowerCase() }] },
    { key: 'APPROVED', label: 'Approved', done: !!approvedRow || ['VERIFIED', 'ACTIVE'].includes(v.status), at: approvedRow?.created_at ?? null,
      metrics: [{ label: 'KYC reviews', value: kyc.rows.length }] },
    { key: 'SUBSCRIPTION', label: 'Subscription', done: !!cur, at: cur?.started_at ?? null,
      metrics: [{ label: 'Plan', value: cur?.plan_name ?? 'Free' }, { label: 'Cycle', value: cur ? cur.billing_cycle.toLowerCase() : '—' }] },
    { key: 'PRODUCTS', label: 'Products', done: P.total > 0, at: P.first_at,
      metrics: [{ label: 'Listings', value: P.total }, { label: 'Approved', value: P.approved }, { label: 'QC passed', value: P.qc_passed }] },
    { key: 'ORDERS', label: 'Orders', done: O.total > 0, at: O.first_at,
      metrics: [{ label: 'Orders', value: O.total }, { label: 'Delivered', value: O.delivered }, { label: 'Cancelled', value: O.cancelled }] },
    { key: 'SALES', label: 'Sales', done: n(M.gross) > 0, at: O.first_at,
      metrics: [{ label: 'Gross sales', value: n(M.gross), money: true }, { label: 'Delivered', value: n(M.delivered_gross), money: true }] },
    { key: 'COMMISSION', label: 'Commission', done: n(M.commission) + n(M.platform_charge) > 0, at: O.first_at,
      metrics: [{ label: 'Commission', value: n(M.commission), money: true }, { label: 'Platform charges', value: n(M.platform_charge), money: true }, { label: 'Tax on fees', value: n(M.fee_tax), money: true }] },
    { key: 'WALLET', label: 'Wallet', done: !!W.last_at, at: W.last_at,
      metrics: [{ label: 'Balance', value: n(W.balance), money: true }, { label: 'Paid out', value: n(PO.paid), money: true }, { label: 'Payouts', value: PO.paid_count }] },
    { key: 'REFUNDS', label: 'Refunds', done: R.cnt > 0, at: R.first_at,
      metrics: [{ label: 'Refunds', value: R.cnt }, { label: 'Amount', value: n(R.amount), money: true }] },
    { key: 'REVIEWS', label: 'Reviews', done: RV.cnt > 0, at: RV.first_at,
      metrics: [{ label: 'Reviews', value: RV.cnt }, { label: 'Average rating', value: n(RV.avg) }] },
    { key: 'AUCTION', label: 'Auction', done: A.total > 0, at: A.first_at,
      metrics: [{ label: 'Auctions', value: A.total }, { label: 'Sold', value: A.sold }, { label: 'Live now', value: A.live }] },
    { key: 'RENEWAL', label: 'Renewal', done: !!renewalEvent, at: renewalEvent?.created_at ?? null,
      metrics: [{ label: 'Renews / ends', value: cur?.expires_at ? new Date(cur.expires_at).toISOString().slice(0, 10) : 'No expiry' },
        { label: 'Days left', value: daysLeft ?? '—' }, { label: 'Auto-renew', value: cur?.auto_renew ? 'on' : 'off' }] },
  ]

  const feed = [
    { at: v.created_at, title: 'Vendor registered' },
    ...kyc.rows.map((r) => ({ at: r.created_at, title: `KYC: ${r.action.replace(/_/g, ' ').toLowerCase()}`, detail: r.comments })),
    ...subEvents.rows.map((e) => ({ at: e.created_at, title: `Subscription ${e.event.replace(/_/g, ' ').toLowerCase()}${e.to_tier ? ` (${e.from_tier ?? '—'} → ${e.to_tier})` : ''}` })),
    ...(P.first_at ? [{ at: P.first_at, title: 'First product listed' }] : []),
    ...(O.first_at ? [{ at: O.first_at, title: 'First order received' }] : []),
    ...(PO.last_paid ? [{ at: PO.last_paid, title: 'Latest payout paid' }] : []),
    ...(R.first_at ? [{ at: R.first_at, title: 'First refund deducted' }] : []),
    ...(A.first_at ? [{ at: A.first_at, title: 'First auction created' }] : []),
  ].filter((e) => e.at).sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 40)

  return { vendor: { id: v.id, name: v.name, status: v.status }, stages, feed }
}
