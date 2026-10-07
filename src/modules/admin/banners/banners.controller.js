import { AdminBannersService } from './banners.service.js'
import { success, error } from '../../../utils/apiResponse.js'

const svc = new AdminBannersService()

export class AdminBannersController {
  async list(request, reply) {
    const data = await svc.list()
    return success(data, 'Banners fetched')
  }

  async getById(request, reply) {
    const banner = await svc.getById(request.params.id)
    if (!banner) return reply.code(404).send(error('Banner not found', 'NOT_FOUND'))
    return success(banner, 'Banner fetched')
  }

  async create(request, reply) {
    const banner = await svc.create(request.body, request.user.id, request.ip)
    return reply.code(201).send(success(banner, 'Banner created'))
  }

  async update(request, reply) {
    const banner = await svc.update(request.params.id, request.body, request.user.id, request.ip)
    if (!banner) return reply.code(404).send(error('Banner not found', 'NOT_FOUND'))
    return success(banner, 'Banner updated')
  }

  async remove(request, reply) {
    const ok = await svc.remove(request.params.id, request.user.id, request.ip)
    if (!ok) return reply.code(404).send(error('Banner not found', 'NOT_FOUND'))
    return success(null, 'Banner deleted')
  }

  async reorder(request, reply) {
    await svc.reorder(request.body.orderedIds, request.user.id, request.ip)
    return success(null, 'Banners reordered')
  }
}
