import { z } from 'zod'

/**
 * Shop Finance module — Zod validation schemas
 * Store-scoped finance endpoints (task 8.8)
 */

export const listTransactionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.string().optional(),
  direction: z.enum(['CREDIT', 'DEBIT']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  order_id: z.string().uuid().optional(),
})

export const financialsQuerySchema = z.object({
  period_type: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  payout_status: z.enum(['PENDING', 'PROCESSING', 'PAID', 'HELD']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const exportQuerySchema = z.object({
  type: z.string().optional(),
  direction: z.enum(['CREDIT', 'DEBIT']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  order_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(10000).default(10000),
})
