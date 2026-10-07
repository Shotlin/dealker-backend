const mappingProperties = {
  id:         { type: 'string' },
  pincode:    { type: 'string' },
  city:       { type: 'string' },
  area:       { type: ['string', 'null'] },
  state:      { type: 'string' },
  isActive:   { type: 'boolean' },
  createdAt:  { type: 'string' },
  updatedAt:  { type: 'string' },
}

const mappingResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data: { type: 'object', properties: mappingProperties },
  },
}

const mappingWriteBody = {
  pincode:  { type: 'string', pattern: '^[1-9][0-9]{5}$' },
  city:     { type: 'string', minLength: 1, maxLength: 100 },
  area:     { type: ['string', 'null'], maxLength: 150 },
  state:    { type: 'string', minLength: 1, maxLength: 100 },
}

export const listMappingsSchema = {
  tags: ['Pincode Mappings'],
  summary: 'List all pincode mappings [ADMIN]',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: { type: 'object', properties: mappingProperties } },
      },
    },
  },
}

export const createMappingSchema = {
  tags: ['Pincode Mappings'],
  summary: 'Create a pincode mapping [ADMIN]',
  body: {
    type: 'object',
    required: ['pincode', 'city', 'state'],
    properties: {
      ...mappingWriteBody,
      isActive: { type: 'boolean' },
    },
  },
  response: { 201: mappingResponse },
}

export const updateMappingSchema = {
  tags: ['Pincode Mappings'],
  summary: 'Update a pincode mapping [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      ...mappingWriteBody,
      isActive: { type: 'boolean' },
    },
  },
  response: { 200: mappingResponse },
}

export const deleteMappingSchema = {
  tags: ['Pincode Mappings'],
  summary: 'Delete a pincode mapping [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
}
