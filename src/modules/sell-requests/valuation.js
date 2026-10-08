/**
 * Sell-request valuation — pure functions, no I/O.
 * The server is the only authority on a quote; clients only send the QA answers.
 *
 * @module modules/sell-requests/valuation
 */

export const SCRATCHES = Object.freeze(['NONE', 'MINOR', 'MAJOR'])

/** Deduction rules (percent of base). Overridable per-key from `sell_settings.rules`. */
export const DEFAULT_RULES = Object.freeze({
  notPoweringOn: 55,
  ageFreeMonths: 6,
  agePctPerMonth: 0.9,
  ageMaxPct: 30,
  minorScratches: 5,
  majorScratches: 14,
  bodyDents: 8,
  screenReplaced: 10,
  skinReplaced: 4,
  batteryHealthFloor: 85,
  batteryPctPerPoint: 0.5,
  noBill: 4,
  noBox: 2,
  noCharger: 3,
  // condition bands: total deduction % at or below → grade
  excellentMaxPct: 8,
  goodMaxPct: 22,
  fairMaxPct: 40,
})

export class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ValidationError'
  }
}

const bool = (v, name) => {
  if (typeof v !== 'boolean') throw new ValidationError(`${name} must be true or false`)
  return v
}

/** Validate + normalise the customer's answers. Throws ValidationError. */
export function parseQa(raw) {
  if (!raw || typeof raw !== 'object') throw new ValidationError('Condition answers are required')
  const ageMonths = Number(raw.ageMonths)
  if (!Number.isInteger(ageMonths) || ageMonths < 0 || ageMonths > 120) throw new ValidationError('Device age must be 0–120 months')
  const batteryHealth = Number(raw.batteryHealth)
  if (!Number.isInteger(batteryHealth) || batteryHealth < 30 || batteryHealth > 100) throw new ValidationError('Battery health must be 30–100')
  if (!SCRATCHES.includes(raw.screenScratches)) throw new ValidationError('Screen scratches must be NONE, MINOR or MAJOR')
  return {
    ageMonths,
    screenScratches: raw.screenScratches,
    bodyDents: bool(raw.bodyDents, 'bodyDents'),
    screenReplaced: bool(raw.screenReplaced, 'screenReplaced'),
    skinReplaced: bool(raw.skinReplaced, 'skinReplaced'),
    billAvailable: bool(raw.billAvailable, 'billAvailable'),
    boxAvailable: bool(raw.boxAvailable, 'boxAvailable'),
    chargerAvailable: bool(raw.chargerAvailable, 'chargerAvailable'),
    batteryHealth,
    powersOn: bool(raw.powersOn, 'powersOn'),
  }
}

/** Base value of a variant: each step below the top variant loses `stepPct`. */
export function variantBase(basePrice, variants, variant, stepPct = 8) {
  const idx = variants.indexOf(variant)
  if (idx < 0) throw new ValidationError('Unknown variant for this model')
  return Math.round(Number(basePrice) * (1 - ((variants.length - 1 - idx) * stepPct) / 100))
}

/**
 * @returns {{ value:number, condition:'EXCELLENT'|'GOOD'|'FAIR'|'POOR', totalPct:number, deductions:Array<{label:string,pct:number}> }}
 */
export function valuate(base, qa, overrides = {}, maxTotalPct = 85) {
  const r = { ...DEFAULT_RULES, ...overrides }
  const d = []
  if (!qa.powersOn) d.push({ label: 'Device does not power on', pct: r.notPoweringOn })
  if (qa.ageMonths > r.ageFreeMonths) {
    d.push({ label: `Age ${qa.ageMonths} months`, pct: Math.min(r.ageMaxPct, Math.round((qa.ageMonths - r.ageFreeMonths) * r.agePctPerMonth)) })
  }
  if (qa.screenScratches === 'MINOR') d.push({ label: 'Minor screen scratches', pct: r.minorScratches })
  if (qa.screenScratches === 'MAJOR') d.push({ label: 'Major screen scratches', pct: r.majorScratches })
  if (qa.bodyDents) d.push({ label: 'Body dents / damage', pct: r.bodyDents })
  if (qa.screenReplaced) d.push({ label: 'Screen replaced', pct: r.screenReplaced })
  if (qa.skinReplaced) d.push({ label: 'Skin / back panel replaced', pct: r.skinReplaced })
  if (qa.batteryHealth < r.batteryHealthFloor) {
    d.push({ label: `Battery health ${qa.batteryHealth}%`, pct: Math.round((r.batteryHealthFloor - qa.batteryHealth) * r.batteryPctPerPoint) })
  }
  if (!qa.billAvailable) d.push({ label: 'No bill', pct: r.noBill })
  if (!qa.boxAvailable) d.push({ label: 'No box', pct: r.noBox })
  if (!qa.chargerAvailable) d.push({ label: 'No charger', pct: r.noCharger })

  const deductions = d.filter((x) => x.pct > 0)
  const totalPct = Math.min(maxTotalPct, deductions.reduce((n, x) => n + x.pct, 0))
  const value = Math.round((Number(base) * (1 - totalPct / 100)) / 100) * 100
  const condition = totalPct <= r.excellentMaxPct ? 'EXCELLENT' : totalPct <= r.goodMaxPct ? 'GOOD' : totalPct <= r.fairMaxPct ? 'FAIR' : 'POOR'
  return { value, condition, totalPct, deductions }
}

/** Luhn checksum — an IMEI is 15 digits. */
export function isValidImei(v) {
  if (!/^\d{15}$/.test(String(v))) return false
  const s = String(v)
  let sum = 0
  for (let i = 0; i < 15; i++) {
    let n = Number(s[14 - i])
    if (i % 2 === 1) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
  }
  return sum % 10 === 0
}
