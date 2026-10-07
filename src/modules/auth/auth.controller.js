import { success, error } from '../../utils/apiResponse.js'
import { env } from '../../config/env.js'

/**
 * Auth controller — thin HTTP layer
 * Parses request, calls service, formats response
 */
export class AuthController {
  constructor(service) {
    this.service = service
  }

  /**
   * POST /send-otp
   */
  async sendOtp(request, reply) {
    const { phone } = request.body

    const result = await this.service.sendOtp(phone)

    // If OTP was sent via SMS (2Factor), don't expose OTP in response
    if (result.smsOtp) {
      return reply.code(200).send(success({}, 'OTP sent to your phone via SMS'))
    }

    const data = result.otp && (env.NODE_ENV === 'development' || result.isDemoOtp)
      ? { otp: result.otp, isDemoOtp: Boolean(result.isDemoOtp) }
      : {}
    return reply.code(200).send(success(data, 'OTP sent successfully'))
  }

  /**
   * POST /verify-otp
   */
  async verifyOtp(request, reply) {
    const { phone, otp, role } = request.body

    const result = await this.service.verifyOtp(phone, otp, role)

    if (!result.success) {
      return reply.code(400).send(error(result.message, 'INVALID_OTP'))
    }

    // Multi-shop staff: client must call POST /auth/select-shop next.
    // No refresh-token cookie is issued for the temp token.
    // Requirement 2.7, 13.3
    if (result.requires_shop_selection) {
      return reply.code(200).send(
        success(
          {
            requires_shop_selection: true,
            temp_token: result.temp_token,
            shops: result.shops,
            user: result.user,
          },
          'Multiple shop assignments — please select a shop'
        )
      )
    }

    // Set refresh token as httpOnly cookie
    reply.setCookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60, // 7 days
    })

    return reply.code(200).send(
      success(
        {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          user: result.user,
        },
        result.user.isNewUser ? 'Account created successfully' : 'Login successful'
      )
    )
  }

  /**
   * POST /select-shop — issue shop-scoped JWT after staff selects a shop.
   * Requires authenticated user (could be temp token or any token without shopId).
   * Requirements: 2.7, 2.8, 13.2, 13.3, 13.5
   */
  async selectShop(request, reply) {
    const { shop_id: shopId } = request.body || {}

    if (!shopId) {
      return reply
        .code(400)
        .send(error('shop_id is required', 'VALIDATION_ERROR'))
    }

    const result = await this.service.selectShop(request.user.id, shopId)

    if (!result.success) {
      const statusCode = result.code === 'STAFF_INACTIVE' ? 403 : 404
      return reply.code(statusCode).send(error(result.message, result.code))
    }

    return reply.code(200).send(
      success(
        {
          token: result.token,
          shop_id: result.shop_id,
          shop_role: result.shop_role,
          permissions: result.permissions,
        },
        'Shop selected successfully'
      )
    )
  }

  /**
   * POST /refresh-token
   */
  async refreshToken(request, reply) {
    const { refreshToken } = request.body

    if (!refreshToken) {
      return reply.code(400).send(error('Refresh token is required', 'REFRESH_TOKEN_REQUIRED'))
    }

    const result = await this.service.refreshToken(refreshToken)

    if (!result.success) {
      return reply.code(401).send(error(result.message, 'INVALID_REFRESH_TOKEN'))
    }

    // Update refresh token cookie
    reply.setCookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60,
    })

    return reply.code(200).send(
      success({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      }, 'Token refreshed successfully')
    )
  }

  /**
   * POST /logout
   */
  async logout(request, reply) {
    await this.service.logout(request.user.id, request.user.role)

    reply.clearCookie('refreshToken', { path: '/api/v1/auth' })

    return reply.code(200).send(success(null, 'Logged out successfully'))
  }

  /**
   * DELETE /account
   */
  async deleteAccount(request, reply) {
    await this.service.deleteAccount(request.user.id)

    reply.clearCookie('refreshToken', { path: '/api/v1/auth' })

    return reply.code(200).send(success(null, 'Account deleted successfully'))
  }

  /**
   * GET /my-shops — paginated active staff assignments for the requester.
   * Requirements: R19.5
   * Design: §5.4
   */
  async myShops(request, reply) {
    const page = parseInt(request.query?.page, 10) || 1
    const limit = Math.min(parseInt(request.query?.limit, 10) || 20, 100)

    const result = await this.service.getMyShops(request.user.id, { page, limit })

    return reply.code(200).send(success(result, 'Shop assignments fetched'))
  }
}
