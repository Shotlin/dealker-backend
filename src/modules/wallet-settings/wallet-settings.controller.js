import { success, error } from '../../utils/apiResponse.js'

/**
 * Wallet Settings controller — thin HTTP layer
 */
export class WalletSettingsController {
  constructor(service) {
    this.service = service
  }

  async get(request, reply) {
    const config = await this.service.getConfig()
    return reply.send(success(config, 'Wallet settings fetched'))
  }

  async update(request, reply) {
    const result = await this.service.updateConfig(request.body)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'WALLET_SETTINGS_INVALID'))
    }
    return reply.send(success(result.data, 'Wallet settings updated'))
  }
}
