// Regression: PIN-code serviceability for the guest storefront gate.
//
// Bug: a Kolkata store configured `pincode_only = true` with
// `serviceable_pincodes = ['201301']` never matched a customer physically in
// PIN 201301 (Noida/Delhi NCR), because the mobile app called
// POST /storefront/resolve-location with lat/lng ONLY — the PIN was
// reverse-geocoded only after serviceability succeeded — and a pincode-only
// store can be matched by nothing except the PIN.
//
// This test drives the REAL route + AllocationService over HTTP (Fastify
// inject). Only the repository is replaced, by a fake that mirrors the
// documented SQL semantics of AllocationRepository:
//   findShopsByPincode  → exact `pin = ANY(serviceable_pincodes)`; distance is
//                         informational only (never a filter)
//   findShopsByRadius   → haversine <= delivery_radius_km AND NOT pincode_only
// The SQL itself is verified separately against a real Postgres engine (see
// the PR notes); here we lock in the route/service contract.

import Fastify from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  cacheDeletePattern: vi.fn(),
}))
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../../src/config/bullmq.js', () => ({
  allocationQueue: { add: vi.fn() },
}))

const shopsTable = vi.hoisted(() => ({ rows: [] }))

vi.mock('../../../src/modules/allocation/allocation.repository.js', () => {
  const R = 6371
  const haversine = (lat1, lng1, lat2, lng2) => {
    const rad = (d) => (d * Math.PI) / 180
    const a =
      Math.sin(rad(lat2 - lat1) / 2) ** 2 +
      Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(a))
  }
  const active = (s) => s.is_active && !s.deleted_at
  class FakeAllocationRepository {
    async findShopsByPincode(pincode, { lat, lng }) {
      return shopsTable.rows
        .filter((s) => active(s) && s.serviceable_pincodes.includes(pincode))
        .map((s) => ({
          id: s.id,
          created_at: s.created_at,
          distance_km: haversine(lat, lng, s.lat, s.lng),
          delivery_radius_km: s.delivery_radius_km,
        }))
    }
    async findShopsByRadius(lat, lng) {
      return shopsTable.rows
        .filter((s) => active(s) && !s.pincode_only)
        .map((s) => ({
          id: s.id,
          created_at: s.created_at,
          distance_km: haversine(lat, lng, s.lat, s.lng),
          delivery_radius_km: s.delivery_radius_km,
        }))
        .filter((s) => s.distance_km <= s.delivery_radius_km)
    }
    async findByShopIds(ids) {
      return shopsTable.rows.filter((s) => ids.includes(s.id)).map((s) => ({ shop_id: s.id, name: s.name }))
    }
  }
  return { AllocationRepository: FakeAllocationRepository }
})

import storefrontRoutes from '../../../src/modules/storefront/storefront.routes.js'

const KOLKATA = { lat: 22.5726, lng: 88.3639 }
const NOIDA = { lat: 28.5355, lng: 77.391 } // physically inside PIN 201301
const NEAR_KOLKATA = { lat: 22.58, lng: 88.37 }

const shop = (over) => ({
  id: 'shop-kolkata',
  name: 'FreshCuts Kolkata',
  created_at: '2026-01-01T00:00:00Z',
  is_active: true,
  deleted_at: null,
  delivery_radius_km: 5,
  pincode_only: false,
  serviceable_pincodes: [],
  ...KOLKATA,
  ...over,
})

let app

