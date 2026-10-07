/**
 * Fee config service — business logic for fee management
 */
export class FeeConfigService {
  constructor(feeConfigRepository) {
    this.repo = feeConfigRepository
  }

  async getAllFees() {
    return this.repo.getAll()
  }

  async updateFee(feeType, data) {
    const existing = await this.repo.getByType(feeType)
    if (!existing) {
      const error = new Error('Fee config not found')
      error.statusCode = 404
      error.code = 'NOT_FOUND'
      throw error
    }

    const nextData = {
      amount: this._hasOwn(data, 'amount') ? data.amount : existing.amount,
      free_threshold: this._hasOwn(data, 'free_threshold') ? data.free_threshold : existing.free_threshold,
      is_active: this._hasOwn(data, 'is_active') ? data.is_active : existing.is_active,
      description: this._hasOwn(data, 'description') ? data.description : existing.description,
      start_hour: this._hasOwn(data, 'start_hour') ? data.start_hour : existing.start_hour,
      end_hour: this._hasOwn(data, 'end_hour') ? data.end_hour : existing.end_hour,
    }

    return this.repo.update(feeType, nextData)
  }

  async getDeliveryFee(cartTotal) {
    const config = await this.repo.getByType('delivery_fee')
    if (!config || !config.is_active) return 0

    const amount = this._toNumber(config.amount)
    const freeThreshold = config.free_threshold === null
      ? null
      : this._toNumber(config.free_threshold)

    if (freeThreshold !== null && this._toNumber(cartTotal) >= freeThreshold) {
      return 0
    }

    return amount
  }

  async getHandlingFee() {
    const config = await this.repo.getByType('handling_fee')
    if (!config || !config.is_active) return 0
    return this._toNumber(config.amount)
  }

  async getLateNightFee() {
    const config = await this.repo.getByType('late_night_fee')
    if (!config || !config.is_active) return 0
    if (!this.isLateNight(config)) return 0
    return this._toNumber(config.amount)
  }

  async getDeliveryEstimate() {
    const config = await this.repo.getByType('delivery_estimate_minutes')
    if (!config || !config.is_active) return 6
    return Math.round(this._toNumber(config.amount, 6))
  }

  /**
   * Check if current time is within late night hours
   */
  isLateNight(config) {
    if (!config || !config.is_active) return false

    const startHour = config.start_hour
    const endHour = config.end_hour
    if (startHour === null || endHour === null) return false

    const currentHour = new Date().getHours()
    if (startHour <= endHour) {
      return currentHour >= startHour && currentHour < endHour
    }

    return currentHour >= startHour || currentHour < endHour
  }

  _hasOwn(data, key) {
    return Object.prototype.hasOwnProperty.call(data, key)
  }

  _toNumber(value, fallback = 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
}
