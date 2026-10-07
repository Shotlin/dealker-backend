import { STORE_KEYS, TAB_STATUSES } from '../../../modules/theme-tabs/theme-tabs.shared.js'

const merchSectionSchema = {
  type: 'object',
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
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
}

const merchConfigSchema = {
  type: 'object',
  properties: {
    seasonal_mosaic: merchSectionSchema,
    featured: merchSectionSchema,
    deals: merchSectionSchema,
    trending: merchSectionSchema,
    category_rails: {
      type: 'array',
      items: {
        type: 'object',
        required: ['category_id'],
        properties: {
          category_id: { type: 'string', format: 'uuid' },
          product_ids: {
            type: 'array',
            items: { type: 'string', format: 'uuid' },
            default: [],
          },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          title: { type: ['string', 'null'], maxLength: 100 },
        },
      },
      default: [],
    },
  },
}

export const themeTabIdSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}

export const listThemeTabsSchema = {
  querystring: {
    type: 'object',
    properties: {
      store_key: { type: 'string', enum: STORE_KEYS },
      status: { type: 'string', enum: TAB_STATUSES },
    },
  },
}

export const createThemeTabSchema = {
  body: {
    type: 'object',
    required: ['store_key', 'key', 'label'],
    properties: {
      store_key: { type: 'string', enum: STORE_KEYS },
      key: { type: 'string', minLength: 1, maxLength: 50 },
      label: { type: 'string', minLength: 1, maxLength: 100 },
      image_url: { type: ['string', 'null'] },
      text_color: { type: ['string', 'null'], pattern: '^#[0-9A-Fa-f]{6}$' },
      sort_order: { type: 'integer', minimum: 0 },
      status: { type: 'string', enum: TAB_STATUSES },
      is_default: { type: 'boolean' },
      merch_config: merchConfigSchema,
    },
  },
}

export const updateThemeTabSchema = {
  params: themeTabIdSchema.params,
  body: {
    type: 'object',
    properties: {
      store_key: { type: 'string', enum: STORE_KEYS },
      key: { type: 'string', minLength: 1, maxLength: 50 },
      label: { type: 'string', minLength: 1, maxLength: 100 },
      image_url: { type: ['string', 'null'] },
      text_color: { type: ['string', 'null'], pattern: '^#[0-9A-Fa-f]{6}$' },
      sort_order: { type: 'integer', minimum: 0 },
      status: { type: 'string', enum: TAB_STATUSES },
      is_default: { type: 'boolean' },
      merch_config: merchConfigSchema,
    },
  },
}
