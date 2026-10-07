import { z } from 'zod'

/**
 * Shop Orders module — Zod validation schemas
 *
 * Maps to design §6.5 / §7 of the multi-vendor-system spec. The module
 * is a thin wrapper over the existing `orders` table, scoped to the
 * caller's shop_id. All inputs go through Zod here so the controller
 * stays free of validation noise.
 *
 * Requirements: R22.3, R22.4, R22.5, R22.6, R22.7, R22.8, R22.9,
 *               R22.10, R22.11, R22.12, R22.13, R22.14
 * Design:       §6.5, §7
 */

const ORDER_STATUSES = /** @type {[string, ...string[]]} */ ([
  'PENDING',
  'CONFIRMED',
  'PREPARING',
  'PACKED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
  'REFUNDED',
])

const PAYMENT_STATUSES = /** @type {[string, ...string[]]} */ ([
  'PENDING',
  'PAID',
  'FAILED',
  'REFUNDED',
])

/** ISO-8601 datetime string accepted on `created_at_from` / `created_at_to`. */
const isoDatetime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: 'must be a valid ISO-8601 datetime',
  })

// ── GET /shop-orders — list filters (R22 AC#3, AC#4) ─────────────
export const listOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(ORDER_STATUSES).optional(),
  payment_status: z.enum(PAYMENT_STATUSES).optional(),
  created_at_from: isoDatetime.optional(),
  created_at_to: isoDatetime.optional(),
  q: z.string().trim().min(1).max(200).optional(),
})

// ── GET /shop-orders/export — same filters as listing (R22 AC#12)
export const exportOrdersQuerySchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  payment_status: z.enum(PAYMENT_STATUSES).optional(),
  created_at_from: isoDatetime.optional(),
  created_at_to: isoDatetime.optional(),
  q: z.string().trim().min(1).max(200).optional(),
})

// ── :orderId path param ──────────────────────────────────────────
export const orderIdParamSchema = z.object({
  orderId: z.string().uuid(),
})

// ── POST /:orderId/assign-rider (R22 AC#8) ───────────────────────
export const assignRiderBodySchema = z.object({
  rider_id: z.string().uuid(),
})

// ── POST /:orderId/cancel — { reason } 10..500 chars (R22 AC#14) ──
export const cancelOrderBodySchema = z.object({
  reason: z.string().trim().min(10).max(500),
})

// ── POST /:orderId/refund — { reason, amount } (R22 AC#10/AC#14) ─
export const refundOrderBodySchema = z.object({
  reason: z.string().trim().min(10).max(500),
  amount: z.coerce
    .number()
    .positive({ message: 'amount must be greater than zero' })
    .max(1_000_000, { message: 'amount is unreasonably large' }),
})

// ── GET /shop-orders/riders — pagination only (R25 AC#6) ─────────
export const ridersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
