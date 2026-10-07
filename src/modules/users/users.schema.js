/**
 * Users module — JSON Schema definitions
 */

export const getProfileSchema = {
  tags: ['Users'],
  summary: 'Get current user profile',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            phone: { type: 'string' },
            email: { type: 'string' },
            name: { type: 'string' },
            role: { type: 'string' },
            avatar_url: { type: 'string' },
            birthday: { type: 'string' },
            loyalty_points: { type: 'integer' },
            referral_code: { type: 'string' },
            created_at: { type: 'string' },
          },
        },
      },
    },
  },
}

export const updateProfileSchema = {
  tags: ['Users'],
  summary: 'Update profile (name, email, birthday)',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 100 },
      email: { type: 'string', format: 'email', maxLength: 255 },
      birthday: { type: 'string', format: 'date' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'object' },
      },
    },
  },
}

export const uploadAvatarSchema = {
  tags: ['Users'],
  summary: 'Upload profile photo',
  security: [{ bearerAuth: [] }],
  consumes: ['multipart/form-data'],
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            avatar_url: { type: 'string' },
          },
        },
      },
    },
  },
}

export const getStatsSchema = {
  tags: ['Users'],
  summary: 'Get user stats (orders, spending, loyalty)',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            total_orders: { type: 'integer' },
            total_spent: { type: 'number' },
            loyalty_points: { type: 'integer' },
          },
        },
      },
    },
  },
}
