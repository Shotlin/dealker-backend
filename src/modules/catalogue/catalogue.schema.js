/**
 * Catalogue & Product Proposal Schemas & DTO Validation
 * Source of truth: Blueprint §06.2, Phase 3A
 *
 * @module modules/catalogue/catalogue.schema
 */

export const CreateBrandSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 255 },
    slug: { type: 'string', maxLength: 255 },
    logo_url: { type: 'string', maxLength: 512 },
    is_active: { type: 'boolean', default: true },
  },
  additionalProperties: false,
}

export const CreateCategorySchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 255 },
    slug: { type: 'string', maxLength: 255 },
    description: { type: 'string' },
    image_url: { type: 'string', maxLength: 512 },
    parent_id: { type: ['string', 'null'] },
  },
  additionalProperties: false,
}

export const CreateProposalSchema = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', minLength: 2, maxLength: 255 },
    slug: { type: 'string', maxLength: 255 },
    category_id: { type: 'string' },
    brand_id: { type: 'string' },
    sku: { type: 'string', maxLength: 100 },
    description: { type: 'string' },
    unit: { type: 'string', default: 'kg' },
    target_price: { type: 'number', minimum: 0 },
    metadata: { type: 'object' },
  },
  additionalProperties: false,
}

export const ReviewProposalSchema = {
  type: 'object',
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['START_REVIEW', 'APPROVE', 'REJECT', 'REQUEST_CORRECTION', 'PUBLISH'] },
    comments: { type: 'string', maxLength: 500 },
  },
  additionalProperties: false,
}
