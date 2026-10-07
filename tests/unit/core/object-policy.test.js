import { describe, expect, it } from 'vitest'
import {
  assertCustomerResource,
  assertVendorResource,
  assertWarehouseResource,
  assertRiderResource,
} from '../../../src/core/permissions/object-policy.js'

describe('Object Authorization Policy Engine (Spec §6.4, §7.3.2, §11.46.2)', () => {
  describe('assertCustomerResource', () => {
    it('allows matching customer IDs', () => {
      expect(assertCustomerResource('cust-1', 'cust-1')).toBe(true)
    })

    it('allows admin platform user to bypass matching check', () => {
      expect(assertCustomerResource('admin-1', 'cust-2', true)).toBe(true)
    })

    it('throws 403 on mismatching customer IDs for normal user', () => {
      expect(() => assertCustomerResource('cust-1', 'cust-2')).toThrowError(
        /Unauthorized access to customer resource/
      )
    })
  })

  describe('assertVendorResource', () => {
    it('allows matching vendor scope IDs', () => {
      expect(assertVendorResource('v-1', 'v-1')).toBe(true)
    })

    it('allows admin platform user to bypass matching check', () => {
      expect(assertVendorResource('admin-1', 'v-2', true)).toBe(true)
    })

    it('throws 403 on cross-vendor resource access for vendor user', () => {
      expect(() => assertVendorResource('v-1', 'v-2')).toThrowError(
        /Unauthorized cross-vendor resource access/
      )
    })
  })

  describe('assertWarehouseResource', () => {
    it('allows matching warehouse scope IDs', () => {
      expect(assertWarehouseResource('w-1', 'w-1')).toBe(true)
    })

    it('allows admin platform user to bypass matching check', () => {
      expect(assertWarehouseResource('admin-1', 'w-2', true)).toBe(true)
    })

    it('throws 403 on cross-warehouse resource access', () => {
      expect(() => assertWarehouseResource('w-1', 'w-2')).toThrowError(
        /Unauthorized cross-warehouse resource access/
      )
    })
  })

  describe('assertRiderResource', () => {
    it('allows matching rider IDs', () => {
      expect(assertRiderResource('r-1', 'r-1')).toBe(true)
    })

    it('allows admin platform user to bypass matching check', () => {
      expect(assertRiderResource('admin-1', 'r-2', true)).toBe(true)
    })

    it('throws 403 when task is not assigned to rider', () => {
      expect(() => assertRiderResource('r-1', 'r-2')).toThrowError(
        /Delivery task is not assigned to this rider/
      )
    })
  })
})
