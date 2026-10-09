/** Repair configuration: settings, service price list, B2B contract terms. Platform staff only. */
import { query } from '../../config/database.js'
import { GSTIN_RE } from './repairs.engine.js'
import { RepairError, getSettings } from './repairs.service.js'

const num = (v) => (v == null ? null : Number(v))
const CATS = ['SCREEN', 'BATTERY', 'CHARGING', 'WATER_DAMAGE', 'SOFTWARE', 'CAMERA', 'AUDIO', 'BODY', 'BOARD', 'BIOMETRIC', 'DATA', 'OTHER']
const DEVICES = ['ANY', 'Smartphone', 'Tablet', 'Laptop']

const SETTING_FIELDS = {
  enabled: { col: 'enabled', bool: true }, b2cEnabled: { col: 'b2c_enabled', bool: true }, b2bEnabled: { col: 'b2b_enabled', bool: true },
  requireAdvance: { col: 'require_advance', bool: true },
  diagnosticFee: { col: 'diagnostic_fee', min: 0, max: 100000, dec: true },
  advancePct: { col: 'advance_pct', min: 0, max: 100, dec: true },
  taxPct: { col: 'tax_pct', min: 0, max: 40, dec: true },
  platformCommissionPct: { col: 'platform_commission_pct', min: 0, max: 100, dec: true },
  defaultWarrantyDays: { col: 'default_warranty_days', min: 0, max: 730 },
  estimateValidityDays: { col: 'estimate_validity_days', min: 1, max: 60 },
  slaInspectionHours: { col: 'sla_inspection_hours', min: 1, max: 720 },
  slaRepairHours: { col: 'sla_repair_hours', min: 1, max: 2160 },
  maxB2cDevices: { col: 'max_b2c_devices', min: 1, max: 20 },
  maxB2bDevices: { col: 'max_b2b_devices', min: 1, max: 1000 },
  maxImages: { col: 'max_images', min: 0, max: 30 }, maxVideos: { col: 'max_videos', min: 0, max: 5 },
  maxImageMb: { col: 'max_image_mb', min: 1, max: 25 }, maxVideoMb: { col: 'max_video_mb', min: 5, max: 500 },
}

export function serializeSettings(s) {
  const out = {}
  for (const [k, f] of Object.entries(SETTING_FIELDS)) out[k] = f.bool ? s[f.col] : Number(s[f.col])
  return out
}

export const readSettings = async () => serializeSettings(await getSettings())

export async function updateSettings(actor, input = {}) {
  const sets = [], vals = [actor.userId]
  for (const [k, f] of Object.entries(SETTING_FIELDS)) {
    if (input[k] === undefined) continue
    let v = input[k]
    if (f.bool) { if (typeof v !== 'boolean') throw new RepairError('VALIDATION', `${k} must be true or false`, 422) }
    else {
      v = Number(v)
      if (!Number.isFinite(v) || v < f.min || v > f.max || (!f.dec && !Number.isInteger(v))) throw new RepairError('VALIDATION', `${k} must be ${f.dec ? 'a number' : 'a whole number'} from ${f.min} to ${f.max}`, 422)
    }
    vals.push(v); sets.push(`${f.col} = $${vals.length}`)
  }
  if (sets.length) await query(`UPDATE repair_settings SET ${sets.join(', ')}, updated_by = $1, updated_at = NOW() WHERE id = TRUE`, vals)
  return readSettings()
}

// ── service price list ──────────────────────────────────────────────────

const serializeService = (s) => ({ id: s.id, code: s.code, name: s.name, category: s.category, deviceCategory: s.device_category, labourPrice: num(s.labour_price), estHours: s.est_hours, warrantyDays: s.warranty_days, isActive: s.is_active })

export async function listServices({ includeInactive = false } = {}) {
  const { rows } = await query(`SELECT * FROM repair_services ${includeInactive ? '' : 'WHERE is_active'} ORDER BY category, name`)
  return rows.map(serializeService)
}

