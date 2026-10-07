import { RazorpaySettingsController } from './razorpay-settings.controller.js'
import { RazorpaySettingsService } from './razorpay-settings.service.js'
import {
  getSettingsSchema,
  testSettingsSchema,
  saveCredentialsSchema,
  activateSchema,
} from './razorpay-settings.schema.js'

/**
 * Razorpay settings admin routes plugin.
 * Prefix: /api/v1/admin/razorpay-settings
 *
 *   GET  /             — both environments (masked), which one is active
 *   POST /test          — test a draft or the stored credentials for one mode
 *   PUT  /:mode          — save credentials for one mode (TEST or PRODUCTION)
 *   POST /activate       — switch the active mode
 *
 * Admin-only, same coarse `requireAdmin` gate as `wallet-settings` and
 * `ola-maps-settings` — no new canonical Permission_String was introduced
 * for this (§ src/utils/permissions.js), consistent with how those two
 * sibling settings modules are gated today.
 */
export default async function razorpaySettingsRoutes(fastify) {
  const service = new RazorpaySettingsService()
  const controller = new RazorpaySettingsController(service)
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/', {
    schema: getSettingsSchema,
    preHandler: adminAuth,
  }, controller.get.bind(controller))

  fastify.post('/test', {
    schema: testSettingsSchema,
    preHandler: adminAuth,
  }, controller.test.bind(controller))

  fastify.put('/:mode', {
    schema: saveCredentialsSchema,
    preHandler: adminAuth,
  }, controller.saveCredentials.bind(controller))

  fastify.post('/activate', {
    schema: activateSchema,
    preHandler: adminAuth,
  }, controller.activate.bind(controller))
}
