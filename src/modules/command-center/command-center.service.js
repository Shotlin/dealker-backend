/**
 * Command centre — every number on the admin's main dashboard, in one call.
 *
 * All figures come from the real tables; "previous" is the equal-length
 * period just before, so each KPI can show a trend. Definitions:
 *   billed        = total payable + wallet + loyalty applied (what the customer was billed)
 *   counted sale  = not cancelled/refunded and not an unpaid online order
 *   B2C           = customer orders; B2B = vendor-to-vendor orders with money in escrow/released
 *
 * @module modules/command-center/command-center.service
 */

import { query } from '../../config/database.js'
import { CampaignsService } from '../promo-campaigns/campaigns.service.js'
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js'
import { PERIODS, periodRange } from './command-center.period.js'

export { PERIODS, periodRange }

const BILLED = `(COALESCE(o.total_payable,0) + COALESCE(o.wallet_amount,0) + COALESCE(o.loyalty_redeemed_amount,0))`
const COUNTED = `(o.status NOT IN ('CANCELLED','REFUNDED') AND NOT (o.payment_method = 'ONLINE' AND o.payment_status = 'PENDING'))`
const B2C_ONLY = `COALESCE(o.order_channel, 'B2C') = 'B2C'`
const PENDING_STATUSES = `('PENDING','ORDER_PLACED','CONFIRMED','PACKED','READY_TO_SHIP','SHIPPED','OUT_FOR_DELIVERY')`
const n = (v) => Number(v || 0)

const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : cur > 0 ? 100 : 0)
const pair = (cur, prev) => ({ value: cur, previous: prev, change: pct(cur, prev) })

export class CommandCenterService {
  constructor() {
    this.campaigns = new CampaignsService()
    this.subscriptions = new SubscriptionsService()
  }

