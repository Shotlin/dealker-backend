export const getProductReviewsSchema = {
  tags: ['Reviews'],
  summary: 'Get reviews for a product',
  params: {
    type: 'object',
    required: ['productId'],
    properties: {
      productId: { type: 'string', format: 'uuid' },
    },
  },
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'number', default: 1 },
      limit: { type: 'number', default: 10 },
    },
  },
}

export const checkReviewEligibilitySchema = {
  tags: ['Reviews'],
  summary: 'Check whether the current user can review a product',
  params: {
    type: 'object',
    required: ['productId'],
    properties: {
      productId: { type: 'string', format: 'uuid' },
    },
  },
}

export const createReviewSchema = {
  tags: ['Reviews'],
  summary: 'Create a product review',
  body: {
    type: 'object',
    required: ['productId', 'orderId', 'rating'],
    properties: {
      productId: { type: 'string', format: 'uuid' },
      orderId: { type: 'string', format: 'uuid' },
      rating: { type: 'number', minimum: 1, maximum: 5 },
      comment: { type: 'string', maxLength: 1000 },
    },
  },
}

export const updateReviewSchema = {
  tags: ['Reviews'],
  summary: 'Update a review',
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
      rating: { type: 'number', minimum: 1, maximum: 5 },
      comment: { type: 'string', maxLength: 1000 },
    },
  },
}

export const deleteReviewSchema = {
  tags: ['Reviews'],
  summary: 'Delete a review',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}

export const getOrderReviewsSchema = {
  tags: ['Reviews'],
  summary: "Get the current user's existing reviews for one order",
  params: {
    type: 'object',
    required: ['orderId'],
    properties: {
      orderId: { type: 'string', format: 'uuid' },
    },
  },
}

export const getMyReviewsSchema = {
  tags: ['Reviews'],
  summary: 'Get my reviews',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'number', default: 1 },
      limit: { type: 'number', default: 10 },
    },
  },
}