function cleanService(i, partial) {
  const o = {}
  const has = (k) => i[k] !== undefined
  if (!partial || has('name')) { const n = String(i.name ?? '').trim(); if (n.length < 3 || n.length > 120) throw new RepairError('VALIDATION', 'Name must be 3–120 characters', 422); o.name = n }
  if (!partial || has('category')) { if (!CATS.includes(i.category)) throw new RepairError('VALIDATION', 'Unknown category', 422); o.category = i.category }
  if (has('deviceCategory')) { if (!DEVICES.includes(i.deviceCategory)) throw new RepairError('VALIDATION', 'Unknown device category', 422); o.device_category = i.deviceCategory }
  if (!partial || has('labourPrice')) { const p = Number(i.labourPrice); if (!Number.isFinite(p) || p < 0 || p > 1_000_000) throw new RepairError('VALIDATION', 'Labour price must be 0–10,00,000', 422); o.labour_price = p }
  if (has('estHours')) { const h = Number(i.estHours); if (!Number.isInteger(h) || h < 1 || h > 720) throw new RepairError('VALIDATION', 'Estimated hours must be 1–720', 422); o.est_hours = h }
  if (has('warrantyDays')) { if (i.warrantyDays === null) o.warranty_days = null; else { const w = Number(i.warrantyDays); if (!Number.isInteger(w) || w < 0 || w > 730) throw new RepairError('VALIDATION', 'Warranty must be 0–730 days', 422); o.warranty_days = w } }
  if (has('isActive')) { if (typeof i.isActive !== 'boolean') throw new RepairError('VALIDATION', 'isActive must be true or false', 422); o.is_active = i.isActive }
  return o
}

export async function createService(input = {}) {
  const code = String(input.code ?? '').trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9_]{2,39}$/.test(code)) throw new RepairError('VALIDATION', 'Code must be 3–40 characters: capital letters, digits, underscore', 422)
  const o = cleanService(input, false)
  try {
    const { rows } = await query(
      `INSERT INTO repair_services (code, name, category, device_category, labour_price, est_hours, warranty_days, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [code, o.name, o.category, o.device_category ?? 'ANY', o.labour_price, o.est_hours ?? 24, o.warranty_days ?? null, o.is_active ?? true])
    return serializeService(rows[0])
  } catch (e) {
    if (e.code === '23505') throw new RepairError('DUPLICATE', 'A service with that code already exists', 409)
    throw e
  }
}

export async function updateService(id, input = {}) {
  const o = cleanService(input, true)
  const keys = Object.keys(o)
  if (!keys.length) throw new RepairError('VALIDATION', 'Nothing to update', 422)
  const { rows } = await query(`UPDATE repair_services SET ${keys.map((k, n) => `${k} = $${n + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => o[k])])
  if (!rows[0]) throw new RepairError('NOT_FOUND', 'Service not found', 404)
  return serializeService(rows[0])
}

// ── business contract terms ─────────────────────────────────────────────

const serializeTerms = (t) => ({ id: t.id, gstin: t.gstin, businessName: t.business_name, discountPct: num(t.discount_pct), paymentTermsDays: t.payment_terms_days, creditLimit: num(t.credit_limit), isActive: t.is_active })

export async function listTerms() {
  const { rows } = await query('SELECT * FROM repair_business_terms ORDER BY business_name')
  return rows.map(serializeTerms)
}

/** Create or update by GSTIN. Credit terms only take effect when a credit limit above zero is granted. */
export async function upsertTerms(actor, input = {}) {
  const gstin = String(input.gstin ?? '').trim().toUpperCase()
  if (!GSTIN_RE.test(gstin)) throw new RepairError('VALIDATION', 'Enter a valid 15-character GSTIN', 422)
  const name = String(input.businessName ?? '').trim()
  if (name.length < 2 || name.length > 160) throw new RepairError('VALIDATION', 'Business name is required', 422)
  const d = Number(input.discountPct ?? 0), days = Number(input.paymentTermsDays ?? 0), limit = Number(input.creditLimit ?? 0)
  if (!Number.isFinite(d) || d < 0 || d > 60) throw new RepairError('VALIDATION', 'Discount must be 0–60%', 422)
  if (!Number.isInteger(days) || days < 0 || days > 120) throw new RepairError('VALIDATION', 'Payment terms must be 0–120 days', 422)
  if (!Number.isFinite(limit) || limit < 0 || limit > 100_000_000) throw new RepairError('VALIDATION', 'Credit limit is invalid', 422)
  if (days > 0 && limit <= 0) throw new RepairError('VALIDATION', 'Set a credit limit to allow payment terms', 422)
  const { rows } = await query(
    `INSERT INTO repair_business_terms (gstin, business_name, discount_pct, payment_terms_days, credit_limit, is_active, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (gstin) DO UPDATE SET business_name = EXCLUDED.business_name, discount_pct = EXCLUDED.discount_pct,
       payment_terms_days = EXCLUDED.payment_terms_days, credit_limit = EXCLUDED.credit_limit, is_active = EXCLUDED.is_active, updated_at = NOW()
     RETURNING *`,
    [gstin, name, d, days, limit, input.isActive !== false, actor.userId])
  return serializeTerms(rows[0])
}
