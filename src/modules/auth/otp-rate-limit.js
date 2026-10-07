import { clientIpKey } from '../../plugins/rateLimit.plugin.js'

const DEMO_PHONE_MAX = 100

/**
 * Per-route rate-limit config for the OTP endpoints.
 *
 * Normal phones are limited per client IP (shared carrier-NAT / office IPs
 * are the reason a QA team trips this quickly). Demo-OTP phones (reviewer /
 * test accounts, `DEMO_OTP_PHONES`) never receive a real SMS, so they are
 * limited per PHONE with a generous ceiling instead of sharing the IP bucket.
 *
 * Runs in `preHandler` (not the default `onRequest`) because the phone lives
 * in the request body, which only exists — and is normalised by
 * `validatePhone` — by then.
 */
export function otpRateLimit(service, max) {
  const isDemo = (request) => {
    const phone = request.body?.phone
    return Boolean(phone) && service._isDemoOtpPhone(phone)
  }

  return {
    max: (request) => (isDemo(request) ? DEMO_PHONE_MAX : max),
    timeWindow: '5 minutes',
    hook: 'preHandler',
    keyGenerator: (request) =>
      isDemo(request) ? `demo-otp:${request.body.phone}` : clientIpKey(request),
  }
}
