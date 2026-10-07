import { z } from 'zod'
import { cleanPincodeList, isValidPincode } from '../../utils/pincode.js'

/**
 * Shops module — Zod validation schemas
 */

// Service-area PIN list. Serviceability matches PINs by exact string equality,
// so the list is normalised at the API boundary: whitespace stripped, blanks
// dropped, duplicates removed (order kept). Anything left that is not a valid
// 6-digit PIN is rejected with an explicit message rather than being stored
// as an entry that can never match a customer.
const serviceablePincodesField = z
  .array(z.string())
  .transform(cleanPincodeList)
  .refine((pins) => pins.every(isValidPincode), {
    message: 'Each serviceable pincode must be a valid 6-digit PIN code',
  })

// ─── CREATE SHOP ─────────────────────────────────────────
export const createShopSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  logo_url: z.string().url().optional(),
  banner_url: z.string().url().optional(),
  phone: z.string().max(15).optional(),
  email: z.string().email().max(255).optional(),
  address_line1: z.string().min(1).max(255),
  address_line2: z.string().max(255).optional(),
  city: z.string().min(1).max(100),
  state: z.string().min(1).max(100),
  pincode: z.string().min(1).max(10),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  serviceable_pincodes: serviceablePincodesField.default([]),
  delivery_radius_km: z.number().min(0.5).max(100).default(5.0),
  // When true, this shop is matchable ONLY via serviceable_pincodes —
  // delivery_radius_km is never used as a fallback match (migration 086).
  pincode_only: z.boolean().default(false),
  operating_hours: z.record(z.any()).default({}),
  commission_rate: z.number().min(0).max(100).default(10.0),
  bank_account_number: z.string().max(20).optional(),
  bank_ifsc: z.string().max(15).optional(),
  bank_name: z.string().max(100).optional(),
  bank_holder_name: z.string().max(100).optional(),
  gst_number: z.string().max(20).optional(),
  pan_number: z.string().max(15).optional(),
})

// ─── UPDATE SHOP ─────────────────────────────────────────
export const updateShopSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional().nullable(),
  logo_url: z.string().url().optional().nullable(),
  banner_url: z.string().url().optional().nullable(),
  phone: z.string().max(15).optional().nullable(),
  email: z.string().email().max(255).optional().nullable(),
  address_line1: z.string().min(1).max(255).optional(),
  address_line2: z.string().max(255).optional().nullable(),
  city: z.string().min(1).max(100).optional(),
  state: z.string().min(1).max(100).optional(),
  pincode: z.string().min(1).max(10).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  serviceable_pincodes: serviceablePincodesField.optional(),
  delivery_radius_km: z.number().min(0.5).max(100).optional(),
  pincode_only: z.boolean().optional(),
  is_active: z.boolean().optional(),
  is_verified: z.boolean().optional(),
  operating_hours: z.record(z.any()).optional(),
  commission_rate: z.number().min(0).max(100).optional(),
  bank_account_number: z.string().max(20).optional().nullable(),
  bank_ifsc: z.string().max(15).optional().nullable(),
  bank_name: z.string().max(100).optional().nullable(),
  bank_holder_name: z.string().max(100).optional().nullable(),
  gst_number: z.string().max(20).optional().nullable(),
  pan_number: z.string().max(15).optional().nullable(),
})

// ─── LIST SHOPS QUERY ────────────────────────────────────
export const listShopsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  city: z.string().max(100).optional(),
  is_active: z.enum(['true', 'false']).optional(),
  search: z.string().max(200).optional(),
  // Requirement 15.3 — Super Admin opt-in to surface soft-deleted shops in
  // admin "show deleted" / restoration views. Excluded by default.
  include_deleted: z.enum(['true', 'false']).optional(),
})

// ─── PARAMS ──────────────────────────────────────────────
export const shopIdParamSchema = z.object({
  id: z.string().uuid(),
})
