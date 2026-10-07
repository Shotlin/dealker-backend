/**
 * Zod-style JSON Schemas for the unified dashboard auth module.
 *
 * Each schema is registered as the route's `schema` config so Fastify's
 * AJV validator rejects malformed bodies with HTTP 400 BEFORE the handler
 * ever runs. This satisfies R18.1 (Zod-validated body for /login),
 * R18.16 (400 VALIDATION_ERROR on schema failure without echoing the
 * submitted password), and R29.3 (case-insensitive email lookup — the
 * email field is just a string, the case-folding happens in the
 * repository's `LOWER(email) = LOWER($1)` query).
 *
 * `additionalProperties: false` on every body schema is intentional:
 * unknown fields are rejected so a forged client cannot smuggle extra
 * keys (e.g. `role`, `permissions`) into the controller layer.
 *
 * Module: src/modules/admin/auth/auth.schema.js
 * Design: §5.1
 */

/**
 * `POST /api/v1/admin/auth/login` body schema.
 *
 * - `email`: RFC-5322-shaped via AJV `format: 'email'`, capped at 255
 *   chars to match the `users.email` column width (R18.1).
 * - `password`: at least 1 char so a blank submission is rejected
 *   without bcrypt running, capped at 200 chars as a defense-in-depth
 *   bound on the verification cost (R18.1 / R18.11).
 *
 * Validator rejections produce 400 VALIDATION_ERROR (R18.16). The
 * Fastify error response surface only carries the violating field
 * path — the submitted `password` value is never echoed back.
 */
export const adminLoginSchema = {
  tags: ['Admin Auth'],
  summary: 'Unified dashboard email + password login',
  body: {
    type: 'object',
    required: ['email', 'password'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', format: 'email', maxLength: 255 },
      password: { type: 'string', minLength: 1, maxLength: 200 },
    },
  },
}

/**
 * `POST /api/v1/admin/auth/select-shop` body schema.
 *
 * Single field `shop_id` (UUID string) — the user picks one of the
 * shops returned by their interim STORE_PENDING login (R18.5/R18.6).
 * `format: 'uuid'` rejects non-UUID strings with 400 VALIDATION_ERROR
 * before the service issues a database lookup.
 */
export const selectShopSchema = {
  tags: ['Admin Auth'],
  summary: 'Upgrade STORE_PENDING token to a final shop-scoped session',
  body: {
    type: 'object',
    required: ['shop_id'],
    additionalProperties: false,
    properties: {
      shop_id: { type: 'string', format: 'uuid' },
    },
  },
}

/**
 * `GET /api/v1/admin/auth/me` schema. The endpoint takes no body or
 * query parameters; the schema exists so OpenAPI / swagger-ui groups
 * the route under the "Admin Auth" tag.
 */
export const meSchema = {
  tags: ['Admin Auth'],
  summary: 'Fetch current dashboard user, role context, and shops',
}

/**
 * `POST /api/v1/admin/auth/change-password` body schema.
 *
 * - `currentPassword`: 1–200 chars. The actual length floor is
 *   meaningless for verification (bcrypt accepts anything), but
 *   enforcing `minLength: 1` rejects accidental blank submissions
 *   without a database round-trip.
 * - `newPassword`: 12–200 chars per design §5.5. The service repeats
 *   the length check defensively in case any non-route caller bypasses
 *   this layer.
 *
 * No password value (current or new) is ever echoed in error
 * responses — Fastify's default validation error surface only lists
 * the violating field paths (R18.16).
 */
export const changePasswordSchema = {
  tags: ['Admin Auth'],
  summary: 'Change the authenticated user password (rotates session)',
  body: {
    type: 'object',
    required: ['currentPassword', 'newPassword'],
    additionalProperties: false,
    properties: {
      currentPassword: { type: 'string', minLength: 1, maxLength: 200 },
      newPassword: { type: 'string', minLength: 12, maxLength: 200 },
    },
  },
}

/**
 * Legacy alias preserved for backward compatibility.
 *
 * The previous `PUT /api/v1/admin/auth/password` route imported
 * `setPasswordSchema` from this module. The route has been retired
 * in favour of `POST /change-password`, but the export stays so any
 * external import paths (e.g. tests) keep resolving until they are
 * migrated. New code should import `changePasswordSchema` directly.
 *
 * @deprecated since multi-vendor task 3.6 — use {@link changePasswordSchema}.
 */
export const setPasswordSchema = changePasswordSchema
