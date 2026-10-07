import { z } from 'zod'

/**
 * Shop Products module — Zod validation schemas
 * Mirrors columns and constraints from migration 031_shop_products.sql
 *
 * Validates: Requirements 3.1, 3.2, 3.5, 3.7, 3.9, 12.1, 12.6
 */

// Numeric ranges from the DB CHECK constraints
const PRICE_MIN = 0.01
const PRICE_MAX = 99999999.99
const COST_PRICE_MIN = 0
const STOCK_MIN = 0
const STOCK_MAX = 2147483647 // INT4 max
const LOW_STOCK_MIN = 0
const MAX_ORDER_QTY_MIN = 1
const MAX_ORDER_QTY_MAX = 10000

// ─── CREATE SHOP PRODUCT ─────────────────────────────────
// shop_id is derived from request.shopId (JWT/header) by the controller —
// the body provides product-specific fields only.
export const createShopProductSchema = z
  .object({
    product_id: z.string().uuid(),
    price: z.number().min(PRICE_MIN).max(PRICE_MAX).optional().nullable(),
    sale_price: z.number().min(PRICE_MIN).max(PRICE_MAX).optional().nullable(),
    cost_price: z.number().min(COST_PRICE_MIN).max(PRICE_MAX).optional().nullable(),
    wholesale_price: z.number().min(PRICE_MIN).max(PRICE_MAX).optional().nullable(),
    stock_quantity: z.number().int().min(STOCK_MIN).max(STOCK_MAX).default(0),
    low_stock_threshold: z.number().int().min(LOW_STOCK_MIN).default(5),
    max_order_qty: z
      .number()
      .int()
      .min(MAX_ORDER_QTY_MIN)
      .max(MAX_ORDER_QTY_MAX)
      .default(50),
    is_available: z.boolean().default(true),
    is_featured: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    // Requirement 3.9 — sale_price must be < price when both are set
    if (
      data.price !== undefined &&
      data.price !== null &&
      data.sale_price !== undefined &&
      data.sale_price !== null &&
      data.sale_price >= data.price
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sale_price'],
        message: 'sale_price must be less than price',
      })
    }
  })

// ─── UPDATE SHOP PRODUCT ─────────────────────────────────
// Excludes stock_quantity (use the dedicated stock-update endpoint that takes
// SELECT FOR UPDATE row-level locks — Requirement 3.8).
export const updateShopProductSchema = z
  .object({
    price: z.number().min(PRICE_MIN).max(PRICE_MAX).optional().nullable(),
    sale_price: z.number().min(PRICE_MIN).max(PRICE_MAX).optional().nullable(),
    cost_price: z.number().min(COST_PRICE_MIN).max(PRICE_MAX).optional().nullable(),
    wholesale_price: z.number().min(PRICE_MIN).max(PRICE_MAX).optional().nullable(),
    low_stock_threshold: z.number().int().min(LOW_STOCK_MIN).optional(),
    max_order_qty: z
      .number()
      .int()
      .min(MAX_ORDER_QTY_MIN)
      .max(MAX_ORDER_QTY_MAX)
      .optional(),
    is_available: z.boolean().optional(),
    is_featured: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.price !== undefined ||
      data.sale_price !== undefined ||
      data.cost_price !== undefined ||
      data.wholesale_price !== undefined ||
      data.low_stock_threshold !== undefined ||
      data.max_order_qty !== undefined ||
      data.is_available !== undefined ||
      data.is_featured !== undefined,
    { message: 'At least one field must be provided' }
  )

// ─── STOCK UPDATE ────────────────────────────────────────
// Two modes: absolute set (`stock_quantity`) or delta (`delta`, +/-).
// Either-or: exactly one must be provided.
export const stockUpdateSchema = z
  .object({
    stock_quantity: z.number().int().min(STOCK_MIN).max(STOCK_MAX).optional(),
    delta: z.number().int().optional(),
    reason: z.string().max(200).optional(),
  })
  .refine(
    (data) =>
      (data.stock_quantity !== undefined && data.delta === undefined) ||
      (data.stock_quantity === undefined && data.delta !== undefined),
    { message: 'Exactly one of stock_quantity or delta must be provided' }
  )

// ─── LIST QUERY ──────────────────────────────────────────
export const listShopProductsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  is_available: z.enum(['true', 'false']).optional(),
  low_stock: z.enum(['true', 'false']).optional(),
  search: z.string().max(200).optional(),
  include_deleted: z.enum(['true', 'false']).optional(),
})

