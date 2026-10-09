/**
 * Commission engine — pure functions, no I/O.
 *
 * Selling Price → Commission → Platform Charge → Tax (on platform fees)
 *   → Vendor Net Amount
 *
 * Rule resolution per item: PRODUCT > CATEGORY > VENDOR > GLOBAL; inside the
 * same scope a channel-specific rule (B2C / B2B) beats an ALL rule.
 *
 * @module modules/commission/commission.engine
 */

const SCOPE_RANK = { PRODUCT: 4, CATEGORY: 3, VENDOR: 2, GLOBAL: 1 }

const round2 = (n) => Number(Number(n || 0).toFixed(2))

/**
 * Pick the winning rule for one item.
 * @param {Array} rules active rules (camelCase or snake_case rows)
 * @param {{vendorId?:string, categoryId?:string, productId?:string, channel:'B2C'|'B2B'}} ctx
 */
export function resolveRule(rules, ctx) {
  const candidates = (rules || []).filter((r) => {
    if (r.is_active === false) return false
    if (r.channel !== 'ALL' && r.channel !== ctx.channel) return false
    switch (r.scope) {
      case 'PRODUCT': return !!ctx.productId && r.product_id === ctx.productId
      case 'CATEGORY': return !!ctx.categoryId && r.category_id === ctx.categoryId
      case 'VENDOR': return !!ctx.vendorId && r.vendor_id === ctx.vendorId
      case 'GLOBAL': return true
      default: return false
    }
  })
  candidates.sort((a, b) => {
    const s = SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope]
    if (s !== 0) return s
    // channel-specific beats ALL
    return (b.channel === ctx.channel ? 1 : 0) - (a.channel === ctx.channel ? 1 : 0)
  })
  return candidates[0] || null
}

/**
 * Fees for a single line.
 * @param {number} base amount the fee is charged on (line total after seller discount)
 */
export function feesForAmount(base, rule) {
  if (!rule || base <= 0) {
    return { base: round2(base), commission: 0, platformCharge: 0, tax: 0, ruleId: rule?.id || null }
  }
  const commission = round2((base * Number(rule.commission_pct || 0)) / 100)
  const platformCharge = round2(
    Number(rule.platform_charge_flat || 0) + (base * Number(rule.platform_charge_pct || 0)) / 100
  )
  const tax = round2(((commission + platformCharge) * Number(rule.tax_pct || 0)) / 100)
  return { base: round2(base), commission, platformCharge, tax, ruleId: rule.id || null }
}

/**
 * Fees for a whole seller order. `items` = [{ lineTotal, discountShare?, productId, categoryId }].
 * A flat platform charge is applied once per order (on the highest-ranked
 * rule of the order's first item), never once per line.
 */
export function calculateSellerOrder({ items, rules, vendorId, channel = 'B2C', shippingCharge = 0 }) {
  const lines = []
  let flatApplied = false
  for (const it of items) {
    const base = round2(Number(it.lineTotal) - Number(it.discountShare || 0))
    const rule = resolveRule(rules, {
      vendorId, channel, productId: it.productId, categoryId: it.categoryId,
    })
    let effective = rule
    if (rule && flatApplied && Number(rule.platform_charge_flat) > 0) {
      effective = { ...rule, platform_charge_flat: 0 }
    }
    const fees = feesForAmount(base, effective)
    if (rule && Number(rule.platform_charge_flat) > 0) flatApplied = true
    lines.push({ ...fees, productId: it.productId || null, rate: Number(rule?.commission_pct || 0) })
  }
  const sellingPrice = round2(lines.reduce((s, l) => s + l.base, 0))
  const commission = round2(lines.reduce((s, l) => s + l.commission, 0))
  const platformCharge = round2(lines.reduce((s, l) => s + l.platformCharge, 0))
  const tax = round2(lines.reduce((s, l) => s + l.tax, 0))
  const vendorNet = round2(sellingPrice - commission - platformCharge - tax - Number(shippingCharge || 0))
  return {
    channel,
    sellingPrice,
    commission,
    platformCharge,
    tax,
    shippingCharge: round2(shippingCharge),
    vendorNet,
    effectiveRate: sellingPrice > 0 ? round2((commission / sellingPrice) * 100) : 0,
    lines,
  }
}
