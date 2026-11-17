/**
 * Categories module — JSON Schema definitions
 */

export const listCategoriesSchema = {
  tags: ['Categories'],
  summary: 'Get all categories (cached 30 min)',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              slug: { type: 'string' },
              description: { type: ['string', 'null'] },
              image_url: { type: ['string', 'null'] },
              parent_id: { type: ['string', 'null'] },
              sort_order: { type: 'integer' },
              is_active: { type: 'boolean' },
              category_type: { type: 'string', enum: ['STANDARD', 'BUNDLE'] },
              product_count: { type: 'integer' },
              created_at: { type: 'string' },
            },
          },
        },
      },
    },
  },
}

export const listCategoriesAdminSchema = {
  tags: ['Categories'],
  summary: 'Get all non-deleted categories, including inactive [ADMIN]',
  security: [{ bearerAuth: [] }],
  response: listCategoriesSchema.response,
}

export const getCategorySchema = {
  tags: ['Categories'],
  summary: 'Get single category',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}

export const getCategoryProductsSchema = {
  tags: ['Categories'],
  summary: 'Get products by category (paginated)',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      // Max raised from 50 to 200 (2026-07-03) so the admin dashboard's
      // product-ranking panel can load a whole category in one page —
      // customer-facing defaults (default: 20) are unaffected.
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
      sort: { type: 'string', enum: ['price_asc', 'price_desc', 'newest', 'popular'] },
      inStock: { type: 'boolean' },
      groupOptions: { type: 'boolean', default: false },
      priceMode: { type: 'string', enum: ['retail', 'wholesale'], default: 'retail' },
    },
  },
}

export const createCategorySchema = {
  tags: ['Categories'],
  summary: 'Create category [ADMIN]',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 100 },
      description: { type: 'string', maxLength: 500 },
      image_url: { type: 'string' },
      parent_id: { oneOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
      sort_order: { type: 'integer', minimum: 0, default: 0 },
      is_active: { type: 'boolean' },
      category_type: { type: 'string', enum: ['STANDARD', 'BUNDLE'], default: 'STANDARD' },
    },
  },
}

export const updateCategorySchema = {
  tags: ['Categories'],
  summary: 'Update category [ADMIN]',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 100 },
      description: { type: 'string', maxLength: 500 },
      image_url: { type: 'string' },
      parent_id: { oneOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
      sort_order: { type: 'integer', minimum: 0 },
      is_active: { type: 'boolean' },
      category_type: { type: 'string', enum: ['STANDARD', 'BUNDLE'] },
    },
  },
}

export const deleteCategorySchema = {
  tags: ['Categories'],
  summary: 'Delete category [ADMIN]',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}

export const listBundlesSchema = {
  tags: ['Categories'],
  summary: 'List all bundle (promo-only) categories [ADMIN]',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    properties: {
      // When given, each bundle in the response also carries `is_member`
      // for this product — powers the product edit form's bundle toggle.
      productId: { type: 'string', format: 'uuid' },
    },
  },
}

export const toggleCategoryMembershipSchema = {
  tags: ['Categories'],
  summary: 'Add/remove a single product from a category or bundle [ADMIN]',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['productId', 'isMember'],
    properties: {
      productId: { type: 'string', format: 'uuid' },
      isMember: { type: 'boolean' },
    },
  },
}

export const listCategoriesForProductSchema = {
  tags: ['Categories'],
  summary:
    "Every category a product could be cross-listed into (its own primary category excluded), each flagged is_member [ADMIN]",
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['productId'],
    properties: {
      productId: { type: 'string', format: 'uuid' },
    },
  },
}

export const getCategoryProductRanksSchema = {
  tags: ['Categories'],
  summary: 'Get a category\'s current product ranking [ADMIN]',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}

export const setCategoryProductsSchema = {
  tags: ['Categories'],
  summary: 'Replace a category\'s product membership/order (bundle members, or a standard category\'s explicit ranking) [ADMIN]',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['productIds'],
    properties: {
      productIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        maxItems: 200,
      },
    },
  },
}
