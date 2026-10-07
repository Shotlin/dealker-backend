import { describe, expect, it } from 'vitest'
import { encryptSecret, decryptSecret } from '../../../src/utils/encryption.js'

describe('encryption (AES-256-GCM, SETTINGS_ENCRYPTION_KEY)', () => {
  it('round-trips a plaintext secret', () => {
    const encrypted = encryptSecret('rzp_live_super_secret_value')
    expect(encrypted).not.toBe('rzp_live_super_secret_value')
    expect(decryptSecret(encrypted)).toBe('rzp_live_super_secret_value')
  })

  it('produces a different ciphertext each time (random IV) for the same plaintext', () => {
    const a = encryptSecret('same-value')
    const b = encryptSecret('same-value')
    expect(a).not.toBe(b)
    expect(decryptSecret(a)).toBe('same-value')
    expect(decryptSecret(b)).toBe('same-value')
  })

  it('returns null for null/undefined/empty-string input without touching the key', () => {
    expect(encryptSecret(null)).toBeNull()
    expect(encryptSecret(undefined)).toBeNull()
    expect(encryptSecret('')).toBeNull()
    expect(decryptSecret(null)).toBeNull()
    expect(decryptSecret('')).toBeNull()
  })

  it('throws on a tampered ciphertext instead of returning garbage', () => {
    const encrypted = encryptSecret('do-not-tamper')
    const buf = Buffer.from(encrypted, 'base64')
    buf[buf.length - 1] ^= 0xff // flip the last ciphertext byte
    const tampered = buf.toString('base64')
    expect(() => decryptSecret(tampered)).toThrow()
  })
})
