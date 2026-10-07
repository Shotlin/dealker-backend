const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

export const templateIdSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
}

export const createTemplateSchema = {
  body: {
    type: 'object',
    required: ['name', 'title', 'body'],
    properties: {
      name:      { type: 'string', minLength: 1, maxLength: 100 },
      title:     { type: 'string', minLength: 1, maxLength: 200 },
      body:      { type: 'string', minLength: 1, maxLength: 2000 },
      type:      { type: 'string', enum: ['PUSH', 'SMS', 'EMAIL', 'IN_APP'], default: 'PUSH' },
      variables: { type: 'array', items: { type: 'string' } },
      image_url: { type: 'string', maxLength: 2000 },
      deep_link: { type: 'string', maxLength: 500 },
    },
  },
}

export const updateTemplateSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
  body: {
    type: 'object',
    properties: {
      name:      { type: 'string', minLength: 1, maxLength: 100 },
      title:     { type: 'string', minLength: 1, maxLength: 200 },
      body:      { type: 'string', minLength: 1, maxLength: 2000 },
      type:      { type: 'string', enum: ['PUSH', 'SMS', 'EMAIL', 'IN_APP'] },
      variables: { type: 'array', items: { type: 'string' } },
      image_url: { type: 'string', maxLength: 2000 },
      deep_link: { type: 'string', maxLength: 500 },
      is_active: { type: 'boolean' },
    },
  },
}

const VALID_SEGMENTS = ['all_customers', 'specific_user', 'store_customers', 'inactive_customers', 'cart_not_empty', 'all', 'new', 'inactive', 'high_value', 'custom_segment', 'all_vendors', 'specific_vendor']

export const sendBulkSchema = {
  body: {
    type: 'object',
    required: ['title', 'body', 'segment'],
    properties: {
      title:          { type: 'string', minLength: 1, maxLength: 200 },
      body:           { type: 'string', minLength: 1, maxLength: 2000 },
      segment:        { type: 'string', enum: VALID_SEGMENTS },
      segmentValue:   { type: 'string' },
      segmentFilters: { type: 'object' },
      image_url:      { type: 'string', maxLength: 2000 },
      deep_link:      { type: 'string', maxLength: 500 },
      type:           { type: 'string', enum: ['system', 'offer', 'product_offer', 'category_offer', 'store_offer', 'order_update', 'rider_update', 'wallet', 'coupon', 'cart_reminder', 'general'], default: 'general' },
      expires_at:     { type: 'string', format: 'date-time' },
      template_id:    { type: 'string', pattern: uuidPattern },
      target_phones:  { type: 'array', items: { type: 'string' } },
    },
  },
}

export const scheduleCampaignSchema = {
  body: {
    type: 'object',
    required: ['title', 'body', 'segment', 'scheduledAt'],
    properties: {
      title:          { type: 'string', minLength: 1, maxLength: 200 },
      body:           { type: 'string', minLength: 1, maxLength: 2000 },
      segment:        { type: 'string', enum: VALID_SEGMENTS },
      segmentValue:   { type: 'string' },
      segmentFilters: { type: 'object' },
      scheduledAt:    { type: 'string', format: 'date-time' },
      image_url:      { type: 'string', maxLength: 2000 },
      deep_link:      { type: 'string', maxLength: 500 },
      type:           { type: 'string', enum: ['system', 'offer', 'product_offer', 'category_offer', 'store_offer', 'order_update', 'rider_update', 'wallet', 'coupon', 'cart_reminder', 'general'], default: 'general' },
      expires_at:     { type: 'string', format: 'date-time' },
      template_id:    { type: 'string', pattern: uuidPattern },
    },
  },
}

export const listCampaignsSchema = {
  querystring: {
    type: 'object',
    properties: {
      page:   { type: 'integer', minimum: 1, default: 1 },
      limit:  { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      status: { type: 'string' },
    },
  },
}

export const campaignIdSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
}

export const cancelCampaignSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
}

export const segmentCountSchema = {
  querystring: {
    type: 'object',
    required: ['segment'],
    properties: {
      segment:       { type: 'string', enum: VALID_SEGMENTS },
      segmentValue:  { type: 'string' },
    },
  },
}