  async #orders(a, b) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE o.status IN ('DELIVERED','COMPLETED'))::int AS delivered,
              COUNT(*) FILTER (WHERE o.status = 'CANCELLED')::int AS cancelled,
              COUNT(*) FILTER (WHERE o.status IN ${PENDING_STATUSES})::int AS pending,
              COALESCE(SUM(${BILLED}) FILTER (WHERE ${COUNTED} AND ${B2C_ONLY}), 0) AS sales,
              COUNT(*) FILTER (WHERE o.payment_plan = 'COD')::int AS cod_orders,
              COUNT(*) FILTER (WHERE o.payment_plan = 'PARTIAL')::int AS partial_orders,
              COALESCE(SUM(${BILLED}) FILTER (WHERE ${COUNTED} AND o.payment_plan IN ('COD','PARTIAL')), 0) AS cod_value
         FROM orders o WHERE o.created_at >= $1 AND o.created_at < $2`, [a, b])
    return rows[0]
  }

  async #b2b(a, b) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS orders,
              COALESCE(SUM(subtotal) FILTER (WHERE status <> 'CANCELLED' AND payment_status IN ('ESCROW_HELD','RELEASED')), 0) AS sales,
              COALESCE(SUM(commission_amount) FILTER (WHERE status <> 'CANCELLED' AND payment_status IN ('ESCROW_HELD','RELEASED')), 0) AS commission
         FROM b2b_orders WHERE created_at >= $1 AND created_at < $2`, [a, b])
    // B2B auction orders are vendor purchases too
    const auction = (await query(
      `SELECT COUNT(*)::int AS orders, COALESCE(SUM(${BILLED}) FILTER (WHERE ${COUNTED}), 0) AS sales
         FROM orders o WHERE o.order_channel = 'B2B' AND o.created_at >= $1 AND o.created_at < $2`, [a, b])).rows[0]
    const auctionFees = (await query(
      `SELECT COALESCE(SUM(so.commission_amount), 0) AS commission
         FROM seller_orders so JOIN orders o ON o.id = so.order_id
        WHERE o.order_channel = 'B2B' AND so.status <> 'CANCELLED' AND o.created_at >= $1 AND o.created_at < $2`, [a, b])).rows[0]
    auction.commission = auctionFees.commission
    return {
      orders: rows[0].orders + auction.orders,
      sales: n(rows[0].sales) + n(auction.sales),
      commission: n(rows[0].commission) + n(auction.commission),
    }
  }

  async #fees(a, b) {
    const { rows } = await query(
      `SELECT COALESCE(SUM(commission_amount), 0) AS commission, COALESCE(SUM(platform_charge), 0) AS platform_charge,
              COALESCE(SUM(fee_tax_amount), 0) AS fee_tax, COALESCE(SUM(tax_amount), 0) AS sales_tax,
              COALESCE(SUM(item_subtotal), 0) AS gross
         FROM seller_orders WHERE status <> 'CANCELLED' AND created_at >= $1 AND created_at < $2`, [a, b])
    return rows[0]
  }

  async #refunds(a, b) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS cnt,
              COALESCE(SUM(COALESCE(resolved_amount, computed_amount)) FILTER (WHERE status <> 'PENDING'), 0) AS amount
         FROM refund_requests WHERE created_at >= $1 AND created_at < $2`, [a, b])
    return rows[0]
  }

  async #sell(kind, a, b) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS cnt, COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
              COALESCE(SUM(final_price) FILTER (WHERE status = 'COMPLETED'), 0) AS value
         FROM sell_requests WHERE kind = $3 AND created_at >= $1 AND created_at < $2`, [a, b, kind])
    return rows[0]
  }

  async #count(sql, params) { return n((await query(sql, params)).rows[0].n) }

  async build(period, { io = null } = {}) {
    const r = periodRange(period)
    const { from, to, prevFrom, prevTo } = r

    const [
      oc, op, bc, bp, fc, fp, rc, rp, exc, exp, sellc, sellp,
      pendingNow, wallets, walletTx, vendorWallet, vendorTx, holds, payouts,
      live, retained, buyers, newCust, newCustPrev, newVend, newVendPrev, topBuyers, topVendors,
      abCart, abB2b, auctions, auctionBids, auctionRevenue, alerts, alertFeed, campaigns, subs,
    ] = await Promise.all([
      this.#orders(from, to), this.#orders(prevFrom, prevTo),
      this.#b2b(from, to), this.#b2b(prevFrom, prevTo),
      this.#fees(from, to), this.#fees(prevFrom, prevTo),
      this.#refunds(from, to), this.#refunds(prevFrom, prevTo),
      this.#sell('EXCHANGE', from, to), this.#sell('EXCHANGE', prevFrom, prevTo),
      this.#sell('SELL', from, to), this.#sell('SELL', prevFrom, prevTo),
      this.#count(`SELECT COUNT(*) AS n FROM orders WHERE status IN ${PENDING_STATUSES}`),
      query(`SELECT COALESCE(SUM(balance), 0) AS total, COUNT(*) FILTER (WHERE balance > 0)::int AS holders FROM wallets`),
      query(`SELECT COALESCE(SUM(amount) FILTER (WHERE type::text = 'CREDIT'), 0) AS credits, COALESCE(SUM(amount) FILTER (WHERE type::text = 'DEBIT'), 0) AS debits
               FROM wallet_transactions WHERE created_at >= $1 AND created_at < $2`, [from, to]),
      query(`SELECT COALESCE(SUM(amount), 0) AS balance FROM settlement_ledger`),
      query(`SELECT COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0) AS credits, COALESCE(-SUM(amount) FILTER (WHERE amount < 0), 0) AS debits
               FROM settlement_ledger WHERE created_at >= $1 AND created_at < $2`, [from, to]),
      this.#count(`SELECT COUNT(DISTINCT vendor_id) AS n FROM settlement_holds WHERE is_active = TRUE`),
      query(`SELECT COALESCE(SUM(amount), 0) AS pending, COUNT(*)::int AS cnt FROM settlement_payouts WHERE status IN ('PENDING','PROCESSING')`),
      query(`SELECT COUNT(*) FILTER (WHERE role = 'CUSTOMER')::int AS customers, COUNT(*) FILTER (WHERE role <> 'CUSTOMER')::int AS staff
               FROM users WHERE last_active_at >= NOW() - interval '5 minutes' AND is_active = TRUE`),
      query(`SELECT COUNT(DISTINCT o.customer_id)::int AS returning_buyers
               FROM orders o WHERE o.created_at >= $1 AND o.created_at < $2 AND o.status NOT IN ('CANCELLED','REFUNDED')
                AND EXISTS (SELECT 1 FROM orders p WHERE p.customer_id = o.customer_id AND p.created_at < $1 AND p.status NOT IN ('CANCELLED','REFUNDED'))`, [from, to]),
      query(`SELECT COUNT(DISTINCT customer_id)::int AS buyers FROM orders WHERE created_at >= $1 AND created_at < $2 AND status NOT IN ('CANCELLED','REFUNDED')`, [from, to]),
      this.#count(`SELECT COUNT(*) AS n FROM users WHERE role = 'CUSTOMER' AND created_at >= $1 AND created_at < $2`, [from, to]),
      this.#count(`SELECT COUNT(*) AS n FROM users WHERE role = 'CUSTOMER' AND created_at >= $1 AND created_at < $2`, [prevFrom, prevTo]),
      this.#count(`SELECT COUNT(*) AS n FROM vendors WHERE deleted_at IS NULL AND created_at >= $1 AND created_at < $2`, [from, to]),
      this.#count(`SELECT COUNT(*) AS n FROM vendors WHERE deleted_at IS NULL AND created_at >= $1 AND created_at < $2`, [prevFrom, prevTo]),
      query(`SELECT u.id, u.name, u.phone, COUNT(*)::int AS orders, COALESCE(SUM(${BILLED}), 0) AS spent
               FROM orders o JOIN users u ON u.id = o.customer_id
              WHERE o.created_at >= $1 AND o.created_at < $2 AND ${COUNTED}
              GROUP BY u.id, u.name, u.phone ORDER BY spent DESC LIMIT 5`, [from, to]),
      query(`SELECT v.id, v.name, COUNT(*)::int AS orders, COALESCE(SUM(so.item_subtotal), 0) AS sales
               FROM seller_orders so JOIN vendors v ON v.id = so.vendor_id
              WHERE so.status <> 'CANCELLED' AND so.created_at >= $1 AND so.created_at < $2
              GROUP BY v.id, v.name ORDER BY sales DESC LIMIT 5`, [from, to]),
      query(`SELECT COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open, COALESCE(SUM(cart_value) FILTER (WHERE status = 'OPEN'), 0) AS open_value,
                    COUNT(*) FILTER (WHERE detected_at >= $1 AND detected_at < $2)::int AS detected,
                    COUNT(*) FILTER (WHERE status IN ('RECOVERED','CONVERTED') AND COALESCE(recovered_at, converted_at) >= $1 AND COALESCE(recovered_at, converted_at) < $2)::int AS recovered
               FROM abandoned_carts`, [from, to]),
      query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(subtotal), 0) AS value
               FROM b2b_orders WHERE status = 'PENDING_PAYMENT' AND payment_status = 'UNPAID' AND created_at < NOW() - interval '24 hours'`),
      query(`SELECT COUNT(*) FILTER (WHERE status = 'LIVE')::int AS live, COUNT(*) FILTER (WHERE status = 'SCHEDULED')::int AS scheduled,
                    COUNT(*) FILTER (WHERE status = 'AWAITING_PAYMENT')::int AS awaiting_payment,
                    COUNT(*) FILTER (WHERE status = 'LIVE' AND ends_at <= NOW() + interval '24 hours')::int AS ending_soon,
                    COUNT(*) FILTER (WHERE status = 'PENDING_APPROVAL')::int AS pending_approval,
                    COUNT(*) FILTER (WHERE status IN ('SOLD','AWAITING_PAYMENT') AND winner_id IS NOT NULL AND ended_at >= $1 AND ended_at < $2)::int AS winners
               FROM auctions`, [from, to]),
      this.#count(`SELECT COUNT(*) AS n FROM auction_bids WHERE created_at >= $1 AND created_at < $2`, [from, to]),
      query(`SELECT COALESCE(SUM(${BILLED}), 0) AS revenue FROM auctions a JOIN orders o ON o.id = a.order_id
              WHERE a.status = 'SOLD' AND a.ended_at >= $1 AND a.ended_at < $2 AND ${COUNTED}`, [from, to]),
      query(`SELECT COUNT(*) FILTER (WHERE severity = 'CRITICAL')::int AS critical, COUNT(*) FILTER (WHERE severity = 'WARNING')::int AS warning,
                    COUNT(*) FILTER (WHERE severity = 'INFO')::int AS info, COUNT(*)::int AS total
               FROM admin_alerts WHERE created_at >= NOW() - interval '7 days'`),
      query(`SELECT id, type, severity, title, link, created_at FROM admin_alerts ORDER BY created_at DESC, id DESC LIMIT 8`),
      this.campaigns.overview(),
      this.subscriptions.overview(),
    ])

    const b2cSales = n(oc.sales); const b2cPrev = n(op.sales)
    const b2bSales = n(bc.sales); const b2bPrev = n(bp.sales)
    const commissionNow = n(fc.commission) + n(bc.commission)
    const commissionPrev = n(fp.commission) + n(bp.commission)
    const buyersN = buyers.rows[0].buyers

    return {
      period: r.period,
      range: { from: from.toISOString(), to: to.toISOString(), previousFrom: prevFrom.toISOString() },
      sales: {
        total: pair(b2cSales + b2bSales, b2cPrev + b2bPrev),
        b2c: pair(b2cSales, b2cPrev),
        b2b: pair(b2bSales, b2bPrev),
      },
      orders: {
        total: pair(oc.total, op.total),
        pending: { value: n(pendingNow), inPeriod: oc.pending },
        delivered: pair(oc.delivered, op.delivered),
        cancelled: pair(oc.cancelled, op.cancelled),
        b2bOrders: pair(bc.orders, bp.orders),
      },
      refunds: { ...pair(rc.cnt, rp.cnt), amount: n(rc.amount), previousAmount: n(rp.amount) },
      exchanges: { ...pair(exc.cnt, exp.cnt), completed: exc.completed },
      payments: { codOrders: oc.cod_orders, partialOrders: oc.partial_orders, codValue: n(oc.cod_value), prepaidShare: oc.total ? Math.round(((oc.total - oc.cod_orders - oc.partial_orders) / oc.total) * 100) : 0 },
      wallets: {
        customer: { balance: n(wallets.rows[0].total), holders: wallets.rows[0].holders, credits: n(walletTx.rows[0].credits), debits: n(walletTx.rows[0].debits) },
        vendor: { balance: n(vendorWallet.rows[0].balance), credits: n(vendorTx.rows[0].credits), debits: n(vendorTx.rows[0].debits), vendorsOnHold: n(holds), pendingPayouts: n(payouts.rows[0].pending), pendingPayoutCount: payouts.rows[0].cnt },
      },
      money: {
        vendorCommission: pair(commissionNow, commissionPrev),
        platformCharges: pair(n(fc.platform_charge), n(fp.platform_charge)),
        tax: { salesTax: n(fc.sales_tax), feeTax: n(fc.fee_tax), total: n(fc.sales_tax) + n(fc.fee_tax), previous: n(fp.sales_tax) + n(fp.fee_tax) },
        vendorGross: n(fc.gross),
      },
      users: {
        live: { customers: live.rows[0].customers, staff: live.rows[0].staff, connections: io?.engine?.clientsCount ?? 0 },
        retained: { returningBuyers: retained.rows[0].returning_buyers, buyers: buyersN, rate: buyersN ? Math.round((retained.rows[0].returning_buyers / buyersN) * 100) : 0 },
        newCustomers: pair(newCust, newCustPrev),
        newVendors: pair(newVend, newVendPrev),
        topBuyers: topBuyers.rows.map((x) => ({ id: x.id, name: x.name || 'Customer', phone: x.phone, orders: x.orders, spent: n(x.spent) })),
        topVendors: topVendors.rows.map((x) => ({ id: x.id, name: x.name, orders: x.orders, sales: n(x.sales) })),
      },
      abandoned: {
        b2c: { open: abCart.rows[0].open, openValue: n(abCart.rows[0].open_value), detected: abCart.rows[0].detected, recovered: abCart.rows[0].recovered },
        b2b: { count: abB2b.rows[0].cnt, value: n(abB2b.rows[0].value) },
      },
      sellOnPhone: { ...pair(sellc.cnt, sellp.cnt), completed: sellc.completed, payoutValue: n(sellc.value) },
      auctions: {
        live: auctions.rows[0].live, scheduled: auctions.rows[0].scheduled, awaitingPayment: auctions.rows[0].awaiting_payment,
        endingSoon: auctions.rows[0].ending_soon, pendingApproval: auctions.rows[0].pending_approval,
        winners: auctions.rows[0].winners, bids: auctionBids, revenue: n(auctionRevenue.rows[0].revenue),
      },
      campaigns,
      subscriptions: subs,
      alerts: { summary: alerts.rows[0], recent: alertFeed.rows },
    }
  }
}
