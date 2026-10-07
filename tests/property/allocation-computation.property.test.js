// Feature: multi-vendor-system, Property 5: Allocation Computation
// **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
//
// Property:
//   For any customer with pincode P and coordinates (lat, lng), allocations
//   must equal the deduplicated union of pincode-matched and radius-matched
//   shops, with the closest marked primary.
//
// Sub-properties asserted below (each as its own property test):
//   1. Deduplication       — every shop_id appears at most once in the result.
//   2. Union               — result IDs == union(pincodeIds, radiusIds).
//   3. Primary selection   — exactly one is_primary=true (zero when empty),
//                            chosen as the shop with the smallest distance_km;
//                            ties broken by earliest created_at.
//   4. NULL ranks last     — a pincode-only match with NULL distance is never
//                            preferred over a radius-match with numeric distance.
//   5. matched_pincode     — pincode-matched shops carry matched_pincode = P;
//                            radius-only shops carry null.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'

const FC_SEED = process.env.FAST_CHECK_SEED
  ? parseInt(process.env.FAST_CHECK_SEED, 10)
  : process.env.CI
    ? 42
    : undefined
const FC_PARAMS = FC_SEED !== undefined ? { numRuns: 100, seed: FC_SEED } : { numRuns: 100 }

// ─── Mock external dependencies BEFORE importing the service ──
// mergeAndMarkPrimary is pure compute, but the module imports cache/log/queue
// at load time. Mock them so tests stay hermetic and don't require Redis.
vi.mock('../../src/utils/cache.js', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../src/config/bullmq.js', () => ({
  allocationQueue: { add: vi.fn() },
}))

import { AllocationService } from '../../src/modules/allocation/allocation.service.js'

// ─── Arbitraries ───────────────────────────────────────────────

// 6-digit pincode (Indian format), e.g. "560001"
const pincodeArb = fc.integer({ min: 100000, max: 999999 }).map(String)

// Distance in km, finite, in [0, 100]
const distanceArb = fc.double({
  min: 0,
  max: 100,
  noNaN: true,
  noDefaultInfinity: true,
})

// created_at as ISO string, between 2020 and 2030
const createdAtArb = fc
  .date({
    min: new Date('2020-01-01T00:00:00.000Z'),
    max: new Date('2030-01-01T00:00:00.000Z'),
  })
  .map((d) => (isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()))

// One shop entry: a single row that may be inserted into either or both arrays.
//   - membership controls which arrays the shop appears in
//   - pincodeDistance can be null (Req 4.1 — pincode-match without coords)
//   - radiusDistance is always numeric (Req 4.2 — haversine output)
const shopEntryArb = fc.record({
  id: fc.uuid(),
  membership: fc.constantFrom('pincode-only', 'radius-only', 'both'),
  pincodeDistance: fc.oneof(distanceArb, fc.constant(null)),
  radiusDistance: distanceArb,
  created_at: createdAtArb,
})

// Unique-by-id list of 0..10 shops
const shopsArb = fc.uniqueArray(shopEntryArb, {
  selector: (s) => s.id,
  minLength: 0,
  maxLength: 10,
})

// Compose pincode_matches + radius_matches from a single uniqued list.
// Returning the source `shops` lets test bodies look up created_at after
// mergeAndMarkPrimary strips it from the output.
const scenarioArb = fc
  .record({
    pincode: pincodeArb,
    shops: shopsArb,
  })
  .map(({ pincode, shops }) => {
    const pincodeMatches = []
    const radiusMatches = []
    for (const s of shops) {
      if (s.membership === 'pincode-only' || s.membership === 'both') {
        pincodeMatches.push({
          id: s.id,
          distance_km: s.pincodeDistance,
          created_at: s.created_at,
        })
      }
      if (s.membership === 'radius-only' || s.membership === 'both') {
        radiusMatches.push({
          id: s.id,
          distance_km: s.radiusDistance,
          created_at: s.created_at,
        })
      }
    }
    return { pincode, shops, pincodeMatches, radiusMatches }
  })

// ─── Service factory (no real IO) ─────────────────────────────

