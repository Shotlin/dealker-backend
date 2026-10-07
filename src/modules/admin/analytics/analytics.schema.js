export const salesSchema = {
  querystring: {
    type: 'object',
    properties: {
      startDate: { type: 'string', format: 'date' },
      endDate: { type: 'string', format: 'date' },
      groupBy: { type: 'string', enum: ['day', 'week', 'month'], default: 'day' },
    },
  },
}

export const productPerformanceSchema = {
  querystring: {
    type: 'object',
    properties: {
      startDate: { type: 'string', format: 'date' },
      endDate: { type: 'string', format: 'date' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
  },
}

export const dateRangeSchema = {
  querystring: {
    type: 'object',
    properties: {
      startDate: { type: 'string', format: 'date' },
      endDate: { type: 'string', format: 'date' },
    },
  },
}

export const cartEnhancementAnalyticsSchema = dateRangeSchema

export const comparisonSchema = {
  querystring: {
    type: 'object',
    required: ['period1Start', 'period1End', 'period2Start', 'period2End'],
    properties: {
      period1Start: { type: 'string', format: 'date' },
      period1End: { type: 'string', format: 'date' },
      period2Start: { type: 'string', format: 'date' },
      period2End: { type: 'string', format: 'date' },
    },
  },
}

export const geographicSchema = dateRangeSchema

export const deadStockSchema = {
  querystring: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
    },
  },
}
