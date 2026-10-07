/**
 * Razorpay SDK client + active credentials — now dashboard-managed
 * (src/modules/razorpay-settings, migration 132) instead of a one-shot
 * read of RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET/RAZORPAY_WEBHOOK_SECRET from
 * `.env` at process start.
 *
 * `razorpay` is an ES module `let` export — every importer
 * (`import { razorpay } from '.../config/razorpay.js'`) gets a *live
 * binding*, not a one-time copy, so calling `refreshRazorpayClient()`
 * after an admin saves/activates new credentials updates every existing
 * `payments.service.js`/`wallet.service.js`/worker import in place, with
 * no process restart. `getRazorpayKeyId()`/`getRazorpayKeySecret()`/
 * `getRazorpayWebhookSecret()` are the equivalent replacements for the
 * old direct `env.RAZORPAY_*` reads at call sites that need the raw
 * values (HMAC signing, webhook verification, the amount the mobile
 * client is told to check out with).
 *
 * Fallback: if the dashboard has no usable credentials saved for its
 * active mode (fresh install, DB row not yet configured, or a DB error
 * while loading), this falls back to the legacy env vars — so existing
 * prod deployments keep working exactly as before until an admin
 * actually uses the new dashboard flow. Only once real credentials are
 * saved and activated does the env fallback stop being consulted.
 */

import Razorpay from 'razorpay'
import { env } from './env.js'
import { logger } from './logger.js'
import { RazorpaySettingsRepository } from '../modules/razorpay-settings/razorpay-settings.repository.js'

const repository = new RazorpaySettingsRepository()

export let razorpay = null
let activeMode = null
let activeKeyId = null
let activeKeySecret = null
let activeWebhookSecret = null

function applyCredentials(mode, keyId, keySecret, webhookSecret) {
  razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret })
  activeMode = mode
  activeKeyId = keyId
  activeKeySecret = keySecret
  activeWebhookSecret = webhookSecret || null
}

function clearCredentials() {
  razorpay = null
  activeMode = null
  activeKeyId = null
  activeKeySecret = null
  activeWebhookSecret = null
}

/**
 * (Re)loads the active Razorpay credentials from the dashboard-managed
 * settings row, falling back to env vars. Call this at boot (server.js /
 * worker.js, after the DB is reachable) and after any settings
 * save/activate (razorpay-settings.controller.js).
 */
export async function refreshRazorpayClient() {
  try {
    const credentials = await repository.getActiveCredentialsDecrypted()
    if (credentials?.keyId && credentials?.keySecret) {
      applyCredentials(credentials.mode, credentials.keyId, credentials.keySecret, credentials.webhookSecret)
      logger.info(`✅ Razorpay configured (${credentials.mode} — dashboard-managed)`)
      return
    }
  } catch (err) {
    logger.error({ err }, 'Failed to load Razorpay settings from the database — falling back to env vars')
  }

  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    applyCredentials('ENV', env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET, env.RAZORPAY_WEBHOOK_SECRET)
    logger.info('✅ Razorpay configured (env var fallback — no dashboard credentials active yet)')
  } else {
    clearCredentials()
    logger.warn('⚠️  Razorpay not configured — payment features will fail')
  }
}

export function getRazorpayKeyId() {
  return activeKeyId
}

export function getRazorpayKeySecret() {
  return activeKeySecret
}

export function getRazorpayWebhookSecret() {
  return activeWebhookSecret
}

export function getRazorpayMode() {
  return activeMode
}

// Synchronous best-effort initial value so a very early caller (before
// refreshRazorpayClient() completes at boot) sees the env-var fallback
// rather than `null`, matching the old module's synchronous behaviour.
// refreshRazorpayClient() (awaited in server.js/worker.js before the app
// starts accepting traffic) supersedes this the moment it resolves.
if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
  applyCredentials('ENV', env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET, env.RAZORPAY_WEBHOOK_SECRET)
}
