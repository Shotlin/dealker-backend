/**
 * Vendor Procurement Schemas — AJV validation (Big Phase 3)
 * Source of truth: vendor_procurement_blueprint/01_VENDOR_REQUIREMENTS.md §6
 *
 * @module modules/vendor-procurement/vendor-procurement.schema
 */

const UUID_PATTERN = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' }

const REQUEST_ITEM_SCHEMA = {
  type: 'object',
  // `product_id` is required (not just `category_id` + free-text
  // `item_name`) so a request line is tied to one exact catalog SKU from
  // creation — the whole point being that it then flows forward unchanged
  // through the quote/award/supply-order-item chain to receiving, instead
  // of staff re-guessing which SKU a "Chicken Breast Boneless" text label
  // meant at goods-in time.
  required: ['category_id', 'product_id', 'item_name', 'requested_quantity'],
  properties: {
    category_id: UUID_PATTERN,
    product_id: UUID_PATTERN,
    item_name: { type: 'string', minLength: 1, maxLength: 200 },
    requested_quantity: { type: 'number', exclusiveMinimum: 0 },
    unit: { type: 'string', enum: ['KG', 'PC', 'PACK', 'LTR'], default: 'KG' },
    spec_note: { type: 'string', maxLength: 2000 },
    fixed_unit_price: { type: 'number', minimum: 0 },
  },
  additionalProperties: false,
}

export const CreateRequestSchema = {
  type: 'object',
  required: ['shop_id', 'mode', 'title', 'items'],
  properties: {
    shop_id: UUID_PATTERN,
    mode: { type: 'string', enum: ['FIXED_OFFER', 'RFQ'] },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    required_delivery_at: { type: 'string' },
    response_deadline: { type: 'string' },
    notes: { type: 'string', maxLength: 4000 },
    quality_instructions: { type: 'string', maxLength: 4000 },
    substitutes_allowed: { type: 'boolean', default: false },
    items: { type: 'array', minItems: 1, items: REQUEST_ITEM_SCHEMA },
  },
  additionalProperties: false,
}

export const UpdateRequestSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    mode: { type: 'string', enum: ['FIXED_OFFER', 'RFQ'] },
    required_delivery_at: { type: 'string' },
    response_deadline: { type: 'string' },
    notes: { type: 'string', maxLength: 4000 },
    quality_instructions: { type: 'string', maxLength: 4000 },
    substitutes_allowed: { type: 'boolean' },
    items: { type: 'array', minItems: 1, items: REQUEST_ITEM_SCHEMA },
  },
  additionalProperties: false,
}

export const CancelRequestSchema = {
  type: 'object',
  properties: {
    reason: { type: 'string', maxLength: 1000 },
  },
  additionalProperties: false,
}

export const ListRequestsQuerySchema = {
  type: 'object',
  properties: {
    shop_id: UUID_PATTERN,
    status: {
      type: 'string',
      enum: ['DRAFT', 'PUBLISHED', 'AWARDED', 'IN_FULFILMENT', 'COMPLETED', 'CANCELLED', 'EXPIRED'],
    },
    mode: { type: 'string', enum: ['FIXED_OFFER', 'RFQ'] },
    search: { type: 'string', maxLength: 200 },
    page: { type: 'integer', minimum: 1, default: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
  additionalProperties: false,
}

export const SubmitQuoteSchema = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['request_item_id', 'quoted_quantity', 'unit_price'],
        properties: {
          request_item_id: UUID_PATTERN,
          quoted_quantity: { type: 'number', exclusiveMinimum: 0 },
          unit_price: { type: 'number', minimum: 0 },
        },
        additionalProperties: false,
      },
    },
    promised_delivery_at: { type: 'string' },
    note: { type: 'string', maxLength: 2000 },
    validity_until: { type: 'string' },
  },
  additionalProperties: false,
}

export const UpdateQuoteSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['request_item_id', 'quoted_quantity', 'unit_price'],
        properties: {
          request_item_id: UUID_PATTERN,
          quoted_quantity: { type: 'number', exclusiveMinimum: 0 },
          unit_price: { type: 'number', minimum: 0 },
        },
        additionalProperties: false,
      },
    },
    promised_delivery_at: { type: 'string' },
    note: { type: 'string', maxLength: 2000 },
    validity_until: { type: 'string' },
  },
  additionalProperties: false,
}

