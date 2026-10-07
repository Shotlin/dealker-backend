import { success } from '../../utils/apiResponse.js'

/**
 * Fee config controller — HTTP layer
 */
export class FeeConfigController {
  constructor(service) {
    this.service = service
  }

  /** GET / — List all fee configs */
  async getAll(request, reply) {
    const configs = await this.service.getAllFees()
    return reply.code(200).send(success(configs, 'Fee configs fetched'))
  }

  /** PUT /:feeType — Update a fee config */
  async update(request, reply) {
    const { feeType } = request.params
    const result = await this.service.updateFee(feeType, request.body)
    return reply.code(200).send(success(result, 'Fee config updated'))
  }
}
