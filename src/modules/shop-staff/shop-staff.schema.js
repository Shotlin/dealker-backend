import { z } from 'zod'

import { PERMISSIONS } from '../../utils/permissions.js'

/**
 * Shop Staff module — Zod validation schemas
 *
 * Mirrors columns and constraints from migration 030_shop_staff.sql, plus the
 * R20 / R16 extensions (canonical Permission_String vocabulary, Temp_Password
 * generation, force_password_change). The legacy `VALID_PERMISSIONS` enum was
 * replaced by the canonical 37-string `PERMISSIONS` set imported from
 * `src/utils/permissions.js` per task 5.2 / R17 AC#1 / R16 AC#17.
 *
 * Requirements: R20.2, R20.3, R20.4, R20.5, R16.16, R16.17, R17.1
 * Design:       §5.5, §6.3
 */

/** Valid shop staff roles (Requirement 2.1, R16.8). */
export const VALID_ROLES = ['SHOP_ADMIN', 'SHOP_MANAGER', 'SHOP_STAFF', 'SHOP_VIEWER']

/**
 * Canonical Permission_String enum used by every staff create/update body
 * (R16 AC#17 / R17 AC#1). The set is materialised as an array for Zod's
 * `z.enum()` constructor — its order is irrelevant since every value is
 * accepted, and de-dup is unnecessary because the upstream set is already
 * unique. The service-layer `assertValidPermissions` defends against direct
 * in-process callers that bypass Zod (R16 AC#17).
 */
export const PERMISSION_ENUM = /** @type {[string, ...string[]]} */ (
  Array.from(PERMISSIONS)
)

// ─── CREATE SHOP STAFF ───────────────────────────────────
//
// Two body shapes are accepted (R20.2):
//   (a) Existing user      — { user_id, role, permissions?, is_active? }
//   (b) New user provision — { email, name, phone?, role,
//                              permissions?, is_active?,
//                              generate_temp_password?, password? }
//
// `shop_id` is NEVER read from the body — the controller resolves it from
// the URL/JWT/header per Shop_Scope_Middleware (R17 AC#4). The legacy
// `shop_id` body parameter is preserved as `.optional()` for backwards
// compatibility with older callers; the service ignores it.
//
// Email is lowercased before persistence (R20 AC#2). We coerce it here so
// every downstream check (case-insensitive uniqueness, audit snapshot)
// observes the canonical form.
const baseStaffFields = {
  shop_id: z.string().uuid().optional(), // legacy — controller resolves authoritative shopId
  role: z.enum(VALID_ROLES),
  permissions: z
    .array(z.enum(PERMISSION_ENUM))
    .max(PERMISSION_ENUM.length)
    .optional(),
  is_active: z.boolean().optional(),
}

const existingUserCreateSchema = z.object({
  ...baseStaffFields,
  user_id: z.string().uuid(),
})

const newUserCreateSchema = z.object({
  ...baseStaffFields,
  // R20 AC#2 — email is RFC-5322-compliant up to 255 chars, lowercased
  // before persistence so the case-insensitive uniqueness check (R20 AC#5)
  // can use a plain `=` comparison.
  email: z
    .string()
    .email('email must be a valid RFC-5322 address')
    .max(255)
    .transform((s) => s.toLowerCase()),
  // R20 AC#2 — full_name 1..200 chars
  name: z.string().trim().min(1).max(200),
  // Optional phone (E.164-style, max 20 chars to match users.phone column).
  phone: z.string().trim().min(1).max(20).optional(),
  // R20 AC#2 — defaults to true so the common flow doesn't need to opt in
  generate_temp_password: z.boolean().default(true),
  // R20 AC#4 — explicit password path (only used when generate_temp_password
  // is false). Validated for length 8..128 and "at least one letter and one
  // digit". A `.refine` chain makes the failure mode unambiguous.
  password: z
    .string()
    .min(8, 'password must be at least 8 characters')
    .max(128, 'password must be at most 128 characters')
    .refine((s) => /[A-Za-z]/.test(s) && /\d/.test(s), {
      message: 'password must contain at least one letter and one digit',
    })
    .optional(),
})

/**
 * Discriminated union of the two body shapes. Zod selects the branch by
 * presence of `user_id` — when present, the existing-user shape is used;
 * otherwise the new-user shape applies and `email` + `name` become
 * required.
 *
 * The union form (rather than a single permissive object) means a stray
 * `email` on an existing-user body will be rejected at validation time,
 * eliminating the "did you mean to create a new user?" ambiguity.
 */
export const createShopStaffSchema = z.union([
  existingUserCreateSchema,
  newUserCreateSchema,
])

// ─── UPDATE SHOP STAFF ───────────────────────────────────
export const updateShopStaffSchema = z
  .object({
    role: z.enum(VALID_ROLES).optional(),
    permissions: z
      .array(z.enum(PERMISSION_ENUM))
      .max(PERMISSION_ENUM.length)
      .optional(),
    is_active: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.role !== undefined ||
      data.permissions !== undefined ||
      data.is_active !== undefined,
    { message: 'At least one of role, permissions, or is_active must be provided' }
  )

// ─── LIST SHOP STAFF QUERY ───────────────────────────────
export const listShopStaffQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  role: z.enum(VALID_ROLES).optional(),
  is_active: z.enum(['true', 'false']).optional(),
  // Requirement 15.3 — Shop Admin opt-in to surface soft-deleted staff
  // records in admin "show deleted" / restoration views. Excluded by default.
  include_deleted: z.enum(['true', 'false']).optional(),
})

// ─── PARAMS ──────────────────────────────────────────────
export const shopStaffIdParamSchema = z.object({
  id: z.string().uuid(),
})
