import { round2 } from './overview.range.js'

/**
 * Profit Leakage & Opportunity detector.
 *
 * Pure: takes already-aggregated section data and returns a ranked list of
 * findings, each with an estimated ₹ impact over the selected period. Every
 * rule and threshold lives in THRESHOLDS so the numbers are explainable and
 * easy to retune. Nothing here guesses at data that was not measured — when a
 * rule needs cost prices (margins, loss-making orders) and they are missing,
 * it is skipped and a data-quality finding says why.
 */

export const THRESHOLDS = Object.freeze({
  TARGET_MARGIN: 0.2,          // margin we compare low-margin sellers against
  LOW_MARGIN: 0.15,            // "very low" margin on a strong seller
  TOP_SELLER_RANK: 10,         // a "strong seller" is top-N by revenue
  MIN_COSTED_REVENUE: 500,     // ignore tiny samples
  RETURN_RATE: 0.08,           // refunded units / sold units
  RETURN_MIN_UNITS: 5,
  AREA_MIN_ORDERS: 5,
  AREA_COST_MULTIPLE: 1.25,    // area delivery cost per order vs platform average
  VENDOR_REJECTION_RATE: 0.08,
  VENDOR_PRICE_PREMIUM: 1.1,   // paying 10%+ more than other vendors
  HEAVY_DISCOUNT_MIN_ORDERS: 3,
  GROWTH_RATE: 0.3,            // +30% vs previous period
  GROWTH_MIN_UNITS: 3,
  REPEAT_BUYERS: 3,
  COST_COVERAGE_WARN: 0.8,
})

