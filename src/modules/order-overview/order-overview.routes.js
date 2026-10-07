import { orderOverview, shipmentTracking } from './order-overview.service.js'
import { orderPayouts } from './order-payout.service.js'

const wrap = (fn) => async (req, reply) => {
  try { return await fn(req, reply) } catch (e) {
    if (e?.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ success: false, message: e.message, code: e.code })
    throw e
  }
}

/** Dedicated order page data — /api/v1/admin/order-overview */
export default async function orderOverviewRoutes(fastify) {
  const pre = [fastify.authenticate, fastify.requireAdmin]
  fastify.get('/:id', { preHandler: pre }, wrap(async (req) => ({ success: true, data: await orderOverview.get(req.params.id) })))
  const me = (req) => req.userId || req.user.id
  fastify.post('/shipments/:shipmentId/event', {
    preHandler: pre,
    schema: { body: { type: 'object', required: ['status'], properties: { status: { enum: ['PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RTO', 'CANCELLED'] }, note: { type: 'string', maxLength: 300 }, location: { type: 'string', maxLength: 120 } }, additionalProperties: false } },
  }, wrap(async (req) => ({ success: true, data: await shipmentTracking.addEvent(req.params.shipmentId, req.body, me(req)) })))
  fastify.post('/shipments/:shipmentId/refresh', { preHandler: pre }, wrap(async (req) => ({ success: true, ...(await shipmentTracking.refresh(req.params.shipmentId)) })))
  fastify.post('/seller-orders/:sellerOrderId/shipment', {
    preHandler: pre,
    schema: { body: { type: 'object', required: ['courierName'], properties: { provider: { enum: ['SELF', 'SHIPROCKET', 'BLUEDART', 'PORTER'] }, courierName: { type: 'string', maxLength: 100 }, awb: { type: 'string', maxLength: 100 }, trackingUrl: { type: 'string', maxLength: 400 }, eta: { type: 'string' } }, additionalProperties: false } },
  }, wrap(async (req) => ({ success: true, data: await shipmentTracking.createManual(req.params.sellerOrderId, req.body, me(req)) })))
  const back = async (orderId) => ({ success: true, data: await orderOverview.get(orderId) })
  fastify.post('/seller-orders/:sellerOrderId/payout/hold', { preHandler: pre, schema: { body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', maxLength: 300 } } } } },
    wrap(async (req) => back(await orderPayouts.hold(req.params.sellerOrderId, req.body.reason, me(req)))))
  fastify.post('/seller-orders/:sellerOrderId/payout/release', { preHandler: pre }, wrap(async (req) => back(await orderPayouts.release(req.params.sellerOrderId, me(req)))))
  fastify.post('/seller-orders/:sellerOrderId/payout/pay', { preHandler: pre, schema: { body: { type: 'object', properties: { early: { type: 'boolean' } } } } },
    wrap(async (req) => back(await orderPayouts.payNow(req.params.sellerOrderId, req.body || {}, me(req)))))
  fastify.post('/payouts/:payoutId/mark-paid', { preHandler: pre, schema: { body: { type: 'object', required: ['utr'], properties: { utr: { type: 'string', maxLength: 60 } } } } },
    wrap(async (req) => back(await orderPayouts.markPaid(req.params.payoutId, req.body.utr, me(req)))))
  fastify.get('/:id/invoice', { preHandler: pre }, wrap(async (req, reply) => {
    const html = await orderOverview.invoiceHtml(req.params.id, req.query?.sellerOrderId || null)
    return reply.type('text/html; charset=utf-8').send(html)
  }))
}