beforeAll(async () => {
  app = Fastify()
  await app.register(fastifyJwt, { secret: 'test-secret-test-secret-test-secret' })
  await app.register(storefrontRoutes, { prefix: '/api/v1/storefront' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

beforeEach(() => {
  shopsTable.rows = []
})

const resolve = (payload) =>
  app.inject({ method: 'POST', url: '/api/v1/storefront/resolve-location', payload })

describe('POST /storefront/resolve-location — pincode_only stores', () => {
  beforeEach(() => {
    shopsTable.rows = [shop({ pincode_only: true, serviceable_pincodes: ['201301'] })]
  })

  it('Kolkata pincode-only shop + [201301] + customer coordinates in PIN 201301 → serviceable, with correct storefront scope', async () => {
    const res = await resolve({ ...NOIDA, pincode: '201301' })
    expect(res.statusCode).toBe(200)

    const body = res.json()
    expect(body.success).toBe(true)
    expect(body.data.serviceable).toBe(true)
    expect(body.data.shop).toEqual({ id: 'shop-kolkata', name: 'FreshCuts Kolkata' })

    // The signed storefront token must scope catalogue reads to exactly this shop.
    const claims = app.jwt.verify(body.data.storefrontToken)
    expect(claims.scope).toBe('guest-storefront')
    expect(claims.shopIds).toEqual(['shop-kolkata'])
  })

  it('wrong PIN → unavailable, no token', async () => {
    const res = await resolve({ ...NOIDA, pincode: '201302' })
    const body = res.json()
    expect(res.statusCode).toBe(200)
    expect(body.data).toEqual({ serviceable: false, shops: [] })
    expect(body.data.storefrontToken).toBeUndefined()
  })

  it('the old app behaviour (lat/lng only, no PIN) cannot match a pincode-only shop — the PIN is what the client must send', async () => {
    const res = await resolve({ ...NOIDA })
    expect(res.json().data.serviceable).toBe(false)
  })

  it('pincode-only shop is not matched by radius even when coordinates are AT the shop with a wrong PIN', async () => {
    const res = await resolve({ ...KOLKATA, pincode: '999999' })
    expect(res.json().data.serviceable).toBe(false)
  })

  it('normalises whitespace in the submitted PIN', async () => {
    const res = await resolve({ ...NOIDA, pincode: ' 201 301 ' })
    expect(res.json().data.serviceable).toBe(true)
  })

  it('a malformed/blank PIN is not an error — it simply cannot match a pincode-only shop', async () => {
    for (const pincode of ['', '   ', 'abc']) {
      const res = await resolve({ ...NOIDA, pincode })
      expect(res.statusCode).toBe(200)
      expect(res.json().data.serviceable).toBe(false)
    }
  })

  it('still rejects out-of-range coordinates', async () => {
    const res = await resolve({ lat: 123, lng: 77, pincode: '201301' })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /storefront/resolve-location — radius-only stores (pincode_only = false) are unchanged', () => {
  beforeEach(() => {
    shopsTable.rows = [shop({ pincode_only: false, serviceable_pincodes: [] })]
  })

  it('inside the radius, no PIN → serviceable', async () => {
    const res = await resolve({ ...NEAR_KOLKATA })
    expect(res.json().data.serviceable).toBe(true)
    expect(res.json().data.shop.id).toBe('shop-kolkata')
  })

  it('inside the radius, unrelated PIN → still serviceable via radius', async () => {
    const res = await resolve({ ...NEAR_KOLKATA, pincode: '999999' })
    expect(res.json().data.serviceable).toBe(true)
  })

  it('outside the radius, no PIN → unavailable', async () => {
    const res = await resolve({ ...NOIDA })
    expect(res.json().data.serviceable).toBe(false)
  })

  it('outside the radius, PIN not on the list → unavailable (no global loosening)', async () => {
    const res = await resolve({ ...NOIDA, pincode: '201301' })
    expect(res.json().data.serviceable).toBe(false)
  })
})

describe('POST /storefront/resolve-location — mixed stores', () => {
  it('radius match is preserved alongside a pincode-only shop; primary is the nearest', async () => {
    shopsTable.rows = [
      shop({ id: 'pin-only-kolkata', name: 'Pin only', pincode_only: true, serviceable_pincodes: ['201301'] }),
      shop({ id: 'noida-radius', name: 'Noida hub', pincode_only: false, ...NOIDA, delivery_radius_km: 10 }),
    ]
    const res = await resolve({ ...NOIDA, pincode: '201301' })
    const body = res.json()
    expect(body.data.serviceable).toBe(true)
    // Noida hub is ~0 km away; the Kolkata pin-only shop is ~1300 km away.
    expect(body.data.shop.id).toBe('noida-radius')
    expect(app.jwt.verify(body.data.storefrontToken).shopIds).toEqual(['noida-radius'])
  })

  it('inactive and soft-deleted shops never match', async () => {
    shopsTable.rows = [
      shop({ id: 'a', pincode_only: true, serviceable_pincodes: ['201301'], is_active: false }),
      shop({ id: 'b', pincode_only: true, serviceable_pincodes: ['201301'], deleted_at: '2026-02-02' }),
    ]
    const res = await resolve({ ...NOIDA, pincode: '201301' })
    expect(res.json().data.serviceable).toBe(false)
  })
})
