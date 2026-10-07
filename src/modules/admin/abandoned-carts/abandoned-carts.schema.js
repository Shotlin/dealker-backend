const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

export const listAbandonedCartsSchema = {
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      search: { type: 'string' },
      status: { type: 'string', enum: ['OPEN', 'RECOVERED', 'CONVERTED', 'EXPIRED', 'ALL'], default: 'OPEN' },
      minValue: { type: 'number', minimum: 0 },
      maxValue: { type: 'number', minimum: 0 },
      sortBy: { type: 'string', enum: ['priority_score', 'cart_value', 'abandoned_at', 'item_count'], default: 'priority_score' },
      sortOrder: { type: 'string', enum: ['ASC', 'DESC'], default: 'DESC' },
    },
  },
}

export const abandonedCartIdSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
}

export const sendReminderSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
  body: {
    type: 'object',
    required: ['title', 'body'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      body: { type: 'string', minLength: 1, maxLength: 1000 },
      imageUrl: { type: 'string' },
      deepLink: { type: 'string' },
    },
  },
}

export const issueCouponSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
  body: {
    type: 'object',
    properties: {
      // Mode A — assign an existing coupon (only couponId is used).
      couponId: { type: 'string', pattern: uuidPattern },
      // Mode B — create a brand-new coupon, individually targeted to
      // this episode's user server-side (targetType/targetUserIds are
      // ignored even if sent — see abandoned-carts.service.js).
      code: { type: 'string', minLength: 3, maxLength: 30 },
      description: { type: 'string', maxLength: 255 },
      discountType: { type: 'string', enum: ['PERCENTAGE', 'FLAT', 'FREE_DELIVERY', 'CASHBACK'] },
      discountValue: { type: 'number', minimum: 0 },
      minOrderAmount: { type: 'number', minimum: 0 },
      maxDiscount: { type: 'number', minimum: 0 },
      usageLimit: { type: 'integer', minimum: 1 },
      perUserLimit: { type: 'integer', minimum: 1, default: 1 },
      validFrom: { type: 'string' },
      validUntil: { type: 'string' },
    },
  },
}

export const bulkReminderSchema = {
  body: {
    type: 'object',
    required: ['ids', 'title', 'body'],
    properties: {
      ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', pattern: uuidPattern } },
      title: { type: 'string', minLength: 1, maxLength: 200 },
      body: { type: 'string', minLength: 1, maxLength: 1000 },
      deepLink: { type: 'string' },
    },
  },
}

export const quickCouponSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
  body: {
    type: 'object',
    required: ['preset'],
    properties: {
      preset: { type: 'string', enum: ['PERCENT_5', 'PERCENT_10', 'PERCENT_15', 'FLAT_50', 'FLAT_100', 'FREE_DELIVERY'] },
      validHours: { type: 'integer', minimum: 1, maximum: 720 },
      notify: { type: 'boolean', default: true },
    },
  },
}
