import { query } from '../../config/database.js'
import { QcService } from '../qc/qc.service.js'

const SETTING_KEY = 'product_page_layout'

/** Every block the customer product page knows how to draw; order here is the default order. */
export const PRODUCT_BLOCKS = [
  { key: 'gallery', label: 'Photo gallery', locked: true },
  { key: 'title_price', label: 'Title, badges & price', locked: true },
  { key: 'condition', label: 'Condition & skin (used only)' },
  { key: 'qc', label: 'QC report card (used only)' },
  { key: 'in_box', label: "What's in the box" },
  { key: 'highlights', label: 'Highlights' },
  { key: 'specs', label: 'Specifications' },
  { key: 'description', label: 'Description' },
  { key: 'vendor', label: 'Seller / vendor' },
  { key: 'similar', label: 'Similar products' },
]

const KEYS = new Set(PRODUCT_BLOCKS.map((b) => b.key))
const DEFAULT_LAYOUT = PRODUCT_BLOCKS.map((b) => ({ key: b.key, visible: true }))

const LABELS = {
  NEW: 'Brand new',
  OPEN_BOX: 'Open box',
  REFURBISHED: 'Refurbished',
  USED_LIKE_NEW: 'Used · Like new',
  USED_GOOD: 'Used · Good',
  USED_FAIR: 'Used · Fair',
}
const GRADE_ORDER = ['USED_FAIR', 'USED_GOOD', 'USED_LIKE_NEW', 'OPEN_BOX']

function cleanLayout(input) {
  const seen = new Set()
  const out = []
  for (const b of Array.isArray(input) ? input : []) {
    const key = String(b?.key || '')
    if (!KEYS.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push({ key, visible: b.visible !== false })
  }
  for (const d of DEFAULT_LAYOUT) if (!seen.has(d.key)) out.push({ ...d })
  // locked blocks can never be hidden
  return out.map((b) => (PRODUCT_BLOCKS.find((x) => x.key === b.key)?.locked ? { ...b, visible: true } : b))
}

export async function getLayout() {
  const { rows } = await query('SELECT value FROM app_settings WHERE key = $1', [SETTING_KEY])
  return cleanLayout(rows[0]?.value?.blocks)
}

export async function saveLayout(blocks) {
  const value = { blocks: cleanLayout(blocks) }
  await query(
    `INSERT INTO app_settings (key, value, description, updated_at) VALUES ($1, $2::jsonb, 'Customer product-page block order', NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [SETTING_KEY, JSON.stringify(value)]
  )
  return value.blocks
}

/** Condition, skin and QC for one product (a product row is one seller's listing). Real data only. */
export async function getCondition(productId) {
  const { rows } = await query(
    `SELECT p.condition, p.condition_notes, p.usage_duration, p.battery_health, p.warranty_info,
            p.accessories_included, p.has_invoice, p.imei, p.specifications,
            sp.vendor_qc, sp.qc_status
       FROM products p
       LEFT JOIN LATERAL (
         SELECT vendor_qc, qc_status FROM shop_products
          WHERE product_id = p.id AND deleted_at IS NULL AND approval_status = 'APPROVED'
          ORDER BY created_at DESC LIMIT 1) sp ON TRUE
      WHERE p.id = $1`, [productId]
  ).catch(async () => ({ rows: [] }))
  const r = rows[0]
  if (!r) return null
  const condition = r.condition || 'NEW'
  const isUsed = condition !== 'NEW'
  const vq = r.vendor_qc && typeof r.vendor_qc === 'object' ? r.vendor_qc : null
  const checklist = vq?.checklist && typeof vq.checklist === 'object'
    ? Object.entries(vq.checklist).map(([label, value]) => ({ label, value: String(value) }))
    : []
  const accessories = r.accessories_included
    ? String(r.accessories_included).split(/[,;\n]| and /i).map((s) => s.trim()).filter(Boolean)
    : []
  const qc = isUsed ? await new QcService().publicReport(productId) : null
  return {
    condition,
    label: LABELS[condition] || condition,
    isUsed,
    grades: GRADE_ORDER.map((k) => ({ key: k, label: LABELS[k].replace('Used · ', '') })),
    notes: r.condition_notes || null,
    usageDuration: r.usage_duration || null,
    batteryHealth: r.battery_health ?? null,
    warranty: r.warranty_info || null,
    accessories,
    hasInvoice: !!r.has_invoice,
    imeiOnFile: !!r.imei,
    checklist,
    specs: Array.isArray(r.specifications) ? r.specifications : (r.specifications && typeof r.specifications === 'object' ? Object.entries(r.specifications).map(([label, value]) => ({ label, value: String(value) })) : []),
    qc,
  }
}
