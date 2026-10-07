import { logger } from '../../../config/logger.js'
import { metric, resolveRange, round2 } from './overview.range.js'
import { buildInsights, withGrowth } from './overview.insights.js'

const TOP_N = 8

const PLACED = ['ORDER_PLACED', 'CONFIRMED', 'PENDING', 'PLACED']
const OUT_FOR_DELIVERY = ['OUT_FOR_DELIVERY', 'DISPATCHED', 'PICKED_UP', 'IN_TRANSIT']

const safeDiv = (a, b) => (b > 0 ? a / b : null)

/** Collapses raw order statuses into the health buckets the dashboard shows. */
export function groupStatuses(rows, returnRequests = 0) {
  const sum = (list) => rows.filter((r) => list.includes(r.status)).reduce((s, r) => s + r.n, 0)
  const one = (s) => sum([s])
  return {
    placed: sum(PLACED),
    preparing: one('PREPARING'),
    packed: one('PACKED'),
    out_for_delivery: sum(OUT_FOR_DELIVERY),
    delivered: one('DELIVERED'),
    cancelled: one('CANCELLED'),
    refunded: one('REFUNDED'),
    return_requested: returnRequests,
    total: rows.reduce((s, r) => s + r.n, 0),
  }
}

/** Resolves a raw `financials()` row into the money model the UI shows. */
export function deriveFinancials(row) {
  const n = (k) => Number(row[k]) || 0
  const orders = n('orders')
  const gross = n('gross_revenue')
  const discounts = n('discounts')
  const refunds = n('refunds')
  const costedOrders = n('costed_orders')
  const hasProfit = costedOrders > 0
  const costedNet = n('costed_net_revenue')
  return {
    orders,
    customers: n('customers'),
    gross_revenue: round2(gross),
    discounts: round2(discounts),
    refunds: round2(refunds),
    net_revenue: round2(gross - discounts - refunds),
    delivery_revenue: round2(n('delivery_revenue')),
    other_fee_revenue: round2(n('other_fee_revenue')),
    taxes: round2(n('taxes')),
    collected: round2(n('collected')),
    aov: orders > 0 ? round2(n('collected') / orders) : 0,
    product_cost: round2(n('product_cost')),
    rider_cost: round2(n('rider_cost')),
    shiprocket_cost: round2(n('shiprocket_cost')),
    costed_orders: costedOrders,
    cost_coverage: orders > 0 ? costedOrders / orders : null,
    gross_profit: hasProfit ? round2(n('gross_profit')) : null,
    net_profit: hasProfit ? round2(n('net_profit')) : null,
    net_margin: hasProfit ? safeDiv(n('net_profit'), costedNet) : null,
    gross_margin: hasProfit ? safeDiv(n('gross_profit'), costedNet) : null,
  }
}

export class OverviewService {
  constructor(repo) {
    this.repo = repo
  }

