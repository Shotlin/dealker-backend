import { success, error } from '../../utils/apiResponse.js'

export class OrderNotificationSettingsController {
  constructor(service) {
    this.service = service
  }

  listAll = async (request, reply) => {
    const data = await this.service.listAll()
    return reply.send(success(data, 'Order notification settings'))
  }

  getCustomerFlags = async (request, reply) => {
    const data = await this.service.getCustomerFlags()
    return reply.send(success(data, 'Order notification flags'))
  }

  update = async (request, reply) => {
    try {
      const data = await this.service.update(
        request.params.eventKey,
        request.body,
        request.user?.id ?? null
      )
      return reply.send(success(data, 'Order notification setting saved'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message, err.code))
    }
  }

  sendTest = async (request, reply) => {
    try {
      await this.service.sendTest(request.params.eventKey, request.user?.id, request.body || {})
      return reply.send(success(null, 'Test notification sent'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message, err.code))
    }
  }
}
