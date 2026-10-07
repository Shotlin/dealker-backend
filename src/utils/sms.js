import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

const TWO_FACTOR_BASE = 'https://2factor.in/API/V1'

/**
 * Normalize phone number to 10-digit Indian mobile number for 2Factor API
 * Strips +91 or 91 prefix if present
 * @param {string} phone
 * @returns {string} 10-digit number
 */
function normalizePhone(phone) {
  // Remove +91 prefix
  if (phone.startsWith('+91')) return phone.slice(3)
  // Remove 91 prefix (if 12-digit number starting with 91)
  if (phone.startsWith('91') && phone.length === 12) return phone.slice(2)
  return phone
}

/**
 * Send OTP via 2Factor.in
 * @param {string} phone - 10-digit Indian mobile number
 * @returns {{ success: boolean, sessionId?: string, message?: string }}
 */
export async function sendSmsOtp(phone) {
  if (env.SMS_PROVIDER !== '2factor' || !env.TWO_FACTOR_API_KEY) {
    logger.warn('SMS provider not configured — skipping real SMS')
    return { success: false, message: 'SMS not configured' }
  }

  try {
    const cleanPhone = normalizePhone(phone)
    // Template: prefer TWO_FACTOR_TEMPLATE, fall back to TWO_FACTOR_SENDER (legacy alias).
    const template = env.TWO_FACTOR_TEMPLATE || env.TWO_FACTOR_SENDER || 'GroceryAppOTP'
    // 2Factor API: GET /API/V1/{api_key}/SMS/{phone}/AUTOGEN/{template}
    const url = `${TWO_FACTOR_BASE}/${env.TWO_FACTOR_API_KEY}/SMS/${cleanPhone}/AUTOGEN/${template}`

    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })

    const data = await res.json()

    if (data.Status === 'Success') {
      logger.info({ phone: phone.slice(-4) }, '2Factor OTP sent')
      return { success: true, sessionId: data.Details }
    }

    logger.error({ phone: phone.slice(-4), error: data }, '2Factor OTP send failed')
    return { success: false, message: data.Details || 'Failed to send OTP' }
  } catch (err) {
    logger.error({ err, phone: phone.slice(-4) }, '2Factor API error')
    return { success: false, message: 'SMS service unavailable' }
  }
}

/**
 * Verify OTP via 2Factor.in
 * @param {string} sessionId - Session ID from sendSmsOtp
 * @param {string} otp - OTP entered by user
 * @returns {{ success: boolean, message?: string }}
 */
export async function verifySmsOtp(sessionId, otp) {
  if (env.SMS_PROVIDER !== '2factor' || !env.TWO_FACTOR_API_KEY) {
    return { success: false, message: 'SMS not configured' }
  }

  try {
    // VERIFY uses sessionId (not VERIFY3 which expects phone number)
    const url = `${TWO_FACTOR_BASE}/${env.TWO_FACTOR_API_KEY}/SMS/VERIFY/${sessionId}/${otp}`
    logger.debug({ sessionId, otp, otpLength: otp?.length, otpType: typeof otp }, '2Factor verify — submitting')

    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })

    const data = await res.json()

    if (data.Status === 'Success' && data.Details === 'OTP Matched') {
      logger.info('2Factor OTP verified')
      return { success: true }
    }

    logger.warn({ response: data }, '2Factor OTP verify failed')
    return { success: false, message: data.Details || 'Invalid OTP' }
  } catch (err) {
    logger.error({ err }, '2Factor verify API error')
    return { success: false, message: 'SMS service unavailable' }
  }
}
