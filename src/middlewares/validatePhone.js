/**
 * Validate Indian phone number format
 * Accepts: 9876543210, +919876543210, 919876543210
 * Normalizes to 10-digit format
 */
export async function validatePhone(request, reply) {
  const { phone } = request.body || {}

  if (!phone) {
    return reply.code(400).send({
      success: false,
      message: 'Phone number is required',
      code: 'PHONE_REQUIRED',
    })
  }

  // Strip spaces, dashes, and country code prefix
  let normalized = String(phone).replace(/[\s-]/g, '')

  if (normalized.startsWith('+91')) {
    normalized = normalized.slice(3)
  } else if (normalized.startsWith('91') && normalized.length === 12) {
    normalized = normalized.slice(2)
  }

  // Must be exactly 10 digits
  if (!/^[6-9]\d{9}$/.test(normalized)) {
    return reply.code(400).send({
      success: false,
      message: 'Invalid phone number. Must be a valid 10-digit Indian mobile number.',
      code: 'INVALID_PHONE',
    })
  }

  // Attach normalized phone to body for downstream use
  request.body.phone = normalized
}
