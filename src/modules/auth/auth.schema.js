/**
 * Auth module — JSON Schema definitions for Fastify route validation
 */

export const sendOtpSchema = {
  tags: ['Auth'],
  summary: 'Send OTP to mobile number',
  body: {
    type: 'object',
    required: ['phone'],
    properties: {
      phone: { type: 'string', minLength: 10, maxLength: 15 },
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
            // In development, we return the OTP for testing
            otp: { type: 'string' },
          },
        },
      },
    },
  },
}

export const verifyOtpSchema = {
  tags: ['Auth'],
  summary: 'Verify OTP and return JWT tokens',
  body: {
    type: 'object',
    required: ['phone', 'otp'],
    properties: {
      phone: { type: 'string', minLength: 10, maxLength: 15 },
      otp: { type: 'string', minLength: 4, maxLength: 8 },
      role: { type: 'string', enum: ['CUSTOMER', 'RIDER', 'DELIVERY'] },
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
          // Two response shapes are possible:
          //  - Standard login: accessToken, refreshToken, user (existing behavior)
          //  - Multi-shop staff: requires_shop_selection=true, shops[], temp_token
          // Schema is intentionally permissive so Fastify does not strip extras.
          additionalProperties: true,
        },
      },
    },
  },
}

// POST /select-shop — issue a shop-scoped JWT for a staff member.
// Requirements: 2.6, 2.7, 2.8, 13.2, 13.3, 13.5
export const selectShopSchema = {
  tags: ['Auth'],
  summary: 'Select a shop and receive a shop-scoped JWT [Authenticated]',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['shop_id'],
    properties: {
      shop_id: { type: 'string', format: 'uuid' },
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
            token: { type: 'string' },
            shop_id: { type: 'string', format: 'uuid' },
            shop_role: { type: 'string' },
            permissions: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
      },
    },
  },
}

export const refreshTokenSchema = {
  tags: ['Auth'],
  summary: 'Get new access token using refresh token',
  body: {
    type: 'object',
    required: ['refreshToken'],
    properties: {
      refreshToken: { type: 'string' },
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
            accessToken: { type: 'string' },
            refreshToken: { type: 'string' },
          },
        },
      },
    },
  },
}

export const logoutSchema = {
  tags: ['Auth'],
  summary: 'Logout — invalidate refresh token',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
  },
}

export const deleteAccountSchema = {
  tags: ['Auth'],
  summary: 'Delete user account (GDPR)',
  security: [{ bearerAuth: [] }],
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
  },
}

// GET /my-shops — paginated active staff assignments for the requester
// Requirements: R19.5
// Design: §5.4
export const myShopsSchema = {
  tags: ['Auth'],
  summary: 'List active shop assignments for the authenticated user [Authenticated]',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
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
            shops: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  shop_id: { type: 'string', format: 'uuid' },
                  shop_name: { type: 'string' },
                  branch_code: { type: 'string' },
                  shop_role: { type: 'string' },
                  permissions: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
              },
            },
            pagination: {
              type: 'object',
              properties: {
                page: { type: 'integer' },
                limit: { type: 'integer' },
                total: { type: 'integer' },
                totalPages: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  },
}
