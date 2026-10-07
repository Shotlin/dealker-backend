import { ThemesService } from './themes.service.js'
import { success, error } from '../../../utils/apiResponse.js'

const svc = new ThemesService()

function shopScope(request) {
  const value = request.headers?.['x-shop-id']
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export class ThemesController {
  async list(request, reply) {
    return success(await svc.list(), 'Themes fetched')
  }

  async getTabThemes(request, reply) {
    return success(await svc.getTabThemes(request.query?.store_key), 'Tab themes fetched')
  }

  async getById(request, reply) {
    const theme = await svc.getById(request.params.id)
    if (!theme) return error('Theme not found', 404)
    return success(theme, 'Theme fetched')
  }

  async create(request, reply) {
    const theme = await svc.create(request.body, request.user.id, request.ip)
    if (!theme) return error('Theme tab not found', 404)
    reply.code(201)
    return success(theme, 'Theme created')
  }

  async update(request, reply) {
    const theme = await svc.update(
      request.params.id,
      request.body,
      request.user.id,
      request.ip,
      shopScope(request)
    )
    if (!theme) return error('Theme not found', 404)
    return success(theme, 'Theme updated')
  }

  async activate(request, reply) {
    const theme = await svc.activate(request.params.id, request.user.id, request.ip)
    if (!theme) return error('Theme not found', 404)
    return success(theme, 'Theme activated')
  }

  async scheduleTheme(request, reply) {
    const { scheduled_at } = request.body
    const theme = await svc.scheduleTheme(request.params.id, scheduled_at, request.user.id, request.ip)
    if (!theme) return error('Theme not found', 404)
    return success(theme, 'Theme scheduled')
  }

  async cancelSchedule(request, reply) {
    const theme = await svc.cancelSchedule(request.params.id, request.user.id, request.ip)
    if (!theme) return error('Theme not found', 404)
    return success(theme, 'Schedule cancelled')
  }

  async getVersions(request, reply) {
    const versions = await svc.getVersions(request.params.id)
    return success(versions, 'Version history fetched')
  }

  async rollbackVersion(request, reply) {
    const { version_id } = request.body
    const theme = await svc.rollbackToVersion(request.params.id, version_id, request.user.id, request.ip)
    if (!theme) return error('Version not found', 404)
    return success(theme, 'Theme rolled back')
  }

  async remove(request, reply) {
    const ok = await svc.remove(request.params.id, request.user.id, request.ip)
    if (!ok) return error('Cannot delete active theme or theme not found', 400)
    return success(null, 'Theme deleted')
  }
}