// ─── PARAMS ──────────────────────────────────────────────
export const shopProductIdParamSchema = z.object({
  id: z.string().uuid(),
})

export const shopProductRouteParamsSchema = z.object({
  shopId: z.string().uuid(),
  productId: z.string().uuid(),
})

// ─── ADJUST STOCK (R23.8, R23.9, R23.14) ─────────────────
// POST /api/v1/shops/:shopId/products/:productId/adjust-stock
// Stock_Movement_Type vocabulary is restricted to operator-driven values;
// system flows (ORDER_DEDUCTION, CANCELLATION_RESTORE) write directly via
// repo.applyStockChange and never come through this endpoint.
//
// `quantity_delta` is a non-zero signed INTEGER (delta to apply with
// SELECT FOR UPDATE per design §8.1). The reason is mandatory and length-
// bounded so the audit trail (stock_changed) carries operator context
// without unbounded growth.
//
// Validates: Requirements R23.8, R23.9, R23.14
export const adjustStockSchema = z.object({
  quantity_delta: z
    .number()
    .int()
    .refine((v) => v !== 0, { message: 'quantity_delta must be non-zero' }),
  type: z.enum(['MANUAL_ADJUSTMENT', 'DAMAGED_STOCK', 'RETURN_STOCK']),
  reason: z.string().min(5).max(500),
})

// ─── MANUAL INVENTORY LOT BACKFILL ───────────────────────
// POST /api/v1/shops/:shopId/products/:productId/inventory-lots/manual
// Records a vendor batch (name, quantity, expiry, optional video) for stock
// that never came through the real Vendor Procurement receiving pipeline
// (§7.5.1) — the lot itself is always tagged `is_manual_entry`, so it can
// never be mistaken for a real vendor-procurement lot downstream.
// ─── LOOKUP INVENTORY LOTS FOR A NOT-YET-ADDED PRODUCT ──
// GET /api/v1/shops/:shopId/products/lookup-inventory-lots?productId=…
// "Add Product to Shop" counterpart to GET /shop-products/:id/inventory-lots
// — looks up real vendor-received batches for a master catalog product
// that hasn't been added to this shop yet (no shop_products id exists).
export const shopIdOnlyParamSchema = z.object({
  shopId: z.string().uuid(),
})

export const lookupInventoryLotsQuerySchema = z.object({
  productId: z.string().uuid(),
})

export const createManualInventoryLotSchema = z.object({
  vendor_name: z.string().trim().min(2).max(255),
  quantity: z.number().positive().max(STOCK_MAX),
  expiry_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expiry_date must be YYYY-MM-DD'),
  video_url: z.string().trim().url().max(2048).optional().or(z.literal('')),
  batch_reference: z.string().trim().max(50).optional().or(z.literal('')),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
  also_add_to_stock: z.boolean().optional().default(false),
})

// ─── BULK PRICE UPDATE (R23.12) ──────────────────────────
// POST /api/v1/shops/:shopId/products/bulk-price-update
// At least one of price/sale_price/cost_price MUST be provided per item;
// stock is never touched (price-only — design §8.1 explicitly notes the
// bulk endpoint never invokes applyStockChange). Capped at 500 items per
// transaction so the lock window stays bounded on the 2-core server.
//
// Validates: Requirement R23.12
const bulkPriceItemSchema = z
  .object({
    product_id: z.string().uuid(),
    price: z.number().min(PRICE_MIN).max(PRICE_MAX).optional(),
    sale_price: z.number().min(PRICE_MIN).max(PRICE_MAX).optional(),
    cost_price: z.number().min(COST_PRICE_MIN).max(PRICE_MAX).optional(),
  })
  .refine(
    (item) =>
      item.price !== undefined ||
      item.sale_price !== undefined ||
      item.cost_price !== undefined,
    {
      message:
        'At least one of price, sale_price, or cost_price must be provided',
      path: ['price'],
    }
  )
  .refine(
    (item) =>
      item.price === undefined ||
      item.sale_price === undefined ||
      Number(item.sale_price) < Number(item.price),
    {
      message: 'sale_price must be less than price',
      path: ['sale_price'],
    }
  )

