import { AdminOrdersRepository } from './orders.repository.js'
import { AdminOrdersService } from './orders.service.js'
import { AdminOrdersController } from './orders.controller.js'
import { requireShopScope } from '../../../middlewares/shop-scope.js'
import {
  listOrdersSchema, statsByStatusSchema, orderDetailSchema,
  updateStatusSchema, assignRiderSchema, bulkAssignSchema,
  manualOrderSchema, invoiceSchema, packingSlipSchema, exportSchema,
  refundOrderSchema, cancelOrderSchema, bulkStatusSchema,
  rescheduleOrderSchema, orderNotesListSchema, addOrderNoteSchema,
  reconcilePaymentSchema, bulkReconcilePaymentsSchema, razorpayDetailsSchema,
  settlementSummarySchema, settlementInfoSchema, recordSettlementSchema, reverseSettlementSchema,
} from './orders.schema.js'

/**
 * Admin orders routes
 * Prefix: /api/v1/admin/orders
 */
export default async function adminOrdersRoutes(fastify) {
  const repo = new AdminOrdersRepository()
  const service = new AdminOrdersService(repo, fastify)
  const ctrl = new AdminOrdersController(service)
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]
  // `requireShopScope()` resolves `request.shopId` — a shop-staff JWT's
  // own shop, or an HQ user's optional X-Shop-Id header (null = "All
  // Shops"). Previously only the list endpoint resolved this at all; every
  // other endpoint here — detail, notes, status, reschedule, assign-rider,
  // invoice, packing-slip, refund, cancel, and the reconcile/razorpay-
  // details endpoints below — let any admin token view or mutate ANY
  // order by UUID regardless of the dashboard's selected shop. HQ
  // ADMIN/SUPER_ADMIN tokens can already see every shop by design (that's
  // what "All Shops" means), so this was never a cross-tenant data leak
  // between different store owners — but it did mean an HQ admin who had
  // deliberately scoped themselves to one branch could still silently
  // read/mutate another branch's order by guessing its UUID, and it left
  // no real enforcement in place for any future permission model that
  // lets a genuinely shop-scoped token reach this module. The service
  // layer now checks the fetched order's own `shop_id` against
  // `request.shopId` (see `AdminOrdersService#_assertShopAccess`) —
  // `requireShopScope()` here is what makes `request.shopId` exist to
  // check in the first place.
  const adminAuthShopScoped = [fastify.authenticate, fastify.requireAdmin, requireShopScope()]

  fastify.get('/', { schema: listOrdersSchema, preHandler: adminAuthShopScoped }, ctrl.findAll.bind(ctrl))
  fastify.get('/stats-by-status', { schema: statsByStatusSchema, preHandler: adminAuth }, ctrl.getStatsByStatus.bind(ctrl))
  // Shop-scoped like the list itself (`adminAuthShopScoped`, not the bare
  // `adminAuth` stats-by-status uses above) — "customer money settled"
  // must respect the dashboard's selected branch, not silently answer for
  // every shop when a shop-scoped user asks.
  fastify.get('/settlement-summary', { schema: settlementSummarySchema, preHandler: adminAuthShopScoped }, ctrl.getSettlementSummary.bind(ctrl))
  fastify.get('/export', { schema: exportSchema, preHandler: adminAuth }, ctrl.exportCSV.bind(ctrl))
  fastify.post('/manual', { schema: manualOrderSchema, preHandler: adminAuth }, ctrl.createManualOrder.bind(ctrl))
  fastify.post('/bulk-assign', { schema: bulkAssignSchema, preHandler: adminAuthShopScoped }, ctrl.bulkAssign.bind(ctrl))
  fastify.post('/bulk-status', { schema: bulkStatusSchema, preHandler: adminAuthShopScoped }, ctrl.bulkUpdateStatus.bind(ctrl))
  fastify.post('/bulk-reconcile-payment', { schema: bulkReconcilePaymentsSchema, preHandler: adminAuthShopScoped }, ctrl.bulkReconcilePayments.bind(ctrl))
  fastify.get('/:id', { schema: orderDetailSchema, preHandler: adminAuthShopScoped }, ctrl.findById.bind(ctrl))
  fastify.get('/:id/notes', { schema: orderNotesListSchema, preHandler: adminAuthShopScoped }, ctrl.getOrderNotes.bind(ctrl))
  fastify.post('/:id/notes', { schema: addOrderNoteSchema, preHandler: adminAuthShopScoped }, ctrl.addOrderNote.bind(ctrl))
  fastify.put('/:id/status', { schema: updateStatusSchema, preHandler: adminAuthShopScoped }, ctrl.updateStatus.bind(ctrl))
  fastify.put('/:id/reschedule', { schema: rescheduleOrderSchema, preHandler: adminAuthShopScoped }, ctrl.rescheduleDelivery.bind(ctrl))
  fastify.put('/:id/assign-rider', { schema: assignRiderSchema, preHandler: adminAuthShopScoped }, ctrl.assignRider.bind(ctrl))
  fastify.get('/:id/invoice', { schema: invoiceSchema, preHandler: adminAuthShopScoped }, ctrl.getInvoice.bind(ctrl))
  fastify.get('/:id/packing-slip', { schema: packingSlipSchema, preHandler: adminAuthShopScoped }, ctrl.getPackingSlip.bind(ctrl))
  fastify.post('/:id/refund', { schema: refundOrderSchema, preHandler: adminAuthShopScoped }, ctrl.refundOrder.bind(ctrl))
  fastify.post('/:id/cancel', { schema: cancelOrderSchema, preHandler: adminAuthShopScoped }, ctrl.cancelOrder.bind(ctrl))
  fastify.post('/:id/reconcile-payment', { schema: reconcilePaymentSchema, preHandler: adminAuthShopScoped }, ctrl.reconcilePayment.bind(ctrl))
  fastify.get('/:id/razorpay-details', { schema: razorpayDetailsSchema, preHandler: adminAuthShopScoped }, ctrl.getRazorpayDetails.bind(ctrl))
  // Manual payment settlement (cash/UPI collected outside the rider app /
  // online-payment flow) — see AdminOrdersService#recordSettlement.
  fastify.get('/:id/settlements', { schema: settlementInfoSchema, preHandler: adminAuthShopScoped }, ctrl.getSettlementInfo.bind(ctrl))
  fastify.post('/:id/settlements', { schema: recordSettlementSchema, preHandler: adminAuthShopScoped }, ctrl.recordSettlement.bind(ctrl))
  fastify.post('/:id/settlements/:entryId/reverse', { schema: reverseSettlementSchema, preHandler: adminAuthShopScoped }, ctrl.reverseSettlement.bind(ctrl))
}
