/**
 * Addresses JSON Schemas
 */

const addressProperties = {
  id:           { type: 'string' },
  label:        { type: 'string' },
  addressLine1: { type: 'string' },
  addressLine2: { type: ['string', 'null'] },
  landmark:     { type: ['string', 'null'] },
  city:         { type: 'string' },
  state:        { type: ['string', 'null'] },
  pincode:      { type: 'string' },
  lat:          { type: ['number', 'null'] },
  lng:          { type: ['number', 'null'] },
  isDefault:    { type: 'boolean' },
  createdAt:    { type: 'string' },
}

const addressResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data: { type: 'object', properties: addressProperties },
  },
}

const addressListResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data:    { type: 'array', items: { type: 'object', properties: addressProperties } },
  },
}

export const listAddressesSchema = {
  tags: ['Addresses'],
  summary: 'Get all saved addresses',
  response: { 200: addressListResponse },
}

export const createAddressSchema = {
  tags: ['Addresses'],
  summary: 'Add new address',
  body: {
    type: 'object',
    required: ['addressLine1', 'city', 'pincode', 'lat', 'lng'],
    properties: {
      label:        { type: 'string', maxLength: 50, default: 'Home' },
      addressLine1: { type: 'string', minLength: 3, maxLength: 255 },
      addressLine2: { type: 'string', maxLength: 255 },
      landmark:     { type: 'string', maxLength: 255 },
      city:         { type: 'string', minLength: 2, maxLength: 100 },
      state:        { type: 'string', maxLength: 100 },
      pincode:      { type: 'string', pattern: '^[1-9][0-9]{5}$' },
      lat:          { type: 'number', minimum: -90, maximum: 90 },
      lng:          { type: 'number', minimum: -180, maximum: 180 },
      isDefault:    { type: 'boolean', default: false },
    },
  },
  response: { 201: addressResponse },
}

export const updateAddressSchema = {
  tags: ['Addresses'],
  summary: 'Update address',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      label:        { type: 'string', maxLength: 50 },
      addressLine1: { type: 'string', minLength: 3, maxLength: 255 },
      addressLine2: { type: 'string', maxLength: 255 },
      landmark:     { type: 'string', maxLength: 255 },
      city:         { type: 'string', minLength: 2, maxLength: 100 },
      state:        { type: 'string', maxLength: 100 },
      pincode:      { type: 'string', pattern: '^[1-9][0-9]{5}$' },
      lat:          { type: 'number', minimum: -90, maximum: 90 },
      lng:          { type: 'number', minimum: -180, maximum: 180 },
    },
  },
  response: { 200: addressResponse },
}

export const deleteAddressSchema = {
  tags: ['Addresses'],
  summary: 'Delete address',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data:    { type: 'null' },
      },
    },
  },
}

export const setDefaultSchema = {
  tags: ['Addresses'],
  summary: 'Set as default address',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: { 200: addressResponse },
}

export const validatePincodeSchema = {
  tags: ['Addresses'],
  summary: 'Check delivery availability by pincode',
  body: {
    type: 'object',
    required: ['pincode'],
    properties: {
      pincode: { type: 'string', pattern: '^[1-9][0-9]{5}$' },
      // Optional — the Add Address screen's already-selected map pin.
      // When present, a pincode the plain list check rejects can still be
      // accepted via delivery-radius match (see
      // addresses.service.js#validatePincode). ajv's removeAdditional:'all'
      // strips any body field not declared here, so these must be listed
      // for a caller that starts sending them to actually reach the handler.
      lat: { type: 'number', minimum: -90, maximum: 90 },
      lng: { type: 'number', minimum: -180, maximum: 180 },
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
            available:    { type: 'boolean' },
            deliveryFee:  { type: 'number' },
            estimatedMin: { type: 'integer' },
            // Only present when an active pincode_mappings row matches —
            // see addresses.service.js#validatePincode (migration 089).
            city:         { type: 'string' },
            area:         { type: ['string', 'null'] },
            state:        { type: 'string' },
          },
        },
      },
    },
  },
}