export const bulkPriceUpdateSchema = z.object({
  items: z.array(bulkPriceItemSchema).min(1).max(500),
})

// ─── STOCK MOVEMENTS LIST QUERY (R23.5) ──────────────────
// GET /api/v1/shops/:shopId/stock-movements
// Filters: product_id, type, date range, actor_user_id; paginated default
// 20 / max 100, default sort created_at DESC handled at the repository.
//
// Validates: Requirement R23.5
export const listStockMovementsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    product_id: z.string().uuid().optional(),
    type: z
      .enum([
        'MANUAL_ADJUSTMENT',
        'ORDER_DEDUCTION',
        'CANCELLATION_RESTORE',
        'DAMAGED_STOCK',
        'RETURN_STOCK',
      ])
      .optional(),
    actor_user_id: z.string().uuid().optional(),
    from_date: z.coerce.date().optional(),
    to_date: z.coerce.date().optional(),
  })
  .refine(
    (q) =>
      q.from_date === undefined ||
      q.to_date === undefined ||
      q.from_date <= q.to_date,
    { message: 'from_date must be on or before to_date', path: ['from_date'] }
  )

// ─── ADMIN: APPROVE / REJECT (R23.10, R23.11) ────────────
// POST /api/v1/admin/shop-products/:id/approve   — empty body accepted
// POST /api/v1/admin/shop-products/:id/reject    — { reason }
//
// Approve has no body fields; we expose an empty schema so the controller
// can validate consistently (rejects unexpected fields).
//
// Reject accepts a 10-500 char reason per R23.11.
//
// Validates: Requirements R23.10, R23.11
export const approveShopProductSchema = z.object({}).strict()

export const rejectShopProductSchema = z.object({
  reason: z.string().min(10).max(500),
})

export const adminShopProductIdParamSchema = z.object({
  id: z.string().uuid(),
})

// ─── MANUAL PRODUCT CREATE (R23.15, R23.17) ──────────────
// POST /api/v1/shops/:shopId/products/manual
// Creates a master Product + Shop_Product + initial stock_movement in
// a single transaction. The Dashboard uploads images first via the
// existing upload service to obtain image_ids, then submits this body.
//
// Validates: Requirements R23.15, R23.17, R23.25
export const manualCreateProductSchema = z
  .object({
    name: z.string().min(1).max(255),
    brand: z.string().max(200).optional().nullable(),
    unit: z.string().max(20).default('piece'),
    description: z.string().max(5000).optional().nullable(),
    category_id: z.string().uuid().optional().nullable(),
    price: z.number().min(PRICE_MIN).max(PRICE_MAX),
    sale_price: z.number().min(PRICE_MIN).max(PRICE_MAX).optional().nullable(),
    cost_price: z.number().min(COST_PRICE_MIN).max(PRICE_MAX).optional().nullable(),
    wholesale_price: z.number().min(PRICE_MIN).max(PRICE_MAX).optional().nullable(),
    stock_quantity: z.number().int().min(STOCK_MIN).max(STOCK_MAX).default(0),
    low_stock_threshold: z.number().int().min(LOW_STOCK_MIN).default(5),
    max_order_qty: z
      .number()
      .int()
      .min(MAX_ORDER_QTY_MIN)
      .max(MAX_ORDER_QTY_MAX)
      .default(50),
    is_available: z.boolean().default(true),
    image_ids: z.array(z.string().uuid()).min(0).max(8).default([]),
  })
  .superRefine((data, ctx) => {
    // Requirement 3.9 — sale_price must be < price when both are set
    if (
      data.price !== undefined &&
      data.price !== null &&
      data.sale_price !== undefined &&
      data.sale_price !== null &&
      data.sale_price >= data.price
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sale_price'],
        message: 'sale_price must be less than price',
      })
    }
  })
