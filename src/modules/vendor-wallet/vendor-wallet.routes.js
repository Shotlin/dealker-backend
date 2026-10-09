/**
 * Vendor Wallet routes — mounted at /api/v1/admin/vendor-wallet.
 *
 * @module modules/vendor-wallet/vendor-wallet.routes
 */

import { VendorWalletService } from './vendor-wallet.service.js'

const service = new VendorWalletService()

function send(reply, err) {
  if (err.statusCode) return reply.status(err.statusCode).send({ success: false, message: err.message, code: err.code })
  throw err
}

export const adminVendorWalletRoutes = async function vendorWalletRoutes(fastify) {
  const view = [fastify.authenticate, fastify.requirePermission('vendor_wallet.view')]
  const manage = [fastify.authenticate, fastify.requirePermission('vendor_wallet.manage')]

  fastify.get('/overview', { preHandler: view, handler: async () => ({ success: true, data: await service.overview() }) })

  fastify.get('/reasons', { preHandler: view, handler: async () => ({ success: true, data: service.reasons() }) })

  fastify.get('/', {
    preHandler: view,
    handler: async (request) => {
      const { search = '', page = 1, limit = 20 } = request.query || {}
      return service.listWallets({ search: String(search), page: Math.max(1, Number(page)), limit: Math.min(100, Math.max(1, Number(limit))) })
    },
  })

  fastify.get('/vendors/:vendorId/transactions', {
    preHandler: view,
    handler: async (request, reply) => {
      const { direction = '', reasonCode = '', from = '', to = '', page = 1, limit = 25 } = request.query || {}
      try {
        return await service.transactions(request.params.vendorId, {
          direction: String(direction).toUpperCase(), reasonCode: String(reasonCode), from: String(from), to: String(to),
          page: Math.max(1, Number(page)), limit: Math.min(100, Math.max(1, Number(limit))),
        })
      } catch (err) { return send(reply, err) }
    },
  })

  fastify.post('/vendors/:vendorId/entries', {
    preHandler: manage,
    handler: async (request, reply) => {
      try {
        return { success: true, data: await service.addManualEntry(request.params.vendorId, request.body || {}, request.user?.id) }
      } catch (err) { return send(reply, err) }
    },
  })
}
