import { emit as emitAudit } from '../../utils/audit-log.js'
import { PincodeMappingsRepository } from './pincode-mappings.repository.js'

const PINCODE_PATTERN = /^[1-9][0-9]{5}$/

function isUniqueViolation(err) {
  return err && err.code === '23505'
}

export class PincodeMappingsService {
  constructor(repository = new PincodeMappingsRepository()) {
    this.repo = repository
  }

  async listAll() {
    return this.repo.findAll()
  }

  async create(data, actor) {
    const validationError = this._validate(data)
    if (validationError) return { success: false, message: validationError }

    try {
      const mapping = await this.repo.create(data, actor.userId)
      emitAudit('pincode_mapping_created', {
        actor_user_id: actor.userId,
        actor_role: actor.platformRole || actor.role,
        target_type: 'pincode_mapping',
        target_id: mapping.id,
        before: null,
        after: mapping,
        ip_address: actor.ip,
        user_agent: actor.userAgent,
      })
      return { success: true, mapping }
    } catch (err) {
      if (isUniqueViolation(err)) {
        return {
          success: false,
          message: 'A mapping already exists for this pincode. Edit that entry instead.',
        }
      }
      throw err
    }
  }

  async update(id, data, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Mapping not found' }

    const merged = { ...existing, ...data }
    const validationError = this._validate(merged, { isUpdate: true })
    if (validationError) return { success: false, message: validationError }

    try {
      const mapping = await this.repo.update(id, data, actor.userId)
      emitAudit('pincode_mapping_updated', {
        actor_user_id: actor.userId,
        actor_role: actor.platformRole || actor.role,
        target_type: 'pincode_mapping',
        target_id: id,
        before: existing,
        after: mapping,
        ip_address: actor.ip,
        user_agent: actor.userAgent,
      })
      return { success: true, mapping }
    } catch (err) {
      if (isUniqueViolation(err)) {
        return {
          success: false,
          message: 'A mapping already exists for this pincode.',
        }
      }
      throw err
    }
  }

  async remove(id, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Mapping not found' }
    await this.repo.remove(id)
    emitAudit('pincode_mapping_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'pincode_mapping',
      target_id: id,
      before: existing,
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true }
  }

  /** Mirrors the DB CHECK constraint so the dashboard gets a friendly 400 instead of a raw SQL error. */
  _validate(data) {
    if (data.pincode !== undefined && !PINCODE_PATTERN.test(String(data.pincode || ''))) {
      return 'pincode must be a valid 6-digit Indian PIN code'
    }
    if (!data.pincode) {
      return 'pincode is required'
    }
    if (!data.city || !String(data.city).trim()) {
      return 'city is required'
    }
    if (!data.state || !String(data.state).trim()) {
      return 'state is required'
    }
    return null
  }
}
