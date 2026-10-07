import { describe, expect, it } from 'vitest'
import {
  createShopSchema,
  updateShopSchema,
  listShopsQuerySchema,
  shopIdParamSchema,
} from '../../../src/modules/shops/shops.schema.js'

const VALID_INPUT = {
  name: 'Fresh Mart',
  address_line1: '100 Main Road',
  city: 'Bangalore',
  state: 'Karnataka',
  pincode: '560038',
  lat: 12.9716,
  lng: 77.5946,
}

// ═══════════════════════════════════════════════════════════
// createShopSchema — Requirement 1.1, 1.8
// ═══════════════════════════════════════════════════════════
describe('createShopSchema', () => {
  it('accepts a minimum valid payload and applies defaults', () => {
    const parsed = createShopSchema.safeParse(VALID_INPUT)

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.serviceable_pincodes).toEqual([])
      expect(parsed.data.delivery_radius_km).toBe(5.0)
      expect(parsed.data.commission_rate).toBe(10.0)
      expect(parsed.data.operating_hours).toEqual({})
    }
  })

  describe('serviceable_pincodes normalisation', () => {
    it('stores a duplicated PIN once ("201301, 201301")', () => {
      const parsed = createShopSchema.safeParse({
        ...VALID_INPUT,
        serviceable_pincodes: ['201301', '201301'],
      })
      expect(parsed.success).toBe(true)
      if (parsed.success) expect(parsed.data.serviceable_pincodes).toEqual(['201301'])
    })

    it('trims, strips inner whitespace, drops blanks, dedupes preserving order', () => {
      const parsed = createShopSchema.safeParse({
        ...VALID_INPUT,
        serviceable_pincodes: [' 700016', '201 301', '', '  ', '700016 ', '201301'],
      })
      expect(parsed.success).toBe(true)
      if (parsed.success) {
        expect(parsed.data.serviceable_pincodes).toEqual(['700016', '201301'])
      }
    })

    it('rejects an entry that is not a valid 6-digit PIN', () => {
      for (const bad of ['2013', '20130a', '012345', '2013011']) {
        const parsed = createShopSchema.safeParse({
          ...VALID_INPUT,
          serviceable_pincodes: ['201301', bad],
        })
        expect(parsed.success).toBe(false)
      }
    })

    it('still defaults to [] when omitted', () => {
      const parsed = createShopSchema.safeParse(VALID_INPUT)
      expect(parsed.success && parsed.data.serviceable_pincodes).toEqual([])
    })

    it('applies the same normalisation on update, and leaves it undefined when omitted', () => {
      const updated = updateShopSchema.safeParse({ serviceable_pincodes: ['201301', ' 201301'] })
      expect(updated.success && updated.data.serviceable_pincodes).toEqual(['201301'])

      const untouched = updateShopSchema.safeParse({ name: 'X' })
      expect(untouched.success && 'serviceable_pincodes' in untouched.data).toBe(false)

      const bad = updateShopSchema.safeParse({ serviceable_pincodes: ['12'] })
      expect(bad.success).toBe(false)
    })

    it('allows clearing the list with []', () => {
      const parsed = updateShopSchema.safeParse({ serviceable_pincodes: [] })
      expect(parsed.success && parsed.data.serviceable_pincodes).toEqual([])
    })
  })

  describe('required fields', () => {
    const requiredKeys = [
      'name',
      'address_line1',
      'city',
      'state',
      'pincode',
      'lat',
      'lng',
    ]

    for (const key of requiredKeys) {
      it(`rejects when "${key}" is missing`, () => {
        const input = { ...VALID_INPUT }
        delete input[key]
        const parsed = createShopSchema.safeParse(input)
        expect(parsed.success).toBe(false)
      })
    }

    it('rejects empty name string', () => {
      expect(
        createShopSchema.safeParse({ ...VALID_INPUT, name: '' }).success
      ).toBe(false)
    })
  })

  describe('lat range', () => {
    it.each([-90, 0, 90])('accepts boundary lat=%s', (lat) => {
      expect(createShopSchema.safeParse({ ...VALID_INPUT, lat }).success).toBe(
        true
      )
    })

    it.each([-90.0001, 90.0001, 95, -95])(
      'rejects out-of-range lat=%s',
      (lat) => {
        expect(
          createShopSchema.safeParse({ ...VALID_INPUT, lat }).success
        ).toBe(false)
      }
    )
  })

  describe('lng range', () => {
    it.each([-180, 0, 180])('accepts boundary lng=%s', (lng) => {
      expect(createShopSchema.safeParse({ ...VALID_INPUT, lng }).success).toBe(
        true
      )
    })

    it.each([-180.0001, 180.0001, 200])(
      'rejects out-of-range lng=%s',
      (lng) => {
        expect(
          createShopSchema.safeParse({ ...VALID_INPUT, lng }).success
        ).toBe(false)
      }
    )
  })

  describe('commission_rate range (0-100)', () => {
    it.each([0, 0.5, 50, 100])('accepts %s', (commission_rate) => {
      const parsed = createShopSchema.safeParse({
        ...VALID_INPUT,
        commission_rate,
      })
      expect(parsed.success).toBe(true)
    })

    it.each([-0.01, -1, 100.01, 101, 200])(
      'rejects out-of-range %s',
      (commission_rate) => {
        const parsed = createShopSchema.safeParse({
          ...VALID_INPUT,
          commission_rate,
        })
        expect(parsed.success).toBe(false)
      }
    )
  })

  describe('delivery_radius_km range (0.5-100)', () => {
    it.each([0.5, 1, 50, 100])('accepts %s', (delivery_radius_km) => {
      expect(
        createShopSchema.safeParse({ ...VALID_INPUT, delivery_radius_km })
          .success
      ).toBe(true)
    })

    it.each([0, 0.49, 100.01, 200, -1])(
      'rejects out-of-range %s',
      (delivery_radius_km) => {
        expect(
          createShopSchema.safeParse({ ...VALID_INPUT, delivery_radius_km })
            .success
        ).toBe(false)
      }
    )
  })

  it('rejects malformed email', () => {
    expect(
      createShopSchema.safeParse({ ...VALID_INPUT, email: 'not-an-email' })
        .success
    ).toBe(false)
  })

  it('rejects malformed logo_url', () => {
    expect(
      createShopSchema.safeParse({ ...VALID_INPUT, logo_url: 'not a url' })
        .success
    ).toBe(false)
  })

  it('rejects name longer than 200 chars', () => {
    expect(
      createShopSchema.safeParse({ ...VALID_INPUT, name: 'x'.repeat(201) })
        .success
    ).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════
// updateShopSchema — all optional
// ═══════════════════════════════════════════════════════════
describe('updateShopSchema', () => {
  it('accepts an empty object (all fields optional)', () => {
    expect(updateShopSchema.safeParse({}).success).toBe(true)
  })

  it('accepts a single-field update', () => {
    expect(updateShopSchema.safeParse({ phone: '9999999999' }).success).toBe(
      true
    )
  })

  it('accepts an is_active toggle', () => {
    expect(updateShopSchema.safeParse({ is_active: false }).success).toBe(true)
  })

  it('still enforces lat/lng range when provided', () => {
    expect(updateShopSchema.safeParse({ lat: 95 }).success).toBe(false)
    expect(updateShopSchema.safeParse({ lng: -200 }).success).toBe(false)
  })

  it('still enforces commission_rate range when provided', () => {
    expect(updateShopSchema.safeParse({ commission_rate: 150 }).success).toBe(
      false
    )
  })

  it('rejects empty name when provided', () => {
    expect(updateShopSchema.safeParse({ name: '' }).success).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════
// listShopsQuerySchema — Requirement 1.6
// ═══════════════════════════════════════════════════════════
describe('listShopsQuerySchema', () => {
  it('applies defaults page=1, limit=20 when query is empty', () => {
    const parsed = listShopsQuerySchema.safeParse({})
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.page).toBe(1)
      expect(parsed.data.limit).toBe(20)
    }
  })

  it('coerces string page/limit to integers', () => {
    const parsed = listShopsQuerySchema.safeParse({ page: '3', limit: '50' })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.page).toBe(3)
      expect(parsed.data.limit).toBe(50)
    }
  })

  it('accepts limit at the boundary value of 100', () => {
    const parsed = listShopsQuerySchema.safeParse({ limit: '100' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.limit).toBe(100)
  })

  it('rejects limit greater than 100', () => {
    expect(listShopsQuerySchema.safeParse({ limit: '101' }).success).toBe(
      false
    )
    expect(listShopsQuerySchema.safeParse({ limit: '500' }).success).toBe(
      false
    )
  })

  it('rejects page less than 1', () => {
    expect(listShopsQuerySchema.safeParse({ page: '0' }).success).toBe(false)
    expect(listShopsQuerySchema.safeParse({ page: '-1' }).success).toBe(false)
  })

  it('rejects non-integer page', () => {
    expect(listShopsQuerySchema.safeParse({ page: '1.5' }).success).toBe(false)
  })

  it('accepts is_active="true" and "false"', () => {
    expect(
      listShopsQuerySchema.safeParse({ is_active: 'true' }).success
    ).toBe(true)
    expect(
      listShopsQuerySchema.safeParse({ is_active: 'false' }).success
    ).toBe(true)
  })

  it('rejects is_active values other than "true"/"false"', () => {
    expect(listShopsQuerySchema.safeParse({ is_active: 'yes' }).success).toBe(
      false
    )
    expect(listShopsQuerySchema.safeParse({ is_active: '1' }).success).toBe(
      false
    )
  })

  it('accepts optional city and search fields', () => {
    const parsed = listShopsQuerySchema.safeParse({
      city: 'Bangalore',
      search: 'fresh',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.city).toBe('Bangalore')
      expect(parsed.data.search).toBe('fresh')
    }
  })
})

// ═══════════════════════════════════════════════════════════
// shopIdParamSchema
// ═══════════════════════════════════════════════════════════
describe('shopIdParamSchema', () => {
  it('accepts a valid UUID v4', () => {
    expect(
      shopIdParamSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
      }).success
    ).toBe(true)
  })

  it.each([
    'not-a-uuid',
    '12345',
    '',
    '550e8400e29b41d4a716446655440000', // missing dashes
    '550e8400-e29b-41d4-a716', // truncated
    'gggggggg-gggg-gggg-gggg-gggggggggggg', // non-hex
  ])('rejects invalid id "%s"', (id) => {
    expect(shopIdParamSchema.safeParse({ id }).success).toBe(false)
  })

  it('rejects missing id', () => {
    expect(shopIdParamSchema.safeParse({}).success).toBe(false)
  })
})
