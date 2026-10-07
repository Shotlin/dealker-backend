/**
 * Placeholder substitution for reminder copy. Admins write
 * "Hi {{name}}, your {{items}} items worth {{cartValue}} are waiting" and each
 * customer gets their own values. Unknown placeholders are left untouched so a
 * typo is visible rather than silently blanked.
 */
const inr = (n) =>
  '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })

export function buildTemplateVars(episode, extra = {}) {
  const first = (episode.user?.name || '').trim().split(/\s+/)[0]
  return {
    name: first || 'there',
    items: String(episode.itemCount ?? 0),
    cartValue: inr(episode.cartValue),
    topItem: episode.items?.[0]?.productName || 'your items',
    ...extra,
  }
}

export function renderTemplate(text, vars) {
  return String(text ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m
  )
}
