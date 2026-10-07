import { SectionsService } from './sections.service.js'
import { success, error } from '../../../utils/apiResponse.js'

const svc = new SectionsService()

function shopScope(request) {
  const value = request.headers?.['x-shop-id']
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export class SectionsController {
  async listByTab(request, reply) {
    return success(await svc.getByTabId(request.params.tabId, shopScope(request)), 'Sections fetched')
  }

  async getById(request, reply) {
    const section = await svc.getById(request.params.id)
    if (!section) return error('Section not found', 404)
    return success(section, 'Section fetched')
  }

  async create(request, reply) {
    const section = await svc.create(request.params.tabId, request.body, request.user.id, request.ip, shopScope(request))
    if (!section) return error('Tab not found', 404)
    reply.code(201)
    return success(section, 'Section created')
  }

  async update(request, reply) {
    const section = await svc.update(request.params.id, request.body, request.user.id, request.ip)
    if (!section) return error('Section not found', 404)
    return success(section, 'Section updated')
  }

  async updateMerch(request, reply) {
    const section = await svc.updateMerchBinding(request.params.id, request.body, request.user.id, request.ip)
    if (!section) return error('Section not found', 404)
    return success(section, 'Merch binding updated')
  }

  async remove(request, reply) {
    const section = await svc.remove(request.params.id, request.user.id, request.ip)
    if (!section) return error('Section not found', 404)
    return success(section, 'Section removed')
  }

  async reorder(request, reply) {
    const sections = await svc.reorder(request.params.tabId, request.body.order, request.user.id, request.ip, shopScope(request))
    return success(sections, 'Sections reordered')
  }

  async duplicate(request, reply) {
    const section = await svc.duplicate(request.params.id, request.user.id, request.ip)
    if (!section) return error('Section not found', 404)
    reply.code(201)
    return success(section, 'Section duplicated')
  }

  async getVersions(request, reply) {
    return success(await svc.getVersions(request.params.tabId), 'Version history fetched')
  }

  async rollbackVersion(request, reply) {
    const sections = await svc.rollbackToVersion(
      request.params.tabId,
      request.body.version_id,
      request.user.id,
      request.ip
    )
    if (!sections) return error('Version not found', 404)
    return success(sections, 'Sections rolled back')
  }

  async scheduleLayout(request, reply) {
    const layout = await svc.scheduleLayout(
      request.params.tabId,
      request.body.scheduled_at,
      request.user.id,
      request.ip
    )
    if (!layout) return error('Tab not found', 404)
    return success(layout, 'Layout scheduled')
  }

  async cancelSchedule(request, reply) {
    const result = await svc.cancelSchedule(request.params.tabId, request.user.id, request.ip)
    if (!result) return error('Tab not found', 404)
    return success(result, 'Schedule cancelled')
  }
}