export const ServiceProfileSchema = {
  type: 'object',
  properties: {
    category_ids: { type: 'array', items: UUID_PATTERN, uniqueItems: true, default: [] },
    service_pincodes: {
      type: 'array',
      items: { type: 'string', pattern: '^[1-9][0-9]{5}$' },
      uniqueItems: true,
      default: [],
    },
    shop_ids: { type: 'array', items: UUID_PATTERN, uniqueItems: true, default: [] },
  },
  additionalProperties: false,
}

export const EligibleVendorPreviewSchema = {
  type: 'object',
  required: ['shop_id'],
  properties: {
    shop_id: UUID_PATTERN,
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['category_id'],
        properties: {
          category_id: UUID_PATTERN,
        },
        additionalProperties: false,
      },
      default: [],
    },
  },
  additionalProperties: false,
}

export const UpdateSupplyStatusSchema = {
  type: 'object',
  required: ['status'],
  properties: {
    status: {
      type: 'string',
      enum: [
        'ACCEPTED', 'PROCESSING', 'CLEANING', 'PACKED',
        'READY_FOR_DISPATCH', 'DISPATCHED',
      ],
    },
    delivery_reference: { type: 'string', maxLength: 100 },
    dispatch_note: { type: 'string', maxLength: 1000 },
    vehicle_note: { type: 'string', maxLength: 500 },
    note: { type: 'string', maxLength: 1000 },
  },
  additionalProperties: false,
}

export const AttachEvidenceSchema = {
  type: 'object',
  required: ['media_public_id', 'media_url'],
  properties: {
    evidence_type: { type: 'string', enum: ['QUALITY_VIDEO', 'QUALITY_IMAGE', 'PACKING_IMAGE', 'DISPATCH_PROOF', 'OTHER'] },
    media_public_id: { type: 'string', minLength: 1, maxLength: 255 },
    media_url: { type: 'string', minLength: 1, maxLength: 512 },
    mime_type: { type: 'string', maxLength: 100 },
    duration_seconds: { type: 'integer', exclusiveMinimum: 0 },
    size_bytes: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
}

export const ReceiveSupplySchema = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['supply_order_item_id', 'received_quantity', 'accepted_quantity', 'rejected_quantity'],
        properties: {
          supply_order_item_id: UUID_PATTERN,
          received_quantity: { type: 'number', minimum: 0 },
          accepted_quantity: { type: 'number', minimum: 0 },
          rejected_quantity: { type: 'number', minimum: 0 },
          product_id: UUID_PATTERN,
          issue_category: { type: 'string', enum: ['QUANTITY_SHORTAGE', 'QUALITY', 'FRESHNESS', 'CLEANING', 'PACKAGING', 'LATE_DELIVERY', 'DAMAGED', 'DOCUMENTATION', 'OTHER'] },
          issue_note: { type: 'string', maxLength: 1000 },
          expiry_date: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    note: { type: 'string', maxLength: 2000 },
    photo_url: { type: 'string', maxLength: 512 },
    warehouse_id: UUID_PATTERN,
  },
  additionalProperties: false,
}

function ratingDimension(name) {
  return { [name]: { type: 'integer', minimum: 1, maximum: 5 } }
}

export const SubmitReviewSchema = {
  type: 'object',
  required: ['rating_freshness', 'rating_cleaning', 'rating_packaging', 'rating_quantity_accuracy', 'rating_punctuality', 'rating_overall'],
  properties: {
    ...ratingDimension('rating_freshness'),
    ...ratingDimension('rating_cleaning'),
    ...ratingDimension('rating_packaging'),
    ...ratingDimension('rating_quantity_accuracy'),
    ...ratingDimension('rating_punctuality'),
    ...ratingDimension('rating_overall'),
    comment: { type: 'string', maxLength: 2000 },
    issue_category: { type: 'string', enum: ['QUANTITY_SHORTAGE', 'QUALITY', 'FRESHNESS', 'CLEANING', 'PACKAGING', 'LATE_DELIVERY', 'DAMAGED', 'DOCUMENTATION', 'OTHER'] },
    issue_note: { type: 'string', maxLength: 2000 },
  },
  additionalProperties: false,
}
