export const getFeeConfigsSchema = {
  tags: ['Fee Config'],
  summary: 'Get all fee configurations',
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
              fee_type: { type: 'string' },
              amount: { type: 'number' },
              free_threshold: { type: ['number', 'null'] },
              is_active: { type: 'boolean' },
              description: { type: ['string', 'null'] },
              start_hour: { type: ['integer', 'null'] },
              end_hour: { type: ['integer', 'null'] },
              created_at: { type: 'string', format: 'date-time' },
              updated_at: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  },
}

export const updateFeeConfigSchema = {
  tags: ['Fee Config'],
  summary: 'Update a fee configuration',
  params: {
    type: 'object',
    required: ['feeType'],
    properties: {
      feeType: { type: 'string' },
    },
  },
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      amount: { type: 'number', minimum: 0 },
      free_threshold: { type: ['number', 'null'], minimum: 0 },
      is_active: { type: 'boolean' },
      description: { type: 'string', maxLength: 500 },
      start_hour: { type: ['integer', 'null'], minimum: 0, maximum: 23 },
      end_hour: { type: ['integer', 'null'], minimum: 0, maximum: 23 },
    },
  },
}
