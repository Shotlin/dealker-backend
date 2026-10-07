import { generateOTP, storeOTP, verifyOTP } from '../../utils/otp.js'
import { sendSmsOtp, verifySmsOtp } from '../../utils/sms.js'
import { generateTokenPair, signAccessToken, signRefreshToken, verifyToken } from '../../utils/jwt.js'
import { ROLE_PERMISSIONS } from '../../utils/permissions.js'
import { orderQueue } from '../../config/bullmq.js'
import { redis } from '../../config/redis.js'
import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'

const REFRESH_TOKEN_PREFIX = 'refresh:'
const SMS_SESSION_PREFIX = 'sms:session:'
// Short-lived token issued when a staff member logs in but has multiple shop
// assignments and must select one before getting a full session JWT.
// Requirement 13.3
const TEMP_TOKEN_EXPIRY = '10m'

/**
 * The role a session ACTS as is decided by the app that logged in, never by
 * overwriting the stored `users.role`. One phone number can be a customer, a
 * rider and a vendor at once; each app gets a session for its own role and
 * none of them changes the account for the others.
 *
 *  - rider app (requested RIDER/DELIVERY) → 'RIDER' for a customer/rider account
 *  - any other app → the stored role, except a legacy account whose stored role
 *    was flipped to RIDER acts as CUSTOMER (it is a customer in the customer app)
 *  - HQ/admin/staff roles are never re-labelled.
 */
export function resolveActingRole(storedRole, requestedRole) {
  const stored = storedRole || 'CUSTOMER'
  if (requestedRole === 'RIDER') {
    return stored === 'CUSTOMER' || stored === 'RIDER' ? 'RIDER' : stored
  }
  return stored === 'RIDER' ? 'CUSTOMER' : stored
}

/**
 * Refresh tokens are kept per acting role so the customer and rider apps (same
 * user id) do not invalidate each other's session. The CUSTOMER key is the
 * historical `refresh:{id}` so existing sessions keep working.
 */
export function refreshKeyFor(userId, role) {
  return role === 'RIDER'
    ? `${REFRESH_TOKEN_PREFIX}${userId}:RIDER`
    : `${REFRESH_TOKEN_PREFIX}${userId}`
}

function normalizePhoneForOtp(phone) {
  const digits = `${phone || ''}`.replace(/\D/g, '')
  if (digits.startsWith('91') && digits.length === 12) return digits.slice(2)
  return digits
}

/**
 * Auth service — business logic for authentication
 */
export class AuthService {
  constructor(repository) {
    this.repo = repository
  }

  _demoOtpPhones() {
    return `${env.DEMO_OTP_PHONES || ''}`
      .split(',')
      .map((p) => normalizePhoneForOtp(p))
      .filter(Boolean)
  }

  _isDemoOtpEnabled() {
    return env.ALLOW_DEMO_OTP && this._demoOtpPhones().length > 0
  }

  _isDemoOtpPhone(phone) {
    if (!this._isDemoOtpEnabled()) return false
    return this._demoOtpPhones().includes(normalizePhoneForOtp(phone))
  }

