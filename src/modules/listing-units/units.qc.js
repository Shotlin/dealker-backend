/**
 * Per-device QC: one structured report per physical unit.
 * Validation, the score and the customer/vendor-facing report are all produced here so every app shows the same thing.
 *
 * qc = {
 *   battery: { health: 40-100 },
 *   screen: { lcd: WORKING|MINOR_DEFECT|DEFECTIVE, condition: FLAWLESS|MINOR_SCRATCHES|VISIBLE_SCRATCHES|CRACKED },
 *   physical: { body: LIKE_NEW|GOOD|FAIR|DENTED, back: LIKE_NEW|GOOD|FAIR|DENTED, frame: STRAIGHT|SCUFFED|BENT },
 *   functional: { <key>: PASS|FAIL|NA, … every key below },
 *   notes?: string
 * }
 */
export const FUNCTIONS = [
  ['touch', 'Touch', 'Touch Working'],
  ['wifi', 'Wi-Fi', 'Wi-Fi Working'],
  ['bluetooth', 'Bluetooth', 'Bluetooth Working'],
  ['gps', 'GPS', 'GPS Working'],
  ['cameras', 'Cameras', 'Cameras Working'],
  ['speaker', 'Speaker', 'Speaker is Working Fine'],
  ['microphone', 'Microphone', 'Microphone Working'],
  ['biometric', 'Face ID / Fingerprint', 'Biometric Working'],
  ['volume_buttons', 'Volume Buttons', 'Volume Button Working'],
  ['power_button', 'Power Button', 'Power Button Working'],
  ['charging_port', 'Charging Port', 'Charging Port Working'],
  ['vibrator', 'Vibrator', 'Vibrator is Working'],
  ['proximity_sensor', 'Proximity Sensor', 'Proximity Sensor Working'],
  ['sim_tray', 'SIM Tray', 'SIM Tray Available'],
  ['audio_jack', 'Audio Jack', 'Audio Jack Working'],
]
const FKEYS = FUNCTIONS.map((f) => f[0])
const LCD = { WORKING: ['LCD Working Fine', 0], MINOR_DEFECT: ['Minor display defect', 5], DEFECTIVE: ['Display defective', 20] }
const SCREEN = { FLAWLESS: ['Flawless, no scratches', 0], MINOR_SCRATCHES: ['Minor scratches', 3], VISIBLE_SCRATCHES: ['Visible scratches', 8], CRACKED: ['Cracked screen', 25] }
const BODY = { LIKE_NEW: ['Like new', 0], GOOD: ['Good, light marks', 2], FAIR: ['Fair, visible wear', 5], DENTED: ['Dents or deep marks', 9] }
const FRAME = { STRAIGHT: ['Straight, no damage', 0], SCUFFED: ['Minor scuffs', 2], BENT: ['Bent frame', 8] }

export class QcError extends Error {}

export function normalizeQc(raw, unitNo = null) {
  const at = unitNo ? `Device ${unitNo}: ` : ''
  const bad = (m) => { throw new QcError(`${at}${m}`) }
  if (!raw || typeof raw !== 'object') bad('QC is required')
  const health = Number(raw.battery?.health)
  if (!Number.isInteger(health) || health < 40 || health > 100) bad('Battery health must be 40 to 100')
  const lcd = raw.screen?.lcd, sc = raw.screen?.condition
  if (!LCD[lcd]) bad('Choose the LCD / display state')
  if (!SCREEN[sc]) bad('Choose the screen condition')
  const body = raw.physical?.body, back = raw.physical?.back, frame = raw.physical?.frame
  if (!BODY[body]) bad('Choose the body condition')
  if (!BODY[back]) bad('Choose the back panel condition')
  if (!FRAME[frame]) bad('Choose the frame condition')
  const functional = {}
  for (const k of FKEYS) {
    const v = raw.functional?.[k]
    if (!['PASS', 'FAIL', 'NA'].includes(v)) bad(`Check ${FUNCTIONS.find((f) => f[0] === k)[1]}`)
    functional[k] = v
  }
  const notes = String(raw.notes || '').trim().slice(0, 300)
  return {
    version: 2, battery: { health }, screen: { lcd, condition: sc }, physical: { body, back, frame }, functional, ...(notes ? { notes } : {}),
  }
}

export function scoreOf(qc) {
  let s = 100
  s -= LCD[qc.screen.lcd][1] + SCREEN[qc.screen.condition][1]
  s -= BODY[qc.physical.body][1] + Math.round(BODY[qc.physical.back][1] / 2) + FRAME[qc.physical.frame][1]
  const h = qc.battery.health
  s -= h < 70 ? 14 : h < 80 ? 8 : 0
  s -= 6 * Object.values(qc.functional).filter((v) => v === 'FAIL').length
  return Math.max(25, Math.min(100, s))
}

export function defectsOf(qc) {
  return (LCD[qc.screen.lcd][1] > 0) + (SCREEN[qc.screen.condition][1] > 0) + (BODY[qc.physical.body][1] > 0) + (BODY[qc.physical.back][1] > 0)
    + (FRAME[qc.physical.frame][1] > 0) + (qc.battery.health < 80) + Object.values(qc.functional).filter((v) => v === 'FAIL').length
}

/** The report the apps render: sections of {label, value, ok} rows (ok null = not applicable). */
export function reportOf(qc) {
  const h = qc.battery.health
  return {
    screen: [
      { label: 'LCD Damage', value: LCD[qc.screen.lcd][0], ok: qc.screen.lcd === 'WORKING' },
      { label: 'Screen Condition', value: SCREEN[qc.screen.condition][0], ok: qc.screen.condition === 'FLAWLESS' },
    ],
    functional: FUNCTIONS.map(([k, label, okText]) => {
      const v = qc.functional[k]
      return { label, value: v === 'PASS' ? okText : v === 'FAIL' ? `${label} not working` : 'Not available on this device', ok: v === 'NA' ? null : v === 'PASS' }
    }),
    battery: [
      { label: 'Battery Health', value: `${h}%`, ok: h >= 80 },
      { label: 'Battery', value: h >= 80 ? 'Battery is good' : 'Battery in service', ok: h >= 80 },
    ],
    physical: [
      { label: 'Body', value: BODY[qc.physical.body][0], ok: qc.physical.body === 'LIKE_NEW' },
      { label: 'Back Panel', value: BODY[qc.physical.back][0], ok: qc.physical.back === 'LIKE_NEW' },
      { label: 'Frame', value: FRAME[qc.physical.frame][0], ok: qc.physical.frame === 'STRAIGHT' },
    ],
    notes: qc.notes || null,
  }
}

/** Compact chips for the "Device N" card. */
export function chipsOf(qc) {
  const fails = Object.values(qc.functional).filter((v) => v === 'FAIL').length
  const h = qc.battery.health
  const physOk = qc.physical.body === 'LIKE_NEW' && qc.physical.back === 'LIKE_NEW' && qc.physical.frame === 'STRAIGHT'
  return [
    { label: 'Battery', value: `${h}%`, ok: h >= 80 },
    { label: 'Screen', value: SCREEN[qc.screen.condition][0].split(',')[0], ok: qc.screen.condition === 'FLAWLESS' && qc.screen.lcd === 'WORKING' },
    { label: 'Physical', value: physOk ? 'Like new' : BODY[qc.physical.body][0].split(',')[0], ok: physOk },
    { label: 'Functions', value: fails ? `${fails} issue${fails > 1 ? 's' : ''}` : 'All working', ok: fails === 0 },
  ]
}
