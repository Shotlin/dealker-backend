import Razorpay from 'razorpay'
import { RazorpaySettingsRepository } from './razorpay-settings.repository.js'
import { emit } from '../../utils/audit-log.js'
import { logger } from '../../config/logger.js'

const REQUEST_TIMEOUT_MS = 8000
const MODES = ['TEST', 'PRODUCTION']

function assertValidMode(mode) {
  if (!MODES.includes(mode)) {
    const err = new Error(`Invalid Razorpay mode "${mode}" — must be TEST or PRODUCTION`)
    err.statusCode = 400
    throw err
  }
}

function maskKeyId(keyId) {
  if (!keyId) return null
  const match = keyId.match(/^(rzp_(?:test|live)_)/)
  const prefix = match ? match[1] : ''
  const tail = keyId.slice(prefix.length)
  if (tail.length <= 4) return `${prefix}••••`
  return `${prefix}••••${tail.slice(-4)}`
}

/**
 * Dashboard-managed Razorpay TEST/PRODUCTION credentials — the admin-facing
 * business logic behind the "paste keys, Test, Save, Activate" flow
 * (§ dashboard Configuration → Platform API Configuration → Razorpay).
 *
 * Mirrors `OlaMapsSettingsService`'s "always re-test before trusting a
 * saved key" discipline, but keeps activation (which mode is LIVE for real
 * traffic) as an explicit, separate step from saving credentials — testing
 * or saving a key must never itself change what customers pay through.
 */
export class RazorpaySettingsService {
  constructor(repository = new RazorpaySettingsRepository()) {
    this.repository = repository
  }

  /** Admin-safe view — both modes, masked, never the raw secret. */
  async get() {
    const row = await this.repository.get()
    return this._toAdminView(row)
  }

  /**
   * Test connection for `mode`. If `keyId`/`keySecret` are both provided,
   * tests that unsaved draft; if omitted, tests whatever is currently
   * stored for that mode. Either way, never activates the mode — and,
   * unlike Ola Maps' standalone test, the result IS persisted as that
   * mode's "Last tested" badge (the product spec calls for a durable
   * per-environment status, not just a one-off toast).
   */
  async test({ mode, keyId, keySecret } = {}, actorUserId = null) {
    assertValidMode(mode)

    let testKeyId = keyId
    let testKeySecret = keySecret
    let testedStoredCredentials = false

    if (testKeyId === undefined && testKeySecret === undefined) {
      const stored = await this.repository.getModeCredentialsDecrypted(mode)
      if (!stored) {
        return { success: false, statusCode: null, message: 'No credentials saved for this environment yet' }
      }
      testKeyId = stored.keyId
      testKeySecret = stored.keySecret
      testedStoredCredentials = true
    }

    const result = await this._testCredentials(testKeyId, testKeySecret)

    await this.repository.recordTest(mode, {
      status: result.success ? 'SUCCESS' : 'FAILED',
      message: result.message,
    }, actorUserId)

    emit('razorpay_settings_test', {
      actor_user_id: actorUserId,
      target_type: 'razorpay_settings',
      after: { mode, testedStoredCredentials, success: result.success, statusCode: result.statusCode },
    })

    return result
  }

  /**
   * Save credentials for one mode. All three fields are optional:
   * omitted -> that field is untouched; empty string -> cleared. Never
   * changes `active_mode` — a saved-but-inactive environment is exactly
   * what "not yet activated" means. Any edit invalidates that mode's
   * previous test result (repository enforces this), since a changed
   * secret was never actually the one that passed the last test.
   */
  async saveCredentials(mode, { keyId, keySecret, webhookSecret } = {}, actorUserId = null) {
    assertValidMode(mode)

    const row = await this.repository.saveCredentials(
      mode,
      { keyId, keySecret, webhookSecret },
      actorUserId
    )

    emit('razorpay_settings_credentials_updated', {
      actor_user_id: actorUserId,
      target_type: 'razorpay_settings',
      after: {
        mode,
        keyIdChanged: keyId !== undefined,
        keySecretChanged: keySecret !== undefined,
        webhookSecretChanged: webhookSecret !== undefined,
      },
    })

    return this._toAdminView(row)
  }

