const SECTION_TYPES = [
  'animated_banner',
  'fee_strip',
  'seasonal_mosaic',
  'round_category_icons',
  'category_product_grid',
  'product_carousel',
  'trending_products',
  'promo_carousel',
  'bank_offers',
  'arched_product_showcase',
  'custom_banner',
  'text_header',
  'spacer',
  'live_auction',
  'deal_of_day',
  'recent_recommended',
  'steal_deals',
  'collection_showcase',
  'brand_spotlight',
  'price_shop',
  'category_hub',
  'banner_rail',
  'top_brands',
  'price_sale',
  'oval_spotlight',
  'category_deals',
  'shops_nearby',
]

const merchBindingSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    category_ids: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      default: [],
    },
    product_ids: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      default: [],
    },
    // Products hidden from this section (Deals & Merchandising page).
    exclude_ids: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      default: [],
    },
    // Filter + sort rules that fill the section after pinned products (see themes/merch-rules.js).
    rules: { type: 'object' },
    // Promo campaign ("deal") whose listings fill the section while it is ACTIVE.
    campaign_id: { type: 'string', format: 'uuid' },
    // Top up the section from its normal feed after pinned / deal / rule products.
    auto_fill: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    source: { type: 'string', enum: ['category', 'tag', 'manual'] },
    tags: {
      type: 'array',
      items: { type: 'string' },
      default: [],
    },
  },
}

export const tabIdSchema = {
  params: {
    type: 'object',
    required: ['tabId'],
    properties: {
      tabId: { type: 'string', format: 'uuid' },
    },
  },
}

export const sectionIdSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}

export const createSectionSchema = {
  params: tabIdSchema.params,
  body: {
    type: 'object',
    required: ['section_type'],
    properties: {
      section_type: { type: 'string', enum: SECTION_TYPES },
      config: { type: 'object' },
      visible: { type: 'boolean', default: true },
      merch_binding: merchBindingSchema,
    },
  },
}

export const updateSectionSchema = {
  params: sectionIdSchema.params,
  body: {
    type: 'object',
    properties: {
      section_type: { type: 'string', enum: SECTION_TYPES },
      config: { type: 'object' },
      visible: { type: 'boolean' },
    },
  },
}

export const updateMerchSchema = {
  params: sectionIdSchema.params,
  body: merchBindingSchema,
}

export const reorderSectionsSchema = {
  params: tabIdSchema.params,
  body: {
    type: 'object',
    required: ['order'],
    properties: {
      order: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
      },
    },
  },
}

export const rollbackSchema = {
  params: tabIdSchema.params,
  body: {
    type: 'object',
    required: ['version_id'],
    properties: {
      version_id: { type: 'string', format: 'uuid' },
    },
  },
}

export const scheduleSchema = {
  params: tabIdSchema.params,
  body: {
    type: 'object',
    required: ['scheduled_at'],
    properties: {
      scheduled_at: { type: 'string', format: 'date-time' },
    },
  },
}
