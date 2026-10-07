import { AdminNotificationsService } from './notifications.service.js'
import { success, error } from '../../../utils/apiResponse.js'

const svc = new AdminNotificationsService()

export class AdminNotificationsController {
  /* ── Templates ── */
  async listTemplates(request, reply) {
    const data = await svc.listTemplates()
    return success(data, 'Templates fetched')
  }

  async getTemplate(request, reply) {
    const t = await svc.getTemplate(request.params.id)
    if (!t) return error('Template not found', 404)
    return success(t, 'Template fetched')
  }

  async createTemplate(request, reply) {
    const t = await svc.createTemplate(request.body, request.user.id, request.ip)
    return success(t, 'Template created')
  }

  async updateTemplate(request, reply) {
    const t = await svc.updateTemplate(request.params.id, request.body, request.user.id, request.ip)
    if (!t) return error('Template not found', 404)
    return success(t, 'Template updated')
  }

  async deleteTemplate(request, reply) {
    const ok = await svc.deleteTemplate(request.params.id, request.user.id, request.ip)
    if (!ok) return error('Template not found', 404)
    return success(null, 'Template deleted')
  }

  /* ── Campaigns ── */
  async sendBulk(request, reply) {
    const data = await svc.sendBulk(request.body, request.user.id, request.ip)
    return success(data, 'Bulk notification queued')
  }

  async schedule(request, reply) {
    const data = await svc.scheduleCampaign(request.body, request.user.id, request.ip)
    return success(data, 'Campaign scheduled')
  }

  async cancelCampaign(request, reply) {
    const c = await svc.cancelCampaign(request.params.id, request.user.id, request.ip)
    if (!c) return error('Campaign not found or cannot be cancelled', 404)
    return success(c, 'Campaign cancelled')
  }

  async listCampaigns(request, reply) {
    const { page, limit, status } = request.query
    const data = await svc.listCampaigns({ page, limit, status })
    return success(data, 'Campaigns fetched')
  }

  async getCampaign(request, reply) {
    const c = await svc.getCampaign(request.params.id)
    if (!c) return error('Campaign not found', 404)
    return success(c, 'Campaign fetched')
  }

  async getSegmentCount(request, reply) {
    const { segment, segmentValue } = request.query
    const count = await svc.getSegmentCount(segment, segmentValue)
    return success({ segment, segmentValue, count }, 'Segment count fetched')
  }
}
