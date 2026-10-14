import { describe, expect, it } from 'vitest'
import { demandTags, matchInventory, matchListing, modelKey, parseStorage } from '../../../src/modules/b2b/demand.match.js'

const req = (over = {}) => ({ product_name: 'iPhone 13 128GB', brand: 'Apple', condition_pref: 'ANY', min_battery_health: null, ...over })
const listing = (over = {}) => ({ name: 'Apple iPhone 13 (128GB)', brand: 'Apple', condition: 'REFURBISHED', battery_health: 90, storage: '128GB', stock: 6, ...over })

describe('parseStorage / modelKey', () => {
  it('reads storage in the usual spellings and prefers the larger figure over RAM', () => {
    expect(parseStorage('iPhone 13 128GB')).toBe('128GB')
    expect(parseStorage('Galaxy S22 8 GB / 256gb')).toBe('256GB')
    expect(parseStorage('iPad 1TB')).toBe('1TB')
    expect(parseStorage('MacBook Air M1')).toBeNull()
  })
  it('drops storage and brand words', () => {
    expect(modelKey('Apple iPhone 13 128GB', 'Apple')).toBe('iphone 13')
    expect(modelKey('Redmi Note 11 (6GB/128GB)', 'Xiaomi')).toBe('redmi note 11')
  })
})

describe('matchListing', () => {
  it('matches the same model even when the brand is written differently', () => {
    expect(matchListing(req(), listing())).toMatchObject({ level: 'EXACT' })
    expect(matchListing(req({ brand: null, product_name: 'Apple iPhone 13 128GB' }), listing())).toMatchObject({ level: 'EXACT' })
  })
  it('does not mix up variants of a model', () => {
    expect(matchListing(req(), listing({ name: 'Apple iPhone 13 Pro (128GB)' }))).toBeNull()
    expect(matchListing(req(), listing({ name: 'Apple iPhone 13 mini (128GB)' }))).toBeNull()
    expect(matchListing(req({ product_name: 'iPhone 13 Pro 128GB' }), listing())).toBeNull()
    expect(matchListing(req({ product_name: 'iPhone 14 128GB' }), listing())).toBeNull()
    expect(matchListing(req({ product_name: 'Redmi 11' }), listing({ name: 'Xiaomi Redmi Note 11', brand: 'Xiaomi' }))).toBeNull()
  })
  it('a different storage or a weak battery is only a close match', () => {
    const s = matchListing(req(), listing({ name: 'Apple iPhone 13 (256GB)', storage: '256GB' }))
    expect(s.level).toBe('CLOSE')
    expect(s.reasons.join(' ')).toMatch(/256GB/)
    const b = matchListing(req({ min_battery_health: 90 }), listing({ battery_health: 82 }))
    expect(b.level).toBe('CLOSE')
    expect(matchListing(req({ min_battery_health: 85 }), listing({ battery_health: 88 })).level).toBe('EXACT')
    expect(matchListing(req({ min_battery_health: 85 }), listing({ battery_health: null })).level).toBe('EXACT') // unknown ≠ bad
  })
  it('respects a condition the buyer ruled out', () => {
    expect(matchListing(req({ condition_pref: 'NEW' }), listing({ condition: 'USED_GOOD' }))).toBeNull()
    expect(matchListing(req({ condition_pref: 'NEW' }), listing({ condition: 'OPEN_BOX' })).level).toBe('EXACT')
    expect(matchListing(req({ condition_pref: 'USED_OR_REFURBISHED' }), listing({ condition: 'NEW' }))).toBeNull()
  })
})

describe('matchInventory', () => {
  it('counts only exact matches as stock the vendor can promise, best first', () => {
    const m = matchInventory(req(), [
      listing({ stock: 2, name: 'Apple iPhone 13 (256GB)', storage: '256GB' }),
      listing({ stock: 4 }), listing({ stock: 5, name: 'Apple iPhone 13 (128GB) Box Pack' }), listing({ name: 'Samsung S22', brand: 'Samsung' }),
    ])
    expect(m.level).toBe('EXACT')
    expect(m.stock).toBe(9)
    expect(m.listings.map((l) => l.level)).toEqual(['EXACT', 'EXACT', 'CLOSE'])
    expect(matchInventory(req(), [listing({ name: 'Samsung S22', brand: 'Samsung' })])).toMatchObject({ level: null, stock: 0, listings: [] })
  })
})

describe('demandTags', () => {
  const now = new Date('2026-10-14T00:00:00Z')
  it('flags bulk from 20 units and urgent when asked or needed within 3 days', () => {
    expect(demandTags({ quantity_needed: 50 }, now)).toEqual(['BULK'])
    expect(demandTags({ quantity_needed: 5, is_urgent: true }, now)).toEqual(['URGENT'])
    expect(demandTags({ quantity_needed: 40, required_by: '2026-10-16' }, now)).toEqual(['URGENT', 'BULK'])
    expect(demandTags({ quantity_needed: 5, required_by: '2026-11-01' }, now)).toEqual([])
  })
})
