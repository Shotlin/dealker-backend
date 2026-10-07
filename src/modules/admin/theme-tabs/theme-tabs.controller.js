import { ThemeTabsService } from './theme-tabs.service.js'
import { success, error } from '../../../utils/apiResponse.js'

const svc = new ThemeTabsService()

export class ThemeTabsController {
  async list(request, reply) {
    return success(await svc.list(request.query), 'Theme tabs fetched')
  }

  async getById(request, reply) {
    const tab = await svc.getById(request.params.id)
    if (!tab) return error('Theme tab not found', 404)
    return success(tab, 'Theme tab fetched')
  }

  async create(request, reply) {
    const tab = await svc.create(request.body, request.user.id, request.ip)
    reply.code(201)
    return success(tab, 'Theme tab created')
  }

  async update(request, reply) {
    const tab = await svc.update(request.params.id, request.body, request.user.id, request.ip)
    if (!tab) return error('Theme tab not found', 404)
    return success(tab, 'Theme tab updated')
  }

  async uploadIcon(request, reply) {
    const file = await request.file()
    if (!file) return error('No file uploaded', 400)

    const tab = await svc.updateIcon(request.params.id, file.file, request.user.id, request.ip)
    if (!tab) return error('Theme tab not found', 404)
    return success(tab, 'Theme tab icon updated')
  }

  async archive(request, reply) {
    const tab = await svc.archive(request.params.id, request.user.id, request.ip)
    if (!tab) return error('Theme tab not found', 404)
    return success(tab, 'Theme tab archived')
  }

  async restore(request, reply) {
    const tab = await svc.restore(request.params.id, request.user.id, request.ip)
    if (!tab) return error('Theme tab not found', 404)
    return success(tab, 'Theme tab restored')
  }
}
