const uuidParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }

export const listOrdersSchema = {
  tags: ['Admin Orders'],
  summary: 'List all orders with filters',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', default: 1 },
      limit: { type: 'integer', default: 20, maximum: 100 },
      status: { type: 'string' },
      paymentMethod: { type: 'string' },
      paymentStatus: { type: 'string' },
      search: { type: 'string' },
      startDate: { type: 'string', format: 'date-time' },
      endDate: { type: 'string', format: 'date-time' },
      deliveryType: { type: 'string', enum: ['express', 'scheduled', 'standard'] },
      riderId: { type: 'string', format: 'uuid' },
      minAmount: { type: 'number', minimum: 0 },
      maxAmount: { type: 'number', minimum: 0 },
      // Money-safety filters — see §"payment reconciliation hardening".
      // needsPaymentReview: a Razorpay capture landed after the order had
      // already moved on (cancelled/stock restored) and needs a human
      // decision. recoveredFromFailed: a payment this app once showed
      // FAILED that Razorpay later proved was actually captured all along.
      needsPaymentReview: { type: 'boolean' },
      recoveredFromFailed: { type: 'boolean' },
    },
  },
}

export const statsByStatusSchema = { tags: ['Admin Orders'], summary: 'Order counts by status (tab badges)' }

// Same filterable fields as listOrdersSchema (minus page/limit — this is
// an aggregate over the whole filtered set, not a page of it), so
// "settlement summary for what I'm currently looking at" always matches
// the list's own filters exactly.
export const settlementSummarySchema = {
  tags: ['Admin Orders'],
  summary: 'Customer money settled — COD vs online vs wallet vs still pending, for the current filtered view',
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string' },
      paymentMethod: { type: 'string' },
      paymentStatus: { type: 'string' },
      search: { type: 'string' },
      startDate: { type: 'string', format: 'date-time' },
      endDate: { type: 'string', format: 'date-time' },
      deliveryType: { type: 'string', enum: ['express', 'scheduled', 'standard'] },
      riderId: { type: 'string', format: 'uuid' },
      minAmount: { type: 'number', minimum: 0 },
      maxAmount: { type: 'number', minimum: 0 },
      needsPaymentReview: { type: 'boolean' },
      recoveredFromFailed: { type: 'boolean' },
    },
  },
}

export const orderDetailSchema = {
  tags: ['Admin Orders'],
  summary: 'Full order detail with items, timeline, payment, delivery',
  params: uuidParam,
}

export const orderNotesListSchema = {
  tags: ['Admin Orders'],
  summary: 'List all internal notes for an order (chronological, oldest first)',
  params: uuidParam,
}

export const addOrderNoteSchema = {
  tags: ['Admin Orders'],
  summary: 'Add a free-text internal note to an order',
  params: uuidParam,
  body: {
    type: 'object',
    required: ['body'],
    properties: {
      body: { type: 'string', minLength: 1, maxLength: 2000 },
    },
  },
}

export const updateStatusSchema = {
  tags: ['Admin Orders'],
  summary: 'Update order status with transition validation',
  params: uuidParam,
  body: {
    type: 'object',
    required: ['status'],
    properties: {
      status: { type: 'string', enum: ['CONFIRMED', 'PREPARING', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'REFUNDED'] },
      note: { type: 'string', maxLength: 500 },
    },
  },
}

export const rescheduleOrderSchema = {
  tags: ['Admin Orders'],
  summary: 'Change an order\'s scheduled delivery slot',
  params: uuidParam,
  body: {
    type: 'object',
    required: ['scheduledSlotStart', 'scheduledSlotEnd', 'scheduledSlotLabel'],
    properties: {
      scheduledSlotStart: { type: 'string', format: 'date-time' },
      scheduledSlotEnd: { type: 'string', format: 'date-time' },
      scheduledSlotLabel: { type: 'string', maxLength: 120 },
      reason: { type: 'string', maxLength: 500 },
    },
  },
}

export const assignRiderSchema = {
  tags: ['Admin Orders'],
  summary: 'Assign rider to order',
  params: uuidParam,
  body: {
    type: 'object',
    required: ['riderId'],
    properties: { riderId: { type: 'string', format: 'uuid' } },
  },
}

