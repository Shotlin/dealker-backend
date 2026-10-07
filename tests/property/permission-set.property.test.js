// Task 2.8 — Permission Set Vocabulary Property
// **Property:** For any random JWT + permission pair, the computed effective
// set never contains a string outside the 37-value vocabulary.
//
// The canonical 37-string Permission_String vocabulary is defined in
// `src/utils/permissions.js` (PERMISSIONS / CANONICAL_PERMISSIONS). The
// `computeEffectivePermissions` function in `src/middlewares/permission-check.js`
// resolves a user's effective permission set from either:
//   - HQ_ROLE_PERMISSIONS[platform_role] (frozen canonical sets), or
//   - partitionShopPermissions(user.permissions).valid (filtered to canonical)
//
// This property test asserts that NO element of the returned Set can ever
// fall outside the canonical vocabulary, regardless of what garbage the JWT
// `permissions` array contains.
//
// Sub-properties:
//   2.8.A — HQ users: effective set ⊆ PERMISSIONS for every HQ role.
//   2.8.B — Shop staff with arbitrary permissions array: effective set ⊆ PERMISSIONS.
//   2.8.C — Null/undefined/missing user: effective set is empty.
//   2.8.D — Mixed valid + invalid permissions: only valid ones survive.

import { describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'

// ─── Mock dependencies before importing ───────────────────────
vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  computeEffectivePermissions,
  partitionShopPermissions,
} from '../../src/middlewares/permission-check.js'
import {
  PERMISSIONS,
  HQ_ROLES,
  HQ_ROLE_PERMISSIONS,
} from '../../src/utils/permissions.js'

// ─── Arbitraries ──────────────────────────────────────────────

// The canonical 37-value vocabulary as an array for sampling
const VOCAB_ARRAY = Array.from(PERMISSIONS)

// A valid permission string (drawn from the vocabulary)
const validPermArb = fc.constantFrom(...VOCAB_ARRAY)

// An invalid permission string (random string NOT in the vocabulary)
const invalidPermArb = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => !PERMISSIONS.has(s))

// Non-string garbage that might appear in a corrupted JWT
const garbageArb = fc.oneof(
  fc.integer(),
  fc.constant(null),
  fc.constant(undefined),
  fc.boolean(),
  fc.float(),
  fc.object(),
  fc.array(fc.integer(), { maxLength: 3 })
)

// A mixed permissions array: some valid, some invalid, some garbage
const mixedPermissionsArb = fc.array(
  fc.oneof(validPermArb, invalidPermArb, garbageArb),
  { minLength: 0, maxLength: 50 }
)

// HQ role arbitrary
const hqRoleArb = fc.constantFrom(...HQ_ROLES)

// ─── Seed for reproducibility ─────────────────────────────────
const SEED = 20240101
const NUM_RUNS = 100

// ═══════════════════════════════════════════════════════════════
// Property 2.8.A — HQ users: effective set ⊆ PERMISSIONS
// ═══════════════════════════════════════════════════════════════
describe('Property 2.8: Permission Set Vocabulary — HQ users', () => {
  it('for any HQ role, every element of the effective set is in the 37-value vocabulary', () => {
    fc.assert(
      fc.property(hqRoleArb, (role) => {
        const user = { platform_role: role }
        const effective = computeEffectivePermissions(user)

        for (const perm of effective) {
          expect(PERMISSIONS.has(perm)).toBe(true)
        }

        // Also verify it matches the frozen role map (or empty set if unmapped)
        const expected = HQ_ROLE_PERMISSIONS[role] || new Set()
        expect(effective).toEqual(expected)
      }),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 2.8.B — Shop staff: effective set ⊆ PERMISSIONS
// ═══════════════════════════════════════════════════════════════
describe('Property 2.8: Permission Set Vocabulary — shop staff', () => {
  it('for any arbitrary permissions array, the effective set contains only canonical strings', () => {
    fc.assert(
      fc.property(mixedPermissionsArb, (permissions) => {
        const user = { permissions }
        const effective = computeEffectivePermissions(user)

        // Every element in the effective set MUST be in the vocabulary
        for (const perm of effective) {
          expect(typeof perm).toBe('string')
          expect(PERMISSIONS.has(perm)).toBe(true)
        }
      }),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })

  it('invalid strings are always filtered out — effective set size ≤ valid input count', () => {
    fc.assert(
      fc.property(mixedPermissionsArb, (permissions) => {
        const user = { permissions }
        const effective = computeEffectivePermissions(user)

        // Count how many inputs are actually valid
        const validCount = permissions.filter(
          (p) => typeof p === 'string' && PERMISSIONS.has(p)
        ).length

        // Effective set size cannot exceed the number of valid inputs
        // (it may be less due to deduplication)
        expect(effective.size).toBeLessThanOrEqual(validCount)
      }),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 2.8.C — Null/undefined/missing user: empty set
// ═══════════════════════════════════════════════════════════════
describe('Property 2.8: Permission Set Vocabulary — null/undefined user', () => {
  it('null, undefined, or empty user always produces an empty effective set', () => {
    const nullishArb = fc.constantFrom(null, undefined, {}, { permissions: null })

    fc.assert(
      fc.property(nullishArb, (user) => {
        const effective = computeEffectivePermissions(user)
        expect(effective.size).toBe(0)
      }),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 2.8.D — partitionShopPermissions: valid ⊆ PERMISSIONS
// ═══════════════════════════════════════════════════════════════
describe('Property 2.8: Permission Set Vocabulary — partitionShopPermissions', () => {
  it('for any mixed array, valid partition contains only canonical strings and invalid contains the rest', () => {
    fc.assert(
      fc.property(mixedPermissionsArb, (permissions) => {
        const { valid, invalid } = partitionShopPermissions(permissions)

        // Every valid element is in the vocabulary
        for (const perm of valid) {
          expect(typeof perm).toBe('string')
          expect(PERMISSIONS.has(perm)).toBe(true)
        }

        // Every invalid element is NOT a canonical string
        for (const perm of invalid) {
          const isCanonical = typeof perm === 'string' && PERMISSIONS.has(perm)
          expect(isCanonical).toBe(false)
        }

        // valid.size + invalid.length accounts for all unique valid + all invalid
        // (valid is a Set so duplicates collapse)
        const uniqueValidInInput = new Set(
          permissions.filter((p) => typeof p === 'string' && PERMISSIONS.has(p))
        )
        expect(valid.size).toBe(uniqueValidInInput.size)
        expect(invalid.length).toBe(
          permissions.filter(
            (p) => !(typeof p === 'string' && PERMISSIONS.has(p))
          ).length
        )
      }),
      { numRuns: NUM_RUNS, seed: SEED }
    )
  })
})
