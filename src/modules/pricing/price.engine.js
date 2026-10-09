/**
 * Price / stock adjustment engine — pure functions, no I/O.
 *
 * Price operations:  PERCENT (±%), FIXED (±₹), SET (absolute ₹),
 *                    DISCOUNT_FROM_MRP (% off MRP).
 * Stock operations:  SET, ADD, SUBTRACT.
 *
 * Every row either gets a new value or a plain-language skip reason.
 *
 * @module modules/pricing/price.engine
 */

export const PRICE_OPERATIONS = ['PERCENT', 'FIXED', 'SET', 'DISCOUNT_FROM_MRP']
export const STOCK_OPERATIONS = ['SET', 'ADD', 'SUBTRACT']
export const ROUNDINGS = ['NONE', 'RUPEE', 'TEN']
export const MAX_PERCENT_SWING = 50

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100

export function applyRounding(value, rounding = 'NONE') {
  if (rounding === 'RUPEE') return Math.round(value)
  if (rounding === 'TEN') return Math.round(value / 10) * 10
  return r2(value)
}

/** Validate operation parameters once, before touching any row. */
export function validatePriceParams(p) {
  if (!PRICE_OPERATIONS.includes(p.operation)) return `operation must be one of ${PRICE_OPERATIONS.join(', ')}`
  if (!ROUNDINGS.includes(p.rounding || 'NONE')) return `rounding must be one of ${ROUNDINGS.join(', ')}`
  const v = Number(p.value)
  if (!Number.isFinite(v)) return 'value must be a number'
  if (p.operation === 'PERCENT') {
    if (v === 0) return 'Percentage cannot be 0'
    if (v <= -100) return 'A reduction of 100% or more would make prices zero'
    if (!p.allowLargeChange && Math.abs(v) > MAX_PERCENT_SWING) {
      return `Changes above ${MAX_PERCENT_SWING}% need “allow large change” to be switched on`
    }
  }
  if (p.operation === 'FIXED' && v === 0) return 'Amount cannot be 0'
  if (p.operation === 'SET' && !(v > 0)) return 'The new price must be greater than 0'
  if (p.operation === 'DISCOUNT_FROM_MRP' && !(v >= 0 && v <= 95)) return 'Discount must be between 0 and 95%'
  return null
}

/**
 * @param {{old:number, mrp:number|null, cost:number|null, field:'sale_price'|'wholesale_price'}} row
 * @returns {{value:number}|{skip:string}}
 */
export function computePrice(row, p) {
  const old = Number(row.old)
  const v = Number(p.value)
  let next
  switch (p.operation) {
    case 'PERCENT': next = old * (1 + v / 100); break
    case 'FIXED': next = old + v; break
    case 'SET': next = v; break
    case 'DISCOUNT_FROM_MRP':
      if (!(Number(row.mrp) > 0)) return { skip: 'No MRP to discount from' }
      next = Number(row.mrp) * (1 - v / 100)
      break
    default: return { skip: 'Unknown operation' }
  }
  next = applyRounding(next, p.rounding)
  if (!(next >= 1)) return { skip: 'New price would be below ₹1' }
  if (next === r2(old)) return { skip: 'Price would not change' }
  if (row.field === 'sale_price' && Number(row.mrp) > 0 && next > Number(row.mrp)) {
    return { skip: `New price ₹${next} would be above the MRP ₹${Number(row.mrp)}` }
  }
  if (!p.allowBelowCost && Number(row.cost) > 0 && next < Number(row.cost)) {
    return { skip: `New price ₹${next} would be below cost ₹${Number(row.cost)}` }
  }
  return { value: next }
}

export function validateStockParams(p) {
  if (!STOCK_OPERATIONS.includes(p.operation)) return `operation must be one of ${STOCK_OPERATIONS.join(', ')}`
  const v = Number(p.value)
  if (!Number.isInteger(v) || v < 0 || v > 100000) return 'value must be a whole number from 0 to 100000'
  if (p.operation !== 'SET' && v === 0) return 'Quantity cannot be 0 for add / subtract'
  return null
}

export function computeStock(row, p) {
  const old = Number(row.old)
  const v = Number(p.value)
  let next
  if (p.operation === 'SET') next = v
  else if (p.operation === 'ADD') next = old + v
  else next = old - v
  if (next < 0) return { skip: `Stock would go below zero (${old} − ${v})` }
  if (row.used && next > 1) return { skip: 'Used items are single-unit listings (max quantity 1)' }
  if (next === old) return { skip: 'Stock would not change' }
  return { value: next }
}

/** Summarise a computed preview for the UI. */
export function summarise(items) {
  const changed = items.filter((i) => i.value !== undefined)
  const skipped = items.filter((i) => i.skip)
  const reasons = {}
  skipped.forEach((s) => { reasons[s.skip.replace(/₹[\d.]+/g, '₹…')] = (reasons[s.skip.replace(/₹[\d.]+/g, '₹…')] || 0) + 1 })
  return { total: items.length, changed: changed.length, skipped: skipped.length, skipReasons: reasons }
}
