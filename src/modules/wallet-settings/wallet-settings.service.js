import { WalletSettingsRepository } from './wallet-settings.repository.js'

const KEYS = [
  'wallet_max_balance',
  'wallet_max_transfer_amount',
  'wallet_min_transfer_amount',
  'wallet_transfers_enabled',
  'wallet_topup_enabled',
]

const DEFAULTS = {
  maxWalletBalance: 2000,
  maxTransferAmount: 2000,
  minTransferAmount: 1,
  // Off by default: user-to-user wallet transfer is gated to RBI-authorized
  // Full-KYC PPI issuers regardless of transfer/balance limits, which this
  // platform is not. Wallet top-up + spend-on-order is unaffected by this
  // flag. Flip on in the dashboard only after that's been cleared.
  transfersEnabled: false,
  // On by default. A manual kill-switch for the admin to flip off during a
  // Razorpay outage or similar — stops new top-up attempts at the source
  // (createTopUp) instead of letting customers hit a broken payment flow.
  topupEnabled: true,
}

/**
 * Wallet Settings service — resolves the admin-configurable wallet balance
 * cap and transfer min/max from the `app_settings` table, falling back to
 * safe defaults. This is the single place `WalletService` consults before
 * crediting a wallet or accepting a transfer, so an admin change in the
 * dashboard is actually enforced, not just cosmetic.
 */
export class WalletSettingsService {
  constructor(repository = new WalletSettingsRepository()) {
    this.repo = repository
  }

  async getConfig() {
    const raw = await this.repo.getMany(KEYS)

    return {
      maxWalletBalance: this._toNumber(raw.wallet_max_balance, DEFAULTS.maxWalletBalance),
      maxTransferAmount: this._toNumber(raw.wallet_max_transfer_amount, DEFAULTS.maxTransferAmount),
      minTransferAmount: this._toNumber(raw.wallet_min_transfer_amount, DEFAULTS.minTransferAmount),
      transfersEnabled: this._toBoolean(raw.wallet_transfers_enabled, DEFAULTS.transfersEnabled),
      topupEnabled: this._toBoolean(raw.wallet_topup_enabled, DEFAULTS.topupEnabled),
    }
  }

  async updateConfig({ maxWalletBalance, maxTransferAmount, minTransferAmount, transfersEnabled, topupEnabled }) {
    const current = await this.getConfig()
    const next = {
      maxWalletBalance: maxWalletBalance ?? current.maxWalletBalance,
      maxTransferAmount: maxTransferAmount ?? current.maxTransferAmount,
      minTransferAmount: minTransferAmount ?? current.minTransferAmount,
      transfersEnabled: transfersEnabled ?? current.transfersEnabled,
      topupEnabled: topupEnabled ?? current.topupEnabled,
    }

    for (const [label, value] of Object.entries(next)) {
      if (label === 'transfersEnabled' || label === 'topupEnabled') continue
      if (!Number.isFinite(value) || value <= 0) {
        return { success: false, message: `${label} must be a positive number` }
      }
    }

    if (next.minTransferAmount > next.maxTransferAmount) {
      return { success: false, message: 'Minimum transfer amount cannot exceed the maximum transfer amount' }
    }
    if (next.maxTransferAmount > next.maxWalletBalance) {
      return { success: false, message: 'Maximum transfer amount cannot exceed the maximum wallet balance' }
    }

    await this.repo.upsert('wallet_max_balance', next.maxWalletBalance)
    await this.repo.upsert('wallet_max_transfer_amount', next.maxTransferAmount)
    await this.repo.upsert('wallet_min_transfer_amount', next.minTransferAmount)
    await this.repo.upsert('wallet_transfers_enabled', next.transfersEnabled)
    await this.repo.upsert('wallet_topup_enabled', next.topupEnabled)

    return { success: true, data: next }
  }

  _toNumber(value, fallback) {
    if (value === undefined || value === null) return fallback
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  _toBoolean(value, fallback) {
    if (value === undefined || value === null) return fallback
    if (typeof value === 'boolean') return value
    return value === 'true' || value === true
  }
}