export const bulkAssignSchema = {
  tags: ['Admin Orders'],
  summary: 'Bulk assign riders to orders',
  body: {
    type: 'object',
    required: ['assignments'],
    properties: {
      assignments: {
        type: 'array',
        maxItems: 50,
        items: {
          type: 'object',
          required: ['orderId', 'riderId'],
          properties: {
            orderId: { type: 'string', format: 'uuid' },
            riderId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
  },
}

export const manualOrderSchema = {
  tags: ['Admin Orders'],
  summary: 'Create manual order on behalf of customer',
  body: {
    type: 'object',
    required: ['userId', 'items', 'deliveryAddress'],
    properties: {
      userId: { type: 'string', format: 'uuid' },
      shopId: { type: 'string', format: 'uuid' },
      items: {
        type: 'array', minItems: 1,
        items: {
          type: 'object',
          required: ['productId', 'quantity'],
          properties: {
            productId: { type: 'string', format: 'uuid' },
            quantity: { type: 'integer', minimum: 1 },
          },
        },
      },
      paymentMethod: { type: 'string', enum: ['COD', 'MANUAL'], default: 'MANUAL' },
      deliveryAddress: { type: 'object' },
      couponCode: { type: 'string' },
    },
  },
}

export const invoiceSchema = { tags: ['Admin Orders'], summary: 'Download PDF invoice', params: uuidParam }
export const packingSlipSchema = { tags: ['Admin Orders'], summary: 'Download PDF packing slip', params: uuidParam }

export const exportSchema = {
  tags: ['Admin Orders'],
  summary: 'Export orders to CSV',
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string' },
      startDate: { type: 'string', format: 'date-time' },
      endDate: { type: 'string', format: 'date-time' },
    },
  },
}

export const refundOrderSchema = {
  tags: ['Admin Orders'],
  summary: 'Refund an order (credits wallet or initiates payment refund)',
  params: uuidParam,
  body: {
    type: 'object',
    properties: {
      // No `amount` field — the refund amount is never admin-editable, it's
      // always exactly what the customer paid (see refundOrder in the
      // service). Accepting an amount here would let an admin refund more
      // (or less) than was ever collected.
      reason: { type: 'string', maxLength: 500 },
      refundTo: { type: 'string', enum: ['wallet', 'original', 'none'], default: 'wallet' },
    },
  },
}

export const cancelOrderSchema = {
  tags: ['Admin Orders'],
  summary: 'Cancel an order with optional reason and refund',
  params: uuidParam,
  body: {
    type: 'object',
    properties: {
      reason: { type: 'string', maxLength: 500 },
      refundTo: { type: 'string', enum: ['wallet', 'original', 'none'], default: 'wallet' },
    },
  },
}

export const reconcilePaymentSchema = {
  tags: ['Admin Orders'],
  summary: 'Re-check this order\'s payment against Razorpay directly (server-to-server)',
  params: uuidParam,
}

export const bulkReconcilePaymentsSchema = {
  tags: ['Admin Orders'],
  summary: 'Re-check payment status for multiple orders against Razorpay',
  body: {
    type: 'object',
    required: ['orderIds'],
    properties: {
      orderIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1, maxItems: 50 },
    },
  },
}

export const razorpayDetailsSchema = {
  tags: ['Admin Orders'],
  summary: 'Live Razorpay payment detail for this order — fetched server-side, never exposes credentials',
  params: uuidParam,
}

export const settlementInfoSchema = {
  tags: ['Admin Orders'],
  summary: 'Manual payment settlement summary + immutable history for this order',
  params: uuidParam,
}

export const recordSettlementSchema = {
  tags: ['Admin Orders'],
  summary: 'Record a manual payment collection (cash/UPI/other) against this order',
  params: uuidParam,
  body: {
    type: 'object',
    required: ['amount', 'method'],
    properties: {
      amount: { type: 'number', exclusiveMinimum: 0 },
      method: { type: 'string', enum: ['CASH', 'UPI', 'CASH_UPI', 'OTHER'] },
      cashAmount: { type: 'number', minimum: 0 },
      upiAmount: { type: 'number', minimum: 0 },
      reference: { type: 'string', maxLength: 150 },
      methodNote: { type: 'string', maxLength: 500 },
      internalNote: { type: 'string', maxLength: 1000 },
    },
  },
}

export const reverseSettlementSchema = {
  tags: ['Admin Orders'],
  summary: 'Reverse a mistaken settlement entry via a controlled, audited adjustment — never edits/deletes the original',
  params: {
    type: 'object',
    required: ['id', 'entryId'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      entryId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    properties: {
      reason: { type: 'string', maxLength: 500 },
    },
  },
}

export const bulkStatusSchema = {
  tags: ['Admin Orders'],
  summary: 'Bulk update status for multiple orders',
  body: {
    type: 'object',
    required: ['orderIds', 'status'],
    properties: {
      orderIds: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: 50 },
      status: { type: 'string', enum: ['CONFIRMED', 'PREPARING', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'] },
    },
  },
}

