const segmentProperties = {
  id:            { type: 'string' },
  name:          { type: 'string' },
  description:   { type: ['string', 'null'] },
  is_active:     { type: 'boolean' },
  member_count:  { type: 'integer' },
  created_at:    { type: 'string' },
  updated_at:    { type: 'string' },
}

export const listSegmentsSchema = {
  tags: ['Customer Segments'],
  summary: 'List all customer segments [ADMIN]',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: { type: 'object', properties: segmentProperties } },
      },
    },
  },
}

export const segmentIdSchema = {
  tags: ['Customer Segments'],
  summary: 'Get a customer segment by id [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
}

export const createSegmentSchema = {
  tags: ['Customer Segments'],
  summary: 'Create a customer segment [ADMIN]',
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name:        { type: 'string', minLength: 1, maxLength: 100 },
      description: { type: 'string', maxLength: 1000 },
    },
  },
}

export const updateSegmentSchema = {
  tags: ['Customer Segments'],
  summary: 'Update a customer segment [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      name:        { type: 'string', minLength: 1, maxLength: 100 },
      description: { type: 'string', maxLength: 1000 },
      isActive:    { type: 'boolean' },
    },
  },
}

export const listMembersSchema = {
  tags: ['Customer Segments'],
  summary: 'List members of a segment [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  querystring: {
    type: 'object',
    properties: {
      page:  { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
  },
}

export const addMembersSchema = {
  tags: ['Customer Segments'],
  summary: 'Add customers to a segment [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    required: ['userIds'],
    properties: {
      userIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 },
    },
  },
}

export const removeMemberSchema = {
  tags: ['Customer Segments'],
  summary: 'Remove a customer from a segment [ADMIN]',
  params: {
    type: 'object',
    required: ['id', 'userId'],
    properties: {
      id:     { type: 'string', format: 'uuid' },
      userId: { type: 'string', format: 'uuid' },
    },
  },
}

export const searchCandidatesSchema = {
  tags: ['Customer Segments'],
  summary: 'Search customers to add to a segment [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  querystring: {
    type: 'object',
    properties: {
      q:     { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    },
  },
}
