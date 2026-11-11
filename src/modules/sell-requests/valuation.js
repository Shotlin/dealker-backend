/**
 * Sell-request valuation — pure functions, no I/O.
 * The server is the only authority on a quote; clients only send the QA answers.
 *
 * @module modules/sell-requests/valuation
 */

export const SCRATCHES = Object.freeze(['NONE', 'MINOR', 'MAJOR'])

/**
 * Deduction rules (percent of the Grade-A base price). Defaults follow the market buyback matrix
 * (Flipkart Reset / Amazon Exchange / Cashify): screen -10..-45, battery 0/-8/-15, body -7/-22,
 * hardware & biometrics -20..-40, bill + original box +3..+5 bonus. Overridable per-key from `sell_settings.rules`.
 */
export const DEFAULT_RULES = Object.freeze({
  notPoweringOn: 55,
  ageFreeMonths: 120,       // the base price already tracks the model's age, so no extra age cut by default
  agePctPerMonth: 0,
  ageMaxPct: 0,
  minorScratches: 10,       // screen: minor scratches
  majorScratches: 45,       // screen: heavy cracks / dead pixels
  bodyDents: 7,             // body: minor scuffs / dents
  bentFrame: 22,            // body: bent frame / cracked back (inspection: POOR)
  screenReplaced: 10,
  skinReplaced: 4,
  batteryHealthFloor: 85,   // 85%+ full → no cut
  batteryMidFloor: 80,      // 80–84% → batteryMidPct, below 80% (service) → batteryLowPct
  batteryMidPct: 8,
  batteryLowPct: 15,
  noBill: 0,
  noBox: 0,
  noCharger: 2,
  billBoxBonus: 4,          // valid bill + original box: price goes UP by this % (3–5)
  billBoxBonusMinBase: 20000, // ...only for phones whose base price is at least this
  faceIdIssue: 30,          // Face ID / Touch ID / True Tone fault (20–40)
  cameraIssue: 20,          // camera fault
  functionFault: 8,         // any other failed function check at inspection (each)
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
    // Optional (older clients never send them): extra faults from the Exchange "Device Issues" checklist.
    faceIdIssue: raw.faceIdIssue == null ? false : bool(raw.faceIdIssue, 'faceIdIssue'),
    cameraIssue: raw.cameraIssue == null ? false : bool(raw.cameraIssue, 'cameraIssue'),
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
  if (qa.faceIdIssue) d.push({ label: 'Face ID / fingerprint issue', pct: r.faceIdIssue })
  if (qa.cameraIssue) d.push({ label: 'Camera issue', pct: r.cameraIssue })
  if (qa.batteryHealth < r.batteryHealthFloor) {
    d.push({ label: `Battery health ${qa.batteryHealth}%`, pct: qa.batteryHealth >= r.batteryMidFloor ? r.batteryMidPct : r.batteryLowPct })
  }
  if (qa.bentFrame) d.push({ label: 'Bent frame / cracked back', pct: r.bentFrame })
  for (const f of qa.failedFunctions || []) d.push({ label: `${f} not working`, pct: r.functionFault })
  if (!qa.billAvailable) d.push({ label: 'No bill', pct: r.noBill })
  if (!qa.boxAvailable) d.push({ label: 'No box', pct: r.noBox })
  if (!qa.chargerAvailable) d.push({ label: 'No charger', pct: r.noCharger })
  if (qa.billAvailable && qa.boxAvailable && Number(base) >= r.billBoxBonusMinBase) d.push({ label: 'Original bill + box bonus', pct: -r.billBoxBonus })

  const deductions = d.filter((x) => x.pct !== 0)
  const totalPct = Math.min(maxTotalPct, deductions.reduce((n, x) => n + x.pct, 0))
  const value = Math.max(0, Math.round((Number(base) * (1 - totalPct / 100)) / 100) * 100)
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

/**
 * What an inspection found, applied to the customer's declared answers (the inspector is the authority).
 * Returns the answers to re-price with.
 */
export function qaFromInspection(declared, f = {}) {
  const qa = { ...declared, failedFunctions: [] }
  const screen = f.screenCondition
  if (screen) qa.screenScratches = screen === 'FLAWLESS' ? 'NONE' : screen === 'MINOR_SCRATCHES' ? 'MINOR' : 'MAJOR'
  if (f.physicalCondition) {
    qa.bodyDents = f.physicalCondition === 'FAIR'
    qa.bentFrame = f.physicalCondition === 'POOR'
  }
  if (f.batteryHealth != null) qa.batteryHealth = Math.max(30, Math.min(100, Number(f.batteryHealth)))
  for (const [k, ok] of Object.entries(f.functionality || {})) {
    if (ok !== false) continue
    const name = k.replace(/([A-Z])/g, ' $1').trim().toLowerCase()
    if (/face|touch|finger|biometric|truetone|true tone/.test(name)) qa.faceIdIssue = true
    else if (/camera/.test(name)) qa.cameraIssue = true
    else if (/power|boot|turn on/.test(name)) qa.powersOn = false
    else qa.failedFunctions.push(name.replace(/^./, (c) => c.toUpperCase()))
  }
  return qa
}
