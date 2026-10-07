import { z } from 'zod'

/**
 * Admin Finance module — Zod validation schemas
 * HQ-scoped finance endpoints (task 8.9)
 */

export const listShopsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(200).optional(),
  has_pending_payout: z.coerce.boolean().optional(),
})

export const shopTransactionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.string().optional(),
  direction: z.enum(['CREDIT', 'DEBIT']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})

export const shopFinancialsQuerySchema = z.object({
  period_type: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  payout_status: z.enum(['PENDING', 'PROCESSING', 'PAID', 'HELD']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const shopIdParamSchema = z.object({
  shopId: z.string().uuid(),
})

export const markPaidParamSchema = z.object({
  shopId: z.string().uuid(),
  periodId: z.string().uuid(),
})

export const payoutReportQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  payout_status: z.enum(['PENDING', 'PROCESSING', 'PAID', 'HELD']).optional(),
  limit: z.coerce.number().int().min(1).max(10000).default(10000),
})

export const listTransactionsFlatQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  shop_id: z.string().uuid().optional(),
  type: z.string().optional(),
  direction: z.enum(['CREDIT', 'DEBIT']).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
})

export const listFinancialsFlatQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  shop_id: z.string().uuid().optional(),
  period_type: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']).optional(),
  payout_status: z.enum(['PENDING', 'PROCESSING', 'PAID', 'HELD']).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

export const financialIdParamSchema = z.object({
  id: z.string().uuid(),
})

export const runSettlementSchema = z.object({
  shopId: z.string().uuid().optional(),
  periodDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

export const comparisonQuerySchema = z.object({
  period_type: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']).default('DAILY'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
