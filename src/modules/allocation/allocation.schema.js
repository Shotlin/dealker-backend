import { z } from 'zod'

/**
 * Allocation module — Zod validation schemas
 *
 * Validates: Requirements 4.1, 4.2, 4.6
 *
 * The recompute endpoint accepts either:
 *   - Self-recompute by an authenticated user (user_id is implied; the
 *     request may pass a fresh address payload to use instead of
 *     looking up the user's default address).
 *   - Admin-triggered recompute on behalf of a user_id, with optional
 *     explicit coordinates/pincode (Requirement 4.6 — coordinates are
 *     required to compute haversine distance).
 */

// ─── ADDRESS PAYLOAD ─────────────────────────────────────
// Coordinates and pincode are required together when an address is supplied
// inline. Lat must be in [-90, 90], lng in [-180, 180]; pincode is captured
// as a free-form string up to 10 chars to match shops.serviceable_pincodes.
export const allocationAddressSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  pincode: z.string().min(1).max(10),
})

// ─── RECOMPUTE BODY ──────────────────────────────────────
// Both fields optional; the controller infers user_id from the JWT when not
// provided. ADMIN role can target any user; other roles can only target self
// (enforced in the controller).
export const recomputeBodySchema = z.object({
  user_id: z.string().uuid().optional(),
  address: allocationAddressSchema.optional(),
})

// ─── PARAMS ──────────────────────────────────────────────
export const userIdParamSchema = z.object({
  user_id: z.string().uuid(),
})