  /**
   * Send OTP to a phone number
   * Production: sends via 2Factor.in SMS
   * Development: returns OTP in response for testing
   */
  async sendOtp(phone) {
    if (this._isDemoOtpPhone(phone)) {
      await redis.del(`${SMS_SESSION_PREFIX}${phone}`)
      logger.info({ phone: phone.slice(-4) }, 'Demo OTP bypass used')
      return {
        otp: env.DEMO_OTP_CODE,
        isDemoOtp: true,
      }
    }

    // Production mode — use 2Factor.in
    if (env.NODE_ENV === 'production' && env.SMS_PROVIDER === '2factor') {
      const smsResult = await sendSmsOtp(phone)

      if (!smsResult.success) {
        logger.error({ phone: phone.slice(-4) }, '2Factor SMS failed, falling back to dev OTP')
        // Fall through to dev mode as fallback
      } else {
        // Store session ID for verification
        await redis.set(
          `${SMS_SESSION_PREFIX}${phone}`,
          smsResult.sessionId,
          'EX',
          env.OTP_EXPIRY_SECONDS
        )
        logger.info({ phone: phone.slice(-4) }, 'OTP sent via 2Factor SMS')
        return {}
      }
    }

    // Development mode OR 2Factor with SMS_PROVIDER=2factor in dev (for testing real SMS)
    if (env.SMS_PROVIDER === '2factor' && env.TWO_FACTOR_API_KEY) {
      const smsResult = await sendSmsOtp(phone)

      if (smsResult.success) {
        await redis.set(
          `${SMS_SESSION_PREFIX}${phone}`,
          smsResult.sessionId,
          'EX',
          env.OTP_EXPIRY_SECONDS
        )
        logger.info({ phone: phone.slice(-4) }, 'OTP sent via 2Factor SMS (dev)')
        return { smsOtp: true }  // Flag: tell controller not to return OTP
      }
    }

    // Fallback: generate local OTP (dev testing)
    const otp = generateOTP()
    await storeOTP(phone, otp)

    logger.info({ phone: phone.slice(-4) }, 'OTP generated (local)')

    if (env.NODE_ENV === 'development') {
      logger.debug({ otp }, 'DEV OTP (remove in production)')
      return { otp }
    }

    return {}
  }

  /**
   * Verify OTP and return JWT tokens
   * Tries 2Factor.in verification first, then falls back to local Redis OTP
   */
  async verifyOtp(phone, otp, role) {
    let otpValid = false

    if (this._isDemoOtpPhone(phone)) {
      if (`${otp || ''}`.trim() !== env.DEMO_OTP_CODE) {
        return { success: false, message: 'Invalid OTP' }
      }
      otpValid = true
      await redis.del(`${SMS_SESSION_PREFIX}${phone}`)
      logger.info({ phone: phone.slice(-4) }, 'Demo OTP verified')
    }

    // Try 2Factor.in verification first
    const sessionId = otpValid ? null : await redis.get(`${SMS_SESSION_PREFIX}${phone}`)

    if (sessionId) {
      const smsResult = await verifySmsOtp(sessionId, otp)
      if (smsResult.success) {
        otpValid = true
        await redis.del(`${SMS_SESSION_PREFIX}${phone}`)
      } else {
        return { success: false, message: smsResult.message || 'Invalid OTP' }
      }
    }

    // Fallback: local Redis OTP verification
    if (!otpValid) {
      const result = await verifyOTP(phone, otp)
      if (!result.valid) {
        return { success: false, message: result.message }
      }
    }

    // Normalize role: RIDER, DELIVERY → 'RIDER' (canonical value)
    const requestedRole = (role === 'RIDER' || role === 'DELIVERY') ? 'RIDER' : null

    // Demo-OTP riders (App Store / Play Store reviewer accounts) skip the
    // manual admin-approval step so the app opens straight to /home.
    const isDemoRider = requestedRole === 'RIDER' && this._isDemoOtpPhone(phone)

    // Find or create user
    let user = await this.repo.findByPhone(phone)
    let isNewUser = false

    if (!user) {
      // Base identity is always CUSTOMER; the rider app acts as RIDER by app
      // (resolveActingRole), it does not store a different role.
      user = await this.repo.createUser(phone, 'CUSTOMER')
      isNewUser = true
      logger.info({ userId: user.id, role: user.role }, 'New user registered')

      // Auto-create rider_profile for new RIDER registrations
      if (requestedRole === 'RIDER') {
        await this.repo.ensureRiderProfile(user.id, { isApproved: isDemoRider })
        logger.info({ userId: user.id, isDemoRider }, 'Auto-created rider_profile for new rider')
      }
    } else if (requestedRole === 'RIDER' && (user.role === 'CUSTOMER' || user.role === 'RIDER')) {
      // Existing customer (or rider) using the rider app: give them a rider
      // profile but DO NOT change users.role — they stay a customer in the
      // customer app. The rider session below acts as RIDER by app.
      await this.repo.ensureRiderProfile(user.id, { isApproved: isDemoRider })
    }

    // Acting role for THIS session (in-memory only; never persisted).
    user.role = resolveActingRole(user.role, requestedRole)

    // Check if user is blocked
    if (!user.is_active) {
      return { success: false, message: 'Your account has been blocked. Contact support.' }
    }

    // ─── Shop staff branch-level authentication ──────────────────
    // Requirement 13.1, 13.2, 13.3, 13.4 — staff must auto-scope (1 shop),
    // pick (multiple shops), or fall through (zero shops → behave as a
    // regular user with no shop scope).
    //
    // Backward compatibility: customers and riders never reach this branch
    // because they have no shop_staff records, so their JWT structure is
    // unchanged.
    let staffAssignments = []
    if (user.role !== 'RIDER') {
      try {
        staffAssignments = await this.repo.findActiveShopStaffByUserId(user.id)
      } catch (err) {
        // If the lookup fails (e.g. shop_staff/shops tables not yet present
        // in a fresh environment), treat the user as a non-staff and continue.
        logger.warn(
          { err: err.message, userId: user.id, action: 'shop_staff_lookup_failed' },
          'Shop staff lookup failed during login — falling back to standard auth'
        )
        staffAssignments = []
      }
    }

    if (staffAssignments.length === 1) {
      // Single shop → issue shop-scoped JWT directly (Requirement 2.6, 13.2)
      const assignment = staffAssignments[0]
      const accessToken = signAccessToken(
        {
          id: user.id,
          phone: user.phone,
          role: user.role,
          shopId: assignment.shop_id,
          shopRole: assignment.role,
          permissions: assignment.permissions || [],
        },
        { expiresIn: '24h' }
      )
      const refreshToken = signRefreshToken({
        id: user.id,
        phone: user.phone,
        role: user.role,
      })
      await redis.set(
        refreshKeyFor(user.id, user.role),
        refreshToken,
        'EX',
        7 * 24 * 60 * 60
      )

      logger.info(
        {
          userId: user.id,
          shopId: assignment.shop_id,
          shopRole: assignment.role,
          action: 'staff_login_auto_scope',
        },
        'Shop staff auto-scoped to single shop'
      )

      return {
        success: true,
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          phone: user.phone,
          name: user.name,
          role: user.role,
          isNewUser,
          isVerified: false,
          shop_id: assignment.shop_id,
          shop_role: assignment.role,
          permissions: assignment.permissions || [],
        },
      }
    }

