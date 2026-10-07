import { describe, expect, it, vi } from 'vitest'

// Importing the service transitively imports config/database.js (which opens
// a pg Pool at module load) — mock it so this unit test needs no live DB.
vi.mock('../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: vi.fn(),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

import { PaymentSettingsService } from '../../src/modules/payment-settings/payment-settings.service.js'

function makeService(rows = {}) {
  const repository = { getMany: vi.fn(async () => rows) }
  return { service: new PaymentSettingsService(repository), repository }
}

describe('PaymentSettingsService', () => {
  it('falls back to safe defaults when no app_settings rows exist', async () => {
    const { service } = makeService({})
    const config = await service.getConfig()

    expect(config).toEqual({
      codEnabled: true,
      razorpayEnabled: true,
      walletEnabled: true,
      codMinOrderAmount: 99,
      codMaxOrderAmount: 2000,
    })
  })

  it('reflects admin-saved values, including a disabled method', async () => {
    const { service } = makeService({
      cod_enabled: false,
      razorpay_enabled: true,
      wallet_enabled: true,
      cod_min_order_amount: 200,
      cod_max_amount: 1500,
    })
    const config = await service.getConfig()

    expect(config.codEnabled).toBe(false)
    expect(config.codMinOrderAmount).toBe(200)
    expect(config.codMaxOrderAmount).toBe(1500)
  })

  it('treats malformed numeric overrides as the safe default', async () => {
    const { service } = makeService({ cod_min_order_amount: 'not-a-number' })
    const config = await service.getConfig()

    expect(config.codMinOrderAmount).toBe(99)
  })
})
