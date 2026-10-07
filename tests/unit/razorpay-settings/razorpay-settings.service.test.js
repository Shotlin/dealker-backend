import { describe, expect, it, vi, beforeEach } from 'vitest'
import { RazorpaySettingsService } from '../../../src/modules/razorpay-settings/razorpay-settings.service.js'

/** In-memory fake standing in for RazorpaySettingsRepository — no DB. */
function makeFakeRepository() {
  const row = {
    id: 'settings-1',
    active_mode: 'TEST',
    test_key_id: null,
    test_key_secret_encrypted: null,
    test_webhook_secret_encrypted: null,
    test_last_tested_at: null,
    test_last_test_status: null,
    test_last_test_message: null,
    live_key_id: null,
    live_key_secret_encrypted: null,
    live_webhook_secret_encrypted: null,
    live_last_tested_at: null,
    live_last_test_status: null,
    live_last_test_message: null,
    updated_at: null,
    updated_by: null,
  }
  const decryptedStore = { TEST: null, PRODUCTION: null }

  return {
    _row: row,
    _decryptedStore: decryptedStore,
    async get() {
      return row
    },
    async getModeCredentialsDecrypted(mode) {
      return decryptedStore[mode]
    },
    async getActiveCredentialsDecrypted() {
      return decryptedStore[row.active_mode]
    },
    async saveCredentials(mode, { keyId, keySecret, webhookSecret } = {}) {
      const prefix = mode === 'PRODUCTION' ? 'live' : 'test'
      if (keyId !== undefined) row[`${prefix}_key_id`] = keyId === '' ? null : keyId
      if (keySecret !== undefined) row[`${prefix}_key_secret_encrypted`] = keySecret === '' ? null : `enc(${keySecret})`
      if (webhookSecret !== undefined) row[`${prefix}_webhook_secret_encrypted`] = webhookSecret === '' ? null : `enc(${webhookSecret})`
      row[`${prefix}_last_tested_at`] = null
      row[`${prefix}_last_test_status`] = null
      row[`${prefix}_last_test_message`] = null
      decryptedStore[mode] = row[`${prefix}_key_id`] && row[`${prefix}_key_secret_encrypted`]
        ? { mode, keyId: row[`${prefix}_key_id`], keySecret, webhookSecret: webhookSecret || null }
        : null
      return row
    },
    async recordTest(mode, { status, message }) {
      const prefix = mode === 'PRODUCTION' ? 'live' : 'test'
      row[`${prefix}_last_tested_at`] = new Date().toISOString()
      row[`${prefix}_last_test_status`] = status
      row[`${prefix}_last_test_message`] = message
      return row
    },
    async setActiveMode(mode) {
      row.active_mode = mode
      return row
    },
    invalidate() {},
  }
}

describe('RazorpaySettingsService', () => {
  let repo
  let service

  beforeEach(() => {
    repo = makeFakeRepository()
    service = new RazorpaySettingsService(repo)
  })

  it('get() returns both environments unconfigured by default, TEST active', async () => {
    const settings = await service.get()
    expect(settings.activeMode).toBe('TEST')
    expect(settings.environments.TEST.configured).toBe(false)
    expect(settings.environments.PRODUCTION.configured).toBe(false)
  })

  it('saveCredentials masks the key id and never leaks the secret in the admin view', async () => {
    const settings = await service.saveCredentials('TEST', {
      keyId: 'rzp_test_ABCD1234WXYZ',
      keySecret: 'super-secret-value',
    })
    expect(settings.environments.TEST.configured).toBe(true)
    expect(settings.environments.TEST.maskedKeyId).toBe('rzp_test_••••WXYZ')
    expect(JSON.stringify(settings)).not.toContain('super-secret-value')
  })

  it('saving TEST credentials never touches PRODUCTION credentials', async () => {
    await service.saveCredentials('TEST', { keyId: 'rzp_test_AAAA1111', keySecret: 'test-secret' })
    await service.saveCredentials('PRODUCTION', { keyId: 'rzp_live_BBBB2222', keySecret: 'live-secret' })

    const settings = await service.get()
    expect(settings.environments.TEST.maskedKeyId).toBe('rzp_test_••••1111')
    expect(settings.environments.PRODUCTION.maskedKeyId).toBe('rzp_live_••••2222')
  })

  it('activate() refuses PRODUCTION without confirm: true', async () => {
    await service.saveCredentials('PRODUCTION', { keyId: 'rzp_live_X', keySecret: 'live-secret' })
    await expect(service.activate('PRODUCTION', { confirm: false })).rejects.toThrow(/confirm/i)
    const settings = await service.get()
    expect(settings.activeMode).toBe('TEST')
  })

  it('activate() succeeds for PRODUCTION with confirm: true when credentials exist', async () => {
    await service.saveCredentials('PRODUCTION', { keyId: 'rzp_live_X', keySecret: 'live-secret' })
    const settings = await service.activate('PRODUCTION', { confirm: true })
    expect(settings.activeMode).toBe('PRODUCTION')
  })

  it('activate() refuses a mode with no saved credentials, confirm or not', async () => {
    await expect(service.activate('TEST', {})).rejects.toThrow(/no key id/i)
  })

  it('test() reports "no credentials saved" for an untouched mode instead of calling Razorpay', async () => {
    const result = await service.test({ mode: 'PRODUCTION' })
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/no credentials saved/i)
  })

  it('test() with a draft key/secret never persists them (testing is not saving)', async () => {
    vi.spyOn(service, '_testCredentials').mockResolvedValue({
      success: true,
      statusCode: 200,
      message: 'Connected — Razorpay API reachable',
    })

    await service.test({ mode: 'TEST', keyId: 'rzp_test_DRAFT', keySecret: 'draft-secret' })

    const settings = await service.get()
    // The draft was never saved as this mode's actual credentials.
    expect(settings.environments.TEST.configured).toBe(false)
    // But the test result IS recorded as this mode's "last tested" status.
    expect(settings.environments.TEST.lastTestStatus).toBe('SUCCESS')
  })

  it('a credential edit clears that mode\'s previous test result', async () => {
    await repo.recordTest('TEST', { status: 'SUCCESS', message: 'ok' })
    await service.saveCredentials('TEST', { keyId: 'rzp_test_NEW', keySecret: 'new-secret' })
    const settings = await service.get()
    expect(settings.environments.TEST.lastTestStatus).toBeNull()
  })
})
