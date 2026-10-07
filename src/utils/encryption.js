/**
 * Application-layer encryption for secrets stored at rest — currently used
 * only by `src/modules/razorpay-settings` to store `key_secret`/
 * `webhook_secret` (migration 132). AES-256-GCM: a fresh random IV per
 * call, the auth tag stored alongside the ciphertext so tampering is
 * detected on decrypt rather than silently producing garbage.
 *
 * Key source: env `SETTINGS_ENCRYPTION_KEY`. Accepts either a base64-encoded
 * 32-byte key (recommended — `openssl rand -base64 32`) or any other
 * string of at least 32 characters, which is deterministically folded
 * into a 32-byte key via SHA-256 so a simple long passphrase still works
 * without the exact-base64-length ceremony.
 */

import crypto from 'node:crypto'
import { env } from '../config/env.js'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

function getKey() {
  if (!env.SETTINGS_ENCRYPTION_KEY) {
    throw new Error(
      'SETTINGS_ENCRYPTION_KEY is not configured — cannot encrypt/decrypt stored secrets. ' +
        'Set it in the environment before saving Razorpay (or any other) encrypted settings.'
    )
  }
  const raw = env.SETTINGS_ENCRYPTION_KEY
  try {
    const decoded = Buffer.from(raw, 'base64')
    if (decoded.length === 32) return decoded
  } catch {
    // fall through to the SHA-256 derivation below
  }
  return crypto.createHash('sha256').update(raw, 'utf8').digest()
}

/**
 * @param {string|null|undefined} plaintext
 * @returns {string|null} base64(iv || authTag || ciphertext), or null for an empty/nullish input
 */
export function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null
  const key = getKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64')
}

/**
 * @param {string|null|undefined} encoded — output of {@link encryptSecret}
 * @returns {string|null}
 */
export function decryptSecret(encoded) {
  if (!encoded) return null
  const key = getKey()
  const buf = Buffer.from(encoded, 'base64')
  const iv = buf.subarray(0, IV_LENGTH)
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}
