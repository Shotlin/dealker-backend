import { describe, expect, it } from 'vitest'
import {
  listRequiresGlobalView, canActOnRider, isHqOnlyActionAllowed, hasResolvedShopForAssignment,
} from '../../../src/modules/admin/riders/riders.authorization.js'

// Pure-function regression coverage for the 2026-09-28 rewrite of
// riders.routes.js's authorization model (was a blanket fastify.requireAdmin
// hook blocking every shop-staff caller — see the module's own doc comment).
// These decisions are the actual security logic; the Fastify preHandlers in
// riders.routes.js are thin, untested-by-design wrappers around them.

describe('listRequiresGlobalView', () => {
  it('requires reports.global_view for an unscoped (HQ, no shop selected) request', () => {
    expect(listRequiresGlobalView(null)).toBe(true)
    expect(listRequiresGlobalView(undefined)).toBe(true)
  })

  it('does not require reports.global_view for a shop-scoped request', () => {
    expect(listRequiresGlobalView('shop-1')).toBe(false)
  })
})

describe('canActOnRider', () => {
  it('always allows an HQ caller (no shop scope), regardless of assignment state', () => {
    expect(canActOnRider({ shopId: null, riderHasActiveAssignment: false })).toBe(true)
    expect(canActOnRider({ shopId: null, riderHasActiveAssignment: true })).toBe(true)
  })

  it('allows a shop-scoped caller only when the rider has an active assignment to that shop', () => {
    expect(canActOnRider({ shopId: 'shop-1', riderHasActiveAssignment: true })).toBe(true)
  })

  it('denies a shop-scoped caller when the rider has no active assignment to that shop', () => {
    expect(canActOnRider({ shopId: 'shop-1', riderHasActiveAssignment: false })).toBe(false)
  })

  it('denies a shop-scoped caller for a rider assigned only to a DIFFERENT shop (the core cross-shop guarantee)', () => {
    // riderHasActiveAssignment is computed by the caller as
    // hasActiveAssignment(riderId, THIS shopId) — a rider assigned
    // exclusively to shop-2 yields false here for a shop-1 caller.
    expect(canActOnRider({ shopId: 'shop-1', riderHasActiveAssignment: false })).toBe(false)
  })
})

describe('isHqOnlyActionAllowed', () => {
  it('allows an HQ caller (no shop scope)', () => {
    expect(isHqOnlyActionAllowed(null)).toBe(true)
  })

  it('denies a shop-scoped caller', () => {
    expect(isHqOnlyActionAllowed('shop-1')).toBe(false)
  })
})

describe('hasResolvedShopForAssignment', () => {
  it('true once a shop is resolved (shop-staff JWT, or HQ + X-Shop-Id)', () => {
    expect(hasResolvedShopForAssignment('shop-1')).toBe(true)
  })

  it('false for an HQ caller with no shop selected — they must pick one first', () => {
    expect(hasResolvedShopForAssignment(null)).toBe(false)
    expect(hasResolvedShopForAssignment(undefined)).toBe(false)
  })
})