  async #section(errors, name, fn, fallback) {
    try {
      return await fn()
    } catch (err) {
      logger.error({ err: err.message, section: name }, 'overview section failed')
      errors[name] = 'Could not load this section'
      return fallback
    }
  }

  async getOverview(query, scopedShopId = null) {
    const range = resolveRange(query)
    // A shop-staff JWT is pinned to its own shop; HQ may pick one (or none).
    const shopId = scopedShopId || query.shopId || null
    const pincode = query.pincode ? String(query.pincode).trim() : null

    const cur = [range.from, range.to, shopId, pincode]
    const prev = [range.previousFrom, range.previousTo, shopId, pincode]
    const bucket = range.days <= 2 ? 'hour' : 'day'
    const errors = {}
    const s = (name, fn, fb) => this.#section(errors, name, fn, fb)

    const [
      finCur, finPrev, series, healthCur, healthPrevRaw, prodCur, prodPrev, slow,
      areasCur, areasPrev, customers, lapsed, delivery, deliveryPrev,
      vendorBuys, vendorMargins, priceGaps, discount, shops, pincodes,
    ] = await Promise.all([
      s('financials', () => this.repo.financials(cur), null),
      s('financials_prev', () => this.repo.financials(prev), null),
      s('series', () => this.repo.series(cur, bucket), []),
      s('order_health', () => this.repo.orderHealth(cur), null),
      s('order_health_prev', () => this.repo.orderHealth(prev), null),
      s('products', () => this.repo.productStats(cur), []),
      s('products_prev', () => this.repo.productStats(prev), []),
      s('slow_movers', () => (pincode ? [] : this.repo.slowMovers(cur, TOP_N)), []),
      s('areas', () => this.repo.areaStats(cur), []),
      s('areas_prev', () => this.repo.areaStats(prev, 200), []),
      s('customers', () => this.repo.customers(cur), []),
      s('lapsed', () => (pincode ? { total: 0, monthly_value: 0, top: [] } : this.repo.lapsedCustomers(shopId)), { total: 0, monthly_value: 0, top: [] }),
      s('delivery', () => this.repo.delivery(cur), null),
      s('delivery_prev', () => this.repo.delivery(prev), null),
      s('vendors', () => this.repo.vendorPurchases(cur), []),
      s('vendor_margins', () => this.repo.vendorSkuMargins(cur), []),
      s('vendor_prices', () => this.repo.vendorPriceGaps(shopId), []),
      s('discount', () => this.repo.discountHealth(cur), null),
      s('shops', () => this.repo.shopOptions(), []),
      s('pincodes', () => this.repo.pincodeOptions(shopId), []),
    ])

    const fin = finCur ? deriveFinancials(finCur) : null
    const finP = finPrev ? deriveFinancials(finPrev) : null
    const vendorPurchases = vendorBuys.reduce((sum, v) => sum + (v.purchases || 0), 0)

    // ── headline KPIs ──
    const m = (key) => (fin ? metric(fin[key], finP ? finP[key] : null) : null)
    const trackedCost = (f) => (f ? f.product_cost + f.rider_cost + f.shiprocket_cost + f.refunds + f.discounts : null)
    const kpis = fin && {
      gross_revenue: m('gross_revenue'),
      net_revenue: m('net_revenue'),
      gross_profit: m('gross_profit'),
      net_profit: m('net_profit'),
      aov: m('aov'),
      orders: m('orders'),
      discounts: m('discounts'),
      refunds: m('refunds'),
      taxes: m('taxes'),
      delivery_revenue: m('delivery_revenue'),
      operating_cost: metric(trackedCost(fin), trackedCost(finP)),
      net_margin: { value: fin.net_margin, previous: finP?.net_margin ?? null },
      cost_coverage: fin.cost_coverage,
    }

    // ── cost breakdown ──
    const cb = (key) => (fin ? metric(fin[key], finP ? finP[key] : null) : null)
    const costBreakdown = fin && {
      items: [
        { key: 'product_cost', label: 'Product cost (goods sold)', ...cb('product_cost'), note: `Based on items with a cost price (${Math.round((fin.cost_coverage || 0) * 100)}% of orders fully costed)` },
        { key: 'rider_cost', label: 'Rider delivery cost', ...cb('rider_cost') },
        { key: 'shiprocket_cost', label: 'Shiprocket delivery cost', ...cb('shiprocket_cost') },
        { key: 'refunds', label: 'Refunds & returns', ...cb('refunds') },
        { key: 'discounts', label: 'Discounts given', ...cb('discounts') },
      ],
      untracked: [
        { key: 'warehouse_handling', label: 'Warehouse handling & packing' },
        { key: 'inbound_logistics', label: 'Vendor → warehouse logistics' },
      ],
      vendor_purchases: round2(vendorPurchases),
      total_tracked: round2(trackedCost(fin)),
    }

    // ── products ──
    const enriched = withGrowth(prodCur, prodPrev)
    const view = (p) => ({
      product_id: p.product_id, name: p.name, image: p.image ?? null, units: p.units, revenue: round2(p.revenue),
      margin: p.margin, profit: p.costed_revenue > 0 && p.cogs != null ? round2(p.costed_revenue - p.cogs) : null,
      growth: p.growth, refunded_units: p.refunded_units, refund_rate: safeDiv(p.refunded_units, p.units),
      refunded_value: round2(p.refunded_value), repeat_buyers: p.repeat_buyers,
    })
    const top = (arr, cmp, filter = () => true) => arr.filter(filter).sort(cmp).slice(0, TOP_N).map(view)
    const products = {
      top_selling: top(enriched, (a, b) => b.units - a.units),
      top_revenue: top(enriched, (a, b) => b.revenue - a.revenue),
      top_profit: top(enriched, (a, b) => (b.costed_revenue - b.cogs) - (a.costed_revenue - a.cogs),
        (p) => p.costed_revenue > 0 && p.cogs != null),
      trending: top(enriched, (a, b) => (b.revenue - b.prev_revenue) - (a.revenue - a.prev_revenue),
        (p) => p.growth != null && p.growth > 0.1 && p.units >= 3),
      high_returns: top(enriched, (a, b) => b.refunded_units / b.units - a.refunded_units / a.units,
        (p) => p.refunded_units > 0 && p.units >= 3),
      slow_moving: slow,
    }

    // ── areas ──
    const prevAreaMap = new Map(areasPrev.map((a) => [a.pincode, a]))
    const areaRows = areasCur.map((a) => {
      const p = prevAreaMap.get(a.pincode)
      return {
        ...a,
        aov: a.orders > 0 ? round2(a.collected / a.orders) : 0,
        delivery_cost_per_order: a.orders > 0 ? round2(a.delivery_cost / a.orders) : 0,
        revenue_change_pct: p ? metric(a.net_revenue, p.net_revenue).change_pct : null,
      }
    })
    const topAreaProducts = await s('area_products',
      () => this.repo.topProductsByArea(cur, areaRows.slice(0, 10).map((a) => a.pincode)), [])
    const productsByArea = new Map()
    topAreaProducts.forEach((p) => {
      if (!productsByArea.has(p.pincode)) productsByArea.set(p.pincode, [])
      productsByArea.get(p.pincode).push({ product_id: p.product_id, name: p.name, image: p.image, units: p.units })
    })
    const areas = areaRows.slice(0, 15).map((a) => ({ ...a, top_products: productsByArea.get(a.pincode) || [] }))

    // ── customers ──
    const newCust = customers.filter((c) => c.is_new)
    const repeatCust = customers.filter((c) => !c.is_new)
    const returningMulti = customers.filter((c) => c.lifetime_orders >= 2)
    const ltvAvailable = customers.length >= 20
    const customerSection = {
      active: customers.length,
      new: newCust.length,
      repeat: repeatCust.length,
      repeat_purchase_rate: safeDiv(returningMulti.length, customers.length),
      avg_frequency: safeDiv(customers.reduce((sum, c) => sum + c.orders, 0), customers.length),
      avg_lifetime_value: ltvAvailable
        ? round2(customers.reduce((sum, c) => sum + (c.lifetime_value || 0), 0) / customers.length) : null,
      ltv_note: ltvAvailable ? null : 'Needs at least 20 active customers in the period',
      top: [...customers].sort((a, b) => b.spend - a.spend).slice(0, TOP_N).map((c) => ({
        customer_id: c.customer_id, name: c.name, phone: c.phone, orders: c.orders,
        spend: round2(c.spend), lifetime_orders: c.lifetime_orders,
      })),
      lapsed,
    }

    // ── vendors ──
    const marginsByVendor = new Map()
    vendorMargins.forEach((r) => {
      if (!marginsByVendor.has(r.vendor_id)) marginsByVendor.set(r.vendor_id, [])
      marginsByVendor.get(r.vendor_id).push(r)
    })
    const vendors = vendorBuys.map((v) => {
      const skus = marginsByVendor.get(v.vendor_id) || []
      const costed = skus.filter((k) => k.costed_revenue > 0 && k.cogs != null)
        .map((k) => ({ name: k.name, image: k.image ?? null, product_id: k.product_id, profit: round2(k.costed_revenue - k.cogs),
          margin: (k.costed_revenue - k.cogs) / k.costed_revenue }))
        .sort((a, b) => b.profit - a.profit)
      const cr = skus.reduce((sum, k) => sum + (k.costed_revenue || 0), 0)
      const cg = skus.reduce((sum, k) => sum + (k.cogs || 0), 0)
      return {
        vendor_id: v.vendor_id, name: v.name, supply_orders: v.supply_orders,
        purchases: round2(v.purchases),
        rejected_value: round2(v.rejected_value),
        rejection_rate: safeDiv(v.rejected_value, v.received_value),
        revenue_generated: round2(skus.reduce((sum, k) => sum + (k.revenue || 0), 0)),
        margin_generated: cr > 0 ? round2(cr - cg) : null,
        margin_pct: cr > 0 ? (cr - cg) / cr : null,
        best_sku: costed[0] || null,
        worst_sku: costed.length > 1 ? costed[costed.length - 1] : null,
      }
    })

    // ── order health ──
    const healthNow = healthCur ? groupStatuses(healthCur.statuses, healthCur.returnRequests) : null
    const healthPrev = healthPrevRaw ? groupStatuses(healthPrevRaw.statuses, healthPrevRaw.returnRequests) : null
    const orderHealth = healthNow && {
      current: healthNow,
      previous: healthPrev,
      changes: Object.fromEntries(Object.keys(healthNow).map((k) =>
        [k, healthPrev ? metric(healthNow[k], healthPrev[k]).change_pct : null])),
      daily: healthCur.daily,
    }

    // ── delivery ──
    const deliveryTotalCost = delivery ? (delivery.rider_cost || 0) + (delivery.shiprocket_cost || 0) : 0
    const deliverySection = delivery && {
      delivered: metric(delivery.delivered, deliveryPrev?.delivered ?? null),
      avg_cost_per_order: safeDiv(deliveryTotalCost, delivery.delivered),
      rider_cost: round2(delivery.rider_cost),
      shiprocket_cost: round2(delivery.shiprocket_cost),
      avg_minutes: delivery.avg_minutes,
      avg_minutes_previous: deliveryPrev?.avg_minutes ?? null,
      on_time_rate: safeDiv(delivery.on_time, delivery.timed),
      on_time_sample: delivery.timed,
      failed: metric(delivery.failed, deliveryPrev?.failed ?? null),
    }

    // ── leakage & opportunity ──
    const deliveryCostPerOrder = fin ? safeDiv(fin.rider_cost + fin.shiprocket_cost, fin.orders) : null
    const insights = buildInsights({
      netRevenue: fin?.net_revenue || 0,
      products: prodCur, prevProducts: prodPrev,
      areas: areaRows, prevAreas: areasPrev, deliveryCostPerOrder,
      vendors, vendorPriceGaps: priceGaps, discountHealth: discount,
      lapsed, slowMovers: slow, costCoverage: fin?.cost_coverage ?? null,
      ordersCount: fin?.orders || 0,
    })

    return {
      range: {
        key: query.range || '7d', label: range.label, days: range.days,
        from: range.from.toISOString(), to: range.to.toISOString(),
        previous_from: range.previousFrom.toISOString(), previous_to: range.previousTo.toISOString(),
        bucket,
      },
      filters: {
        shop_id: shopId, pincode, shop_locked: Boolean(scopedShopId),
        // Stock and lapsed-customer figures are per store, not per delivery area.
        store_wide_hidden: Boolean(pincode),
      },
      options: { shops: scopedShopId ? shops.filter((x) => x.id === scopedShopId) : shops, pincodes },
      kpis,
      series,
      cost_breakdown: costBreakdown,
      order_health: orderHealth,
      products,
      areas,
      customers: customerSection,
      vendors,
      delivery: deliverySection,
      insights,
      section_errors: errors,
      generated_at: new Date().toISOString(),
    }
  }
}