    if (staffAssignments.length > 1) {
      // Multiple shops → require selection (Requirement 2.7, 13.3)
      // Issue a short-lived temp token (no shop scope) so the client can
      // call POST /auth/select-shop. We do NOT issue a refresh token here.
      const tempToken = signAccessToken(
        {
          id: user.id,
          phone: user.phone,
          role: user.role,
          requires_shop_selection: true,
        },
        { expiresIn: TEMP_TOKEN_EXPIRY }
      )

      logger.info(
        {
          userId: user.id,
          shopCount: staffAssignments.length,
          action: 'staff_login_requires_selection',
        },
        'Shop staff has multiple shops — selection required'
      )

      return {
        success: true,
        requires_shop_selection: true,
        temp_token: tempToken,
        shops: staffAssignments.map((a) => ({
          shop_id: a.shop_id,
          shop_name: a.shop_name,
          shop_role: a.role,
        })),
        user: {
          id: user.id,
          phone: user.phone,
          name: user.name,
          role: user.role,
          isNewUser,
        },
      }
    }

    // ─── Vendor branch: vendor_users members get vendor-scoped JWTs ─────
    // Mirrors the shop-staff auto-scope: permissions come from the vendor
    // role maps (ROLE_PERMISSIONS), vendorId enables vendor-scope middleware.
    let vendorMemberships = []
    try {
      if (user.role !== 'RIDER') vendorMemberships = await this.repo.findActiveVendorUsersByUserId(user.id)
    } catch (err) {
      logger.warn(
        { err: err.message, userId: user.id, action: 'vendor_users_lookup_failed' },
        'Vendor membership lookup failed during login — falling back to standard auth'
      )
      vendorMemberships = []
    }