  /**
   * Switch which mode is live. Requires `confirm: true` when activating
   * PRODUCTION (defense in depth — the dashboard's own confirmation
   * dialog is the primary gate, but the API must not silently go live on
   * a stray/automated PUT). Refuses to activate a mode with no saved
   * credentials — there would be nothing for the payment flow to use.
   */
  async activate(mode, { confirm = false } = {}, actorUserId = null) {
    assertValidMode(mode)

    if (mode === 'PRODUCTION' && confirm !== true) {
      const err = new Error(
        'Activating PRODUCTION requires explicit confirmation (confirm: true) — new customer payments would use real money.'
      )
      err.statusCode = 400
      throw err
    }

    const credentials = await this.repository.getModeCredentialsDecrypted(mode)
    if (!credentials) {
      const err = new Error(`Cannot activate ${mode} — no Key ID / Key Secret saved for it yet`)
      err.statusCode = 400
      throw err
    }

    const row = await this.repository.setActiveMode(mode, actorUserId)

    emit('razorpay_settings_activated', {
      actor_user_id: actorUserId,
      target_type: 'razorpay_settings',
      after: { mode },
    })

    logger.info({ mode, actorUserId }, 'Razorpay active environment changed')

    return this._toAdminView(row)
  }

  /** @private A cheap, real, harmless Razorpay API call — proves the key pair actually authenticates. */
  async _testCredentials(keyId, keySecret) {
    const trimmedId = (keyId || '').trim()
    const trimmedSecret = (keySecret || '').trim()
    if (!trimmedId || !trimmedSecret) {
      return { success: false, statusCode: null, message: 'Key ID and Key Secret are required' }
    }

    try {
      const client = new Razorpay({ key_id: trimmedId, key_secret: trimmedSecret })
      await Promise.race([
        client.orders.all({ count: 1 }),
        new Promise((_, reject) =>
          setTimeout(() => reject(Object.assign(new Error('Network timeout'), { code: 'ETIMEDOUT' })), REQUEST_TIMEOUT_MS)
        ),
      ])
      return { success: true, statusCode: 200, message: 'Connected — Razorpay API reachable' }
    } catch (err) {
      const statusCode = err?.statusCode || err?.status || null
      if (statusCode === 401 || statusCode === 400) {
        return {
          success: false,
          statusCode,
          message: err?.error?.description || 'Authentication failed — invalid Key ID or Key Secret',
        }
      }
      if (err?.code === 'ETIMEDOUT') {
        return { success: false, statusCode: null, message: 'Network timeout — could not reach Razorpay' }
      }
      return {
        success: false,
        statusCode,
        message: err?.error?.description || err?.message || 'Could not reach Razorpay',
      }
    }
  }

  /** @private */
  _toAdminView(row) {
    if (!row) {
      return {
        activeMode: 'TEST',
        environments: {
          TEST: this._emptyEnvView(),
          PRODUCTION: this._emptyEnvView(),
        },
        updatedAt: null,
      }
    }
    return {
      activeMode: row.active_mode,
      environments: {
        TEST: this._envView(row, 'test'),
        PRODUCTION: this._envView(row, 'live'),
      },
      updatedAt: row.updated_at,
    }
  }

  /** @private */
  _envView(row, prefix) {
    return {
      configured: Boolean(row[`${prefix}_key_id`] && row[`${prefix}_key_secret_encrypted`]),
      maskedKeyId: maskKeyId(row[`${prefix}_key_id`]),
      hasWebhookSecret: Boolean(row[`${prefix}_webhook_secret_encrypted`]),
      lastTestedAt: row[`${prefix}_last_tested_at`],
      lastTestStatus: row[`${prefix}_last_test_status`],
      lastTestMessage: row[`${prefix}_last_test_message`],
    }
  }

  /** @private */
  _emptyEnvView() {
    return {
      configured: false,
      maskedKeyId: null,
      hasWebhookSecret: false,
      lastTestedAt: null,
      lastTestStatus: null,
      lastTestMessage: null,
    }
  }
}
