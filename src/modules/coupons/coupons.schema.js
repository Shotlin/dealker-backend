/**
 * Coupons JSON Schemas
 */

const couponProperties = {
  id:              { type: 'string' },
  code:            { type: 'string' },
  description:     { type: ['string', 'null'] },
  discountType:    { type: 'string' },
  discountValue:   { type: 'number' },
  discountAmount:  { type: ['number', 'null'] },
  minOrderAmount:  { type: 'number' },
  maxDiscount:     { type: ['number', 'null'] },
  usageLimit:      { type: ['integer', 'null'] },
  usedCount:       { type: 'integer' },
  perUserLimit:    { type: 'integer' },
  validFrom:       { type: ['string', 'null'] },
  validUntil:      { type: ['string', 'null'] },
  isActive:        { type: 'boolean' },
  createdAt:       { type: 'string' },
  terms:           { type: ['string', 'null'] },
  targetType:      { type: 'string' },
  targetSegmentId: { type: ['string', 'null'] },
  cashbackCreditTrigger: { type: 'string' },
  couponType:            { type: 'string' },
  applicableCategoryIds: { type: ['array', 'null'], items: { type: 'string' } },
  applicableProductIds:  { type: ['array', 'null'], items: { type: 'string' } },
  grantsFreeDelivery:    { type: 'boolean' },
}

const couponResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data: { type: 'object', properties: couponProperties },
  },
}

export const validateCouponSchema = {
  tags: ['Coupons'],
  summary: 'Validate coupon code for cart',
  body: {
    type: 'object',
    required: ['code', 'cartTotal'],
    properties: {
      code:      { type: 'string', minLength: 1, maxLength: 50 },
      cartTotal: { type: 'number', minimum: 0 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            valid:                 { type: 'boolean' },
            discount:              { type: 'number' },
            freeDelivery:          { type: 'boolean' },
            cashbackAmount:        { type: 'number' },
            cashbackCreditTrigger: { type: 'string' },
            discountType:          { type: 'string' },
            discountValue:         { type: 'number' },
            description:           { type: ['string', 'null'] },
            terms:                 { type: ['string', 'null'] },
            minOrderAmount:        { type: 'number' },
            maxDiscount:           { type: ['number', 'null'] },
            // null/empty on both = coupon applies to the whole cart.
            applicableCategoryIds: { type: ['array', 'null'], items: { type: 'string' } },
            applicableProductIds:  { type: ['array', 'null'], items: { type: 'string' } },
            code:                  { type: 'string' },
            couponId:              { type: ['string', 'null'] },
            isDemo:                { type: 'boolean' },
          },
        },
      },
    },
  },
}

export const availableCouponsSchema = {
  tags: ['Coupons'],
  summary: 'List available coupons for user',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: { type: 'object', properties: couponProperties } },
      },
    },
  },
}

export const listCouponsAdminSchema = {
  tags: ['Coupons'],
  summary: 'All coupons [ADMIN]',
  querystring: {
    type: 'object',
    properties: {
      page:  { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array' },
        pagination: { type: 'object' },
      },
    },
  },
}

