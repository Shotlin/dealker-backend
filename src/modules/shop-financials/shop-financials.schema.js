import { z } from 'zod'

/**
 * Shop Financials module — Zod validation schemas
 *
 * Mirrors columns and constraints from migration 034_shop_financials.sql.
 * Read-only module: schemas validate query/path params only — writes happen
 * exclusively in the Settlement_Worker (task 9.1) and Payout_Worker (task 9.2).
 *
 * Validates: Requirements 6.1, 6.5, 6.6
 */

// Allowed enums (kept in sync with the DB CHECK constraints)
export const PERIOD_TYPES = ['DAILY', 'WEEKLY', 'MONTHLY']
export const PAYOUT_STATUSES = ['PENDING', 'PROCESSING', 'PAID', 'HELD']

// ─── Helpers ────────────────────────────────────────────
// Strict YYYY-MM-DD ISO date with calendar validation. Rejects malformed
// strings, fictitious dates ("2024-02-30"), and timezone offsets — period
// boundaries are stored as DATE in PostgreSQL, so we compare on date alone.
const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must match YYYY-MM-DD')
  .refine(
    (val) => {
      const [yyyy, mm, dd] = val.split('-').map(Number)
      const d = new Date(Date.UTC(yyyy, mm - 1, dd))
      return (
        d.getUTCFullYear() === yyyy &&
        d.getUTCMonth() === mm - 1 &&
        d.getUTCDate() === dd
      )
    },
    { message: 'Date must be a valid calendar date' }
  )

// ─── LIST QUERY ────────────────────────────────────────
// Requirement 6.6 — pagination default 20, max 100; filter by period_type and
// date range.
export const listShopFinancialsQuerySchema = z
  .object({
    period_type: z.enum(PERIOD_TYPES).optional(),
    from: isoDateString.optional(),
    to: isoDateString.optional(),
    payout_status: z.enum(PAYOUT_STATUSES).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .superRefine((data, ctx) => {
    // Inclusive range: from <= to
    if (data.from && data.to && data.from > data.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: '"to" must be greater than or equal to "from"',
      })
    }
  })

// ─── PATH PARAMS ───────────────────────────────────────
export const shopFinancialIdParamSchema = z.object({
  id: z.string().uuid(),
})