    if (vendorMemberships.length > 0) {
      const vendorRoles = [...new Set(vendorMemberships.map((m) => m.role))]
      const permissionSet = new Set()
      for (const vendorRole of vendorRoles) {
        for (const perm of ROLE_PERMISSIONS[vendorRole] ?? []) {
          permissionSet.add(perm)
        }
      }
      const permissions = [...permissionSet]
      // Single membership auto-scopes; multi-vendor users may pass X-Vendor-Id
      // (vendor-scope middleware validates membership per request).
      const vendorId = vendorMemberships.length === 1 ? vendorMemberships[0].vendor_id : null

      const accessToken = signAccessToken(
        {
          id: user.id,
          phone: user.phone,
          role: user.role,
          vendorId,
          vendorRoles,
          permissions,
        },
        { expiresIn: '24h' }
      )
      const refreshToken = signRefreshToken({ id: user.id, phone: user.phone, role: user.role })
      await redis.set(refreshKeyFor(user.id, user.role), refreshToken, 'EX', 7 * 24 * 60 * 60)

      logger.info(
        { userId: user.id, vendorId, vendorRoles, action: 'vendor_login_scoped' },
        'Vendor user signed in with vendor-scoped JWT'
      )

      return {
        success: true,
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          phone: user.phone,
          name: user.name,
          role: user.role,
          isNewUser,
          isVerified: false,
          vendor_id: vendorId,
          vendor_roles: vendorRoles,
          permissions,
        },
      }
    }

    // ─── Default path: zero shop assignments (customers, riders, admins) ─
    // JWT structure remains unchanged for backward compatibility.
    // Generate JWT pair
    const payload = { id: user.id, phone: user.phone, role: user.role }
    const tokens = generateTokenPair(payload)

    // Store refresh token in Redis (for invalidation on logout)
    await redis.set(
      refreshKeyFor(user.id, user.role),
      tokens.refreshToken,
      'EX',
      7 * 24 * 60 * 60 // 7 days
    )

    // For RIDER users, fetch rider_profile to get verification (approval) status
    let isVerified = false
    if (user.role === 'RIDER') {
      const riderProfile = await this.repo.getRiderProfile(user.id)
      isVerified = riderProfile?.is_approved === true
      if (isVerified) {
        await this._queueBacklogAssignScan('RIDER_LOGIN')
      }
    }

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        role: user.role,
        isNewUser,
        isVerified,
      },
    }
  }

  /**
   * Refresh access token using a valid refresh token
   */
  async refreshToken(refreshToken) {
    try {
      const decoded = verifyToken(refreshToken, env.JWT_REFRESH_SECRET)

      // Check if refresh token is still valid in Redis
      // The refresh token carries the acting role it was issued for, so a
      // rider-app session refreshes as RIDER and a customer-app one as
      // CUSTOMER — independent keys, independent lifetimes.
      const requestedRole = decoded.role === 'RIDER' ? 'RIDER' : null
      const stored = await redis.get(refreshKeyFor(decoded.id, requestedRole))
      if (!stored || stored !== refreshToken) {
        return { success: false, message: 'Invalid or expired refresh token' }
      }

      // Check user still exists and is active
      const user = await this.repo.findById(decoded.id)
      if (!user || !user.is_active) {
        return { success: false, message: 'User account is not active' }
      }

      // Generate new token pair (rotate refresh token)
      const actingRole = resolveActingRole(user.role, requestedRole)
      const payload = { id: user.id, phone: user.phone, role: actingRole }
      const tokens = generateTokenPair(payload)

      // Update refresh token in Redis
      await redis.set(
        refreshKeyFor(user.id, actingRole),
        tokens.refreshToken,
        'EX',
        7 * 24 * 60 * 60
      )

      return {
        success: true,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'Refresh token verification failed')
      return { success: false, message: 'Invalid or expired refresh token' }
    }
  }

  /**
   * Logout — invalidate refresh token
   */
  async logout(userId, role) {
    // Only this app's session ends; the same account's other apps stay signed in.
    await redis.del(refreshKeyFor(userId, role))
    logger.info({ userId }, 'User logged out')
  }

  /**
   * Delete user account (GDPR compliance)
   */
  async deleteAccount(userId) {
    await this.repo.deleteUser(userId)
    await redis.del(refreshKeyFor(userId, 'CUSTOMER'), refreshKeyFor(userId, 'RIDER'))
    logger.info({ userId }, 'User account deleted')
  }

  /**
   * Select a shop after authentication and issue a shop-scoped JWT.
   * Validates that the user has an active Shop_Staff_Record for the requested
   * shop (and the parent shop is itself active).
   *
   * Requirements: 2.6, 2.7, 2.8, 13.2, 13.5
   * Error codes: STAFF_NOT_FOUND (404), STAFF_INACTIVE (403)
   *
   * @param {string} userId - From the authenticated request (could be a temp
   *   token issued during a multi-shop login or any token without shopId).
   * @param {string} shopId - From the request body, validated as UUID.
   * @returns {Promise<{success, token?, shop_id?, shop_role?, permissions?, message?, code?}>}
   */
  async selectShop(userId, shopId) {
    // Verify the user is still active before issuing a long-lived token.
    const user = await this.repo.findById(userId)
    if (!user || !user.is_active) {
      return {
        success: false,
        message: 'User account is not active',
        code: 'STAFF_INACTIVE',
      }
    }

    const assignment = await this.repo.findActiveShopStaffByUserAndShop(
      userId,
      shopId
    )

    if (!assignment) {
      logger.info(
        { userId, shopId, action: 'select_shop_rejected' },
        'Shop selection rejected — no active assignment'
      )
      return {
        success: false,
        message: 'No active shop assignment found for this user and shop',
        code: 'STAFF_NOT_FOUND',
      }
    }

    const token = signAccessToken(
      {
        id: user.id,
        phone: user.phone,
        role: user.role,
        shopId: assignment.shop_id,
        shopRole: assignment.role,
        permissions: assignment.permissions || [],
      },
      { expiresIn: '24h' }
    )

    logger.info(
      {
        userId: user.id,
        shopId: assignment.shop_id,
        shopRole: assignment.role,
        action: 'shop_scope_selected',
      },
      'Shop scope selected and JWT issued'
    )

    return {
      success: true,
      token,
      shop_id: assignment.shop_id,
      shop_role: assignment.role,
      permissions: assignment.permissions || [],
    }
  }

  /**
   * Get paginated active shop assignments for the authenticated user
   * (used by `GET /api/v1/auth/my-shops`).
   *
   * No permission check beyond `fastify.authenticate` — the route returns
   * the requester's own assignments only. Bounds (`page >= 1`,
   * `1 <= limit <= 100`) are enforced by the JSON-Schema querystring
   * validator on the route; the service re-clamps defensively so any
   * direct in-process caller stays within bounds.
   *
   * Requirements: R19.5
   * Design: §5.4
   *
   * @param {string} userId
   * @param {{ page?: number, limit?: number }} pagination
   * @returns {Promise<{ items: Array<object>, page: number, limit: number, total: number }>}
   */
  async getMyShops(userId, { page = 1, limit = 20 } = {}) {
    const safePage = Math.max(1, Math.floor(Number(page) || 1))
    const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)))

    const { items, total } = await this.repo.loadActiveShopAssignmentsPaginated(
      userId,
      { page: safePage, limit: safeLimit }
    )

    return {
      items,
      page: safePage,
      limit: safeLimit,
      total,
    }
  }

  async _queueBacklogAssignScan(source) {
    try {
      await orderQueue.add(
        'auto-assign-backlog',
        {
          type: 'auto-assign-backlog',
          source,
          limit: 500,
        },
        {
          jobId: 'auto-assign-backlog-on-rider-login',
          removeOnComplete: true,
          removeOnFail: true,
        }
      )
    } catch (err) {
      logger.warn({ err, source }, 'Failed to queue rider backlog assignment scan')
    }
  }
}