export const createCouponSchema = {
  tags: ['Coupons'],
  summary: 'Create coupon [HQ or shop staff with shop_coupons.create]',
  body: {
    type: 'object',
    required: ['code', 'discountType', 'discountValue'],
    properties: {
      code:                  { type: 'string', minLength: 2, maxLength: 50 },
      description:           { type: 'string', maxLength: 500 },
      terms:                 { type: 'string', maxLength: 2000 },
      discountType:          { type: 'string', enum: ['PERCENTAGE', 'FLAT', 'CASHBACK', 'FREE_DELIVERY'] },
      discountValue:         { type: 'number', minimum: 0 },
      minOrderAmount:        { type: 'number', minimum: 0, default: 0 },
      maxDiscount:           { type: 'number', minimum: 0 },
      usageLimit:            { type: 'integer', minimum: 1 },
      perUserLimit:          { type: 'integer', minimum: 1, default: 1 },
      validFrom:             { type: 'string', format: 'date-time' },
      validUntil:            { type: 'string', format: 'date-time' },
      couponType:            { type: 'string', enum: ['PLATFORM_COUPON', 'SHOP_COUPON', 'CATEGORY_COUPON', 'PRODUCT_COUPON', 'DELIVERY_COUPON'] },
      absorber:              { type: 'string', enum: ['PLATFORM', 'SHOP'] },
      shopId:                { type: 'string', format: 'uuid' },
      applicableShopIds:     { type: 'array', items: { type: 'string', format: 'uuid' } },
      applicableCategoryIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
      applicableProductIds:  { type: 'array', items: { type: 'string', format: 'uuid' } },
      usageLimitTotal:       { type: 'integer', minimum: 1 },
      usageLimitPerUser:     { type: 'integer', minimum: 1, default: 1 },
      targetType:            { type: 'string', enum: ['ALL', 'SEGMENT', 'INDIVIDUAL', 'FIRST_TIME'], default: 'ALL' },
      targetSegmentId:       { type: 'string', format: 'uuid' },
      targetUserIds:         { type: 'array', items: { type: 'string', format: 'uuid' } },
      cashbackCreditTrigger: { type: 'string', enum: ['PAYMENT_SUCCESS', 'ORDER_CONFIRMED', 'ORDER_DELIVERED'], default: 'ORDER_DELIVERED' },
      grantsFreeDelivery:    { type: 'boolean', default: false },
    },
  },
  response: { 201: couponResponse },
}

export const updateCouponSchema = {
  tags: ['Coupons'],
  summary: 'Update coupon [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      code:                  { type: 'string', minLength: 2, maxLength: 50 },
      description:           { type: 'string', maxLength: 500 },
      terms:                 { type: 'string', maxLength: 2000 },
      discountType:          { type: 'string', enum: ['PERCENTAGE', 'FLAT', 'CASHBACK', 'FREE_DELIVERY'] },
      discountValue:         { type: 'number', minimum: 0 },
      minOrderAmount:        { type: 'number', minimum: 0 },
      maxDiscount:           { type: 'number', minimum: 0 },
      usageLimit:            { type: 'integer', minimum: 1 },
      perUserLimit:          { type: 'integer', minimum: 1 },
      validFrom:             { type: 'string', format: 'date-time' },
      validUntil:            { type: 'string', format: 'date-time' },
      isActive:              { type: 'boolean' },
      targetType:            { type: 'string', enum: ['ALL', 'SEGMENT', 'INDIVIDUAL', 'FIRST_TIME'] },
      targetSegmentId:       { type: 'string', format: 'uuid' },
      targetUserIds:         { type: 'array', items: { type: 'string', format: 'uuid' } },
      cashbackCreditTrigger: { type: 'string', enum: ['PAYMENT_SUCCESS', 'ORDER_CONFIRMED', 'ORDER_DELIVERED'] },
      // couponType is create-time-only (changing it later would orphan the
      // shop_id/absorber pairing the DB's CHECK constraints enforce) — only
      // the scope arrays and the free-delivery flag are editable after
      // creation.
      applicableCategoryIds: { type: ['array', 'null'], items: { type: 'string', format: 'uuid' } },
      applicableProductIds:  { type: ['array', 'null'], items: { type: 'string', format: 'uuid' } },
      grantsFreeDelivery:    { type: 'boolean' },
    },
  },
  response: { 200: couponResponse },
}

export const deleteCouponSchema = {
  tags: ['Coupons'],
  summary: 'Delete coupon [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data:    { type: 'null' },
      },
    },
  },
}

export const couponAnalyticsSchema = {
  tags: ['Coupons'],
  summary: 'Redemption/revenue analytics for one coupon [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            totalRedemptions: { type: 'integer' },
            revenueGenerated: { type: 'number' },
            avgOrderValue:    { type: 'number' },
            avgDiscount:      { type: 'number' },
            conversionRate:   { type: 'number' },
            dailyRedemptions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  date:    { type: 'string' },
                  count:   { type: 'integer' },
                  revenue: { type: 'number' },
                },
              },
            },
            topUsers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name:       { type: 'string' },
                  uses:       { type: 'integer' },
                  totalSpent: { type: 'number' },
                },
              },
            },
          },
        },
      },
    },
  },
}
