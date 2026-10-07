import { z } from 'zod'

/**
 * Validation schemas for the Fee Settings module.
 *
 * The update payload is a partial — the dashboard PATCHes only the fields the
 * admin changed. Cross-field rules (max distance >= base distance, percent
 * ranges) are enforced via superRefine so the admin gets a clear message
 * instead of a raw DB CHECK violation.
 */

const nonNegative = z.number().min(0)
const feeType = z.enum(['FLAT', 'PERCENT'])
const label = z.string().trim().min(1).max(60)
const description = z.string().trim().max(500).nullable()

export const updateFeeSettingsSchema = z
  .object({
    is_active: z.boolean(),

    // Delivery (distance-based)
    delivery_fee_enabled: z.boolean(),
    min_delivery_fee: nonNegative.max(100000),
    base_distance_km: nonNegative.max(1000),
    per_km_fee: nonNegative.max(100000),
    max_delivery_distance_km: nonNegative.max(1000).nullable(),
    free_delivery_enabled: z.boolean(),
    free_delivery_above: nonNegative.max(10000000).nullable(),

    // Handling
    handling_fee_enabled: z.boolean(),
    handling_fee_type: feeType,
    handling_fee_value: nonNegative.max(100000),
    handling_fee_label: label,
    handling_fee_description: description,

    // Platform
    platform_fee_enabled: z.boolean(),
    platform_fee_type: feeType,
    platform_fee_value: nonNegative.max(100000),
    platform_fee_label: label,
    platform_fee_description: description,

    // Small cart
    small_cart_fee_enabled: z.boolean(),
    small_cart_threshold: nonNegative.max(10000000),
    small_cart_fee: nonNegative.max(100000),
    small_cart_fee_label: label,
    small_cart_fee_description: description,

    // Surge / rain
    surge_fee_enabled: z.boolean(),
    surge_fee_value: nonNegative.max(100000),
    surge_fee_label: label,
    surge_fee_description: description,

    // Packaging
    packaging_fee_enabled: z.boolean(),
    packaging_fee_value: nonNegative.max(100000),
    packaging_fee_label: label,
    packaging_fee_description: description,

    // ETA (display only)
    delivery_eta_minutes: z.number().int().min(0).max(100000),

    // Quick Delivery surcharge — flat, only charged when the customer
    // explicitly opts into "Quick Delivery" at checkout.
    quick_delivery_surcharge_enabled: z.boolean(),
    quick_delivery_surcharge_amount: nonNegative.max(10000),
    quick_delivery_surcharge_label: label,
    // How fast delivery is promised when the customer opts in — distinct
    // from delivery_eta_minutes, the normal always-shown estimate.
    quick_delivery_eta_minutes: z.number().int().min(0).max(100000),

    // GST — exclusive, charged on top of (subtotal - coupon + other fees).
    // Off by default; enabling it is the admin's explicit action.
    gst_enabled: z.boolean(),
    gst_rate: z.number().min(0).max(100),
    gst_label: label,
  })
  .partial()
  .superRefine((data, ctx) => {
    // Percentage fees must be a sane 0–100 range.
    const pctChecks = [
      ['handling_fee_type', 'handling_fee_value'],
      ['platform_fee_type', 'platform_fee_value'],
    ]
    for (const [typeKey, valueKey] of pctChecks) {
      if (data[typeKey] === 'PERCENT' && data[valueKey] !== undefined && data[valueKey] > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [valueKey],
          message: 'Percentage fee cannot exceed 100',
        })
      }
    }

    // max distance, when both provided, must be >= base distance.
    if (
      data.max_delivery_distance_km != null &&
      data.base_distance_km != null &&
      data.max_delivery_distance_km < data.base_distance_km
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['max_delivery_distance_km'],
        message: 'Maximum delivery distance must be greater than or equal to the included base distance',
      })
    }
  })

export const feePreviewSchema = z.object({
  subtotal: z.number().min(0).max(100000000),
  distanceKm: z.number().min(0).max(10000).optional(),
  shopId: z.string().uuid().optional(),
})
