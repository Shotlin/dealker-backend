/**
 * Reminder templates a vendor can send. Deliberately a closed set, rendered on
 * the server: a vendor can never push free text to a customer, and a template
 * may only claim what is true (low-stock is offered only when real stock is low).
 *
 * Placeholders: {{name}} first name · {{product}} top product · {{count}} items ·
 * {{shop}} vendor name · {{stock}} real units left of the scarcest item.
 */
export const VENDOR_TEMPLATES = {
  GENTLE: {
    label: 'Friendly reminder',
    hint: 'A simple nudge — best as the first message.',
    title: 'Still thinking about {{product}}?',
    body: 'Hi {{name}}, your {{product}} is waiting in your cart at {{shop}}. Complete your order whenever you are ready.',
  },
  HELP: {
    label: 'Offer help',
    hint: 'Invites questions — good when the price is high.',
    title: '{{shop}} is here to help',
    body: 'Hi {{name}}, you left {{product}} in your cart. Have a question about it? Open the product and ask, or complete your order now.',
  },
  LOW_STOCK: {
    label: 'Low stock',
    hint: 'Only when real stock is low.',
    title: 'Only {{stock}} left: {{product}}',
    body: 'Hi {{name}}, only {{stock}} unit(s) of {{product}} are left at {{shop}}. Order now so you do not miss out.',
    requiresLowStock: true,
  },
}

const DEFAULT_ORDER = ['GENTLE', 'HELP', 'LOW_STOCK']

const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'there'

/** First name + last initial — the only identity a vendor ever sees. */
export function maskName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return 'Customer'
  if (parts.length === 1) return parts[0]
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`
}

export function render(text, vars) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''))
}

/**
 * @param {{customerName:string, vendorName:string, items:Array<{productName:string, quantity:number, stock:number|null}>}} slice
 * @param {number} lowStockThreshold
 */
export function templatesFor(slice, lowStockThreshold) {
  const scarce = slice.items
    .filter((i) => Number.isFinite(i.stock) && i.stock > 0 && i.stock <= lowStockThreshold)
    .sort((a, b) => a.stock - b.stock)[0]
  const top = slice.items[0]
  const vars = {
    name: first(slice.customerName),
    product: slice.items.length > 1 ? `${top.productName} + ${slice.items.length - 1} more` : top.productName,
    count: slice.items.length,
    shop: slice.vendorName,
    stock: scarce?.stock ?? '',
  }
  return DEFAULT_ORDER.map((key) => {
    const t = VENDOR_TEMPLATES[key]
    const available = !t.requiresLowStock || !!scarce
    const v = t.requiresLowStock && scarce ? { ...vars, product: scarce.productName } : vars
    return {
      key,
      label: t.label,
      hint: t.hint,
      available,
      unavailableReason: available ? null : 'No item of yours is low on stock.',
      title: available ? render(t.title, v) : '',
      body: available ? render(t.body, v) : '',
    }
  })
}
