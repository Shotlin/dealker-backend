/**
 * Cart JSON Schemas — validation for all cart endpoints
 */

const cartItemResponse = {
  type: 'object',
  properties: {
    productId:    { type: 'string' },
    shopId:       { type: 'string' },
    shopProductId:{ type: ['string', 'null'] },
    productFamilyId: { type: ['string', 'null'] },
    familyName:   { type: ['string', 'null'] },
    optionLabel:  { type: ['string', 'null'] },
    netQuantity:  { type: ['string', 'null'] },
    foodType:     { type: ['string', 'null'] },
    originTag:    { type: ['string', 'null'] },
    customBadges: { type: ['array', 'null'], items: { type: 'string' } },
    displayDeliveryMinutes: { type: ['integer', 'null'] },
    shopName:     { type: ['string', 'null'] },
    name:         { type: 'string' },
    slug:         { type: 'string' },
    price:        { type: 'number' },
    originalPrice:{ type: ['number', 'null'] },
    salePrice:    { type: ['number', 'null'] },
    effectivePrice:{ type: 'number' },
    discountAmount:{ type: 'number' },
    discountPercent:{ type: 'integer' },
    quantity:     { type: 'integer' },
    unit:         { type: 'string' },
    image:        { type: ['string', 'null'] },
    thumbnailUrl: { type: ['string', 'null'] },
    stockQuantity:{ type: 'integer' },
    maxOrderQty:  { type: 'integer' },
    subtotal:     { type: 'number' },
    lineTotal:    { type: 'number' },
    inStock:      { type: 'boolean' },
    isAvailable:  { type: 'boolean' },
  },
}

const shopGroupResponse = {
  type: 'object',
  properties: {
    shopId:    { type: 'string' },
    shopName:  { type: ['string', 'null'] },
    items:     { type: 'array', items: cartItemResponse },
    subtotal:  { type: 'number' },
    itemCount: { type: 'integer' },
  },
}

const cartResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data: {
      type: 'object',
      properties: {
        items:                { type: 'array', items: cartItemResponse },
        subtotal:             { type: 'number' },
        count:                { type: 'integer' },
        totalMrp:             { type: 'number' },
        totalSavings:         { type: 'number' },
        tipAmount:            { type: 'number' },
        deliveryInstructions: { type: ['string', 'null'] },
        priceMode:            { type: 'string', enum: ['retail', 'wholesale'] },
        shopGroups:           { type: 'array', items: shopGroupResponse },
      },
    },
  },
}

export const getCartSchema = {
  tags: ['Cart'],
  summary: 'Get current cart',
  response: { 200: cartResponse },
}

export const addItemSchema = {
  tags: ['Cart'],
  summary: 'Add item to cart',
  body: {
    type: 'object',
    required: ['quantity'],
    properties: {
      productId:     { type: 'string', format: 'uuid' },
      shopId:        { type: 'string', format: 'uuid' },
      shopProductId: { type: 'string', format: 'uuid' },
      priceMode: { type: 'string', enum: ['retail', 'wholesale'] },
      priceMode: { type: 'string', enum: ['retail', 'wholesale'] },
      quantity:      { type: 'integer', minimum: 1, maximum: 10000 },
    },
    anyOf: [
      { required: ['productId'] },
      { required: ['shopProductId'] },
    ],
  },
  response: { 200: cartResponse },
}

export const updateItemSchema = {
  tags: ['Cart'],
  summary: 'Update item quantity',
  params: {
    type: 'object',
    required: ['productId'],
    properties: {
      productId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['quantity'],
    properties: {
      quantity:      { type: 'integer', minimum: 1, maximum: 10000 },
      shopId:        { type: 'string', format: 'uuid' },
      shopProductId: { type: 'string', format: 'uuid' },
      priceMode: { type: 'string', enum: ['retail', 'wholesale'] },
    },
  },
  response: { 200: cartResponse },
}

export const removeItemSchema = {
  tags: ['Cart'],
  summary: 'Remove item from cart',
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
      shopId:        { type: 'string', format: 'uuid' },
      shopProductId: { type: 'string', format: 'uuid' },
    },
  },
  response: { 200: cartResponse },
}

export const clearCartSchema = {
  tags: ['Cart'],
  summary: 'Clear entire cart',
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

export const validateCartSchema = {
  tags: ['Cart'],
  summary: 'Validate cart before checkout (stock + price check)',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            valid:    { type: 'boolean' },
            items:    { type: 'array' },
            subtotal: { type: 'number' },
            warnings: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
}

export const getQuickAddSchema = {
  tags: ['Cart'],
  summary: 'Get "Quick Add" product suggestions based on cart contents',
  querystring: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 12 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array' },
      },
    },
  },
}

export const getCartSummarySchema = {
  tags: ['Cart'],
  summary: 'Get full bill summary with fees, savings, and delivery estimate',
  querystring: {
    type: 'object',
    properties: {
      quickDeliverySelected: { type: 'boolean', default: false },
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
          // Allow the new canonical fee fields (totals, fees[], distance,
          // freeDelivery, platformFee, smallCartFee, totalPayable) through
          // without enumerating every nested key — they are additive and
          // consumed by the redesigned bill UI.
          additionalProperties: true,
          properties: {
            itemTotal: {
              type: 'object',
              properties: {
                original: { type: 'number' },
                discounted: { type: 'number' },
              },
            },
            deliveryFee: {
              type: 'object',
              additionalProperties: true,
              properties: {
                amount: { type: 'number' },
                isFree: { type: 'boolean' },
                freeIn: { type: 'number' },
                originalAmount: { type: 'number' },
                waiverReason: { type: ['string', 'null'] },
              },
            },
            handlingFee: {
              type: 'object',
              properties: {
                amount: { type: 'number' },
                isFree: { type: 'boolean' },
                savedAmount: { type: 'number' },
              },
            },
            lateNightFee: {
              type: 'object',
              properties: {
                amount: { type: 'number' },
                isFree: { type: 'boolean' },
                savedAmount: { type: 'number' },
                isLateNight: { type: 'boolean' },
              },
            },
            couponDiscount: { type: 'number' },
            tipAmount: { type: 'number' },
            toPay: {
              type: 'object',
              properties: {
                original: { type: 'number' },
                final: { type: 'number' },
              },
            },
            savings: {
              type: 'object',
              properties: {
                total: { type: 'number' },
                breakdown: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string' },
                      label: { type: 'string' },
                      amount: { type: 'number' },
                    },
                  },
                },
              },
            },
            deliveryEstimate: {
              type: 'object',
              properties: {
                minutes: { type: 'integer' },
                label: { type: 'string' },
              },
            },
            itemCount: { type: 'integer' },
          },
        },
      },
    },
  },
}

export const updateTipSchema = {
  tags: ['Cart'],
  summary: 'Save tip amount for delivery partner',
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['amount'],
    properties: {
      amount: { type: 'number', minimum: 0, maximum: 500 },
      priceMode: { type: 'string', enum: ['retail', 'wholesale'] },
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
            tipAmount: { type: 'number' },
          },
        },
      },
    },
  },
}

export const updateDeliveryInstructionsSchema = {
  tags: ['Cart'],
  summary: 'Save delivery instructions',
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['instructions'],
    properties: {
      instructions: { type: 'string', maxLength: 200 },
      priceMode: { type: 'string', enum: ['retail', 'wholesale'] },
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
            instructions: { type: ['string', 'null'] },
          },
        },
      },
    },
  },
}