const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`
const pct = (n, digits = 0) => `${(Number(n) * 100).toFixed(digits)}%`

function severityFor(impact, netRevenue) {
  const v = Number(impact) || 0
  if (netRevenue > 0) {
    const share = v / netRevenue
    if (share >= 0.03) return 'high'
    if (share >= 0.01) return 'medium'
    return 'low'
  }
  if (v >= 5000) return 'high'
  if (v >= 1000) return 'medium'
  return 'low'
}

const marginOf = (p) =>
  p.costed_revenue > 0 && p.cogs != null ? (p.costed_revenue - p.cogs) / p.costed_revenue : null

/** Join current + previous product stats for growth maths. */
export function withGrowth(products, prevProducts) {
  const prevById = new Map(prevProducts.map((p) => [p.product_id, p]))
  return products.map((p) => {
    const prev = prevById.get(p.product_id)
    const growth = prev && prev.revenue > 0 ? (p.revenue - prev.revenue) / prev.revenue : null
    return { ...p, prev_revenue: prev?.revenue ?? 0, prev_units: prev?.units ?? 0, growth, margin: marginOf(p) }
  })
}

export function buildInsights(ctx) {
  const {
    netRevenue = 0, products = [], prevProducts = [], areas = [], prevAreas = [],
    deliveryCostPerOrder = null, vendors = [], vendorPriceGaps = [], discountHealth = null,
    lapsed = null, slowMovers = [], costCoverage = null, ordersCount = 0,
  } = ctx
  const T = THRESHOLDS
  const out = []
  const push = (i) => out.push({ ...i, impact_inr: i.impact_inr == null ? null : round2(i.impact_inr) })

  const enriched = withGrowth(products, prevProducts)
  const byRevenue = [...enriched].sort((a, b) => b.revenue - a.revenue)

  // 1 ── strong sellers with thin margin
  byRevenue.slice(0, T.TOP_SELLER_RANK).forEach((p) => {
    if (p.margin == null || p.costed_revenue < T.MIN_COSTED_REVENUE) return
    if (p.margin >= T.LOW_MARGIN) return
    const impact = (T.TARGET_MARGIN - p.margin) * p.costed_revenue
    push({
      id: `low-margin:${p.product_id}`, kind: 'leakage', category: 'product',
      severity: severityFor(impact, netRevenue),
      title: `${p.name} sells well but earns only ${pct(p.margin, 1)} margin`,
      detail: `${inr(p.revenue)} revenue at ${pct(p.margin, 1)} margin. Reaching a ${pct(T.TARGET_MARGIN)} margin would add about ${inr(impact)}. Review its selling price or vendor cost.`,
      impact_inr: impact, entity: { type: 'product', id: p.product_id, name: p.name, image: p.image ?? null }, link: '/catalogue',
    })
  })

  // 2 ── unusually high refunds / returns
  enriched.forEach((p) => {
    if (p.units < T.RETURN_MIN_UNITS || !(p.refunded_units > 0)) return
    const rate = p.refunded_units / p.units
    if (rate < T.RETURN_RATE) return
    push({
      id: `returns:${p.product_id}`, kind: 'leakage', category: 'product',
      severity: severityFor(p.refunded_value, netRevenue),
      title: `${p.name} has a ${pct(rate, 1)} refund rate`,
      detail: `${p.refunded_units} of ${p.units} units refunded (${inr(p.refunded_value)} refunded). Check quality, packing and the vendor batch.`,
      impact_inr: p.refunded_value, entity: { type: 'product', id: p.product_id, name: p.name, image: p.image ?? null }, link: '/returns',
    })
  })

  // 3 ── areas whose delivery cost is well above average
  if (deliveryCostPerOrder > 0) {
    areas.forEach((a) => {
      if (a.orders < T.AREA_MIN_ORDERS || !(a.delivery_cost > 0)) return
      const cpo = a.delivery_cost / a.orders
      if (cpo < deliveryCostPerOrder * T.AREA_COST_MULTIPLE) return
      const impact = (cpo - deliveryCostPerOrder) * a.orders
      push({
        id: `area-cost:${a.pincode}`, kind: 'leakage', category: 'area',
        severity: severityFor(impact, netRevenue),
        title: `Pincode ${a.pincode}: delivery costs ${pct(cpo / deliveryCostPerOrder - 1)} more than average`,
        detail: `${inr(a.net_revenue)} net revenue from ${a.orders} orders, but ${inr(cpo)} delivery cost per order vs ${inr(deliveryCostPerOrder)} average. Consider a delivery-fee tier, a minimum basket or batching here.`,
        impact_inr: impact, entity: { type: 'area', id: a.pincode, name: a.pincode }, link: '/coverage-map',
      })
    })
  }

  // 4 ── vendors hurting margin: rejections and price premium
  vendors.forEach((v) => {
    if (!(v.received_value > 0) || !(v.rejected_value > 0)) return
    const rate = v.rejected_value / v.received_value
    if (rate < T.VENDOR_REJECTION_RATE) return
    push({
      id: `vendor-reject:${v.vendor_id}`, kind: 'leakage', category: 'vendor',
      severity: severityFor(v.rejected_value, netRevenue),
      title: `${v.name}: ${pct(rate, 1)} of delivered stock was rejected`,
      detail: `${inr(v.rejected_value)} of goods rejected at receiving out of ${inr(v.received_value)} received.`,
      impact_inr: v.rejected_value, entity: { type: 'vendor', id: v.vendor_id, name: v.name }, link: '/vendors',
    })
  })
  vendorPriceGaps.forEach((g) => {
    if (!(g.peer_price > 0) || g.unit_price < g.peer_price * T.VENDOR_PRICE_PREMIUM) return
    const impact = (g.unit_price - g.peer_price) * g.qty
    push({
      id: `vendor-price:${g.vendor_id}:${g.product_id}`, kind: 'leakage', category: 'vendor',
      severity: severityFor(impact, netRevenue),
      title: `${g.vendor_name} charges ${pct(g.unit_price / g.peer_price - 1)} more than other vendors for ${g.name}`,
      detail: `${inr(g.unit_price)} per unit vs ${inr(g.peer_price)} elsewhere (last 90 days, ${Math.round(g.qty)} units). Re-quote or shift volume.`,
      impact_inr: impact, entity: { type: 'vendor', id: g.vendor_id, name: g.vendor_name }, link: '/procurement',
    })
  })

  // 5 ── discounts
  if (discountHealth) {
    if (discountHealth.loss_orders > 0) {
      push({
        id: 'discount-loss', kind: 'leakage', category: 'discount',
        severity: severityFor(discountHealth.loss_amount, netRevenue),
        title: `${discountHealth.loss_orders} order${discountHealth.loss_orders > 1 ? 's' : ''} lost money after discounts and delivery cost`,
        detail: `These orders had ${inr(discountHealth.loss_discount)} in discounts and ended ${inr(discountHealth.loss_amount)} below break-even. Tighten coupon rules or minimum basket.`,
        impact_inr: discountHealth.loss_amount, entity: null, link: '/orders',
      })
    }
    if (discountHealth.heavy_orders >= T.HEAVY_DISCOUNT_MIN_ORDERS) {
      push({
        id: 'discount-heavy', kind: 'leakage', category: 'discount',
        severity: severityFor(discountHealth.heavy_discount, netRevenue),
        title: `${discountHealth.heavy_orders} orders used discounts of 25% or more`,
        detail: `${inr(discountHealth.heavy_discount)} given away on heavily discounted baskets. Check whether these customers would have ordered anyway.`,
        impact_inr: discountHealth.heavy_discount, entity: null, link: '/marketing',
      })
    }
  }

  // 6 ── stock that is not moving
  slowMovers.slice(0, 2).forEach((s) => {
    if (!(s.stock_value > 0)) return
    push({
      id: `slow:${s.product_id}`, kind: 'leakage', category: 'inventory',
      severity: severityFor(s.stock_value * 0.5, netRevenue),
      title: `${s.name}: ${s.stock} in stock, only ${Math.round(s.units_sold)} sold`,
      detail: `About ${inr(s.stock_value)} of stock is tied up and barely selling. Fresh meat expires — consider a promotion or smaller purchases.`,
      impact_inr: s.stock_value, entity: { type: 'product', id: s.product_id, name: s.name, image: s.image ?? null }, link: '/inventory',
    })
  })

  // 7 ── lapsed regulars
  if (lapsed && lapsed.total > 0) {
    push({
      id: 'lapsed-customers', kind: 'leakage', category: 'customer',
      severity: severityFor(lapsed.monthly_value, netRevenue),
      title: `${lapsed.total} regular customer${lapsed.total > 1 ? 's' : ''} stopped ordering`,
      detail: `They ordered 3+ times and have been quiet for 30–180 days. At their old pace that is about ${inr(lapsed.monthly_value)} a month. A win-back offer is worth testing.`,
      impact_inr: lapsed.monthly_value, entity: null, link: '/retention',
    })
  }

  // ── opportunities ──
  enriched
    .filter((p) => p.growth != null && p.growth >= T.GROWTH_RATE && p.units >= T.GROWTH_MIN_UNITS)
    .sort((a, b) => (b.revenue - b.prev_revenue) - (a.revenue - a.prev_revenue))
    .slice(0, 3)
    .forEach((p) => {
      const gain = p.revenue - p.prev_revenue
      push({
        id: `growth:${p.product_id}`, kind: 'opportunity', category: 'product',
        severity: severityFor(gain, netRevenue),
        title: `${p.name} demand is up ${pct(p.growth)}`,
        detail: `Revenue grew from ${inr(p.prev_revenue)} to ${inr(p.revenue)}. Make sure it stays in stock${p.margin != null ? ` (margin ${pct(p.margin, 1)})` : ''}.`,
        impact_inr: gain, entity: { type: 'product', id: p.product_id, name: p.name, image: p.image ?? null }, link: '/catalogue',
      })
    })

  const prevAreaMap = new Map(prevAreas.map((a) => [a.pincode, a]))
  areas
    .map((a) => {
      const prev = prevAreaMap.get(a.pincode)
      const growth = prev && prev.net_revenue > 0 ? (a.net_revenue - prev.net_revenue) / prev.net_revenue : null
      return { ...a, growth, gain: prev ? a.net_revenue - prev.net_revenue : 0 }
    })
    .filter((a) => a.growth != null && a.growth >= T.GROWTH_RATE && a.orders >= T.AREA_MIN_ORDERS)
    .sort((a, b) => b.gain - a.gain)
    .slice(0, 2)
    .forEach((a) => {
      push({
        id: `area-growth:${a.pincode}`, kind: 'opportunity', category: 'area',
        severity: severityFor(a.gain, netRevenue),
        title: `Pincode ${a.pincode} is growing fast (+${pct(a.growth)})`,
        detail: `${a.orders} orders and ${inr(a.net_revenue)} net revenue, up ${inr(a.gain)}. A good place to push offers or add rider capacity.`,
        impact_inr: a.gain, entity: { type: 'area', id: a.pincode, name: a.pincode }, link: '/coverage-map',
      })
    })

  enriched
    .filter((p) => p.repeat_buyers >= T.REPEAT_BUYERS)
    .sort((a, b) => b.repeat_revenue - a.repeat_revenue)
    .slice(0, 2)
    .forEach((p) => {
      push({
        id: `repeat:${p.product_id}`, kind: 'opportunity', category: 'product',
        severity: severityFor(p.repeat_revenue, netRevenue),
        title: `${p.repeat_buyers} customers keep re-buying ${p.name}`,
        detail: `${inr(p.repeat_revenue)} came from customers who bought it more than once. Candidates for a subscription or bundle.`,
        impact_inr: p.repeat_revenue, entity: { type: 'product', id: p.product_id, name: p.name, image: p.image ?? null }, link: '/catalogue',
      })
    })

  // ── data quality ──
  if (ordersCount > 0 && costCoverage != null && costCoverage < T.COST_COVERAGE_WARN) {
    const uncosted = [...enriched]
      .filter((p) => p.revenue - (p.costed_revenue || 0) > 0)
      .sort((a, b) => (b.revenue - (b.costed_revenue || 0)) - (a.revenue - (a.costed_revenue || 0)))
      .slice(0, 3)
      .map((p) => p.name)
    push({
      id: 'data-cost-coverage', kind: 'data', category: 'data', severity: 'info',
      title: `Profit is calculated on only ${pct(costCoverage)} of orders`,
      detail: `Orders with any item missing a cost price are left out of profit figures so they are never guessed.${uncosted.length ? ` Biggest gaps: ${uncosted.join(', ')}.` : ''} Set cost prices in Products → Shop Products.`,
      impact_inr: null, entity: null, link: '/catalogue',
    })
  }
  push({
    id: 'data-untracked-costs', kind: 'data', category: 'data', severity: 'info',
    title: 'Warehouse handling and inbound freight are not tracked yet',
    detail: 'Net profit is before warehouse packing labour and vendor-to-warehouse logistics because the system has no record of them. It is therefore a contribution margin.',
    impact_inr: null, entity: null, link: null,
  })

  const sevRank = { high: 0, medium: 1, low: 2, info: 3 }
  const kindRank = { leakage: 0, opportunity: 1, data: 2 }
  out.sort((a, b) =>
    kindRank[a.kind] - kindRank[b.kind] ||
    sevRank[a.severity] - sevRank[b.severity] ||
    (b.impact_inr ?? 0) - (a.impact_inr ?? 0))

  const leakage = out.filter((i) => i.kind === 'leakage')
  return {
    items: out,
    investigate_today: leakage.slice(0, 5),
    totals: {
      leakage_inr: round2(leakage.reduce((s, i) => s + (i.impact_inr || 0), 0)),
      opportunity_inr: round2(out.filter((i) => i.kind === 'opportunity').reduce((s, i) => s + (i.impact_inr || 0), 0)),
      leakage_count: leakage.length,
      opportunity_count: out.filter((i) => i.kind === 'opportunity').length,
    },
  }
}
