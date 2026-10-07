export const productAnalyticsSchema = {
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      sortBy: { type: 'string', enum: ['revenue', 'sold', 'views'], default: 'revenue' },
    },
  },
}

export const deadStockSchema = {
  querystring: {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, default: 30 },
    },
  },
}

export const lowMarginSchema = {
  querystring: {
    type: 'object',
    properties: {
      threshold: { type: 'number', minimum: 0, maximum: 100, default: 15 },
    },
  },
}

export const exportProductsSchema = {
  querystring: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['csv', 'xlsx'], default: 'csv' },
    },
  },
}

export const bulkUpdateSchema = {
  body: {
    type: 'object',
    required: ['products'],
    properties: {
      products: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          required: ['id'],
          properties: {
            // Bug fix: products.id is UUID, not integer — this previously
            // rejected every real request (Activate/Deactivate/quick-edit
            // all call this endpoint with real product ids).
            id: { type: 'string', format: 'uuid' },
            price: { type: 'number', minimum: 0 },
            sale_price: { type: ['number', 'null'], minimum: 0 },
            stock_quantity: { type: 'integer', minimum: 0 },
            // Same bug as id above — categories.id is also UUID.
            category_id: { type: 'string', format: 'uuid' },
            is_active: { type: 'boolean' },
          },
        },
      },
      // Quick-edit price changes only — when true, also overwrites
      // shop_products.price for every shop currently selling each updated
      // product, so the storefront price matches the new master price.
      propagate_to_shops: { type: 'boolean', default: false },
    },
  },
}

export const duplicateSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
}

export const searchBarcodeSchema = {
  params: {
    type: 'object',
    required: ['code'],
    properties: { code: { type: 'string', minLength: 1 } },
  },
}
