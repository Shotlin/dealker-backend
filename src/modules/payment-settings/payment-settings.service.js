import { PaymentSettingsRepository } from './payment-settings.repository.js'

const KEYS = [
  'cod_enabled',
  'razorpay_enabled',
  'wallet_enabled',
  'cod_min_order_amount',
  'cod_max_amount',
]

const DEFAULTS = {
  codEnabled: true,
  razorpayEnabled: true,
  walletEnabled: true,
  codMinOrderAmount: 99,
  codMaxOrderAmount: 2000,
}

/**
 * Payment Settings service — resolves whether COD / Razorpay / Wallet are
 * enabled, and the COD min/max amount, from the `app_settings` table.
 *
 * This is the single place order placement, the cart bill summary, and the
 * wallet/payments modules consult before allowing a payment method — so an
 * admin toggle in the dashboard is actually enforced, not just cosmetic.
 */
export class PaymentSettingsService {
  constructor(repository = new PaymentSettingsRepository()) {
    this.repo = repository
  }

  /** Resolve the effective payment-method config, falling back to safe defaults. */
  async getConfig() {
    const raw = await this.repo.getMany(KEYS)

    return {
      codEnabled: this._toBoolean(raw.cod_enabled, DEFAULTS.codEnabled),
      razorpayEnabled: this._toBoolean(raw.razorpay_enabled, DEFAULTS.razorpayEnabled),
      walletEnabled: this._toBoolean(raw.wallet_enabled, DEFAULTS.walletEnabled),
      codMinOrderAmount: this._toNumber(raw.cod_min_order_amount, DEFAULTS.codMinOrderAmount),
      codMaxOrderAmount: this._toNumber(raw.cod_max_amount, DEFAULTS.codMaxOrderAmount),
    }
  }

  _toBoolean(value, fallback) {
    if (value === undefined || value === null) return fallback
    return value === true || value === 'true'
  }

  _toNumber(value, fallback) {
    if (value === undefined || value === null) return fallback
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
}
