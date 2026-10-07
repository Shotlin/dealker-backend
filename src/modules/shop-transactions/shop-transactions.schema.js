import { z } from 'zod'

/**
 * Shop Transactions module — Zod validation schemas
 *
 * Mirrors columns and CHECK constraints from migration
 * 035_shop_transactions.sql.
 *
 * Validates: Requirements 7.1, 7.2, 7.10
 *
 * NOTE: This module is read-only at the API layer (Requirement 7.4).
 * No create/update/delete request bodies exist — internal callers (orders,
 * refunds, payouts) use `LedgerWriteService.append(client, data)` directly,
 * which validates with `ledgerAppendDataSchema` below.
 */

// ─── Allowed enum values (mirror DB CHECK constraints) ──
// V2 types (R24.1) + legacy types preserved for read-back (R24.15)
export const TRANSACTION_TYPES = [
  'ORDER_REVENUE',
  'PLATFORM_COMMISSION',
  'DELIVERY_FEE',
  'RIDER_COST',
  'COUPON_DISCOUNT',
  'TAX',
  'REFUND',
  'PAYOUT',
  'ADJUSTMENT',
  // Legacy (read-only, still accepted by DB CHECK)
  'COMMISSION_DEBIT',
  'DELIVERY_COST',
  'REFUND_DEBIT',
  'PAYOUT_CREDIT',
  'EXPENSE',
]

export const REFERENCE_TYPES = ['ORDER', 'PAYOUT', 'ADJUSTMENT', 'EXPENSE', 'REFUND', 'COUPON', 'TAX']

// Credits add to the running balance (Requirement 7.7)
export const CREDIT_TYPES = new Set([
  'ORDER_REVENUE',
  'DELIVERY_FEE',
  'PAYOUT_CREDIT',
  'ADJUSTMENT',
])

// Debits subtract from the running balance (Requirement 7.7)
export const DEBIT_TYPES = new Set([
  'PLATFORM_COMMISSION',
  'RIDER_COST',
  'COUPON_DISCOUNT',
  'TAX',
  'REFUND',
  'PAYOUT',
  'COMMISSION_DEBIT',
  'DELIVERY_COST',
  'REFUND_DEBIT',
  'EXPENSE',
])

// Amount range from the DB CHECK constraint (Requirement 7.1)
const AMOUNT_MIN = 0.01
const AMOUNT_MAX = 99999999.99

// ─── LIST QUERY (GET /api/v1/shop-transactions) ─────────
// Pagination max 100/page (project standard, Requirement 14.7 family).
export const listShopTransactionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  type: z.enum(TRANSACTION_TYPES).optional(),
  reference_type: z.enum(REFERENCE_TYPES).optional(),
  reference_id: z.string().uuid().optional(),
  // ISO 8601 timestamps. Coerced into Date for the repository.
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})

// ─── PARAMS ──────────────────────────────────────────────
export const shopTransactionIdParamSchema = z.object({
  id: z.string().uuid(),
})

// ─── INTERNAL: LedgerWriteService.append() input ─────────
// Used by orders / refunds / payouts modules. Not exposed via HTTP.
export const ledgerAppendDataSchema = z
  .object({
    shopId: z.string().uuid(),
    type: z.enum(TRANSACTION_TYPES),
    amount: z.number().min(AMOUNT_MIN).max(AMOUNT_MAX),
    referenceType: z.enum(REFERENCE_TYPES),
    referenceId: z.string().uuid().nullable().optional(),
    description: z.string().max(500).nullable().optional(),
    createdBy: z.string().uuid().nullable().optional(),
  })
  .strict()

// ─── INTERNAL: LedgerWriteService.recordEntry() input ────
// Snake_case canonical surface used by orders / refunds / payouts modules.
// Mirrors the column names in shop_transactions for ergonomic call sites.
export const ledgerRecordEntrySchema = z
  .object({
    shop_id: z.string().uuid(),
    type: z.enum(TRANSACTION_TYPES),
    amount: z.number().min(AMOUNT_MIN).max(AMOUNT_MAX),
    reference_type: z.enum(REFERENCE_TYPES),
    reference_id: z.string().uuid().nullable().optional(),
    description: z.string().max(500).nullable().optional(),
    created_by: z.string().uuid().nullable().optional(),
  })
  .strict()

// ─── INTERNAL: LedgerWriteService.recordPair() input ─────
// Convenience for Req 7.5 — order completion records ORDER_REVENUE +
// COMMISSION_DEBIT atomically. `commission_rate` is a percentage in [0, 100].
export const ledgerRecordPairSchema = z
  .object({
    shop_id: z.string().uuid(),
    revenue_amount: z.number().min(AMOUNT_MIN).max(AMOUNT_MAX),
    commission_rate: z.number().min(0).max(100),
    reference_id: z.string().uuid().nullable().optional(),
    description: z.string().max(500).nullable().optional(),
    created_by: z.string().uuid().nullable().optional(),
  })
  .strict()
