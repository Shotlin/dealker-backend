/**
 * Automatic QC engine — pure functions, no I/O.
 *
 * Every enabled rule returns PASS / FAIL / SKIP (SKIP = not applicable, e.g.
 * IMEI on a non-phone). Decision:
 *   any required rule FAILS            → QC_FAILED
 *   weighted score >= passThreshold    → QC_PASSED
 *   otherwise                          → QC_RECHECK
 *
 * @module modules/qc/qc.engine
 */

const USED = ['USED_LIKE_NEW', 'USED_GOOD', 'USED_FAIR']

/** Luhn checksum for a 15-digit IMEI. */
export function isValidImei(value) {
  const s = String(value || '').replace(/[\s-]/g, '')
  if (!/^\d{15}$/.test(s)) return false
  let sum = 0
  for (let i = 0; i < 15; i++) {
    let d = Number(s[i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return sum % 10 === 0
}

const clean = (v) => String(v || '').replace(/[\s-]/g, '').toLowerCase()
const pass = (detail) => ({ status: 'PASS', detail })
const fail = (detail) => ({ status: 'FAIL', detail })
const skip = (detail) => ({ status: 'SKIP', detail })

const CHECKS = {
  IMEI(ctx, params) {
    const words = (params.categoryKeywords || []).map((w) => String(w).toLowerCase())
    const cat = String(ctx.listing.categoryName || '').toLowerCase()
    if (!words.some((w) => cat.includes(w))) return skip('Not a phone or tablet category')
    if (!ctx.listing.imei) return fail('IMEI is missing')
    if (!isValidImei(ctx.listing.imei)) return fail('IMEI is not a valid 15-digit number')
    const mismatch = ctx.invoices.find(
      (i) => i.status !== 'REJECTED' && i.imei_serial && clean(i.imei_serial) !== clean(ctx.listing.imei)
        && isValidImei(i.imei_serial)
    )
    if (mismatch) return fail('IMEI does not match the invoice')
    return pass('Valid IMEI')
  },

  IMAGES(ctx, params) {
    const min = Number(params.minImages ?? 3)
    const n = Number(ctx.listing.imageCount || 0)
    return n >= min ? pass(`${n} photos`) : fail(`${n} photo${n === 1 ? '' : 's'}, needs at least ${min}`)
  },

  INVOICE(ctx, params) {
    if (params.skipForNew && ctx.listing.condition === 'NEW') return skip('New item')
    const live = ctx.invoices.filter((i) => i.status !== 'REJECTED')
    if (!live.length) return fail('No invoice uploaded')
    if (params.requireVerified !== false && !live.some((i) => i.status === 'VERIFIED')) {
      return fail('Invoice uploaded but not verified yet')
    }
    return pass(live.some((i) => i.status === 'VERIFIED') ? 'Invoice verified' : 'Invoice uploaded')
  },

  CONDITION(ctx, params) {
    const c = ctx.listing.condition
    if (c === 'NEW') return skip('New item')
    const min = Number(params.minNoteLength ?? 10)
    const len = String(ctx.listing.conditionNotes || '').trim().length
    if (len < min) return fail(`Condition notes too short (${len}/${min} characters)`)
    if (USED.includes(c) && ctx.listing.batteryHealth != null && Number(ctx.listing.batteryHealth) < 50) {
      return fail(`Battery health ${ctx.listing.batteryHealth}% is below 50%`)
    }
    return pass('Condition described')
  },

  PRICE_RANGE(ctx, params) {
    const { price, mrp } = ctx.listing
    if (!(Number(mrp) > 0)) return skip('No MRP to compare against')
    const pct = (Number(price) / Number(mrp)) * 100
    const lo = Number(params.minPctOfMrp ?? 30)
    const hi = Number(params.maxPctOfMrp ?? 100)
    const r = Math.round(pct * 10) / 10
    if (pct < lo) return fail(`Price is ${r}% of MRP, below the ${lo}% floor`)
    if (pct > hi) return fail(`Price is ${r}% of MRP, above the ${hi}% ceiling`)
    return pass(`Price is ${r}% of MRP`)
  },

  REQUIRED_DOCUMENTS(ctx, params) {
    const missing = []
    if (params.requireInvoice !== false && !ctx.invoices.some((i) => i.status !== 'REJECTED')) missing.push('invoice')
    if (params.requireWarranty !== false && !String(ctx.listing.warrantyInfo || '').trim()) missing.push('warranty details')
    return missing.length ? fail(`Missing: ${missing.join(', ')}`) : pass('All required documents present')
  },

  SERIAL_NUMBER(ctx, params) {
    const min = Number(params.minLength ?? 4)
    return String(ctx.listing.serialNumber || '').trim().length >= min
      ? pass('Serial number present')
      : fail('Serial number is missing')
  },

  SELLER_INFO(ctx) {
    const v = ctx.vendor
    if (!v) return skip('Listed by Dealker')
    if (['VERIFIED', 'ACTIVE'].includes(v.status)) return pass(`Seller is ${v.status.toLowerCase()}`)
    return fail(`Seller status is ${String(v.status || 'unknown').toLowerCase().replace(/_/g, ' ')}`)
  },
}

export const RULE_KEYS = Object.keys(CHECKS)

/**
 * @param {{listing:object, invoices:object[], vendor:object|null}} ctx
 * @param {Array<{key:string,label:string,enabled:boolean,required:boolean,weight:number,params:object}>} rules
 * @param {{passThreshold:number}} settings
 */
export function evaluateQc(ctx, rules, settings) {
  const results = []
  for (const rule of rules) {
    if (!rule.enabled || !CHECKS[rule.key]) continue
    const out = CHECKS[rule.key](ctx, rule.params || {})
    results.push({
      key: rule.key, label: rule.label, required: !!rule.required,
      weight: Number(rule.weight), status: out.status, detail: out.detail,
    })
  }
  const applicable = results.filter((r) => r.status !== 'SKIP')
  const total = applicable.reduce((s, r) => s + r.weight, 0)
  const earned = applicable.filter((r) => r.status === 'PASS').reduce((s, r) => s + r.weight, 0)
  const score = total > 0 ? Math.round((earned / total) * 100) : 100
  const requiredFailed = results.filter((r) => r.required && r.status === 'FAIL')

  let status
  if (requiredFailed.length) status = 'QC_FAILED'
  else if (score >= Number(settings.passThreshold ?? 80)) status = 'QC_PASSED'
  else status = 'QC_RECHECK'

  const failedLabels = results.filter((r) => r.status === 'FAIL').map((r) => `${r.label}: ${r.detail}`)
  return { status, score, results, requiredFailed: requiredFailed.map((r) => r.key), summary: failedLabels.join('; ') }
}
