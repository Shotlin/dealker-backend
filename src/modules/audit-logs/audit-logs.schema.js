import { z } from 'zod'

/**
 * Audit Logs module — Zod validation schemas.
 *
 * Mirrors the columns of `audit_logs` (migration 043) and the read-endpoint
 * filter set defined in design §12.3. The HQ reader at
 * GET /api/v1/admin/audit-logs (task 10.2) and the shop-scoped reader at
 * GET /api/v1/shop-audit-logs (task 10.3) both consume
 * {@link listAuditLogsQuerySchema} — the only difference between the two
 * endpoints is the additional WHERE predicate the service appends for shop
 * scope, not the validation surface.
 *
 * NOTE: This module is **read-only at the API layer** (R28.3, design §10 +
 * §12.4). No create/update/delete request bodies exist — the application
 * INSERT path lives in `src/utils/audit-log.js` and is invoked from every
 * mutating service.
 *
 * Requirements: R28.3, R28.6
 * Design:       §10, §12.3 of .kiro/specs/multi-vendor-system/design.md
 */

// ─── LIST QUERY ───────────────────────────────────────────
// Used by GET /api/v1/admin/audit-logs (HQ, task 10.2) and
// GET /api/v1/shop-audit-logs (shop-scoped, task 10.3). Pagination defaults
// follow the project standard: 20 per page, max 100 (R28.6, R28.7).
export const listAuditLogsQuerySchema = z.object({
  // Pagination — coerced because Fastify query strings arrive as strings.
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),

  // Filters from R28 AC#6 / AC#7. All optional and combined with AND.
  actor_user_id: z.string().uuid().optional(),
  actor_shop_id: z.string().uuid().optional(),
  // target_type / action are free-form in the DB (no CHECK constraint per
  // migration 043 so new vocabulary lands without a migration). We still
  // length-limit them defensively to stay inside the column widths.
  target_type: z.string().min(1).max(50).optional(),
  target_id: z.string().uuid().optional(),
  action: z.string().min(1).max(80).optional(),

  // Date range — ISO 8601 timestamps coerced to Date for the repository.
  // Both bounds are inclusive at the SQL layer (created_at >= from AND
  // created_at <= to); the controller may additionally enforce from <= to.
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})
