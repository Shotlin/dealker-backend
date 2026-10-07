const milestoneProperties = {
  id:                    { type: 'string' },
  name:                  { type: 'string' },
  minCartAmount:         { type: 'number' },
  rewardType:            { type: 'string' },
  rewardValue:           { type: ['number', 'null'] },
  rewardPercent:         { type: ['number', 'null'] },
  maxDiscount:           { type: ['number', 'null'] },
  unlockCouponId:        { type: ['string', 'null'] },
  messageBefore:         { type: ['string', 'null'] },
  messageAfter:          { type: ['string', 'null'] },
  iconUrl:               { type: ['string', 'null'] },
  isActive:              { type: 'boolean' },
  applicableUserType:    { type: 'string' },
  applicableSegmentId:   { type: ['string', 'null'] },
  excludedSegmentId:     { type: ['string', 'null'] },
  excludeFirstTimeUsers: { type: 'boolean' },
  stackableWithCoupon:   { type: 'boolean' },
  priority:              { type: 'integer' },
  cashbackCreditTrigger: { type: 'string' },
  usageLimitPerUser:     { type: ['integer', 'null'] },
  grantsFreeDelivery:    { type: 'boolean' },
  applicableCategoryIds: { type: ['array', 'null'], items: { type: 'string' } },
  applicableProductIds:  { type: ['array', 'null'], items: { type: 'string' } },
  createdAt:             { type: 'string' },
}

const milestoneResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data: { type: 'object', properties: milestoneProperties },
  },
}

export const progressSchema = {
  tags: ['Cart Milestones'],
  summary: 'Milestone progress for the current cart total',
  querystring: {
    type: 'object',
    required: ['cartTotal'],
    properties: { cartTotal: { type: 'number', minimum: 0 } },
  },
}

export const listMilestonesSchema = {
  tags: ['Cart Milestones'],
  summary: 'List all cart milestones [ADMIN]',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: { type: 'object', properties: milestoneProperties } },
      },
    },
  },
}

export const createMilestoneSchema = {
  tags: ['Cart Milestones'],
  summary: 'Create a cart milestone [ADMIN]',
  body: {
    type: 'object',
    required: ['name', 'rewardType', 'minCartAmount'],
    properties: {
      name:                  { type: 'string', minLength: 1, maxLength: 100 },
      minCartAmount:         { type: 'number', minimum: 0 },
      rewardType:            { type: 'string', enum: ['CASHBACK', 'FLAT_DISCOUNT', 'COUPON_UNLOCK'] },
      rewardValue:           { type: 'number', minimum: 0 },
      rewardPercent:         { type: ['number', 'null'], minimum: 0, maximum: 100 },
      maxDiscount:           { type: 'number', minimum: 0 },
      unlockCouponId:        { type: 'string', format: 'uuid' },
      messageBefore:         { type: 'string', maxLength: 200 },
      messageAfter:          { type: 'string', maxLength: 200 },
      iconUrl:               { type: 'string', maxLength: 2000 },
      applicableUserType:    { type: 'string', enum: ['ALL', 'FIRST_TIME', 'SEGMENT'], default: 'ALL' },
      applicableSegmentId:   { type: 'string', format: 'uuid' },
      // Only meaningful when applicableUserType is 'ALL' — see
      // 106_cart_milestone_excluded_segment.sql. Nullable so the dashboard
      // can explicitly clear it, same convention as the scope arrays below.
      excludedSegmentId:     { type: ['string', 'null'], format: 'uuid' },
      // Also only meaningful for 'ALL' — see
      // 107_cart_milestone_exclude_first_time.sql. Lets a first-time
      // customer's dedicated First-Time Offer be the only reward they get,
      // instead of also earning this general milestone on the same order.
      excludeFirstTimeUsers: { type: 'boolean', default: false },
      stackableWithCoupon:   { type: 'boolean', default: true },
      priority:              { type: 'integer', default: 0 },
      cashbackCreditTrigger: { type: 'string', enum: ['PAYMENT_SUCCESS', 'ORDER_CONFIRMED', 'ORDER_DELIVERED'], default: 'ORDER_DELIVERED' },
      usageLimitPerUser:     { type: ['integer', 'null'], minimum: 1 },
      grantsFreeDelivery:    { type: 'boolean', default: false },
      applicableCategoryIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
      applicableProductIds:  { type: 'array', items: { type: 'string', format: 'uuid' } },
    },
  },
  response: { 201: milestoneResponse },
}

export const updateMilestoneSchema = {
  tags: ['Cart Milestones'],
  summary: 'Update a cart milestone [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      name:                  { type: 'string', minLength: 1, maxLength: 100 },
      minCartAmount:         { type: 'number', minimum: 0 },
      rewardType:            { type: 'string', enum: ['CASHBACK', 'FLAT_DISCOUNT', 'COUPON_UNLOCK'] },
      rewardValue:           { type: 'number', minimum: 0 },
      rewardPercent:         { type: ['number', 'null'], minimum: 0, maximum: 100 },
      maxDiscount:           { type: 'number', minimum: 0 },
      unlockCouponId:        { type: 'string', format: 'uuid' },
      messageBefore:         { type: 'string', maxLength: 200 },
      messageAfter:          { type: 'string', maxLength: 200 },
      iconUrl:               { type: 'string', maxLength: 2000 },
      isActive:              { type: 'boolean' },
      applicableUserType:    { type: 'string', enum: ['ALL', 'FIRST_TIME', 'SEGMENT'] },
      applicableSegmentId:   { type: 'string', format: 'uuid' },
      excludedSegmentId:     { type: ['string', 'null'], format: 'uuid' },
      excludeFirstTimeUsers: { type: 'boolean' },
      stackableWithCoupon:   { type: 'boolean' },
      priority:              { type: 'integer' },
      cashbackCreditTrigger: { type: 'string', enum: ['PAYMENT_SUCCESS', 'ORDER_CONFIRMED', 'ORDER_DELIVERED'] },
      usageLimitPerUser:     { type: ['integer', 'null'], minimum: 1 },
      grantsFreeDelivery:    { type: 'boolean' },
      applicableCategoryIds: { type: ['array', 'null'], items: { type: 'string', format: 'uuid' } },
      applicableProductIds:  { type: ['array', 'null'], items: { type: 'string', format: 'uuid' } },
    },
  },
  response: { 200: milestoneResponse },
}

export const deleteMilestoneSchema = {
  tags: ['Cart Milestones'],
  summary: 'Delete a cart milestone [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
}
