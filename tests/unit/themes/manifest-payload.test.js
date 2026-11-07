import { describe, it, expect } from 'vitest'
import {
  compactManifest,
  etagMatches,
  quoteEtag,
  slimCardProduct,
  slimManifestProducts,
} from '../../../src/modules/themes/manifest-payload.js'

const product = (id, extra = {}) => ({
  id,
  name: `Phone ${id}`,
  slug: `phone-${id}`,
  price: '1000.00',
  sale_price: '900.00',
  thumbnail_url: `https://x/${id}.jpg`,
  images: ['a', 'b', 'c', 'd', 'e'],
  description: 'D'.repeat(500),
  ingredients: 'flour',
  nutrition_info: { kcal: 1 },
  storage_instructions: 'cool',
  highlights: { ram: '8GB' },
  ...extra,
})

describe('etag helpers', () => {
  it('quotes the etag so nginx keeps it when gzipping', () => {
    expect(quoteEtag('abc')).toBe('"abc"')
  })

  it('matches strong, weak, legacy-unquoted, list and wildcard If-None-Match values', () => {
    expect(etagMatches('"abc"', 'abc')).toBe(true)
    expect(etagMatches('W/"abc"', 'abc')).toBe(true) // what nginx turns it into
    expect(etagMatches('abc', 'abc')).toBe(true) // clients that cached the old unquoted tag
    expect(etagMatches('"zzz", W/"abc"', 'abc')).toBe(true)
    expect(etagMatches('*', 'abc')).toBe(true)
  })

  it('does not match a different etag or a missing header', () => {
    expect(etagMatches('"abd"', 'abc')).toBe(false)
    expect(etagMatches(undefined, 'abc')).toBe(false)
    expect(etagMatches('"abc"', undefined)).toBe(false)
    // the compact variant must not be confused with the full one
    expect(etagMatches('"abc"', 'abc-c')).toBe(false)
  })
})

describe('slimCardProduct', () => {
  it('drops grocery-era fields, truncates description and caps images', () => {
    const slim = slimCardProduct(product('1'))
    expect(slim).not.toHaveProperty('ingredients')
    expect(slim).not.toHaveProperty('nutrition_info')
    expect(slim).not.toHaveProperty('storage_instructions')
    expect(slim.description).toHaveLength(160)
    expect(slim.images).toEqual(['a', 'b', 'c'])
  })

  it('keeps everything a card renders and does not mutate the input', () => {
    const input = product('1')
    const slim = slimCardProduct(input)
    expect(slim).toMatchObject({ id: '1', name: 'Phone 1', price: '1000.00', sale_price: '900.00', highlights: { ram: '8GB' } })
    expect(input.images).toHaveLength(5)
    expect(input.ingredients).toBe('flour')
  })

  it('leaves short descriptions alone', () => {
    expect(slimCardProduct(product('1', { description: 'short' })).description).toBe('short')
  })
})

describe('slimManifestProducts', () => {
  it('slims products nested in sections and tabs, leaving everything else untouched', () => {
    const manifest = {
      tab_key: 'all',
      sections: [
        { id: 's1', type: 'product_carousel', config: { title: 'T' }, products: [product('1')] },
        { id: 's2', type: 'steal_deals', config: { tabs: [{ label: 'x', chips: [], products: [product('2')] }] } },
      ],
    }
    const out = slimManifestProducts(manifest)
    expect(out.sections[0].products[0]).not.toHaveProperty('ingredients')
    expect(out.sections[1].config.tabs[0].products[0].description).toHaveLength(160)
    expect(out.sections[0].config).toEqual({ title: 'T' })
    expect(manifest.sections[0].products[0]).toHaveProperty('ingredients') // input untouched
  })
})

// Mirrors what the Flutter client does to rebuild the legacy shape.
function hydrate(compact) {
  const { product_pool: pool, ...rest } = compact
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk)
    if (!node || typeof node !== 'object') return node
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [
        k,
        k === 'products' && Array.isArray(v) && v.length && v.every((e) => typeof e === 'string' && e.startsWith('@') && e.slice(1) in pool)
          ? v.map((ref) => pool[ref.slice(1)])
          : walk(v),
      ])
    )
  }
  return walk(rest)
}

describe('compactManifest', () => {
  const build = () => ({
    tab_key: 'all',
    store_key: 'mobile',
    sections: [
      { id: 's1', type: 'product_carousel', products: [product('1'), product('2')] },
      { id: 's2', type: 'trending_products', products: [product('2'), product('3')] },
      { id: 's3', type: 'price_shop', config: { tabs: [{ label: 'u', products: [product('1'), product('3')] }, { label: 'v', products: [] }] } },
      { id: 's4', type: 'banner_rail', config: { items: [{ image_url: 'x' }] } },
    ],
  })

  it('sends each distinct product once and references it by key', () => {
    const compact = compactManifest(build())
    expect(Object.keys(compact.product_pool).sort()).toEqual(['1', '2', '3'])
    expect(compact.sections[0].products).toEqual(['@1', '@2'])
    expect(compact.sections[2].config.tabs[0].products).toEqual(['@1', '@3'])
    expect(compact.sections[2].config.tabs[1].products).toEqual([])
  })

  it('round-trips to exactly the legacy structure', () => {
    const original = build()
    expect(hydrate(compactManifest(original))).toEqual(original)
  })

  it('keeps two different payloads for the same product id apart', () => {
    const manifest = {
      sections: [
        { id: 'a', products: [product('1', { deal_category_ids: ['x'] })] },
        { id: 'b', products: [product('1', { deal_category_ids: ['y'] })] },
      ],
    }
    const compact = compactManifest(manifest)
    expect(Object.keys(compact.product_pool)).toHaveLength(2)
    expect(hydrate(compact)).toEqual(manifest)
  })

  it('is much smaller than the repeated form', () => {
    const repeated = { sections: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, products: [product('1'), product('2'), product('3')] })) }
    const full = JSON.stringify(repeated).length
    const compact = JSON.stringify(compactManifest(repeated)).length
    expect(compact).toBeLessThan(full / 4)
  })

  it('does not treat non-product `products` lists as products', () => {
    const manifest = { sections: [{ id: 'a', config: { products: ['id-1', 'id-2'] } }] }
    const compact = compactManifest(manifest)
    expect(compact.sections[0].config.products).toEqual(['id-1', 'id-2'])
    expect(compact.product_pool).toEqual({})
  })
})