function makeService() {
  const repo = {
    findByUserId: vi.fn(),
    findShopsByPincode: vi.fn(),
    findShopsByRadius: vi.fn(),
    replaceForUser: vi.fn(),
    findUsersAffectedByShop: vi.fn(),
  }
  return new AllocationService(repo, { queue: { add: vi.fn() } })
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════
// Property 5.1 — Deduplication
// ═══════════════════════════════════════════════════════════════
describe('Property 5: Allocation Computation — deduplication', () => {
  it('every shop_id appears at most once in the result', () => {
    const service = makeService()
    fc.assert(
      fc.property(scenarioArb, ({ pincode, pincodeMatches, radiusMatches }) => {
        const result = service.mergeAndMarkPrimary({
          pincode,
          pincodeMatches,
          radiusMatches,
        })
        const ids = result.map((r) => r.shop_id)
        expect(new Set(ids).size).toBe(ids.length)
      }),
      FC_PARAMS
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 5.2 — Union
// ═══════════════════════════════════════════════════════════════
describe('Property 5: Allocation Computation — union', () => {
  it('result IDs equal union(pincodeIds, radiusIds)', () => {
    const service = makeService()
    fc.assert(
      fc.property(scenarioArb, ({ pincode, pincodeMatches, radiusMatches }) => {
        const result = service.mergeAndMarkPrimary({
          pincode,
          pincodeMatches,
          radiusMatches,
        })
        const expected = new Set([
          ...pincodeMatches.map((r) => r.id),
          ...radiusMatches.map((r) => r.id),
        ])
        const got = new Set(result.map((r) => r.shop_id))
        expect(got).toEqual(expected)
      }),
      FC_PARAMS
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 5.3 — Primary selection
// ═══════════════════════════════════════════════════════════════
describe('Property 5: Allocation Computation — primary selection', () => {
  it('exactly one is_primary=true when non-empty (zero when empty); chosen by smallest distance, ties broken by earliest created_at', () => {
    const service = makeService()
    fc.assert(
      fc.property(
        scenarioArb,
        ({ pincode, shops, pincodeMatches, radiusMatches }) => {
          const result = service.mergeAndMarkPrimary({
            pincode,
            pincodeMatches,
            radiusMatches,
          })

          const primaries = result.filter((r) => r.is_primary === true)

          if (result.length === 0) {
            expect(primaries.length).toBe(0)
            return
          }

          // Exactly one primary
          expect(primaries.length).toBe(1)
          const primary = primaries[0]

          // Re-derive the expected effective distance per merged shop.
          // Service rule: pincode rows seed the slot (and may carry NULL
          // distance); radius rows then either fill a missing slot or replace
          // the slot's distance only when their numeric value is smaller.
          const sourceById = new Map(shops.map((s) => [s.id, s]))

          // Build the same final distance the service computes.
          function effectiveDistance(shop) {
            const inPincode =
              shop.membership === 'pincode-only' || shop.membership === 'both'
            const inRadius =
              shop.membership === 'radius-only' || shop.membership === 'both'

            if (inPincode && inRadius) {
              // pincode seeded with pincodeDistance (possibly null), radius
              // overrides only if numeric-and-smaller (or seed was null).
              const seed = shop.pincodeDistance
              const r = shop.radiusDistance
              if (seed === null) return r
              return r < seed ? r : seed
            }
            if (inPincode) return shop.pincodeDistance
            if (inRadius) return shop.radiusDistance
            return null
          }

          // Recompute primary by scanning merged shops with the same rules
          // the service applies, so we are checking the property — not a
          // restated implementation that could drift.
          const merged = Array.from(
            new Set([
              ...pincodeMatches.map((r) => r.id),
              ...radiusMatches.map((r) => r.id),
            ])
          ).map((id) => {
            const src = sourceById.get(id)
            return {
              shop_id: id,
              distance: effectiveDistance(src),
              created_at_ms: new Date(src.created_at).getTime(),
            }
          })

          // Sort: numeric distances ascending; NULLs last; ties → earliest created_at.
          merged.sort((a, b) => {
            const aNull = a.distance === null
            const bNull = b.distance === null
            if (aNull && !bNull) return 1
            if (!aNull && bNull) return -1
            if (!aNull && !bNull && a.distance !== b.distance) {
              return a.distance - b.distance
            }
            return a.created_at_ms - b.created_at_ms
          })
          const expectedPrimaryId = merged[0].shop_id

          expect(primary.shop_id).toBe(expectedPrimaryId)
        }
      ),
      FC_PARAMS
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 5.4 — NULL distance ranks last
// ═══════════════════════════════════════════════════════════════
describe('Property 5: Allocation Computation — NULL distance ranks last', () => {
  it('a pincode-only match with NULL distance is never primary when any numeric-distance match exists', () => {
    const service = makeService()
    fc.assert(
      fc.property(scenarioArb, ({ pincode, pincodeMatches, radiusMatches }) => {
        const result = service.mergeAndMarkPrimary({
          pincode,
          pincodeMatches,
          radiusMatches,
        })
        if (result.length === 0) return
        const primary = result.find((r) => r.is_primary)
        if (!primary) return
        const hasAnyNumeric = result.some((r) => r.distance_km !== null)
        if (hasAnyNumeric) {
          expect(primary.distance_km).not.toBeNull()
        }
      }),
      FC_PARAMS
    )
  })

  it('explicit scenario: pincode-only NULL vs radius-only numeric → radius shop is primary', () => {
    const service = makeService()
    const result = service.mergeAndMarkPrimary({
      pincode: '560001',
      pincodeMatches: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          distance_km: null,
          created_at: '2020-01-01T00:00:00.000Z',
        },
      ],
      radiusMatches: [
        {
          id: '22222222-2222-2222-2222-222222222222',
          distance_km: 7.5,
          created_at: '2024-01-01T00:00:00.000Z',
        },
      ],
    })
    expect(result).toHaveLength(2)
    const primary = result.find((r) => r.is_primary)
    expect(primary.shop_id).toBe('22222222-2222-2222-2222-222222222222')
    expect(primary.distance_km).toBe(7.5)
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 5.5 — matched_pincode preservation
// ═══════════════════════════════════════════════════════════════
describe('Property 5: Allocation Computation — matched_pincode preservation', () => {
  it('pincode-matched shops carry matched_pincode = P; radius-only shops carry null', () => {
    const service = makeService()
    fc.assert(
      fc.property(
        scenarioArb,
        ({ pincode, shops, pincodeMatches, radiusMatches }) => {
          const result = service.mergeAndMarkPrimary({
            pincode,
            pincodeMatches,
            radiusMatches,
          })
          const sourceById = new Map(shops.map((s) => [s.id, s]))

          for (const row of result) {
            const src = sourceById.get(row.shop_id)
            const inPincode =
              src.membership === 'pincode-only' || src.membership === 'both'
            if (inPincode) {
              expect(row.matched_pincode).toBe(pincode)
            } else {
              expect(row.matched_pincode).toBeNull()
            }
          }
        }
      ),
      FC_PARAMS
    )
  })
})
