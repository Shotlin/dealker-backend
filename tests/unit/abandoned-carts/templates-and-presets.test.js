import { describe, it, expect } from 'vitest'
import { buildTemplateVars, renderTemplate } from '../../../src/modules/admin/abandoned-carts/abandoned-carts.templates.js'
import { QUICK_COUPON_PRESETS, ABANDONMENT_THRESHOLD_MS } from '../../../src/constants/abandonedCart.js'

describe('abandoned-cart reminder templates', () => {
  const episode = {
    user: { name: 'Asha Rao' },
    itemCount: 3,
    cartValue: 12499.5,
    items: [{ productName: 'Noise Buds' }],
  }

  it('fills placeholders per customer', () => {
    const vars = buildTemplateVars(episode)
    expect(renderTemplate('Hi {{name}}, {{items}} items ({{cartValue}}) incl. {{topItem}}', vars))
      .toBe('Hi Asha, 3 items (₹12,499.5) incl. Noise Buds')
  })

  it('falls back gracefully for unnamed customers and empty carts', () => {
    const vars = buildTemplateVars({ user: { name: null }, itemCount: 0, cartValue: 0, items: [] })
    expect(vars.name).toBe('there')
    expect(vars.topItem).toBe('your items')
  })

  it('leaves unknown placeholders visible and supports extras like {{code}}', () => {
    const vars = buildTemplateVars(episode, { code: 'COMEBACK1' })
    expect(renderTemplate('{{code}} {{nope}}', vars)).toBe('COMEBACK1 {{nope}}')
  })
})

describe('quick coupon presets', () => {
  it('every preset is a well-formed coupon definition', () => {
    for (const [key, p] of Object.entries(QUICK_COUPON_PRESETS)) {
      expect(['PERCENTAGE', 'FLAT', 'FREE_DELIVERY'], key).toContain(p.discountType)
      expect(p.discountValue).toBeGreaterThanOrEqual(0)
      if (p.discountType === 'PERCENTAGE') expect(p.discountValue).toBeLessThanOrEqual(100)
      expect(p.label).toBeTruthy()
    }
  })

  it('defaults the abandonment threshold to 30 minutes when unset', () => {
    expect(ABANDONMENT_THRESHOLD_MS).toBe(30 * 60 * 1000)
  })
})
