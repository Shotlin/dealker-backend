import { success } from '../../utils/apiResponse.js'
import { refreshRazorpayClient } from '../../config/razorpay.js'

/**
 * Razorpay settings controller — thin HTTP layer. `save`/`activate` both
 * call `refreshRazorpayClient()` afterwards so the running API/worker
 * process picks up the change immediately, with no redeploy/restart —
 * same "no bundled fallback, live invalidation" discipline as the Ola
 * Maps and theme-cache modules.
 */
export class RazorpaySettingsController {
  constructor(service) {
    this.service = service
  }

  /** GET / — both environments (masked), which one is active */
  async get(request, reply) {
    const settings = await this.service.get()
    return reply.code(200).send(success(settings, 'Razorpay settings fetched'))
  }

  /** POST /test — validate a draft or the currently-saved credentials for one mode, without activating it */
  async test(request, reply) {
    const { mode, keyId, keySecret } = request.body
    const result = await this.service.test({ mode, keyId, keySecret }, request.user?.id)
    const message = result.success ? 'Connection successful' : 'Connection failed'
    return reply.code(200).send(success(result, message))
  }

  /** PUT /:mode — save credentials for one mode (does not activate it) */
  async saveCredentials(request, reply) {
    const { mode } = request.params
    const { keyId, keySecret, webhookSecret } = request.body
    const settings = await this.service.saveCredentials(
      mode.toUpperCase(),
      { keyId, keySecret, webhookSecret },
      request.user?.id
    )
    await refreshRazorpayClient()
    return reply.code(200).send(success(settings, 'Razorpay credentials saved'))
  }

  /** POST /activate — switch which mode is live */
  async activate(request, reply) {
    const { mode, confirm } = request.body
    const settings = await this.service.activate(mode, { confirm }, request.user?.id)
    await refreshRazorpayClient()
    return reply.code(200).send(success(settings, `${mode} is now the active Razorpay environment`))
  }
}
