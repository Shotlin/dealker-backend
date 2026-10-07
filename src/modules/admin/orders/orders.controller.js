import { success, error } from '../../../utils/apiResponse.js'

export class AdminOrdersController {
  constructor(service) {
    this.service = service
  }

  async findAll(request, reply) {
    // `request.shopId` is set by the shared `requireShopScope` preHandler —
    // a shop-staff JWT's own shop, or an HQ user's optional X-Shop-Id
    // header (null = "All Shops", the only value that ever meant "every
    // permitted order" pre-fix, and still does).
    const data = await this.service.findAll({ ...request.query, shopId: request.shopId ?? null })
    return reply.send(success(data, 'Orders fetched'))
  }

  async getStatsByStatus(request, reply) {
    const data = await this.service.getStatsByStatus()
    return reply.send(success(data, 'Order stats by status'))
  }

  async getSettlementSummary(request, reply) {
    const data = await this.service.getSettlementSummary({ ...request.query, shopId: request.shopId ?? null })
    return reply.send(success(data, 'Settlement summary'))
  }

  async findById(request, reply) {
    try {
      const data = await this.service.findById(request.params.id, request.shopId ?? null)
      return reply.send(success(data, 'Order details'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async getOrderNotes(request, reply) {
    try {
      const data = await this.service.getOrderNotes(request.params.id, request.shopId ?? null)
      return reply.send(success(data, 'Order notes'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async addOrderNote(request, reply) {
    try {
      const data = await this.service.addOrderNote(request.params.id, request.user.id, request.body.body, request.ip, request.shopId ?? null)
      return reply.code(201).send(success(data, 'Note added'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async updateStatus(request, reply) {
    try {
      const { status, note } = request.body
      const data = await this.service.updateStatus(request.params.id, status, request.user.id, note, request.ip, request.shopId ?? null)
      return reply.send(success(data, 'Order status updated'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async rescheduleDelivery(request, reply) {
    try {
      const { scheduledSlotStart, scheduledSlotEnd, scheduledSlotLabel, reason } = request.body
      const data = await this.service.rescheduleDelivery(
        request.params.id,
        { scheduledSlotStart, scheduledSlotEnd, scheduledSlotLabel, reason },
        request.user.id,
        request.ip,
        request.shopId ?? null
      )
      return reply.send(success(data, 'Delivery rescheduled'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async assignRider(request, reply) {
    try {
      const { riderId } = request.body
      const data = await this.service.assignRider(request.params.id, riderId, request.user.id, request.ip, request.shopId ?? null)
      return reply.send(success(data, 'Rider assigned'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async bulkAssign(request, reply) {
    try {
      const data = await this.service.bulkAssign(request.body.assignments, request.user.id, request.ip, request.shopId ?? null)
      return reply.send(success(data, 'Bulk assignment done'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async createManualOrder(request, reply) {
    try {
      const data = await this.service.createManualOrder(request.body, request.user.id, request.ip)
      return reply.code(201).send(success(data, 'Manual order created'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async getInvoice(request, reply) {
    try {
      const buffer = await this.service.getInvoice(request.params.id, request.shopId ?? null)
      return reply.type('application/pdf').header('Content-Disposition', `attachment; filename=invoice-${request.params.id}.pdf`).send(buffer)
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async getPackingSlip(request, reply) {
    try {
      const buffer = await this.service.getPackingSlip(request.params.id, request.shopId ?? null)
      return reply.type('application/pdf').header('Content-Disposition', `attachment; filename=packing-slip-${request.params.id}.pdf`).send(buffer)
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async exportCSV(request, reply) {
    try {
      const buffer = await this.service.exportCSV(request.query)
      return reply.type('text/csv').header('Content-Disposition', 'attachment; filename=orders-export.csv').send(buffer)
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async refundOrder(request, reply) {
    try {
      const data = await this.service.refundOrder(
        request.params.id,
        request.body || {},
        request.user.id,
        request.ip,
        request.shopId ?? null
      )
      return reply.send(success(data, 'Order refunded'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async cancelOrder(request, reply) {
    try {
      const data = await this.service.cancelOrder(
        request.params.id,
        request.body || {},
        request.user.id,
        request.ip,
        request.shopId ?? null
      )
      return reply.send(success(data, 'Order cancelled'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async bulkUpdateStatus(request, reply) {
    try {
      const { orderIds, status } = request.body
      const data = await this.service.bulkUpdateStatus(orderIds, status, request.user.id, request.ip, request.shopId ?? null)
      return reply.send(success(data, 'Bulk status update done'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  /**
   * "Re-check with Razorpay" — a live, server-to-server reconciliation for
   * one order. Shown by the dashboard when a payment is PENDING or flagged
   * `needs_manual_review`.
   */
  async reconcilePayment(request, reply) {
    try {
      const data = await this.service.reconcilePayment(request.params.id, request.shopId ?? null)
      return reply.send(success(data, 'Payment reconciled'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async bulkReconcilePayments(request, reply) {
    try {
      const data = await this.service.bulkReconcilePayments(request.body.orderIds, request.shopId ?? null)
      return reply.send(success(data, 'Bulk reconciliation done'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  /**
   * Live Razorpay payment detail — fetched server-side with our Razorpay
   * secret, never exposed to the browser. Only the fields the dashboard
   * actually needs are returned.
   */
  async getRazorpayDetails(request, reply) {
    try {
      const data = await this.service.getRazorpayDetails(request.params.id, request.shopId ?? null)
      return reply.send(success(data, 'Razorpay payment detail'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async getSettlementInfo(request, reply) {
    try {
      const data = await this.service.getSettlementInfo(request.params.id, request.shopId ?? null)
      return reply.send(success(data, 'Settlement info'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async recordSettlement(request, reply) {
    try {
      const data = await this.service.recordSettlement(request.params.id, request.body, request.user.id, request.shopId ?? null)
      return reply.code(201).send(success(data, 'Payment settlement recorded'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async reverseSettlement(request, reply) {
    try {
      const data = await this.service.reverseSettlement(
        request.params.id, request.params.entryId, request.body?.reason, request.user.id, request.shopId ?? null
      )
      return reply.send(success(data, 'Payment settlement reversed'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }
}
