import crypto from 'node:crypto'
import { redis } from '../config/redis.js'
import { env } from '../config/env.js'

const OTP_PREFIX = 'otp:'
const OTP_ATTEMPTS_PREFIX = 'otp:attempts:'
const OTP_LOCKOUT_PREFIX = 'otp:lockout:'

/**
 * Generate a numeric OTP of configured length
 * @returns {string}
 */
export function generateOTP() {
  const length = env.OTP_LENGTH || 6
  const max = Math.pow(10, length)
  const min = Math.pow(10, length - 1)
  const num = crypto.randomInt(min, max)
  return String(num)
}

/**
 * Store OTP in Redis with TTL
 * @param {string} phone - Normalized 10-digit phone
 * @param {string} otp
 */
export async function storeOTP(phone, otp) {
  const key = `${OTP_PREFIX}${phone}`
  await redis.set(key, otp, 'EX', env.OTP_EXPIRY_SECONDS)
}

/**
 * Verify OTP from Redis
 * Handles attempt tracking and lockout
 * @param {string} phone
 * @param {string} otp
 * @returns {{ valid: boolean, message?: string }}
 */
export async function verifyOTP(phone, otp) {
  const lockoutKey = `${OTP_LOCKOUT_PREFIX}${phone}`
  const attemptsKey = `${OTP_ATTEMPTS_PREFIX}${phone}`
  const otpKey = `${OTP_PREFIX}${phone}`

  // Check lockout
  const isLocked = await redis.get(lockoutKey)
  if (isLocked) {
    const ttl = await redis.ttl(lockoutKey)
    return {
      valid: false,
      message: `Too many failed attempts. Try again in ${Math.ceil(ttl / 60)} minutes.`,
    }
  }

  const storedOTP = await redis.get(otpKey)

  if (!storedOTP) {
    return { valid: false, message: 'OTP expired or not found. Request a new one.' }
  }

  if (storedOTP !== otp) {
    // Increment attempts
    const attempts = await redis.incr(attemptsKey)
    await redis.expire(attemptsKey, env.OTP_EXPIRY_SECONDS)

    if (attempts >= env.OTP_MAX_ATTEMPTS) {
      // Lock the user out
      await redis.set(lockoutKey, '1', 'EX', env.OTP_LOCKOUT_SECONDS)
      await redis.del(otpKey, attemptsKey)
      return {
        valid: false,
        message: `Too many failed attempts. Locked out for ${env.OTP_LOCKOUT_SECONDS / 60} minutes.`,
      }
    }

    return {
      valid: false,
      message: `Invalid OTP. ${env.OTP_MAX_ATTEMPTS - attempts} attempts remaining.`,
    }
  }

  // OTP is valid — clean up
  await redis.del(otpKey, attemptsKey)

  return { valid: true }
}
