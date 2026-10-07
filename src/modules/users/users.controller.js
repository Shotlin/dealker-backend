import { success, error } from '../../utils/apiResponse.js'

/**
 * Users controller — thin HTTP layer
 */
export class UsersController {
  constructor(service) {
    this.service = service
  }

  /**
   * GET /me
   */
  async getProfile(request, reply) {
    const user = await this.service.getProfile(request.user.id)

    if (!user) {
      return reply.code(404).send(error('User not found', 'USER_NOT_FOUND'))
    }

    return reply.code(200).send(success(user, 'Profile fetched'))
  }

  /**
   * PUT /me
   */
  async updateProfile(request, reply) {
    const result = await this.service.updateProfile(request.user.id, request.body)

    if (!result.success) {
      return reply.code(400).send(error(result.message, 'EMAIL_TAKEN'))
    }

    return reply.code(200).send(success(result.user, 'Profile updated'))
  }

  /**
   * PUT /me/avatar
   */
  async uploadAvatar(request, reply) {
    const file = await request.file()

    if (!file) {
      return reply.code(400).send(error('No file uploaded', 'NO_FILE'))
    }

    // Validate image type
    const allowed = ['image/jpeg', 'image/png', 'image/webp']
    if (!allowed.includes(file.mimetype)) {
      return reply.code(400).send(error('Only JPEG, PNG, and WebP images are allowed', 'INVALID_FILE_TYPE'))
    }

    const result = await this.service.uploadAvatar(request.user.id, file.file)

    return reply.code(200).send(success({ avatar_url: result.avatar_url }, 'Avatar updated'))
  }

  /**
   * GET /me/stats
   */
  async getStats(request, reply) {
    const stats = await this.service.getStats(request.user.id)

    return reply.code(200).send(success(stats, 'Stats fetched'))
  }
}
